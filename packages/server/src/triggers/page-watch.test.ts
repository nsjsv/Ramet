/* ---------- 来源：盯页面（真实写路径：协同存盘 → 攒改动 → 时钟到点汇报） ----------
 * bob 改了 alice 盯着的页、停手满设定的时长 → alice 的 Genet 页出现一条外来的事件通知，摘要里是 bob 改成的字；只汇报一次。
 * alice 自己改的不算；静默期内再改往后推、一直改最多攒 3 小时；含子页 / 不含子页；暂停期间不攒、恢复不补；主人被移出空间后不算；
 * 连锁深度从 causedBy 来。Genet 的 watch_page / list_watches / unwatch_page，外来事件之后增删先问主人。 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { PermissionEvent } from '../agents/types.js'
import { insertConnection } from '../ai-connections.js'
import { mintPageToken } from '../page-read.js'
import { ASSISTANT_ID } from '../agents/assistant-agent.js'
import { textOf } from '../updates.js'
import { say, script as fakeModel } from '../agents/drivers/assistant/test-model.js'
import {
  answerPermission,
  assistantModel,
  assistantSecret,
  base,
  connectDoc,
  insertUser,
  joinPageSpace,
  login,
  pool,
  postJson,
  s,
  settled,
  setupPage,
  SSECollector,
  triggerClock,
  userIdOf,
  waitFor,
} from '../agents/test-kit.js'
import { DEFAULT_WATCH } from '../routes/watch-tools.js'
import type { AutomationView } from './rules.js'

const MIN = 60_000

type World = {
  alice: { id: string; cookie: string }
  bob: { id: string; cookie: string }
  home: string
  page: string
  space: string
  doc: HocuspocusProvider
  sse: SSECollector
  token: string
}

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

async function world(): Promise<World> {
  const { cookie, pageId } = await setupPage()
  const aliceId = await userIdOf('alice')
  await insertConnection(pool, aliceId, { name: 'c', protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' }, 'sk-ant-test-secret-9999', assistantSecret)
  const home = ((await (await postJson('/api/me/assistant', cookie)).json()) as { pageId: string }).pageId
  const bobCookie = await joinPageSpace(pageId, 'bob')
  // 盯的那一页早就建好了（不然空页第一次被写会被当成「这阵新建的」）
  await pool.query("UPDATE pages SET created_at = (now() - interval '1 day')::text WHERE id = $1", [pageId])
  const doc = await connectDoc(home, cookie)
  const sse = new SSECollector()
  await sse.start(home, cookie)
  assistantModel.script = fakeModel(say('收到')).stream
  return {
    alice: { id: aliceId, cookie },
    bob: { id: await userIdOf('bob'), cookie: bobCookie },
    home,
    page: pageId,
    space: (await pool.query<{ space_id: string }>('SELECT space_id FROM pages WHERE id = $1', [pageId])).rows[0]!.space_id,
    doc,
    sse,
    token: mintPageToken(aliceId, ASSISTANT_ID, { pageId: home, agentId: ASSISTANT_ID, canDispatch: true }),
  }
}

async function watch(w: World, config: Record<string, unknown>, name = '盯预算'): Promise<AutomationView> {
  const res = await req('POST', '/api/me/automations', { cookie: w.alice.cookie }, { name, source: 'page_watch', config, actions: [{ type: 'genet', instruction: '看看改了什么' }] })
  expect(res.status).toBe(201)
  return ((await res.json()) as { automation: AutomationView }).automation
}

/** 正文末尾加一段（块 id 由测试给：前端的补 id 插件这里没有） */
function write(p: HocuspocusProvider, blockId: string, text: string): void {
  const para = new Y.XmlElement('paragraph')
  para.setAttribute('id', blockId)
  const t = new Y.XmlText()
  t.insert(0, text)
  para.insert(0, [t])
  p.document.getXmlFragment('prosemirror').push([para])
}

/** 这一块的「上次编辑」落库了 = 那次存盘跑过了（攒改动在它之后，再给后台一点时间） */
async function stored(pageId: string, blockId: string): Promise<void> {
  await waitFor(async () => ((await pool.query('SELECT 1 FROM edit_marks WHERE page_id = $1 AND block_id = $2', [pageId, blockId])).rowCount ?? 0) > 0, 20_000)
  await new Promise((r) => setTimeout(r, 400))
}

