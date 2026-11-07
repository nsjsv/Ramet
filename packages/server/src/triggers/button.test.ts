/* ---------- 来源：点按钮（POST /api/automations/:id/press） ----------
 * 正文按钮：能编辑那一页的人点了就跑（建子页），别人点的是外来的、主人点的不是；只读 403、看不到 404、按钮在别的页上 400、暂停 409、删了 404。
 * 合集按钮列：点某一行 = 以那一行为事件所在的行（改属性只改那一行）。规则必须挂在页上。 */
import { describe, expect, it } from 'vitest'
import { call, eventually, newCollection, postPage, postRow, pool, replicaOf, team } from '../collections/test-kit.js'
import type { AutomationView } from './rules.js'

type Ev = { external: boolean; actor_id: string | null; payload: { row?: { id: string }; extra?: Array<[string, string]> } }
async function events(ruleId: string): Promise<Ev[]> {
  return (await pool.query<Ev>('SELECT external, actor_id, payload FROM trigger_events WHERE trigger_id = $1 ORDER BY created_at', [ruleId])).rows
}

async function button(
  cookie: string,
  scopePage: string | undefined,
  label: string,
  actions: unknown[],
): Promise<{ status: number; body: { automation: AutomationView; error?: string } }> {
  return call('POST', '/api/me/automations', cookie, { name: label, source: 'button', config: { label }, actions, ...(scopePage ? { scopePage } : {}) })
}

const press = (cookie: string, id: string, body: Record<string, unknown>) =>
  call<{ ok?: boolean; name?: string; error?: string }>('POST', `/api/automations/${id}/press`, cookie, body)

describe('点按钮', () => {
  it('正文按钮：能编辑的人点了就跑；别人点外来、主人点不外来；只读 403、看不到 404、别的页 400、暂停 409、删了 404', async () => {
    const t = await team()
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId })
    const other = await postPage(t.owner.cookie, { space_id: t.spaceId })
    expect((await button(t.owner.cookie, undefined, '新建周报', [{ type: 'notify', to: 'owner', text: 'x' }])).body.error).toBe(
      '按钮的规则要挂在按钮所在的页上',
    )
    const made = await button(t.owner.cookie, page, '新建周报', [{ type: 'create_page', parent: page, title: '{{actor}} 的周报' }])
    expect(made.status).toBe(201)
    const rule = made.body.automation
    expect(rule.triggerText).toBe('点「新建周报」按钮')
    expect(rule.scopePage?.id).toBe(page)

    expect(await press(t.member.cookie, rule.id, { page })).toEqual({ status: 200, body: { ok: true, name: '新建周报' } })
    await eventually(async () => {
      const { rows } = await pool.query<{ title: string }>('SELECT title FROM live_pages WHERE parent_id = $1', [page])
      expect(rows.map((r) => r.title)).toEqual([`${t.member.name} 的周报`])
    })
    await press(t.owner.cookie, rule.id, { page })
    await eventually(async () =>
      expect((await events(rule.id)).map((e) => [e.actor_id, e.external])).toEqual([
        [t.member.id, true],
        [t.owner.id, false],
      ]),
    )
    expect((await events(rule.id))[0]!.payload.extra).toEqual([
      ['按钮', '新建周报'],
      ['所在页', `《无标题》（page:${page}）`],
    ])

    expect((await press(t.viewer.cookie, rule.id, { page })).status).toBe(403)
    expect((await press(t.outsider.cookie, rule.id, { page })).status).toBe(404)
    expect((await press(t.owner.cookie, rule.id, { page: other })).body.error).toBe('这个按钮的设置在别的页上：重新设置一下')
    await call('PATCH', `/api/me/automations/${rule.id}`, t.owner.cookie, { enabled: false })
    expect((await press(t.member.cookie, rule.id, { page })).status).toBe(409)
    await call('DELETE', `/api/me/automations/${rule.id}`, t.owner.cookie)
    expect(await press(t.member.cookie, rule.id, { page })).toEqual({ status: 404, body: { error: '这个按钮还没设置，或者它的设置已经删了' } })
  }, 60_000)

  it('合集按钮列：点某一行 = 那一行是事件所在的行，改属性只改那一行；行不在这个合集 400', async () => {
    const t = await team()
    const f = await newCollection(t)
    const done = f.status.options.find((o) => o.id === f.done)!.name
    const made = await button(t.owner.cookie, f.id, '标记完成', [{ type: 'set_props', row: 'event', set: { [f.status.name]: done } }])
    expect(made.status).toBe(201)
    const rule = made.body.automation
    const rowOf = async (title: string): Promise<string> => ((await postRow(t.member.cookie, f.id, { title })).body as { id: string }).id
    const a = await rowOf('一')
    const b = await rowOf('二')
    expect((await press(t.member.cookie, rule.id, { page: f.id, row: a })).status).toBe(200)
    await eventually(async () => expect((await replicaOf(a))?.[f.status.id]).toBe(f.done))
    expect((await replicaOf(b))?.[f.status.id]).toBeUndefined()
    expect((await events(rule.id))[0]!.payload.row?.id).toBe(a)

    const other = await newCollection(t, { title: '别的' })
    const elsewhere = ((await postRow(t.member.cookie, other.id, { title: '外面' })).body as { id: string }).id
    expect((await press(t.member.cookie, rule.id, { page: f.id, row: elsewhere })).body.error).toBe('那一行不在这个合集里了')
    expect((await press(t.member.cookie, rule.id, { page: f.id })).status).toBe(400)
  }, 60_000)
})
