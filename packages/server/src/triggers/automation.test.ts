/* ---------- 规则（自动化）：动作串、迁移、合集动作、防循环、失败与上限 ----------
 * 真库 + test-kit 起的完整服务；Genet 用假模型，任务交给本机假 agent；时钟用 triggerClock + s.triggers.tick()；
 * 别的来源的事件用 s.triggers.emit 造（本期还没有真的事件源）。向外 webhook 打本机起的接收端（*.hook.test 解析到本机，见 test-kit 的 webhookFetch）。 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { newShortId, parseCollection } from '@ramet/shared/collection-model'
import { insertConnection } from '../ai-connections.js'
import { appendDocUpdate, loadDocFromDb } from '../collab.js'
import { textOf } from '../updates.js'
import { ASSISTANT_ID } from '../agents/assistant-agent.js'
import { say, script as fakeModel, type Step } from '../agents/drivers/assistant/test-model.js'
import {
  assistantModel,
  assistantSecret,
  base,
  connectDoc,
  insertUser,
  login,
  pool,
  postJson,
  s,
  setupPage,
  triggerClock,
  waitFor,
} from '../agents/test-kit.js'
import type { ActionResult, AutomationView } from './rules.js'
import { nextAt } from './schedule.js'
import { TRIGGERS_DDL } from './schema.js'

const TZ = 'Asia/Shanghai'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function script(...steps: Step[]): void {
  assistantModel.script = fakeModel(...steps).stream
}

type Home = { cookie: string; userId: string; pageId: string; otherPage: string; space: string; doc: HocuspocusProvider }

function req(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function home(): Promise<Home> {
  const { cookie, pageId: otherPage } = await setupPage()
  const userId = (await pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'alice'")).rows[0]!.id
  await insertConnection(pool, userId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const pageId = ((await (await postJson('/api/me/assistant', cookie)).json()) as { pageId: string }).pageId
  expect((await req('PUT', '/api/me/time-zone', cookie, { timeZone: TZ })).status).toBe(200)
  const space = (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id
  return { cookie, userId, pageId, otherPage, space, doc: await connectDoc(pageId, cookie) }
}

async function createRule(h: Home, body: Record<string, unknown>): Promise<AutomationView> {
  const res = await req('POST', '/api/me/automations', h.cookie, body)
  const json = (await res.json()) as { automation: AutomationView; error?: string }
  expect(res.status, json.error).toBe(201)
  return json.automation
}

/** 自己建的规则（内置的「评论找我」「正文 @我」每人都有，见 triggers/sources.test.ts） */
async function rules(h: Home): Promise<AutomationView[]> {
  return ((await (await req('GET', '/api/me/automations', h.cookie)).json()) as { automations: AutomationView[] }).automations.filter((r) => !r.builtin)
}

/** 别的来源的规则：本期还没有建它们的入口，直接落库 */
async function eventRule(h: Home, actions: unknown[], name = '评论找我'): Promise<string> {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO agent_triggers (id, space_id, owner_id, source, name, instruction, spec, time_zone, agent, actions)
     VALUES ($1, $2, $3, 'comment', $4, '', '{}', $5, '', $6::jsonb)`,
    [id, h.space, h.userId, name, TZ, JSON.stringify(actions)],
  )
  return id
}

type Ev = { id: string; status: string; reason: string; results: ActionResult[]; depth: number }
async function events(ruleId: string): Promise<Ev[]> {
  return (await pool.query<Ev>('SELECT id, status, reason, results, depth FROM trigger_events WHERE trigger_id = $1 ORDER BY created_at, id', [ruleId])).rows
}

async function tickAt(ms: number): Promise<void> {
  triggerClock.at = ms
  await s.triggers.tick()
}

const nextLocal = (time: string): number => nextAt({ kind: 'daily', time }, TZ, new Date(), new Date())!.getTime()

function notices(p: HocuspocusProvider, kind?: string): Y.XmlElement[] {
  return p.document
    .getXmlFragment('prosemirror')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'user_message' && Boolean(n.getAttribute('notice')))
    .filter((n) => !kind || n.getAttribute('notice') === kind)
}

type Item = { type: string; key: string; text?: string; ruleName?: string; reason?: string; source?: string; pageId?: string | null }
async function inbox(cookie: string, type: string): Promise<Item[]> {
  return ((await (await req('GET', '/api/inbox', cookie)).json()) as { items: Item[] }).items.filter((i) => i.type === type)
}

/** 本机的 webhook 接收端：记下每次的请求体，回 status */
async function receiver(status = 200): Promise<{ url: string; bodies: string[]; close(): void }> {
  const bodies: string[] = []
  const server: Server = createServer((rq, rs) => {
    let raw = ''
    rq.on('data', (c: Buffer) => (raw += c.toString()))
    rq.on('end', () => {
      bodies.push(raw)
      rs.statusCode = status
      rs.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { url: `http://in.hook.test:${port}/hook`, bodies, close: () => server.close() }
}

