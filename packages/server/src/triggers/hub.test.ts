/* ---------- 触发器（定时器）：真库 + test-kit 的完整服务；Genet 的模型是假的，任务交给本机假 agent，时钟注入 ----------
 * 设定时器（经 Genet 的工具 / 直接打 Genet 端点）→ 到点先落触发记录再派发：目标是 Genet 页 = 写定时提醒 + 叫醒 Genet；
 * 目标是任务页 = 走排队发送（忙时排着、上一次还排着就跳过、撤回算跳过），开跑后做完照常回报 Genet。
 * 可靠性：同一预定时刻只触发一次、触发前按创建人重判、停机错过只补一次、连续 3 次失败自动暂停、失败进收件箱、启动恢复。
 * 上限、闸门（只有 Genet 凭证、只看得到自己的、目标只能在自己 Genet 页名下）、时区上报。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { insertConnection } from '../ai-connections.js'
import { mintPageToken } from '../page-read.js'
import { textOf } from '../updates.js'
import { ASSISTANT_ID } from '../agents/assistant-agent.js'
import type { GenetNotify } from '../agents/genet-notify.js'
import { brief, callTool, lastResult, say, script as fakeModel, type GenetCall, type Step } from '../agents/drivers/assistant/test-model.js'
import {
  assistantModel,
  assistantSecret,
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pool,
  postJson,
  replyBlocks,
  s,
  settled,
  setupPage,
  SSECollector,
  triggerClock,
  userMessage,
  waitFor,
} from '../agents/test-kit.js'
import { TriggerHub } from './hub.js'
import { nextAt } from './schedule.js'
import type { TimerView } from './store.js'

const TZ = 'Asia/Shanghai'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function script(...steps: Step[]): GenetCall[] {
  const fake = fakeModel(...steps)
  assistantModel.script = fake.stream
  return fake.calls
}

type Home = { cookie: string; userId: string; pageId: string; otherPage: string; doc: HocuspocusProvider; sse: SSECollector; token: string }

function req(method: string, path: string, auth: { cookie?: string; token?: string }, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function home(): Promise<Home> {
  const { cookie, pageId: otherPage } = await setupPage()
  const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const pageId = ((await (await postJson('/api/me/assistant', cookie)).json()) as { pageId: string }).pageId
  expect((await req('PUT', '/api/me/time-zone', { cookie }, { timeZone: TZ })).status).toBe(200)
  const doc = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const token = mintPageToken(userId, ASSISTANT_ID, { pageId, agentId: ASSISTANT_ID, canDispatch: true })
  return { cookie, userId, pageId, otherPage, doc, sse, token }
}

function close(h: Home): void {
  h.sse.stop()
  h.doc.destroy()
}

async function send(h: Home, text: string): Promise<void> {
  userMessage(h.doc.document, text, { agent: ASSISTANT_ID })
  expect(await continuePage(h.pageId, h.cookie, { agent: ASSISTANT_ID })).toBe(202)
}

async function setTimer(h: Home, input: Record<string, unknown>): Promise<TimerView> {
  const res = await req('POST', '/api/ramet/timers', { token: h.token }, input)
  expect(res.status).toBe(200)
  return ((await res.json()) as { timer: TimerView }).timer
}

async function timers(h: Home): Promise<TimerView[]> {
  return ((await (await req('GET', '/api/me/timers', { cookie: h.cookie })).json()) as { timers: TimerView[] }).timers
}

async function patchTimer(h: Home, id: string, body: unknown): Promise<Response> {
  return req('PATCH', `/api/me/timers/${id}`, { cookie: h.cookie }, body)
}

type Ev = { id: string; status: string; reason: string; scheduled_at: Date }
async function events(timerId: string): Promise<Ev[]> {
  return (await pool.query<Ev>('SELECT id, status, reason, scheduled_at FROM trigger_events WHERE trigger_id = $1 ORDER BY scheduled_at', [timerId])).rows
}

async function tickAt(ms: number): Promise<void> {
  triggerClock.at = ms
  await s.triggers.tick()
}

/** 下一个当地 hh:mm（从真实时间算，离现在不到一天：收件箱这类按库里 now() 算窗口的地方照常） */
const nextLocal = (time: string): number => nextAt({ kind: 'daily', time }, TZ, new Date(), new Date())!.getTime()

