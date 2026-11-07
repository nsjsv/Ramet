/* ---------- 来源：合集里有变化（真实写路径：建行 / 复制 / 挪进 / 建页挂到合集下、改值） ----------
 * 新增了一行 → 改「事件所在的行」；属性改了 + 条件（改之前不满足、改之后满足才算）、只看某些属性；主人自己改的不算外来；
 * 两条规则互相改状态的连锁到第 3 层跳过；主人移出空间 / 合集进回收站不触发；配置校验、挂靠页上的列表带主人名。 */
import { describe, expect, it } from 'vitest'
import { call, eventually, newCollection, patchRow, postPage, postRow, pool, replicaOf, team, type Fixture, type Team } from '../collections/test-kit.js'
import type { AutomationView } from './rules.js'

type Ev = {
  status: string
  reason: string | null
  external: boolean
  depth: number
  dedup_key: string
  payload: { changes?: Array<{ prop: string; from: string; to: string }>; row?: { id: string; props: Record<string, string> } }
}

async function events(ruleId: string): Promise<Ev[]> {
  return (
    await pool.query<Ev>('SELECT status, reason, external, depth, dedup_key, payload FROM trigger_events WHERE trigger_id = $1 ORDER BY created_at, depth', [
      ruleId,
    ])
  ).rows
}

async function rule(cookie: string, name: string, config: Record<string, unknown>, actions: unknown[]): Promise<AutomationView> {
  const res = await call<{ automation: AutomationView; error?: string }>('POST', '/api/me/automations', cookie, { name, source: 'collection', config, actions })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.automation
}

const NOTIFY = [{ type: 'notify', to: 'owner', text: '{{row.名称}}' }]
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 500))

function optionName(f: Fixture, id: string): string {
  return f.status.options.find((o) => o.id === id)!.name
}

async function newRow(t: Team, f: Fixture, title: string, who = t.member): Promise<string> {
  const res = await postRow(who.cookie, f.id, { title })
  expect(res.status).toBe(201)
  return (res.body as { id: string }).id
}

