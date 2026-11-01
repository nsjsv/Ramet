/* ---------- 换机器搬会话：中心侧的同步与下发（真库 + 脚本化机器）----------
 * 脚本化机器照真 connector 的形状应答 session-* 帧（scripted-machine.ts 的 respondSession），prompt 收尾前往 main.jsonl 追加一行。
 * 这里测中心的流程与判定：每轮只拉新增 / 重写了整份重拉 / >1MB 分块、换机器下发（先 close 再写、只发新增）、换回原机器、
 * 各种退回（中心没有副本且原机器离线 / 授权来的机器 / 老 connector / 写入中途失败）、重新生成与清空回收站删副本、
 * 原机器离线时续跑换到另一台。四家真驱动跨两台 connector 的端到端在 session-move-native.test.ts。
 */
import { expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { connectMachine, pairMachine, type Machine } from './agents/scripted-machine.js'
import {
  agentSession,
  agentsList,
  connectDoc,
  continuePage,
  grantMachine,
  joinPageSpace,
  pageOwnership,
  pool,
  postJson,
  replyBlocks,
  settled,
  setupPage,
  SSECollector,
  base,
  userIdOf,
  userMessage,
  waitFor,
} from './agents/test-kit.js'
import { copyPath } from './agents/session-copies.js'
import { CARRY_FAILED } from './agents/session-move.js'
import { RESUME_TAG } from './agents/resume-turn.js'
import type { CenterMsg } from './agents/protocol.js'

const UPLOADS = mkdtempSync(join(tmpdir(), 'ramet-session-move-'))
process.env.UPLOAD_DIR = UPLOADS

const CLAUDE = [{ id: 'claude', label: 'Claude', driver: 'claude' }]
const WITH_SESSION = ['project', 'session']
const MB = 1024 * 1024

type Ctx = { cookie: string; pageId: string; spaceId: string; ownerId: string; a: HocuspocusProvider; sse: SSECollector; turns: number }

async function setup(): Promise<Ctx> {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  return { cookie, pageId, spaceId, ownerId, a, sse, turns: 0 }
}

function done(ctx: Ctx): void {
  ctx.sse.stop()
  ctx.a.destroy()
}

const machine = (ctx: Ctx, name: string, caps = WITH_SESSION): Promise<Machine> => pairMachine(ctx.spaceId, ctx.ownerId, name, caps, CLAUDE)
const agentOf = (m: Machine): string => `c:${m.id}:claude`

/** 发一条消息给某台机器上的 claude，等这一轮收尾 */
async function turn(ctx: Ctx, m: Machine, text: string): Promise<void> {
  userMessage(ctx.a.document, text)
  expect(await continuePage(ctx.pageId, ctx.cookie, { agent: agentOf(m) })).toBe(202)
  ctx.turns += 1
  await settled(ctx.sse, ctx.turns)
}

const mainOf = (m: Machine, sessionId: string): Buffer => m.sessionFiles.get(sessionId)?.get('main.jsonl') ?? Buffer.alloc(0)

async function copyRows(pageId: string): Promise<Array<{ session_id: string; name: string; size: number }>> {
  const { rows } = await pool.query<{ session_id: string; name: string; size: string }>(
    'SELECT session_id, name, size FROM agent_session_files WHERE page_id = $1 ORDER BY name',
    [pageId],
  )
  return rows.map((r) => ({ ...r, size: Number(r.size) }))
}

/** 等中心的副本追上机器上的 main.jsonl */
async function synced(ctx: Ctx, m: Machine, sessionId: string): Promise<void> {
  await waitFor(async () => {
    const want = mainOf(m, sessionId).length
    return want > 0 && (await copyRows(ctx.pageId)).some((r) => r.session_id === sessionId && r.name === 'main.jsonl' && r.size === want)
  })
}

const centerCopy = (ctx: Ctx, sessionId: string): Promise<Buffer> => readFile(copyPath(ctx.pageId, 'claude', sessionId, 'main.jsonl'))

/** 下发进度那一步的全部增量（运行条上的「正在把会话接到…」/「没能接上原会话」） */
function moveSteps(ctx: Ctx): Array<{ title?: string; status?: string; note?: string }> {
  return ctx.sse.events.flatMap((e) => {
    const ev = e as unknown as { type: string; step?: { id: string; title?: string; status?: string; note?: string } }
    return ev.type === 'step' && ev.step?.id === 'ramet-session-move' ? [ev.step] : []
  })
}

/** 等这台机器从目录里消失（中心认定它离线） */
async function offline(ctx: Ctx, m: Machine): Promise<void> {
  await waitFor(async () => !(await agentsList(ctx.cookie)).some((a) => a.id === agentOf(m)))
}

const reads = (m: Machine): Array<Extract<CenterMsg, { t: 'session-read' }>> => m.of('session-read')
const sessionTypes = (m: Machine): string[] => m.frames.filter((f) => f.t.startsWith('session-') || f.t === 'load' || f.t === 'new' || f.t === 'prompt').map((f) => f.t)
const lastPrompt = (m: Machine): string => {
  const p = m.of('prompt').at(-1)
  return p ? p.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
}

test('每轮收尾后同步到中心：第二轮只拉新增；文件被整个重写就整份重拉', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  await turn(ctx, x, '第一问')
  const sid = 'xbox-S1'
  await synced(ctx, x, sid)
  expect((await centerCopy(ctx, sid)).equals(mainOf(x, sid))).toBe(true)
  const first = mainOf(x, sid).length
  expect(reads(x).map((r) => r.offset)).toEqual([0])

  await turn(ctx, x, '第二问')
  await synced(ctx, x, sid)
  // 第二轮只从已有长度接着读
  expect(reads(x).slice(1).map((r) => r.offset)).toEqual([first])
  expect((await centerCopy(ctx, sid)).equals(mainOf(x, sid))).toBe(true)

  // 机器上的文件被整个重写（前缀变了）：尾巴哈希对不上，整份重拉
  x.sessionFiles.get(sid)!.set('main.jsonl', Buffer.from('x'.repeat(first + 500) + '\n'))
  const before = reads(x).length
  await turn(ctx, x, '第三问')
  await synced(ctx, x, sid)
  expect(reads(x)[before]?.offset).toBe(0)
  expect((await centerCopy(ctx, sid)).equals(mainOf(x, sid))).toBe(true)
  done(ctx)
})