/** 那一刻在用户时区的 'YYYY-MM-DDTHH:MM' */
function localAt(ms: number): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** 文档里的通知块（带 notice 的用户消息）；kind 给了只看那一种 */
function notices(p: HocuspocusProvider, kind?: string): Y.XmlElement[] {
  return p.document
    .getXmlFragment('prosemirror')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'user_message' && Boolean(n.getAttribute('notice')))
    .filter((n) => !kind || n.getAttribute('notice') === kind)
}

function timerMessages(p: HocuspocusProvider): Y.XmlElement[] {
  return p.document
    .getXmlFragment('prosemirror')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'user_message' && Boolean(n.getAttribute('timer')))
}

async function taskPages(pageId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM live_pages WHERE parent_id = $1 AND kind = 'doc' ORDER BY created_at", [pageId])
  return rows.map((r) => r.id)
}

/** Genet 页下直接建一个任务页，并登记成派给 agent 的（同 dispatch_task 留下的那一行） */
async function taskPage(h: Home, agent: string): Promise<string> {
  const space = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [h.pageId])).rows[0]!.space_id
  const page = (await (await postJson('/api/pages', h.cookie, { space_id: space, parent_id: h.pageId, link_in_parent: false })).json()) as { id: string }
  await pool.query('INSERT INTO assistant_tasks (page_id, home_id, user_id, agent, label, reported_at) VALUES ($1, $2, $3, $4, $5, now())', [page.id, h.pageId, h.userId, agent, agent])
  return page.id
}

type InboxItem = { type: string; key: string; timerId?: string; timerName?: string; reason?: string; paused?: boolean }
async function inbox(cookie: string): Promise<InboxItem[]> {
  return ((await (await req('GET', '/api/inbox', { cookie })).json()) as { items: InboxItem[] }).items.filter((i) => i.type === 'timer_failed')
}

const lastText = (c: GenetCall): string => brief(c.messages.at(-1)!).text

/** 用户消息的原文（含驱动加的时间行） */
function rawText(c: GenetCall): string {
  const m = c.messages.findLast((x) => x.role === 'user')!
  return typeof m.content === 'string' ? m.content : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}

/** 不碰服务里那份的另一个 TriggerHub（并发扫描 / 启动恢复用）：派发都落在桩上 */
function standaloneHub(now: () => Date): { hub: TriggerHub; posted: () => number } {
  let posted = 0
  const notify = { post: async () => (posted++, null) } as unknown as GenetNotify
  const hub = new TriggerHub({
    pool,
    now,
    queue: { enqueue: async () => Promise.reject(new Error('不该排队')), discardTriggered: async () => undefined },
    host: { writable: async () => true, usable: async () => null, running: () => false },
    names: { localAgents: () => [], onlineAgents: () => undefined },
    tasks: { arm: async () => undefined, disarm: async () => undefined, notify },
    poke: () => undefined,
  })
  return { hub, posted: () => posted }
}