async function edited(pageId: string, blockId: string): Promise<boolean> {
  return ((await pool.query('SELECT 1 FROM edit_marks WHERE page_id = $1 AND block_id = $2', [pageId, blockId])).rowCount ?? 0) > 0
}

type Win = { page_id: string; editors: string[]; depth: number }
async function windows(ruleId: string): Promise<Win[]> {
  return (await pool.query<Win>('SELECT page_id, editors, depth FROM page_watch_windows WHERE trigger_id = $1 ORDER BY opened_at', [ruleId])).rows
}

async function nextAt(ruleId: string): Promise<number | null> {
  return (await pool.query<{ next_at: Date | null }>('SELECT next_at FROM agent_triggers WHERE id = $1', [ruleId])).rows[0]?.next_at?.getTime() ?? null
}

type Ev = { status: string; reason: string | null; external: boolean; depth: number; actor_id: string | null; payload: { text?: string; page?: { id: string } } }
async function events(ruleId: string): Promise<Ev[]> {
  return (await pool.query<Ev>('SELECT status, reason, external, depth, actor_id, payload FROM trigger_events WHERE trigger_id = $1 ORDER BY created_at', [ruleId])).rows
}

async function tickAt(ms: number): Promise<void> {
  triggerClock.at = ms
  await s.triggers.tick()
}

function notices(p: HocuspocusProvider): string[] {
  return p.document
    .getXmlFragment('prosemirror')
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'user_message' && n.getAttribute('notice') === 'event')
    .map((n) => {
      expect(n.getAttribute('external')).toBe('1')
      return n
        .toArray()
        .map((c) => textOf(c as Y.XmlElement))
        .join('\n')
    })
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 400))