test('换机器：原机器已停，新机器先 close 再写入，同一会话 load、只发新增；再换回原机器同样先 close 再写入', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  await turn(ctx, x, '第一问')
  const sid = 'xbox-S1'
  await synced(ctx, x, sid)
  const xContent = mainOf(x, sid)
  x.ws.terminate()
  await offline(ctx, x)

  await turn(ctx, y, '第二问')
  // 顺序：先关掉会话 → 写入 → 加载同一个会话 → 发提示词；不新建会话
  expect(sessionTypes(y).filter((t) => t !== 'session-stat' && t !== 'session-read')).toEqual(['session-close', 'session-write', 'load', 'prompt'])
  expect(y.of('load')[0]?.sessionId).toBe(sid)
  expect(y.of('prompt')[0]?.sessionId).toBe(sid)
  // Y 拿到的是 X 的记录（再加上这一轮自己追加的一行）
  expect(mainOf(y, sid).subarray(0, xContent.length).equals(xContent)).toBe(true)
  // 只发新增：第一问不在提示词里
  expect(lastPrompt(y)).toContain('第二问')
  expect(lastPrompt(y)).not.toContain('第一问')
  const sessions = await agentSession(ctx.pageId)
  expect(sessions?.[agentOf(y)]?.sessionId).toBe(sid)
  expect(sessions?.[agentOf(y)]?.seen).toBe(replyBlocks(ctx.a).at(-1)?.id)
  expect(moveSteps(ctx).map((s) => s.status)).toEqual(['in_progress', 'completed'])
  await synced(ctx, y, sid)

  // 再换回 X（重新上线）：X 先关掉旧会话再写入，接着的是包含 Y 那一轮的最新记录
  const x2 = await connectMachine({ id: x.id, name: 'xbox', token: x.token, caps: WITH_SESSION, agents: CLAUDE })
  x2.sessionFiles.set(sid, new Map([['main.jsonl', xContent]]))
  const yContent = mainOf(y, sid)
  await turn(ctx, x2, '第三问')
  expect(sessionTypes(x2).filter((t) => t !== 'session-stat' && t !== 'session-read')).toEqual(['session-close', 'session-write', 'load', 'prompt'])
  expect(mainOf(x2, sid).subarray(0, yContent.length).equals(yContent)).toBe(true)
  expect(lastPrompt(x2)).not.toContain('第二问')
  const current = await pool.query<{ current: Record<string, string> }>("SELECT agent_session->'current' AS current FROM pages WHERE id = $1", [ctx.pageId])
  expect(current.rows[0]?.current).toEqual({ claude: agentOf(x2) })
  done(ctx)
})