describe('到点叫 Genet', () => {
  it('跟 Genet 说「两分钟后提醒我喝水」：建出一次性定时器、回复里有时间表与下次触发；到点出现定时提醒、Genet 自动回一轮；之后不再触发', async () => {
    const h = await home()
    const t0 = Math.floor(Date.now() / MIN) * MIN + 10_000
    triggerClock.at = t0
    const requests = script(
      callTool('toolu_t', 'set_timer', { name: '喝水', instruction: '提醒我喝水', schedule: { kind: 'once', at: localAt(t0 + 2 * MIN) } }),
      say((c) => `好的。${lastResult(c)}`),
      say('该喝水啦'),
    )
    await send(h, '两分钟后提醒我喝水')
    await settled(h.sse, 1)
    // 每一轮的输入最前面是当前时间与用户时区
    expect(rawText(requests[0]!)).toMatch(/^\[现在：\d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}（Asia\/Shanghai）\]\n\n/)
    await waitFor(() => replyBlocks(h.doc).at(-1)?.text.includes('已设定时「喝水」') === true)
    expect(replyBlocks(h.doc).at(-1)!.text).toMatch(/（一次），下次 \d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}（Asia\/Shanghai）/)
    const [timer] = await timers(h)
    expect(timer).toMatchObject({ name: '喝水', instruction: '提醒我喝水', enabled: true, target: { kind: 'genet' }, timeZone: TZ, last: null })
    expect(timer!.nextAt).toBe(new Date(t0 - 10_000 + 2 * MIN).toISOString())

    await tickAt(t0 + MIN)
    expect(await events(timer!.id)).toEqual([])
    await tickAt(t0 + 2 * MIN)
    await waitFor(() => notices(h.doc).length === 1)
    const n = notices(h.doc)[0]!
    expect(n.getAttribute('notice')).toBe('timer')
    expect(n.getAttribute('timer')).toBe(timer!.id)
    expect(n.getAttribute('agent')).toBe(ASSISTANT_ID)
    expect(n.getAttribute('author')).toBe('')
    expect(textOf(n.get(0) as Y.XmlElement)).toMatch(/^定时「喝水」· \d+ 月 \d+ 日 \d{2}:\d{2}（一次）$/)
    expect(textOf(n)).toContain('提醒我喝水')
    await settled(h.sse, 2)
    expect(lastText(requests[2]!).startsWith('[Ramet 定时提醒：不是用户此刻发的，是用户设的定时到点了]')).toBe(true)
    await waitFor(() => replyBlocks(h.doc).at(-1)?.text === '该喝水啦')
    expect((await events(timer!.id)).map((e) => e.status)).toEqual(['delivered'])

    await tickAt(t0 + 2 * DAY)
    expect(await events(timer!.id)).toHaveLength(1)
    expect((await timers(h))[0]).toMatchObject({ enabled: false, nextAt: null, last: { status: 'delivered' } })
    close(h)
  })

  it('每天 09:00：按用户时区算下次；触发后下次是第二天 09:00；暂停后不触发，恢复后从下一个 09:00 开始', async () => {
    const h = await home()
    script(say('收到'))
    const nine = nextLocal('09:00')
    triggerClock.at = nine - 30 * MIN
    const timer = await setTimer(h, { name: '早报', instruction: '整理今天的待办', schedule: { kind: 'daily', time: '09:00' } })
    expect(timer).toMatchObject({ scheduleText: '每天 09:00', nextAt: new Date(nine).toISOString() })
    expect(timer.nextText).toMatch(/ 09:00$/)

    await tickAt(nine + 1000)
    await settled(h.sse, 1)
    const [after] = await timers(h)
    expect(after).toMatchObject({ nextAt: new Date(nine + DAY).toISOString(), last: { status: 'delivered', reason: '', at: new Date(nine).toISOString() } })

    const paused = await patchTimer(h, timer.id, { enabled: false })
    expect(((await paused.json()) as { timer: TimerView }).timer).toMatchObject({ enabled: false, nextAt: null })
    await tickAt(nine + DAY + 1000)
    expect(await events(timer.id)).toHaveLength(1)

    // 恢复时当天的 09:00 已经过了：从第二天的开始
    triggerClock.at = nine + DAY + 2 * HOUR
    const resumed = await patchTimer(h, timer.id, { enabled: true })
    expect(((await resumed.json()) as { timer: TimerView }).timer).toMatchObject({ enabled: true, nextAt: new Date(nine + 2 * DAY).toISOString() })
    close(h)
  })

  it('停机跨过两次预定时刻：恢复后只补一次，通知里注明本应几点；之后从现在往后排', async () => {
    const h = await home()
    const requests = script(say('早'))
    const nine = nextLocal('09:00')
    triggerClock.at = nine - 30 * MIN
    const timer = await setTimer(h, { name: '早报', instruction: '整理待办', schedule: { kind: 'daily', time: '09:00' } })
    await tickAt(nine + 2 * DAY + HOUR)
    expect((await events(timer.id)).map((e) => e.scheduled_at.toISOString())).toEqual([new Date(nine).toISOString()])
    await waitFor(() => notices(h.doc).length === 1)
    expect(textOf(notices(h.doc)[0]!.get(0) as Y.XmlElement)).toMatch(/^定时「早报」· 每天 09:00 · 本应 \d+ 月 \d+ 日 09:00，延后到 \d+ 月 \d+ 日 10:00$/)
    expect((await timers(h))[0]!.nextAt).toBe(new Date(nine + 3 * DAY).toISOString())
    await settled(h.sse, 1)
    expect(lastText(requests[0]!)).toContain('本应')
    close(h)
  })

  it('同一预定时刻并发扫描 / 重复扫描只触发一次', async () => {
    const h = await home()
    script(say('收到'))
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '整点', instruction: '看一眼', schedule: { kind: 'every', minutes: 60 } })
    const other = standaloneHub(() => new Date(triggerClock.at!))
    triggerClock.at = t0 + HOUR + 1000
    await Promise.all([s.triggers.tick(), s.triggers.tick(), other.hub.tick(), other.hub.tick()])
    await other.hub.dispose()
    expect(await events(timer.id)).toHaveLength(1)
    const delivered = (): number => notices(h.doc).length + other.posted()
    await waitFor(() => delivered() >= 1)
    // 扫描崩在提交之后、同一个预定时刻又被扫到：记录还是那一条，不再派发
    await pool.query('UPDATE agent_triggers SET next_at = $2, enabled = true WHERE id = $1', [timer.id, new Date(t0 + HOUR)])
    await s.triggers.tick()
    expect(await events(timer.id)).toHaveLength(1)
    expect((await timers(h))[0]!.nextAt).toBe(new Date(t0 + 2 * HOUR).toISOString())
    await new Promise((r) => setTimeout(r, 500))
    expect(delivered()).toBe(1)
    close(h)
  })
})