describe('合集里有变化', () => {
  it('新增了一行：表格建行、复制、挪进来、建页挂到合集下都触发一次；改属性改的是事件所在的那一行', async () => {
    const t = await team()
    const f = await newCollection(t)
    const r = await rule(t.owner.cookie, '新行先标进行中', { collection: f.id, on: 'added' }, [
      { type: 'set_props', row: 'event', set: { [f.status.name]: optionName(f, f.doing) } },
    ])
    expect(r.scopePage?.id).toBe(f.id)
    expect(r.triggerText).toBe('《任务》新增了一行')

    const a = await newRow(t, f, '第一行')
    await eventually(async () => expect((await replicaOf(a))?.[f.status.id]).toBe(f.doing))
    await eventually(async () => expect((await events(r.id)).map((e) => e.status)).toEqual(['delivered']))
    const [ev] = await events(r.id)
    expect(ev).toMatchObject({ status: 'delivered', external: true, dedup_key: `collection_add:${a}:${r.id}` })
    expect(ev!.payload.row?.props).toMatchObject({ 名称: '第一行' })

    const dup = await call<{ created: Array<{ id: string }> }>('POST', `/api/collections/${f.id}/rows/duplicate`, t.member.cookie, { ids: [a] })
    expect(dup.status).toBe(201)
    const copy = dup.body.created[0]!.id
    const page = await postPage(t.owner.cookie, { space_id: t.spaceId, parent_id: f.id })
    const other = await newCollection(t, { title: '别的' })
    const moving = await newRow(t, other, '挪过来的')
    expect((await call('POST', `/api/collections/${other.id}/rows/move`, t.member.cookie, { ids: [moving], to: f.id })).status).toBe(200)
    await eventually(async () => expect((await events(r.id)).length).toBe(4))
    const keys = (await events(r.id)).map((e) => e.dedup_key)
    for (const id of [copy, page, moving]) expect(keys).toContain(`collection_add:${id}:${r.id}`)
    // 主人自己建的不算外来
    expect((await events(r.id)).find((e) => e.dedup_key.includes(page))?.external).toBe(false)
  }, 60_000)

  it('属性改了 + 条件：改成完成才触发、带「从 → 到」；完成之后改别的不触发；改回再改成完成又触发；只看别的属性的规则不触发', async () => {
    const t = await team()
    const f = await newCollection(t)
    const row = await newRow(t, f, '写报告')
    const done = await rule(
      t.owner.cookie,
      '完成了告诉我',
      { collection: f.id, on: 'edited', props: [f.status.id], filter: { all: [{ prop: f.status.id, op: 'is', value: f.done }] } },
      NOTIFY,
    )
    const titleOnly = await rule(t.owner.cookie, '只看名称', { collection: f.id, on: 'edited', props: ['title'] }, NOTIFY)
    expect(done.triggerText).toBe('《任务》的属性改了（1 个属性 · 1 个条件）')

    expect((await patchRow(t.member.cookie, f.id, row, { set: { [f.status.id]: f.doing } })).status).toBe(200)
    await drain()
    expect(await events(done.id)).toEqual([])
    expect((await patchRow(t.member.cookie, f.id, row, { set: { [f.status.id]: f.done } })).status).toBe(200)
    await eventually(async () => expect((await events(done.id)).map((e) => e.status)).toEqual(['delivered']))
    const [ev] = await events(done.id)
    expect(ev).toMatchObject({ status: 'delivered', external: true })
    expect(ev!.payload.changes).toEqual([{ prop: f.status.name, from: optionName(f, f.doing), to: optionName(f, f.done) }])
    expect(ev!.payload.row?.props).toMatchObject({ 名称: '写报告', [f.status.name]: optionName(f, f.done) })

    // 已经是完成：改名不算「改成完成」
    expect((await patchRow(t.member.cookie, f.id, row, { title: '写周报' })).status).toBe(200)
    await drain()
    expect((await events(done.id)).length).toBe(1)
    // 改回再改成完成（主人自己改）：又触发，不算外来
    await patchRow(t.owner.cookie, f.id, row, { set: { [f.status.id]: f.todo } })
    await drain()
    await patchRow(t.owner.cookie, f.id, row, { set: { [f.status.id]: f.done } })
    await eventually(async () => expect((await events(done.id)).length).toBe(2))
    expect((await events(done.id))[1]!.external).toBe(false)
    expect(await events(titleOnly.id)).toEqual([])
  }, 60_000)

  it('两条规则互相改状态：连锁到第 3 层跳过；主人移出空间、合集进回收站后不触发', async () => {
    const t = await team()
    const f = await newCollection(t)
    const row = await newRow(t, f, '乒乓')
    const set = (to: string) => [{ type: 'set_props', row: 'event', set: { [f.status.id]: optionName(f, to) } }]
    const when = (id: string) => ({ collection: f.id, on: 'edited', props: [f.status.id], filter: { all: [{ prop: f.status.id, op: 'is', value: id }] } })
    const ping = await rule(t.owner.cookie, '完成 → 未开始', when(f.done), set(f.todo))
    const pong = await rule(t.owner.cookie, '未开始 → 完成', when(f.todo), set(f.done))
    await patchRow(t.member.cookie, f.id, row, { set: { [f.status.id]: f.done } })
    await eventually(async () => {
      const all = [...(await events(ping.id)), ...(await events(pong.id))].sort((a, b) => a.depth - b.depth)
      expect(all.map((e) => [e.depth, e.status])).toEqual([
        [0, 'delivered'],
        [1, 'delivered'],
        [2, 'delivered'],
        [3, 'skipped'],
      ])
    })
    expect((await events(pong.id)).at(-1)?.reason).toBe('自动化连锁太深')

    // 主人不在空间里了：不触发
    const watch = await rule(t.owner.cookie, '改了就说', { collection: f.id, on: 'edited' }, NOTIFY)
    await pool.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [t.spaceId, t.owner.id])
    await patchRow(t.member.cookie, f.id, row, { title: '主人走了' })
    await drain()
    expect(await events(watch.id)).toEqual([])
  }, 60_000)

  it('配置校验：viewer 不能建、属性 / 条件对不上、条件值没填；挂靠页上的列表带主人名', async () => {
    const t = await team()
    const f = await newCollection(t)
    const post = (cookie: string, config: Record<string, unknown>) =>
      call<{ error: string }>('POST', '/api/me/automations', cookie, { name: 'x', source: 'collection', config, actions: NOTIFY })
    expect((await post(t.viewer.cookie, { collection: f.id, on: 'added' })).body.error).toBe('你不能编辑这个合集')
    expect((await post(t.outsider.cookie, { collection: f.id, on: 'added' })).body.error).toBe('那个合集不在了，或者你看不到它')
    expect((await post(t.owner.cookie, { collection: f.id, on: 'edited', props: ['zzzzzzzz'] })).body.error).toBe('要看的属性有的已经不在了')
    expect((await post(t.owner.cookie, { collection: f.id, on: 'edited', filter: { all: [{ prop: f.status.id, op: 'checked' }] } })).body.error).toBe(
      `条件「${f.status.name}」的比较方式不适用于这种属性`,
    )
    expect((await post(t.owner.cookie, { collection: f.id, on: 'edited', filter: { all: [{ prop: f.status.id, op: 'is' }] } })).body.error).toBe(
      `条件「${f.status.name}」的值没填好`,
    )
    expect((await post(t.owner.cookie, { collection: f.id, on: 'sometimes' })).status).toBe(400)

    const mine = await rule(t.member.cookie, 'amy 的', { collection: f.id, on: 'added' }, NOTIFY)
    const seen = await call<{ automations: AutomationView[] }>('GET', `/api/pages/${f.id}/automations`, t.owner.cookie)
    expect(seen.body.automations.map((r) => [r.id, r.ownerName])).toEqual([[mine.id, t.member.name]])
    // 合集进了回收站：不触发
    await pool.query('UPDATE pages SET deleted_at = now()::text WHERE id = $1', [f.id])
    await postPage(t.member.cookie, { space_id: t.spaceId, parent_id: f.id }).catch(() => undefined)
    await drain()
    expect(await events(mine.id)).toEqual([])
  }, 60_000)
})
