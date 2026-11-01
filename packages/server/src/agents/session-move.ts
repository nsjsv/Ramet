// ---------- 换机器：把这一页这个工具的原生会话从中心下发到这一轮要跑的机器（换机器搬会话的下半段）----------
// 下一轮的 agent 是机器 Y 上的某个工具，而这一页这个工具的会话上次在机器 X 上跑（agent_session.current[工具]）：
// 等这一页的同步做完 → X 在线就再补拉一次新增（中心没有副本时这是唯一的来源）→ Y 上先关掉这个会话（驱动可能还拿着内存里的旧状态）
// → 把中心那份分块写到 Y（路径只由 Y 上的驱动按工具规则算）→ 会话记录照抄一份给 Y（同 sessionId、同 seen，cwd 换成 Y 的）
// → 之后照常 load + 只发新增。原机器在不在线都不影响（中心有副本就行）。
// 只在发起人自己接入的机器之间搬（session-sync.ts 的 movable）：别人授权给你的机器、老 connector、不支持的工具、
// 中心没有副本且原机器离线、写入 / 加载失败，一律退回新建会话 + 全文重放，运行条上说明「没能接上原会话」。
// 下发期间这一页的槽被这一轮占着，同一个会话不会被并发跑起来；connector 也拒绝写一个正在跑的会话。

import { parseRemoteId, type ManagerHost, type ResolvedAgent, type SavedSession } from './manager-types.js'
import { toolOf } from '@ramet/shared/reply-stats'
import type { RunRecord } from './run-record.js'
import { copyFiles, copyPath, readCopy, type CopyFile } from './session-copies.js'
import { loadCurrent, loadOwnSession, loadToolProfile } from './session-store.js'
import { machinePass, sessionFrame, TOOL_NOT_PORTED, type SessionSync } from './session-sync.js'
import { SESSION_CHUNK_BYTES } from './session-types.js'
import { toolProfileOf } from './tool-profile.js'
import type { MachinePass } from './machine-access.js'

/** 运行条上的那一步（同一个 id 先 in_progress，再 completed / failed） */
const STEP_ID = 'ramet-session-move'
export const CARRY_FAILED = '没能接上原会话，已把文档发给新机器'

const SELECT_OWNER = 'SELECT owner_id FROM connectors WHERE id = $1'

export type CarryHost = Pick<ManagerHost, 'pool' | 'ensureAdapter'> & { sessions: SessionSync }

/** 一次换机器。saved = 这一轮该接着用的会话记录（下发成功时就是原会话，cwd 已换成目标机器的；不能搬时是目标机器自己的记录）。
 *  run 在回复块建好之后调（运行条要有地方显示），返回 false = 下发失败，这一轮不要再去加载那个会话；
 *  settle 在会话打开之后调：fresh = 目标机器加载不上、新建了 */
export type Carry = {
  saved: SavedSession | null
  run(record: RunRecord): Promise<boolean>
  settle(fresh: boolean): void
}

function step(record: RunRecord, status: 'in_progress' | 'completed' | 'failed', title: string, note?: string): void {
  record.tool({ type: 'tool', id: STEP_ID, kind: 'other', title, status, ...(note ? { note } : {}) })
}

/** 判断这一轮要不要换机器搬会话；不用搬（同一台、没有记录、不是这个人的会话、换了工具档位）= null。
 *  from = 续跑指定的原会话（跑那块回复的 agent 与会话）；缺省按 current[工具] 找上一轮在哪 */