/** 一个合集（缺省的「状态」属性 + 加一个「数量」数字属性）和它的一行 */
async function collection(h: Home): Promise<{ id: string; row: string; status: string; count: string; options: Record<string, string> }> {
  const created = (await (await postJson('/api/collections', h.cookie, { space_id: h.space, title: '反馈' })).json()) as { id: string }
  const count = newShortId()
  const docName = `page:${created.id}`
  const doc = await loadDocFromDb(pool, docName)
  const before = Y.encodeStateVector(doc)
  doc.transact(() => {
    const prop = new Y.Map<unknown>()
    ;(doc.getMap<unknown>('collection').get('props') as Y.Map<unknown>).set(count, prop)
    prop.set('name', '数量')
    prop.set('type', 'number')
    prop.set('pos', 5)
  })
  await appendDocUpdate(pool, docName, Buffer.from(Y.encodeStateAsUpdate(doc, before)))
  const schema = parseCollection((await loadDocFromDb(pool, docName)).getMap('collection').toJSON())
  const status = schema.props.find((p) => p.name === '状态')!
  const row = (await (await postJson(`/api/collections/${created.id}/rows`, h.cookie, { title: '第一行' })).json()) as { id: string }
  return { id: created.id, row: row.id, status: status.id, count, options: Object.fromEntries(status.options.map((o) => [o.name, o.id])) }
}

async function replica(rowId: string): Promise<Record<string, unknown>> {
  return (await pool.query<{ props: Record<string, unknown> }>('SELECT props FROM collection_rows WHERE page_id = $1', [rowId])).rows[0]?.props ?? {}
}