test('超过 1MB 的记录分块拉、分块写', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  await turn(ctx, x, '第一问')
  const sid = 'xbox-S1'
  await synced(ctx, x, sid)
  const first = mainOf(x, sid).length
  // 一轮里 agent 读了个大文件：记录一下子长了 2.5MB
  x.sessionFiles.get(sid)!.set('main.jsonl', Buffer.concat([mainOf(x, sid), Buffer.alloc(2.5 * MB, 0x61), Buffer.from('\n')]))
  await turn(ctx, x, '第二问')
  await synced(ctx, x, sid)
  expect(reads(x).slice(1).map((r) => r.offset)).toEqual([first, first + MB, first + 2 * MB])
  const size = mainOf(x, sid).length
  expect((await stat(copyPath(ctx.pageId, 'claude', sid, 'main.jsonl'))).size).toBe(size)

  x.ws.terminate()
  await offline(ctx, x)
  await turn(ctx, y, '第三问')
  const writes = y.of('session-write')
  expect(writes.map((w) => [w.offset, w.last])).toEqual([[0, false], [MB, false], [2 * MB, true]])
  expect(writes.every((w) => w.size === size)).toBe(true)
  expect(y.of('load')[0]?.sessionId).toBe(sid)
  done(ctx)
})

test('退回：中心没有副本且原机器离线 → 新机器新建会话 + 全文重放，运行条说明', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  await turn(ctx, x, '第一问')
  await synced(ctx, x, 'xbox-S1')
  await pool.query('DELETE FROM agent_session_files WHERE page_id = $1', [ctx.pageId])
  x.ws.terminate()
  await offline(ctx, x)

  await turn(ctx, y, '第二问')
  expect(y.of('session-write')).toHaveLength(0)
  expect(y.of('new')).toHaveLength(1)
  expect(y.of('load')).toHaveLength(0)
  expect(lastPrompt(y)).toContain('第一问')
  const failed = moveSteps(ctx).find((s) => s.status === 'failed')
  expect(failed?.title).toBe(CARRY_FAILED)
  expect(failed?.note).toContain('中心没有这个会话的副本')
  expect(replyBlocks(ctx.a).at(-1)?.outcome).toBe('end')
  done(ctx)
})

test('中心没有副本但原机器在线：先从原机器补拉一次再下发', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  await turn(ctx, x, '第一问')
  await synced(ctx, x, 'xbox-S1')
  await pool.query('DELETE FROM agent_session_files WHERE page_id = $1', [ctx.pageId])
  const before = reads(x).length

  await turn(ctx, y, '第二问')
  expect(reads(x).length).toBeGreaterThan(before)
  expect(y.of('load')[0]?.sessionId).toBe('xbox-S1')
  expect(lastPrompt(y)).not.toContain('第一问')
  done(ctx)
})

test('退回：别人授权给我的机器、老 connector 都不搬，新建会话 + 全文重放并说明', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  await turn(ctx, x, '第一问')
  await synced(ctx, x, 'xbox-S1')

  // bob 的机器授权给 alice：会话记录不进别人的机器
  await joinPageSpace(ctx.pageId, 'bob')
  const bob = await userIdOf('bob')
  const lent = await pairMachine(ctx.spaceId, bob, 'bobbox', WITH_SESSION, CLAUDE)
  await grantMachine(lent.id, ctx.ownerId)
  await turn(ctx, lent, '第二问')
  expect(lent.frames.some((f) => f.t.startsWith('session-'))).toBe(false)
  expect(lent.of('new')).toHaveLength(1)
  expect(lastPrompt(lent)).toContain('第一问')
  expect(moveSteps(ctx).at(-1)).toMatchObject({ status: 'failed', title: CARRY_FAILED, note: '只在你自己接入的机器之间搬会话' })

  // 老 connector（没有 session 能力）
  const old = await machine(ctx, 'oldbox', ['project'])
  await turn(ctx, old, '第三问')
  expect(old.frames.some((f) => f.t.startsWith('session-'))).toBe(false)
  expect(old.of('new')).toHaveLength(1)
  expect(moveSteps(ctx).at(-1)?.note).toContain('版本太旧')
  done(ctx)
})