describe('到点叫任务页', () => {
  it('任务页正忙：指令排在后面、上一次还排着就跳过、撤回算跳过；轮到时以用户身份写一条带 timer 的指令开跑，做完回报 Genet', async () => {
    const h = await home()
    script(callTool('toolu_d', 'dispatch_task', { agent: 'fake', title: '巡检', task: '断线续' }), say('派好了'), say('收到'))
    await send(h, '派个活')
    await settled(h.sse, 1)
    const [task] = await taskPages(h.pageId)
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '巡检', instruction: '再巡检一遍', schedule: { kind: 'every', minutes: 60 }, target: `page:${task}` })
    expect(timer.target).toEqual({ kind: 'page', pageId: task, title: '巡检' })

    // 任务页还在跑（断线续睡 8 秒）：排进队里；上一次还排着，这次跳过
    await tickAt(t0 + HOUR)
    expect((await events(timer.id)).map((e) => e.status)).toEqual(['queued'])
    await tickAt(t0 + 2 * HOUR)
    expect((await events(timer.id)).map((e) => [e.status, e.reason])).toEqual([
      ['queued', ''],
      ['skipped', '上一次的指令还排着没发出去'],
    ])
    // 撤回：那一次算跳过；下一次照常排上
    const item = (await pool.query<{ id: string }>('SELECT id FROM send_queue WHERE page_id = $1', [task])).rows[0]!
    expect((await req('DELETE', `/api/pages/${task}/queue/${item.id}`, { cookie: h.cookie })).status).toBe(200)
    expect((await events(timer.id))[0]).toMatchObject({ status: 'skipped', reason: '排队的指令被撤回了' })
    await tickAt(t0 + 3 * HOUR)
    expect((await events(timer.id)).at(-1)?.status).toBe('queued')

    // 那一轮结束后轮到它：写进任务页、那页的 agent 开跑；做完 Genet 页出现第二条任务通知
    const taskDoc = await connectDoc(task!, h.cookie)
    await waitFor(async () => (await events(timer.id)).at(-1)?.status === 'delivered', 30_000)
    await waitFor(() => timerMessages(taskDoc).length === 1)
    const m = timerMessages(taskDoc)[0]!
    expect(m.getAttribute('timer')).toBe(timer.id)
    expect(m.getAttribute('author')).toBe(h.userId)
    expect(m.getAttribute('notice')).toBeFalsy()
    expect(textOf(m)).toBe('再巡检一遍')
    await waitFor(() => notices(h.doc, 'done').length === 2, 30_000)
    expect(textOf(notices(h.doc, 'done')[1]!)).toContain('已完成 · Fake')
    expect((await timers(h))[0]!.last).toMatchObject({ status: 'delivered' })
    taskDoc.destroy()
    close(h)
  }, 90_000)

  it('上一次的指令卡在空闲任务页的队里（队列暂停 / 重启丢了暂停态）：这一次顶替它当场派发，不被它一直挡成跳过', async () => {
    const h = await home()
    const task = await taskPage(h, 'fake')
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '巡检', instruction: '新的一遍', schedule: { kind: 'every', minutes: 60 }, target: `page:${task}` })
    // 造一条卡住的：记录 queued、队里一条指向它的消息，页面空着、没有下一次结束来派发它
    const stuck = 'stuck-event'
    await pool.query(
      "INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, status) VALUES ($1, $2, $3, $4, $5, 'queued')",
      [stuck, timer.id, h.userId, `timer:${timer.id}:old`, new Date(t0 - HOUR)],
    )
    await pool.query("INSERT INTO send_queue (id, page_id, user_id, agent, kind, text, trigger_event) VALUES ('q-stuck', $1, $2, 'fake', 'message', '旧的一遍', $3)", [
      task,
      h.userId,
      stuck,
    ])
    const taskDoc = await connectDoc(task, h.cookie)
    await tickAt(t0 + HOUR + 1000)
    expect((await events(timer.id)).find((e) => e.id === stuck)).toMatchObject({ status: 'skipped', reason: '一直没发出去，被下一次顶替了' })
    await waitFor(async () => (await events(timer.id)).at(-1)?.status === 'delivered', 30_000)
    expect(await pool.query("SELECT 1 FROM send_queue WHERE id = 'q-stuck'")).toMatchObject({ rowCount: 0 })
    await waitFor(() => timerMessages(taskDoc).length === 1)
    expect(textOf(timerMessages(taskDoc)[0]!)).toBe('新的一遍')
    taskDoc.destroy()
    close(h)
  }, 60_000)

  it('目标页进了回收站 / 目标 agent 不可用：不跑，记录失败带原因；Genet 照样列得出、删得掉', async () => {
    const h = await home()
    const gone = await taskPage(h, 'fake')
    const other = await taskPage(h, 'fake')
    const t0 = Date.now()
    triggerClock.at = t0
    const a = await setTimer(h, { name: 'A', instruction: 'a', schedule: { kind: 'every', minutes: 60 }, target: `page:${gone}` })
    const b = await setTimer(h, { name: 'B', instruction: 'b', schedule: { kind: 'every', minutes: 60 }, target: `page:${other}` })
    expect((await postJson(`/api/pages/${gone}/trash`, h.cookie)).status).toBe(200)
    await pool.query(`UPDATE agent_triggers SET agent = 'nope', actions = jsonb_set(actions, '{0,agent}', '"nope"') WHERE id = $1`, [b.id])
    await tickAt(t0 + HOUR + 1000)
    expect(await events(a.id)).toMatchObject([{ status: 'failed', reason: expect.stringContaining('目标页已经不在了') }])
    expect(await events(b.id)).toMatchObject([{ status: 'failed', reason: expect.stringContaining('nope 现在用不了') }])
    expect(await pool.query('SELECT 1 FROM send_queue')).toMatchObject({ rowCount: 0 })
    // 暂停后再恢复：目标页已经不在了，当场 400 带原因（不等下一次到点再失败）
    expect((await patchTimer(h, a.id, { enabled: false })).status).toBe(200)
    const resumed = await patchTimer(h, a.id, { enabled: true })
    expect(resumed.status).toBe(400)
    expect(((await resumed.json()) as { error: string }).error).toContain('目标页已经不在了')
    expect((await timers(h)).find((t) => t.id === a.id)).toMatchObject({ enabled: false, nextAt: null })
    const listed = (await (await req('GET', '/api/ramet/timers', { token: h.token })).json()) as { timers: TimerView[] }
    expect(listed.timers.map((t) => t.name).sort()).toEqual(['A', 'B'])
    expect((await req('DELETE', `/api/ramet/timers/${a.id}`, { token: h.token })).status).toBe(200)
    expect((await timers(h)).map((t) => t.name)).toEqual(['B'])
    close(h)
  })
})