describe('规则模型与迁移', () => {
  it('老定时器（只有目标页 / agent / 指令，actions 还是空的）迁成一个动作：重复执行 DDL 不再改；照常触发；「自动」里看得到、能改动作', async () => {
    const h = await home()
    script(say('收到'))
    const task = ((await (await postJson('/api/pages', h.cookie, { space_id: h.space, parent_id: h.pageId, link_in_parent: false })).json()) as { id: string }).id
    await pool.query('INSERT INTO assistant_tasks (page_id, home_id, user_id, agent, label, reported_at) VALUES ($1, $2, $3, $4, $4, now())', [task, h.pageId, h.userId, 'fake'])
    const t0 = Date.now()
    triggerClock.at = t0
    const legacy = (id: string, page: string, agent: string, instruction: string): Promise<unknown> =>
      pool.query(
        `INSERT INTO agent_triggers (id, space_id, owner_id, source, name, instruction, spec, time_zone, target_page, agent, next_at)
         VALUES ($1, $2, $3, 'timer', $1, $4, '{"kind":"every","minutes":60}', $5, $6, $7, $8)`,
        [id, h.space, h.userId, instruction, TZ, page, agent, new Date(t0 + HOUR)],
      )
    await legacy('old-genet', h.pageId, ASSISTANT_ID, '看看待办')
    await legacy('old-task', task, 'fake', '再巡检一遍')
    await pool.query(TRIGGERS_DDL)
    await pool.query(TRIGGERS_DDL)
    const migrated = Object.fromEntries((await pool.query<{ id: string; actions: unknown }>('SELECT id, actions FROM agent_triggers')).rows.map((r) => [r.id, r.actions]))
    expect(migrated).toEqual({
      'old-genet': [{ type: 'genet', instruction: '看看待办' }],
      'old-task': [{ type: 'agent', page: task, agent: 'fake', instruction: '再巡检一遍' }],
    })
    const constraints = (await pool.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conname LIKE 'agent_triggers_source%'")).rows.map((r) => r.conname)
    expect(constraints).toEqual(['agent_triggers_source_known'])

    await tickAt(t0 + HOUR + 1000)
    await waitFor(() => notices(h.doc, 'timer').length === 1)
    expect(textOf(notices(h.doc, 'timer')[0]!)).toContain('看看待办')
    await waitFor(async () => (await events('old-task')).at(-1)?.status === 'delivered', 30_000)
    expect((await events('old-genet')).map((e) => e.status)).toEqual(['delivered'])

    const listed = await rules(h)
    expect(listed.map((r) => [r.id, r.source, r.triggerText, r.actionsText]).sort()).toEqual([
      ['old-genet', 'timer', '每 1 小时', ['叫 Genet：看看待办']],
      ['old-task', 'timer', '每 1 小时', [`叫 Fake 在《无标题》：再巡检一遍`]],
    ])
    expect(listed.find((r) => r.id === 'old-genet')!.last).toMatchObject({ status: 'delivered', results: [{ type: 'genet', status: 'done' }] })
    // 在 AI 页上改它的动作：老列跟着同步（Genet 的列表按它限定范围）
    const res = await req('PATCH', '/api/me/automations/old-genet', h.cookie, { actions: [{ type: 'notify', text: '到点了' }] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { automation: AutomationView }).automation.actions).toEqual([{ type: 'notify', to: 'owner', text: '到点了' }])
    expect((await pool.query("SELECT agent, target_page FROM agent_triggers WHERE id = 'old-genet'")).rows[0]).toEqual({ agent: '', target_page: null })
    h.doc.destroy()
  }, 60_000)
})

describe('动作串', () => {
  it('每天 09:00 → 发通知 + 向外 webhook + 叫 Genet：按序执行、结果逐个可见；webhook 指向内网地址时那一步失败、后面不跑、进收件箱', async () => {
    const h = await home()
    script(say('收到'))
    const hook = await receiver()
    const nine = nextLocal('09:00')
    triggerClock.at = nine - 30 * MIN
    const rule = await createRule(h, {
      name: '早报',
      source: 'timer',
      config: { kind: 'daily', time: '09:00' },
      actions: [
        { type: 'notify', text: '{{rule}}：{{now}} 到点了' },
        { type: 'webhook', url: hook.url },
        { type: 'genet', instruction: '整理今天的待办' },
      ],
    })
    expect(rule).toMatchObject({ source: 'timer', triggerText: '每天 09:00', enabled: true, nextAt: new Date(nine).toISOString(), last: null })
    expect(rule.actionsText).toEqual(['通知我：{{rule}}：{{now}} 到点了', `POST ${hook.url}`, '叫 Genet：整理今天的待办'])

    await tickAt(nine + 1000)
    await waitFor(async () => (await events(rule.id))[0]?.status === 'delivered')
    expect((await events(rule.id))[0]!.results).toEqual([
      { type: 'notify', status: 'done', reason: '通知了 1 人' },
      { type: 'webhook', status: 'done', reason: 'HTTP 200' },
      { type: 'genet', status: 'done', reason: '' },
    ])
    expect(JSON.parse(hook.bodies[0]!)).toMatchObject({ rule: { id: rule.id, name: '早报' }, event: { source: 'timer', external: false }, payload: { source: 'timer' } })
    const [note] = await inbox(h.cookie, 'automation')
    expect(note).toMatchObject({ ruleName: '早报', text: expect.stringMatching(/^早报：\d{4}-\d{2}-\d{2} 周. 09:00 到点了$/) })
    await waitFor(() => notices(h.doc, 'timer').length === 1)
    expect(textOf(notices(h.doc, 'timer')[0]!)).toContain('整理今天的待办')
    expect((await rules(h))[0]!.last).toMatchObject({ status: 'delivered', results: [{ status: 'done' }, { status: 'done' }, { status: 'done' }] })

    // 第二个动作换成内网地址：通知照发，webhook 失败、叫 Genet 不跑，记录失败写明第几个动作，进收件箱
    const internal = hook.url.replace('in.hook.test', '127.0.0.1')
    const patched = await req('PATCH', `/api/me/automations/${rule.id}`, h.cookie, {
      actions: [{ type: 'notify', text: '又到点了' }, { type: 'webhook', url: internal }, { type: 'genet', instruction: '整理今天的待办' }],
    })
    expect(patched.status).toBe(200)
    await tickAt(nine + DAY + 1000)
    const failed = (await events(rule.id))[1]!
    expect(failed.status).toBe('failed')
    expect(failed.reason).toBe('第 2 个动作（向外 webhook）：这个地址指向本机、内网或保留地址，不允许')
    expect(failed.results.map((r) => r.status)).toEqual(['done', 'failed'])
    expect(hook.bodies).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(notices(h.doc, 'timer')).toHaveLength(1)
    expect((await inbox(h.cookie, 'automation')).map((i) => i.text)).toEqual(['又到点了', expect.stringContaining('到点了')])
    expect(await inbox(h.cookie, 'timer_failed')).toMatchObject([{ source: 'timer', reason: failed.reason }])
    // 自动化通知可「知道了」，别人的 key 消不掉
    const key = (await inbox(h.cookie, 'automation'))[0]!.key
    expect((await postJson('/api/inbox/dismiss', h.cookie, { key: 'automation:nope' })).status).toBe(404)
    expect((await postJson('/api/inbox/dismiss', h.cookie, { key })).status).toBe(200)
    expect(await inbox(h.cookie, 'automation')).toHaveLength(1)
    hook.close()
    h.doc.destroy()
  })

  it('改属性 / 新建行：以主人身份写合集、值带变量（选项按名字、数字按文字换）；非法值写明原因；新建页可用模板', async () => {
    const h = await home()
    const c = await collection(h)
    const bob = await insertUser('bob')
    const setter = await eventRule(h, [{ type: 'set_props', row: 'event', set: { 状态: '{{text}}', 数量: '{{row.数量}}' } }])
    const emit = (key: string, text: string, actor = h.userId): Promise<string[]> =>
      s.triggers.emit({ source: 'comment', key, actorId: actor, payload: { actor: { id: actor, name: 'alice' }, row: { id: c.row, props: { 数量: '3' } }, text } })
    await emit('k1', '进行中')
    expect((await events(setter)).map((e) => [e.status, e.reason])).toEqual([['delivered', '']])
    expect(await replica(c.row)).toMatchObject({ [c.status]: c.options['进行中'], [c.count]: 3 })
    await emit('k2', '不存在的状态')
    expect((await events(setter))[1]).toMatchObject({ status: 'failed', reason: '属性「状态」：没有这个选项' })

    // 外来事件（触发者不是主人）也照跑确定性动作：新建一行，标题与属性带变量，行归主人
    const maker = await eventRule(h, [{ type: 'create_page', parent: c.id, title: '{{actor}} 的反馈', props: { 状态: '未开始' } }], '收反馈')
    await s.triggers.emit({ source: 'comment', key: 'k3', actorId: bob, payload: { actor: { id: bob, name: 'bob' }, text: '好用' } })
    const [made] = await events(maker)
    expect(made).toMatchObject({ status: 'delivered', results: [{ type: 'create_page', status: 'done', reason: expect.stringMatching(/^建了 page:/) }] })
    const newRow = made!.results[0]!.reason.replace('建了 page:', '')
    expect((await pool.query('SELECT title, owner_id, parent_id FROM live_pages WHERE id = $1', [newRow])).rows[0]).toEqual({ title: 'bob 的反馈', owner_id: h.userId, parent_id: c.id })
    expect(await replica(newRow)).toMatchObject({ [c.status]: c.options['未开始'] })

    // 新建页：从模板复制一份到文档页下，标题换成规则给的
    const tpl = ((await (await postJson('/api/pages', h.cookie, { space_id: h.space, title: '周报模板' })).json()) as { id: string }).id
    const parent = ((await (await postJson('/api/pages', h.cookie, { space_id: h.space, title: '周报' })).json()) as { id: string }).id
    const weekly = await eventRule(h, [{ type: 'create_page', parent, template: tpl, title: '{{text}} 周报' }], '建周报')
    await s.triggers.emit({ source: 'comment', key: 'k4', actorId: h.userId, payload: { text: '第 45 周' } })
    const page = (await events(weekly))[0]!.results[0]!.reason.replace('建了 page:', '')
    expect((await pool.query('SELECT title, parent_id FROM live_pages WHERE id = $1', [page])).rows[0]).toEqual({ title: '第 45 周 周报', parent_id: parent })
    expect(textOf((await loadDocFromDb(pool, `page:${page}`)).getXmlFragment('title'))).toBe('第 45 周 周报')

    // 保存时就知道不行的：定时规则改「事件所在行」、属性名对不上、模板看不到
    const bad = async (actions: unknown[]): Promise<string> => {
      const res = await req('POST', '/api/me/automations', h.cookie, { name: 'x', source: 'timer', config: { kind: 'daily', time: '09:00' }, actions })
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: string }).error
    }
    expect(await bad([{ type: 'set_props', row: 'event', set: { 状态: 'x' } }])).toContain('定时规则没有「事件所在的行」')
    expect(await bad([{ type: 'set_props', row: c.row, set: { 没有: 'x' } }])).toBe('合集里没有叫「没有」的属性')
    expect(await bad([{ type: 'create_page', parent: c.id, title: 'x', template: 'nope' }])).toContain('模板页 page:nope 不在了')
    expect(await bad([{ type: 'notify', text: 'x', to: [bob] }])).toBe(`收件人 ${bob} 不是这个空间的成员`)
    h.doc.destroy()
  })
})