describe('盯页面', () => {
  it('bob 改了、停手满时长 → 汇报一次，摘要是 bob 改成的字；alice 自己改的不算；静默期内再改往后推；外来事件之后 Genet 再盯页面先问主人', async () => {
    const w = await world()
    const t0 = Date.now()
    triggerClock.at = t0
    const rule = await watch(w, { page: w.page, quiet: 10 })
    expect(rule.triggerText).toBe('《无标题》及子页 · 别人改完 10 分钟后')
    expect(rule.nextAt).toBeNull()

    const aliceDoc = await connectDoc(w.page, w.alice.cookie)
    write(aliceDoc, 'a-1', 'alice 自己写的')
    await stored(w.page, 'a-1')
    expect(await windows(rule.id)).toEqual([])

    const bobDoc = await connectDoc(w.page, w.bob.cookie)
    write(bobDoc, 'b-1', '新的预算是 3 万')
    await waitFor(async () => (await windows(rule.id)).length === 1, 20_000)
    expect(await nextAt(rule.id)).toBe(t0 + 10 * MIN)
    // AI 页上看得到「约几点汇报」
    const listed = ((await (await req('GET', '/api/me/automations', { cookie: w.alice.cookie })).json()) as { automations: AutomationView[] }).automations
    expect(listed.find((r) => r.id === rule.id)?.nextAt).toBe(new Date(t0 + 10 * MIN).toISOString())

    // 静默期内 bob 又改了：往后推
    triggerClock.at = t0 + 8 * MIN
    write(bobDoc, 'b-2', '风险：汇率')
    await waitFor(async () => (await nextAt(rule.id)) === t0 + 18 * MIN, 20_000)
    await tickAt(t0 + 17 * MIN)
    expect(await events(rule.id)).toEqual([])

    await tickAt(t0 + 19 * MIN)
    await waitFor(() => notices(w.doc).length === 1)
    const n = notices(w.doc)[0]!
    expect(n).toContain('规则「盯预算」· bob 在《无标题》的页面改动')
    expect(n).toContain('《无标题》 · bob\n· 新增：新的预算是 3 万\n· 新增：风险：汇率')
    expect(n).not.toContain('alice 自己写的')
    expect(n).toContain(`盯着：《无标题》及子页\n改的人：bob`)
    expect(n).toContain(`链接：/page/${w.page}`)
    expect(n).toContain('规则的指令：看看改了什么')
    const [ev] = await events(rule.id)
    expect(ev).toMatchObject({ external: true, actor_id: w.bob.id, depth: 0 })
    expect(await windows(rule.id)).toEqual([])
    expect(await nextAt(rule.id)).toBeNull()
    await settled(w.sse, 1)

    // 只汇报一次
    await tickAt(t0 + 60 * MIN)
    expect((await events(rule.id)).length).toBe(1)

    // 读到别人的改动之后、主人亲自说话之前：Genet 再盯一页先弹卡
    const pending = req('POST', '/api/ramet/watches', { token: w.token }, { page: `page:${w.page}` })
    await waitFor(() => w.sse.events.some((e) => e.type === 'permission' && e.toolCall?.title === '盯《无标题》'))
    const card = w.sse.events.find((e): e is PermissionEvent => e.type === 'permission' && e.toolCall?.title === '盯《无标题》')!
    expect((await answerPermission(w.home, w.alice.cookie, card, 'reject')).status).toBe(200)
    expect(await (await pending).json()).toMatchObject({ rejected: true })
    w.sse.stop()
    for (const p of [w.doc, aliceDoc, bobDoc]) p.destroy()
  }, 90_000)

  it('含子页：子页新建 / 改动分页列出、标「新页」；不含子页的规则只认那一页；一直有人改最多攒 3 小时', async () => {
    const w = await world()
    const t0 = Date.now()
    triggerClock.at = t0
    // 静默 2 小时：中途把时钟往前拨也不会有哪条先到点（时钟自己也会醒来认领）
    const tree = await watch(w, { page: w.page, quiet: 120 }, '盯整棵')
    const only = await watch(w, { page: w.page, subtree: false, quiet: 120 }, '只盯这页')
    const child = ((await (await postJson('/api/pages', w.bob.cookie, { space_id: w.space, parent_id: w.page })).json()) as { id: string }).id
    const childDoc = await connectDoc(child, w.bob.cookie)
    write(childDoc, 'c-1', '子页的第一段')
    await waitFor(async () => (await windows(tree.id)).some((x) => x.page_id === child), 20_000)
    await drain()
    // 建子页时根页里多了一个子页链接（bob 改的）：只盯这页的那条也开了窗口，但没有子页
    expect((await windows(only.id)).map((x) => x.page_id)).toEqual([w.page])

    const bobDoc = await connectDoc(w.page, w.bob.cookie)
    write(bobDoc, 'r-1', '根页的改动')
    await waitFor(async () => (await edited(w.page, 'r-1')), 20_000)
    expect(await nextAt(tree.id)).toBe(t0 + 120 * MIN)

    // 一直有人在改：最多攒 3 小时
    triggerClock.at = t0 + 100 * MIN
    write(bobDoc, 'r-2', '还在改')
    await waitFor(async () => (await nextAt(tree.id)) === t0 + 180 * MIN && (await nextAt(only.id)) === t0 + 180 * MIN, 20_000)

    await tickAt(t0 + 180 * MIN)
    await waitFor(async () => (await events(tree.id)).length === 1)
    const [ev] = await events(tree.id)
    // 按开始被改的先后：建子页先改了根页（多了子页链接，读得见的字没变），子页接着被写
    expect(ev!.payload.text).toBe(['《无标题》 · bob', '· 新增：根页的改动', '· 新增：还在改', '《无标题》（新页） · bob', '· 新增：子页的第一段'].join('\n'))
    // 改了不止一页：事件页 = 盯的那一页
    expect(ev!.payload.page?.id).toBe(w.page)
    await waitFor(async () => (await events(only.id)).length === 1)
    expect((await events(only.id))[0]!.payload.text).toBe(['《无标题》 · bob', '· 新增：根页的改动', '· 新增：还在改'].join('\n'))
    await settled(w.sse, 2)
    w.sse.stop()
    for (const p of [w.doc, childDoc, bobDoc]) p.destroy()
  }, 90_000)

  it('暂停期间不攒、恢复不补；主人被移出空间后不算；连锁深度来自 causedBy', async () => {
    const w = await world()
    const t0 = Date.now()
    triggerClock.at = t0
    const rule = await watch(w, { page: w.page, quiet: 10 })
    const bobDoc = await connectDoc(w.page, w.bob.cookie)
    write(bobDoc, 'b-1', '第一处')
    await waitFor(async () => (await windows(rule.id)).length === 1, 20_000)

    expect((await req('PATCH', `/api/me/automations/${rule.id}`, { cookie: w.alice.cookie }, { enabled: false })).status).toBe(200)
    expect(await windows(rule.id)).toEqual([])
    expect(await nextAt(rule.id)).toBeNull()
    write(bobDoc, 'b-2', '暂停期间')
    await stored(w.page, 'b-2')
    expect(await windows(rule.id)).toEqual([])
    expect((await req('PATCH', `/api/me/automations/${rule.id}`, { cookie: w.alice.cookie }, { enabled: true })).status).toBe(200)
    await tickAt(t0 + 60 * MIN)
    expect(await events(rule.id)).toEqual([])

    // 连锁：这一页刚被自动化改过（深度 2）→ 这次改动深度 3，到上限跳过
    s.triggers.touched(w.page, 2)
    write(bobDoc, 'b-3', '自动化引起的')
    await waitFor(async () => (await windows(rule.id))[0]?.depth === 3, 20_000)
    await tickAt(t0 + 80 * MIN)
    await waitFor(async () => (await events(rule.id)).length === 1)
    expect((await events(rule.id))[0]).toMatchObject({ status: 'skipped', reason: '自动化连锁太深', depth: 3 })

    // alice 被移出那一页所在的空间：攒着的不汇报，之后的不攒
    write(bobDoc, 'b-4', '移出之前')
    await waitFor(async () => (await windows(rule.id)).length === 1, 20_000)
    await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [w.space, w.alice.id])
    await tickAt(t0 + 200 * MIN)
    expect((await events(rule.id)).length).toBe(1)
    expect(await windows(rule.id)).toEqual([])
    write(bobDoc, 'b-5', '移出之后')
    await stored(w.page, 'b-5')
    expect(await windows(rule.id)).toEqual([])
    w.sse.stop()
    for (const p of [w.doc, bobDoc]) p.destroy()
  }, 90_000)
})

