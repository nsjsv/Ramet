// ---------- 一轮的共用步骤：普通一轮（turn.ts 的 runTurn）与续跑（resume-turn.ts 的 runResume）同一份 ----------
// 会话怎么选、提示词怎么拼两边不同；会话建好之后到 prompt 收尾之间的这几步（配置、镜像、授权、绑定行、发送）必须一致，
// 两份必然漂移（比如一边忘了在 prompt 之前写 open_runs，进程死在发送之后就没有行可认领）。
import type { Pool } from 'pg'
import { loadAiImage, type PageTool } from '../page-read.js'
import type { AdapterEntry, ManagerHost, ResolvedAgent } from './manager-types.js'
import { authorize } from './posture.js'
import { insertOpenRun, requestCancel } from './remote-run.js'
import type { RunState } from './run-state.js'
import { applyConfigs, applyMsgOpts } from './session-config.js'
import type { ConfigOption, PromptBlock, PromptResult } from './types.js'

/** 接着用 sessionId 指的会话：本进程加载过直接用，没有就加载；加载不上（agent 侧已不存在）或 sessionId 为空就新建。
 *  fresh = 新建的会话，它什么都没见过，调用方要发全文 */
export async function useSession(
  entry: AdapterEntry,
  sessionId: string | null,
  cwd: string,
  tools: PageTool[],
): Promise<{ sessionId: string; configOptions: ConfigOption[]; fresh: boolean }> {
  if (sessionId && entry.loaded.has(sessionId)) return { sessionId, configOptions: [], fresh: false }
  if (sessionId) {
    try {
      const { configOptions } = await entry.adapter.loadSession(sessionId, cwd, tools)
      entry.loaded.add(sessionId)
      return { sessionId, configOptions, fresh: false }
    } catch {
      // 降级为新建 + 全文重放：结果正确，只是丢了 agent 自己的上下文
    }
  }
  const created = await entry.adapter.newSession(cwd, tools)
  entry.loaded.add(created.sessionId)
  return { sessionId: created.sessionId, configOptions: created.configOptions, fresh: true }
}

/** 会话建好之后、挂监听之前：页面级配置 → 会话镜像 → 机器主人判定 → 这条消息的配置覆盖 */
export async function readySession(
  host: ManagerHost,
  pageId: string,
  agent: ResolvedAgent,
  entry: AdapterEntry,
  sessionId: string,
  configOptions: ConfigOption[],
  user: { id: string; role: string },
  run: RunState,
): Promise<void> {
  await applyConfigs(host, pageId, agent.id, entry, sessionId, configOptions)
  // 绑进会话镜像（执行端快照播种 + 广播全量）。换了会话时旧会话的待批在这里按取消应答
  host.mirror.bind(pageId, agent.id, sessionId, entry.adapter)
  // 跳过全部确认只有机器主人能发起：会话此刻就在该档而发起人不是主人，本轮失败并给出原因。
  // 必须在 prompt 之前，也在消息级覆盖之前（覆盖不带 mode，见 applyMsgOpts）
  authorize(user, agent, {
    kind: 'run',
    mode: host.mirror.configs(pageId, agent.id).find((o) => o.category === 'mode')?.currentValue,
  })
  // 这条消息的配置覆盖（attrs.opts）：页面级之后再叠加，整轮生效、轮末还原。不落库，否则会把这一条消息的配置
  // 变成整个页面的配置。run.msgBefore 由 applyMsgOpts 边应用边登记，并写进 open_runs：认领回来的收尾只能靠它还原
  await applyMsgOpts(host, pageId, agent.id, entry, sessionId, run)
}

/** 监听挂上之后：记下本轮的会话与目录；已经点了停止 / 服务要关了就不发 prompt（返回 false）。
 *  远端回合在 prompt 之前写绑定行：写晚了，进程死在发送之后就没有行可认领，占位块只能被收成出错 */
export async function bindRun(
  host: ManagerHost,
  run: RunState,
  row: { pageId: string; replyId: string; sessionId: string; agentId: string; userId: string; cwd: string; baseRun?: string },
): Promise<boolean> {
  run.sessionId = row.sessionId
  run.cwd = row.cwd
  if (run.cancelled || run.hold) return false
  if (!run.remote) return true
  await insertOpenRun(host.pool, {
    ...row,
    runId: run.runId,
    connectorId: run.remote.connectorId,
    startedAt: run.startedAt,
    msgOpts: run.msgOpts,
    msgBefore: run.msgBefore,
  })
  run.bound = true
  // 长回合里定时把会话记录的新增拉到中心（收尾时由 manager.release 停掉并再拉一次）
  host.sessions.watch(run)
  if (!run.cancelled && !run.hold) return true
  if (run.cancelled) await requestCancel(host.pool, run.runId).catch(() => undefined)
  return false
}

/** 这一轮那条用户消息里的图：作为图片块跟在文本后面（能不能收由执行端按 agent 的能力决定；超过体积闸的不带，链接仍在文本里） */
export async function withImages(pool: Pool, blocks: PromptBlock[], imageIds: string[]): Promise<PromptBlock[]> {
  for (const id of imageIds) {
    const img = await loadAiImage(pool, id)
    if (!img.error) blocks.push({ type: 'image', mimeType: img.mime, data: img.data })
  }
  return blocks
}

/** 发出提示词并等它结束；关停时与 run.abort 竞速（agent 不回也能走到收尾） */
export async function sendPrompt(entry: AdapterEntry, sessionId: string, blocks: PromptBlock[], run: RunState): Promise<PromptResult> {
  const pending = entry.adapter.prompt(sessionId, blocks, run.runId)
  // abort 先赢时 prompt 稍后的拒绝不能变成 unhandledRejection
  void pending.catch(() => undefined)
  return Promise.race([pending, run.abort.promise])
}

/** prompt 正常返回后的结局：关停不算结局（由 shutdown 定），agent 报取消或用户点过停止 = 停止，否则正常结束 */
export function settleRun(run: RunState, res: PromptResult): void {
  if (run.shutdown) return
  if (res.stopReason === 'cancelled' || run.cancelled) run.cancelled = true
  else run.ended = true
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