describe('防循环、失败与上限', () => {
  it('动作改了页面又触发规则：深度一层层加，到第 3 层跳过并记原因', async () => {
    const h = await home()
    const c = await collection(h)
    const rule = await eventRule(h, [{ type: 'set_props', row: 'event', set: { 数量: '{{text}}' } }])
    expect(s.triggers.causedBy(c.row)).toBe(0)
    for (let i = 0; i < 4; i++) {
      await s.triggers.emit({ source: 'comment', key: `d${i}`, actorId: h.userId, depth: s.triggers.causedBy(c.row), payload: { row: { id: c.row, props: {} }, text: String(i) } })
    }
    expect((await events(rule)).map((e) => [e.depth, e.status, e.reason])).toEqual([
      [0, 'delivered', ''],
      [1, 'delivered', ''],
      [2, 'delivered', ''],
      [3, 'skipped', '自动化连锁太深'],
    ])
    expect(await replica(c.row)).toMatchObject({ [c.count]: 2 })
    h.doc.destroy()
  })

  it('每个动作执行前按主人重判：失去写权限时记录写明第几个动作；连续 3 次自动暂停；确定性动作与 AI 动作的每日次数分开算；启用中的规则最多 100 条', async () => {
    const h = await home()
    const c = await collection(h)
    const rule = await eventRule(h, [{ type: 'notify', text: '有动静' }, { type: 'set_props', row: c.row, set: { 数量: 1 } }])
    await pool.query("UPDATE space_members SET role = 'viewer' WHERE user_id = $1 AND space_id = $2", [h.userId, h.space])
    for (let i = 0; i < 3; i++) await s.triggers.emit({ source: 'comment', key: `f${i}`, actorId: h.userId, payload: {} })
    const evs = await events(rule)
    expect(evs.map((e) => e.status)).toEqual(['failed', 'failed', 'failed'])
    expect(evs[0]!.reason).toBe('第 2 个动作（改属性）：你已经不能编辑这个合集了')
    expect(evs[0]!.results.map((r) => r.status)).toEqual(['done', 'failed'])
    const paused = (await pool.query<{ enabled: boolean; paused_reason: string }>('SELECT enabled, paused_reason FROM agent_triggers WHERE id = $1', [rule])).rows[0]!
    expect(paused.enabled).toBe(false)
    expect(paused.paused_reason).toContain('连续 3 次没能触发')
    expect((await inbox(h.cookie, 'timer_failed')).map((i) => i.source)).toEqual(['comment', 'comment', 'comment'])
    // 暂停了的规则不再接事件
    expect(await s.triggers.emit({ source: 'comment', key: 'f9', actorId: h.userId, payload: {} })).toEqual([])
    await pool.query("UPDATE space_members SET role = 'owner' WHERE user_id = $1 AND space_id = $2", [h.userId, h.space])

    // 只含确定性动作的不被 AI 的 50 次挡住；到 1000 次才跳过
    const plain = await eventRule(h, [{ type: 'notify', text: 'x' }], '计数')
    const seed = (n: number, ai: boolean): Promise<unknown> =>
      pool.query(
        `INSERT INTO trigger_events (id, trigger_id, owner_id, dedup_key, scheduled_at, created_at, status, ai)
         SELECT 'seed-' || $4 || '-' || i, $1, $2, 'seed:' || $4 || ':' || i, now(), now(), 'delivered', $3 FROM generate_series(1, $5) i`,
        [plain, h.userId, ai, ai ? 'ai' : 'plain', n],
      )
    await seed(50, true)
    await s.triggers.emit({ source: 'comment', key: 'p1', actorId: h.userId, payload: {} })
    expect((await events(plain)).filter((e) => !e.id.startsWith('seed-')).map((e) => e.status)).toEqual(['delivered'])
    await seed(1000, false)
    await s.triggers.emit({ source: 'comment', key: 'p2', actorId: h.userId, payload: {} })
    expect((await events(plain)).filter((e) => !e.id.startsWith('seed-')).at(-1)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('1000 次') })

    await pool.query(
      `INSERT INTO agent_triggers (id, space_id, owner_id, source, name, instruction, spec, time_zone, agent, actions)
       SELECT 'many-' || i, $1, $2, 'comment', 'x', '', '{}', 'UTC', '', '[{"type":"notify","text":"x"}]' FROM generate_series(1, 99) i`,
      [h.space, h.userId],
    )
    const over = await req('POST', '/api/me/automations', h.cookie, { name: 'x', source: 'timer', config: { kind: 'daily', time: '09:00' }, actions: [{ type: 'notify', text: 'x' }] })
    expect(over.status).toBe(400)
    expect(((await over.json()) as { error: string }).error).toContain('启用中的规则最多 100 个')
    h.doc.destroy()
  })

  it('REST：别人的规则 404、只认认得的来源、校验原因是人话；删掉规则', async () => {
    const h = await home()
    triggerClock.at = Date.now()
    const rule = await createRule(h, { name: '提醒', source: 'timer', config: { kind: 'every', minutes: 60 }, actions: [{ type: 'notify', text: 'x' }] })
    await insertUser('bob')
    const bob = await login('bob')
    expect((await req('PATCH', `/api/me/automations/${rule.id}`, bob, { enabled: false })).status).toBe(404)
    expect((await req('DELETE', `/api/me/automations/${rule.id}`, bob)).status).toBe(404)
    expect(((await (await req('GET', '/api/me/automations', bob)).json()) as { automations: AutomationView[] }).automations.filter((r) => !r.builtin)).toEqual([])
    const bad = async (body: Record<string, unknown>): Promise<string> => {
      const res = await req('POST', '/api/me/automations', h.cookie, body)
      expect(res.status).toBe(400)
      return ((await res.json()) as { error: string }).error
    }
    expect(await bad({ name: 'x', source: 'comment', config: {}, actions: [{ type: 'notify', text: 'x' }] })).toBe('这种触发还不能在这里建')
    expect(await bad({ name: 'x', source: 'timer', config: { kind: 'every', minutes: 5 }, actions: [{ type: 'notify', text: 'x' }] })).toContain('最短 60')
    expect(await bad({ name: '', source: 'timer', config: { kind: 'daily', time: '09:00' }, actions: [] })).toBe('名字不能为空')
    expect(await bad({ name: 'x', source: 'timer', config: { kind: 'daily', time: '09:00' }, actions: [] })).toBe('至少要有一个动作')
    expect((await req('PATCH', `/api/me/automations/${rule.id}`, h.cookie, {})).status).toBe(400)
    const paused = await req('PATCH', `/api/me/automations/${rule.id}`, h.cookie, { enabled: false, name: '改名' })
    expect(((await paused.json()) as { automation: AutomationView }).automation).toMatchObject({ enabled: false, nextAt: null, name: '改名' })
    expect((await req('DELETE', `/api/me/automations/${rule.id}`, h.cookie)).status).toBe(200)
    expect(await rules(h)).toEqual([])
    h.doc.destroy()
  })
})