test('退回：下发中途失败 → 新建会话 + 全文重放，运行条带原因', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  await turn(ctx, x, '第一问')
  await synced(ctx, x, 'xbox-S1')
  y.failWriteAt = 1
  await turn(ctx, y, '第二问')
  expect(y.of('load')).toHaveLength(0)
  expect(y.of('new')).toHaveLength(1)
  expect(lastPrompt(y)).toContain('第一问')
  expect(moveSteps(ctx).at(-1)).toMatchObject({ status: 'failed', title: CARRY_FAILED, note: '磁盘写满了' })
  // 失败的写入没有留下东西
  expect(y.sessionFiles.has('xbox-S1')).toBe(false)
  done(ctx)
})

test('重新生成换了会话：旧会话的副本删掉；清空回收站连副本目录一起删', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  await turn(ctx, x, '第一问')
  await synced(ctx, x, 'xbox-S1')
  const oldDir = join(copyPath(ctx.pageId, 'claude', 'xbox-S1', 'main.jsonl'), '..')

  const reply = replyBlocks(ctx.a).at(-1)!
  expect((await postJson(`/api/pages/${ctx.pageId}/replies/${reply.id}/regenerate`, ctx.cookie)).status).toBe(202)
  ctx.turns += 1
  await settled(ctx.sse, ctx.turns)
  await synced(ctx, x, 'xbox-S2')
  expect((await copyRows(ctx.pageId)).map((r) => r.session_id)).toEqual(['xbox-S2'])
  expect(await stat(oldDir).catch(() => null)).toBeNull()

  const pageDir = join(UPLOADS, 'agent-sessions', ctx.pageId)
  expect((await stat(pageDir)).isDirectory()).toBe(true)
  done(ctx)
  expect((await postJson(`/api/pages/${ctx.pageId}/trash`, ctx.cookie)).status).toBe(200)
  const res = await fetch(`${base}/api/pages/trash?space_id=${ctx.spaceId}`, { method: 'DELETE', headers: { cookie: ctx.cookie } })
  expect(res.status).toBe(200)
  expect(await copyRows(ctx.pageId)).toEqual([])
  expect(await stat(pageDir).catch(() => null)).toBeNull()
})

test('续跑：跑这块回复的机器不在线，换到本页选的同一工具的另一台，会话从中心下发', async () => {
  const ctx = await setup()
  const x = await machine(ctx, 'xbox')
  const y = await machine(ctx, 'ybox')
  x.hold = true
  userMessage(ctx.a.document, '第一问')
  expect(await continuePage(ctx.pageId, ctx.cookie, { agent: agentOf(x) })).toBe(202)
  await waitFor(() => x.held.length === 1)
  // 写了半句就被停掉（agent 报 cancelled）：这块回复可以续跑，过程页记着跑它的会话
  const held = x.held[0]!
  x.send({ t: 'ev', rid: held.rid, runId: held.runId, seq: 0, ev: { type: 'text', delta: '写到一半', sessionId: held.sessionId } })
  x.send({ t: 'end', rid: held.rid, runId: held.runId, seq: 1, stopReason: 'cancelled' })
  await settled(ctx.sse, 1)
  await synced(ctx, x, 'xbox-S1')
  const reply = replyBlocks(ctx.a).at(-1)!
  expect(reply.outcome).toBe('cancelled')
  x.ws.terminate()
  await offline(ctx, x)
  expect((await postJson(`/api/pages/${ctx.pageId}/agent-choice`, ctx.cookie, { agent: agentOf(y) })).status).toBe(200)

  expect((await postJson(`/api/pages/${ctx.pageId}/replies/${reply.id}/resume`, ctx.cookie)).status).toBe(202)
  await settled(ctx.sse, 2)
  expect(sessionTypes(y).filter((t) => t !== 'session-stat' && t !== 'session-read')).toEqual(['session-close', 'session-write', 'load', 'prompt'])
  expect(y.of('load')[0]?.sessionId).toBe('xbox-S1')
  // 接着原会话：只发续跑说明，不重放文档
  expect(lastPrompt(y).startsWith(RESUME_TAG)).toBe(true)
  expect(replyBlocks(ctx.a).at(-1)).toMatchObject({ id: reply.id, outcome: 'end' })
  done(ctx)
})