describe('到点叫任务页：回报与删除', () => {
  it('任务页上没有派活记录（只记着来源）：开跑前登记回报，抬头里写 agent 的显示名', async () => {
    const h = await home()
    script(say('收到'))
    const space = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [h.pageId])).rows[0]!.space_id
    const task = ((await (await postJson('/api/pages', h.cookie, { space_id: space, parent_id: h.pageId, link_in_parent: false })).json()) as { id: string }).id
    await pool.query(`UPDATE pages SET agent_session = jsonb_build_object('choice', 'fake') WHERE id = $1`, [task])
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '看看', instruction: '看一眼', schedule: { kind: 'every', minutes: 60 }, target: `page:${task}` })
    await tickAt(t0 + HOUR + 1000)
    await waitFor(() => notices(h.doc, 'done').length === 1, 30_000)
    expect(textOf(notices(h.doc, 'done')[0]!)).toContain('已完成 · Fake')
    expect((await pool.query<{ label: string }>('SELECT label FROM assistant_tasks WHERE page_id = $1', [task])).rows[0]?.label).toBe('Fake')
    expect((await events(timer.id)).map((e) => e.status)).toEqual(['delivered'])
    close(h)
  }, 60_000)

  it('删掉定时器：它排着还没发出去的指令一起拿掉，任务页的排队区跟着刷新；别人排的不动', async () => {
    const h = await home()
    const task = await taskPage(h, 'fake')
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '巡检', instruction: '再巡检一遍', schedule: { kind: 'every', minutes: 60 }, target: `page:${task}` })
    // 任务页正忙时到点的那一次：记录 queued、排队项挂着它（直接造出来，不必真等一轮跑完）
    await pool.query("INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, created_at, status) VALUES ('ev-q', $1, $2, 'timer:q', $3, $3, 'queued')", [
      timer.id, h.userId, new Date(t0),
    ])
    await pool.query(
      "INSERT INTO send_queue (id, page_id, user_id, agent, kind, text, trigger_event) VALUES ('q-timer', $1, $2, 'fake', 'message', '再巡检一遍', 'ev-q'), ('q-mine', $1, $2, 'fake', 'message', '我自己排的', NULL)",
      [task, h.userId],
    )
    const sse = new SSECollector()
    await sse.start(task, h.cookie)
    expect((await req('DELETE', `/api/me/timers/${timer.id}`, { cookie: h.cookie })).status).toBe(200)
    expect((await pool.query<{ id: string }>('SELECT id FROM send_queue')).rows.map((r) => r.id)).toEqual(['q-mine'])
    await waitFor(() => sse.events.some((e) => e.type === 'queue' && e.items.length === 1 && e.items[0]!.id === 'q-mine'))
    sse.stop()
    close(h)
  })
})