export async function planCarry(
  host: CarryHost,
  pageId: string,
  agent: ResolvedAgent,
  user: { id: string },
  cwd: string,
  from?: { agentId: string; sessionId: string; seen: string },
): Promise<Carry | null> {
  const { pool } = host
  const tool = toolOf(agent.id)
  const profile = await loadToolProfile(pool, pageId)
  let src = from ?? null
  if (!src) {
    const current = await loadCurrent(pool, pageId, tool)
    if (!current || current === agent.id) return null
    const saved = await loadOwnSession(pool, pageId, current, user.id)
    // 工具档位换了本来就要新建会话，没必要搬
    if (!saved?.seen || toolProfileOf(saved.tools) !== profile) return null
    src = { agentId: current, sessionId: saved.sessionId, seen: saved.seen }
  }
  if (src.agentId === agent.id || toolOf(src.agentId) !== tool) return null
  const source = parseRemoteId(src.agentId)
  const target = agent.remote
  const reason = !source || !target
    ? '服务器本机的会话不在机器之间搬'
    : await (async () => {
        const movable = host.sessions.movable(target.connectorId, target.agentId, user.id)
        if ('reason' in movable) return movable.reason
        const { rows } = await pool.query<{ owner_id: string | null }>(SELECT_OWNER, [source.connectorId])
        return rows[0]?.owner_id === user.id ? null : '原来的会话不在你自己的机器上'
      })()
  // 工具本身搬不了（老 connector 上仍经 ACP 的）：与没换机器一样，用目标机器自己的记录或新建，运行条不出「没接上」——那是给本来能搬的情况的
  if (reason === TOOL_NOT_PORTED) return null
  if (reason || !source || !target) {
    // 搬不了：这一轮照没有换机器时的规则走（目标机器自己的记录，或新建 + 全文重放），运行条上说一声
    const own = await loadOwnSession(pool, pageId, agent.id, user.id)
    return {
      saved: own,
      run: async (record) => {
        step(record, 'failed', CARRY_FAILED, reason ?? undefined)
        return true
      },
      settle: () => undefined,
    }
  }
  const sessionId = src.sessionId
  const saved: SavedSession = { sessionId, cwd, seen: src.seen, userId: user.id, tools: profile }
  const name = host.sessions.hub.get(target.connectorId)?.name ?? '这台机器'
  let carried: RunRecord | null = null
  return {
    saved,
    run: async (record) => {
      step(record, 'in_progress', `正在把会话接到 ${name}…`)
      try {
        await host.sessions.enqueue(pageId, async () => {
          // 原机器在线就先补拉一次新增：中心没有副本（老会话 / 同步失败过）时这是唯一的来源，有的话也补上可能漏掉的尾巴
          const origin = { pageId, connectorId: source.connectorId, agentId: source.agentId, sessionId, userId: user.id }
          await host.sessions.pull(origin).catch((err: unknown) => console.warn(`[session-move] 从原机器补拉失败：${err instanceof Error ? err.message : String(err)}`))
          const files = await copyFiles(pool, pageId, tool, sessionId)
          if (files.length === 0) throw new Error('中心没有这个会话的副本，原来的机器也不在线')
          // 会话帧是 machine 范围：要这台机器的 machine 范围凭据（主人永远有），普通 resolve 出来的只有 agent 范围
          const pass = await machinePass(pool, user.id, target.connectorId)
          if (!pass) throw new Error('拿不到这台机器的使用凭据')
          // 先关：驱动可能还拿着内存里的旧会话（以前在这台机器上跑过），不关的话写进去的新记录不生效
          const entry = host.ensureAdapter({ ...agent, pass })
          entry.loaded.delete(sessionId)
          await entry.adapter.closeSession(sessionId)
          for (const f of files) await pushFile(host.sessions, pass, { pageId, tool, agentId: target.agentId, sessionId, cwd }, f)
        })
        carried = record
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[session-move] ${pageId} 接到 ${name} 失败：${message}`)
        step(record, 'failed', CARRY_FAILED, message)
        return false
      }
    },
    settle: (fresh) => {
      if (!carried) return
      // 写进去了但加载不上（驱动认不出这份记录）：同样退回新建 + 全文重放
      if (fresh) step(carried, 'failed', CARRY_FAILED, '这台机器加载不了下发的会话')
      else step(carried, 'completed', `已把会话接到 ${name}`)
    },
  }
}

/** 把中心的一个文件分块写到目标机器（最后一块带 last，connector 核对总长后原子换入）。内容寻址的文件目标已有就跳过 */
async function pushFile(
  sessions: SessionSync,
  pass: MachinePass,
  at: { pageId: string; tool: string; agentId: string; sessionId: string; cwd: string },
  file: CopyFile,
): Promise<void> {
  const path = copyPath(at.pageId, at.tool, at.sessionId, file.name)
  let offset = 0
  do {
    const len = Math.min(SESSION_CHUNK_BYTES, file.size - offset)
    const data = (await readCopy(path, offset, len)).toString('base64')
    const last = offset + len >= file.size
    const reply = await sessionFrame(sessions.hub, pass, 'session-write', (rid, actor) => ({
      t: 'session-write', rid, actor, agent: at.agentId, sessionId: at.sessionId, cwd: at.cwd,
      name: file.name, offset, data, last, size: file.size,
    }))
    if (reply.skipped) return
    offset += len
  } while (offset < file.size)
}