describe('Genet 盯页面的工具', () => {
  it('watch_page 建一条叫 Genet 的规则（缺省指令）；list_watches 只列盯页面的；unwatch_page 只删盯页面的；看不到的页 400', async () => {
    const w = await world()
    const tools = ((await (await req('GET', '/api/ramet/tools', { token: w.token })).json()) as { tools: string[] }).tools
    expect(tools).toEqual(expect.arrayContaining(['watch_page', 'list_watches', 'unwatch_page']))

    const res = await req('POST', '/api/ramet/watches', { token: w.token }, { page: `page:${w.page}`, quiet: 5 })
    expect(res.status).toBe(200)
    const made = ((await res.json()) as { watch: AutomationView }).watch
    expect(made).toMatchObject({ name: '盯《无标题》', source: 'page_watch', triggerText: '《无标题》及子页 · 别人改完 5 分钟后', actions: [{ type: 'genet', instruction: DEFAULT_WATCH }] })

    const list = ((await (await req('GET', '/api/ramet/watches', { token: w.token })).json()) as { watches: AutomationView[] }).watches
    expect(list.map((r) => r.id)).toEqual([made.id])

    // 看不到的页：carol 自己空间里的
    const carol = await setupCarol()
    const bad = await req('POST', '/api/ramet/watches', { token: w.token }, { page: carol })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '要盯的那一页不在了，或者你看不到它' })

    // 内置规则不是盯页面的：这里删不了
    const builtin = ((await (await req('GET', '/api/me/automations', { cookie: w.alice.cookie })).json()) as { automations: AutomationView[] }).automations.find((r) => r.builtin)!
    expect((await req('DELETE', `/api/ramet/watches/${builtin.id}`, { token: w.token })).status).toBe(404)
    const del = await req('DELETE', `/api/ramet/watches/${made.id}`, { token: w.token })
    expect(await del.json()).toEqual({ ok: true, name: '盯《无标题》' })
    expect(((await (await req('GET', '/api/ramet/watches', { token: w.token })).json()) as { watches: AutomationView[] }).watches).toEqual([])
    w.sse.stop()
    w.doc.destroy()
  }, 60_000)
})

/** carol 自己的空间里的一页（alice 不是成员） */
async function setupCarol(): Promise<string> {
  await insertUser('carol')
  const cookie = await login('carol')
  const space = ((await (await postJson('/api/spaces', cookie, { name: 'c' })).json()) as { id: string }).id
  return ((await (await postJson('/api/pages', cookie, { space_id: space })).json()) as { id: string }).id
}