describe('失败、上限与闸门', () => {
  it('创建人失去写权限：不跑、记录失败带原因、进收件箱；连续 3 次失败自动暂停；条目只给主人、可「知道了」', async () => {
    const h = await home()
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '周报', instruction: '写周报', schedule: { kind: 'every', minutes: 60 } })
    await pool.query("UPDATE space_members SET role = 'viewer' WHERE user_id = $1 AND space_id = (SELECT space_id FROM pages WHERE id = $2)", [h.userId, h.pageId])
    for (let i = 1; i <= 3; i++) await tickAt(t0 + i * HOUR + 1000)
    const evs = await events(timer.id)
    expect(evs.map((e) => e.status)).toEqual(['failed', 'failed', 'failed'])
    expect(evs[0]!.reason).toContain('不能编辑')
    const [now] = await timers(h)
    expect(now).toMatchObject({ enabled: false, nextAt: null, last: { status: 'failed' } })
    expect(now!.pausedReason).toContain('连续 3 次')
    await tickAt(t0 + 5 * HOUR)
    expect(await events(timer.id)).toHaveLength(3)
    expect(notices(h.doc)).toEqual([])

    const items = await inbox(h.cookie)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ timerId: timer.id, timerName: '周报', paused: true, reason: expect.stringContaining('不能编辑') })
    // 「已暂停」只标在让它暂停的第 3 次上
    expect(items.map((i) => i.paused)).toEqual([true, false, false])
    await insertUser('bob')
    const bob = await login('bob')
    expect(await inbox(bob)).toEqual([])
    expect((await postJson('/api/inbox/dismiss', bob, { key: items[0]!.key })).status).toBe(404)
    expect((await postJson('/api/inbox/dismiss', h.cookie, { key: 'timer_failed:nope' })).status).toBe(404)
    expect((await postJson('/api/inbox/dismiss', h.cookie, { key: items[0]!.key })).status).toBe(200)
    expect(await inbox(h.cookie)).toHaveLength(2)

    // 暂停着只改时间表：仍是自动暂停，原因留着（不能看起来像手动暂停）
    const space = "(SELECT space_id FROM pages WHERE id = $2)"
    await pool.query(`UPDATE space_members SET role = 'owner' WHERE user_id = $1 AND space_id = ${space}`, [h.userId, h.pageId])
    expect((await req('PATCH', `/api/ramet/timers/${timer.id}`, { token: h.token }, { schedule: { kind: 'daily', time: '09:00' } })).status).toBe(200)
    expect((await timers(h))[0]).toMatchObject({ enabled: false, nextAt: null, scheduleText: '每天 09:00', pausedReason: expect.stringContaining('连续 3 次') })
    // 不再是那个空间的成员：收件箱不列这一类（列举类只含自己是成员的空间）
    await pool.query(`DELETE FROM space_members WHERE user_id = $1 AND space_id = ${space}`, [h.userId, h.pageId])
    expect(await inbox(h.cookie)).toEqual([])
    close(h)
  })

  it('上限：间隔不到 60 分钟、第 21 个启用中的被拒；24 小时内第 51 次触发跳过并记原因（跳过不进收件箱）', async () => {
    const h = await home()
    const t0 = Date.now()
    triggerClock.at = t0
    const short = await req('POST', '/api/ramet/timers', { token: h.token }, { name: 'x', instruction: 'x', schedule: { kind: 'every', minutes: 30 } })
    expect(short.status).toBe(400)
    expect(((await short.json()) as { error: string }).error).toContain('最短 60')
    const made: TimerView[] = []
    for (let i = 0; i < 20; i++) made.push(await setTimer(h, { name: `t${i}`, instruction: 'x', schedule: { kind: 'every', minutes: 60 } }))
    const over = await req('POST', '/api/ramet/timers', { token: h.token }, { name: 'x', instruction: 'x', schedule: { kind: 'daily', time: '09:00' } })
    expect(over.status).toBe(400)
    expect(((await over.json()) as { error: string }).error).toContain('最多 20 个')
    // 暂停一个就能再建；再恢复它又超了
    expect((await patchTimer(h, made[0]!.id, { enabled: false })).status).toBe(200)
    await setTimer(h, { name: 'extra', instruction: 'x', schedule: { kind: 'every', minutes: 60 } })
    expect((await patchTimer(h, made[0]!.id, { enabled: true })).status).toBe(400)

    await pool.query(
      `INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, created_at, status)
       SELECT 'old-' || n, $1, $2, 'old:' || n, $3, $3, 'delivered' FROM generate_series(1, 50) n`,
      [made[1]!.id, h.userId, new Date(t0 - HOUR)],
    )
    await tickAt(t0 + HOUR + 1000)
    const fresh = (await pool.query<{ status: string; reason: string }>("SELECT status, reason FROM trigger_events WHERE id NOT LIKE 'old-%'")).rows
    expect(fresh).toHaveLength(20)
    expect(fresh.every((e) => e.status === 'skipped' && e.reason.includes('24 小时内已经触发了 50 次'))).toBe(true)
    expect(notices(h.doc)).toEqual([])
    expect(await inbox(h.cookie)).toEqual([])
    close(h)
  })

  it('只有 Genet 凭证能管定时器（403）；只看得到 / 改得了自己的（404）；目标不在自己 Genet 页名下 400；工具表；时区上报', async () => {
    const h = await home()
    triggerClock.at = Date.now()
    const mine = await setTimer(h, { name: '我的', instruction: 'x', schedule: { kind: 'daily', time: '09:00' } })
    const fakeToken = mintPageToken(h.userId, 'fake', { pageId: h.pageId, agentId: 'fake', canDispatch: true })
    const elsewhere = mintPageToken(h.userId, ASSISTANT_ID, { pageId: h.otherPage, agentId: ASSISTANT_ID, canDispatch: true })
    for (const token of [fakeToken, elsewhere]) {
      expect((await req('GET', '/api/ramet/timers', { token })).status).toBe(403)
      expect((await req('POST', '/api/ramet/timers', { token }, { name: 'x', instruction: 'x', schedule: { kind: 'daily', time: '09:00' } })).status).toBe(403)
      expect((await req('PATCH', `/api/ramet/timers/${mine.id}`, { token }, { enabled: false })).status).toBe(403)
      expect((await req('DELETE', `/api/ramet/timers/${mine.id}`, { token })).status).toBe(403)
    }
    expect((await req('GET', '/api/ramet/timers', {})).status).toBe(401)
    for (const target of [`page:${h.otherPage}`, 'page:nope']) {
      const res = await req('POST', '/api/ramet/timers', { token: h.token }, { name: 'x', instruction: 'x', schedule: { kind: 'daily', time: '09:00' }, target })
      expect(res.status).toBe(400)
    }

    const bobId = await insertUser('bob')
    const bob = await login('bob')
    const bobHome = ((await (await postJson('/api/me/assistant', bob)).json()) as { pageId: string }).pageId
    const bobToken = mintPageToken(bobId, ASSISTANT_ID, { pageId: bobHome, agentId: ASSISTANT_ID, canDispatch: true })
    expect(((await (await req('GET', '/api/ramet/timers', { token: bobToken })).json()) as { timers: unknown[] }).timers).toEqual([])
    expect((await req('PATCH', `/api/ramet/timers/${mine.id}`, { token: bobToken }, { enabled: false })).status).toBe(404)
    expect((await req('DELETE', `/api/ramet/timers/${mine.id}`, { token: bobToken })).status).toBe(404)
    expect((await req('PATCH', `/api/me/timers/${mine.id}`, { cookie: bob }, { enabled: false })).status).toBe(404)
    expect((await req('DELETE', `/api/me/timers/${mine.id}`, { cookie: bob })).status).toBe(404)
    expect(((await (await req('GET', '/api/me/timers', { cookie: bob })).json()) as { timers: unknown[] }).timers).toEqual([])
    // AI 页只能开关
    expect((await patchTimer(h, mine.id, { name: '改名' })).status).toBe(400)

    const listed = (await (await req('GET', '/api/ramet/tools', { token: h.token })).json()) as { tools: string[] }
    expect(listed.tools).toEqual(expect.arrayContaining(['set_timer', 'list_timers', 'update_timer', 'delete_timer']))
    const plain = (await (await req('GET', '/api/ramet/tools', { token: fakeToken })).json()) as { tools: string[] }
    expect(plain.tools).not.toContain('set_timer')

    for (const timeZone of ['Mars/Olympus', '+08:00', 8]) expect((await req('PUT', '/api/me/time-zone', { cookie: h.cookie }, { timeZone })).status).toBe(400)
    expect((await req('PUT', '/api/me/time-zone', { cookie: h.cookie }, { timeZone: 'America/New_York' })).status).toBe(200)
    expect((await pool.query<{ tz: string }>('SELECT time_zone AS tz FROM users WHERE id = $1', [h.userId])).rows[0]!.tz).toBe('America/New_York')
    // 已有的定时器不跟着挪；之后新建的按新时区
    expect((await timers(h))[0]!.timeZone).toBe(TZ)
    expect((await setTimer(h, { name: '新的', instruction: 'x', schedule: { kind: 'daily', time: '09:00' } })).timeZone).toBe('America/New_York')
    close(h)
  })

  it('启动恢复：1 小时内落下没派发的补发，更早的算错过；进了排队却已经不在队里的收成失败', async () => {
    const h = await home()
    const t0 = Date.now()
    triggerClock.at = t0
    const timer = await setTimer(h, { name: '恢复', instruction: 'x', schedule: { kind: 'every', minutes: 60 } })
    const insert = (id: string, status: string, created: number): Promise<unknown> =>
      pool.query('INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, created_at, status) VALUES ($1, $2, $3, $1, $4, $4, $5)', [
        id, timer.id, h.userId, new Date(created), status,
      ])
    await insert('recent', 'pending', t0 - 10 * MIN)
    await insert('stale', 'pending', t0 - 2 * HOUR)
    await insert('lost', 'queued', t0 - 5 * MIN)
    const other = standaloneHub(() => new Date(t0))
    other.hub.start()
    const status = async (): Promise<Record<string, [string, string]>> =>
      Object.fromEntries(
        (await pool.query<{ id: string; status: string; reason: string }>('SELECT id, status, reason FROM trigger_events')).rows.map((r) => [r.id, [r.status, r.reason]]),
      )
    await waitFor(async () => Object.values(await status()).every(([st]) => st !== 'pending' && st !== 'queued'))
    await other.hub.dispose()
    expect(await status()).toEqual({
      recent: ['delivered', ''],
      stale: ['failed', '服务重启，错过了这次'],
      lost: ['failed', expect.stringContaining('排队的指令丢了')],
    })
    expect(other.posted()).toBe(1)
    close(h)
  })
})
