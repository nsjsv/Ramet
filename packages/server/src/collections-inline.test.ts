import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { referencedInlineCollections } from './collections/inline.js'
import {
  call,
  connect,
  eventually,
  newCollection,
  pool,
  postCollection,
  postPage,
  postRow,
  team,
  watchControl,
  type Team,
} from './collections/test-kit.js'

// 内联集合的生命周期：唯一执行者是宿主正文的存储钩子，只认「集合」块（collection_inline）从正文里消失 / 回来。
// 侧栏删除、挪走都不归它管；链接视图块不拥有数据。钩子挂在 onStoreDocument 上，
// 要等 Hocuspocus 的存储防抖（约 2 秒），断言一律 eventually

type State = { deleted_at: string | null; trashed_by_block: boolean; ref_host: string | null }

async function stateOf(collectionId: string): Promise<State | undefined> {
  const { rows } = await pool.query<State>(
    `SELECT p.deleted_at, c.trashed_by_block, c.ref_host FROM pages p JOIN collections c ON c.page_id = p.id WHERE p.id = $1`,
    [collectionId],
  )
  return rows[0]
}

async function deletedAt(pageId: string): Promise<string | null | undefined> {
  return (await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE id = $1', [pageId])).rows[0]?.deleted_at
}

/** 宿主的正文索引：同一个存储钩子刷新它 —— 看它变了就知道这一次存储（连同内联集合对齐）已经跑完 */
async function bodyText(pageId: string): Promise<string> {
  return (await pool.query<{ content_text: string | null }>('SELECT content_text FROM pages WHERE id = $1', [pageId])).rows[0]?.content_text ?? ''
}

function block(name: 'collection_inline' | 'collection_link', collectionId: string): Y.XmlElement {
  const el = new Y.XmlElement(name)
  el.setAttribute('id', crypto.randomUUID())
  el.setAttribute('collectionId', collectionId)
  el.setAttribute('viewId', '')
  el.setAttribute('title', '内嵌')
  return el
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  p.insert(0, [t])
  t.insert(0, text)
  return p
}

function body(p: HocuspocusProvider): Y.XmlFragment {
  return p.document.getXmlFragment('prosemirror')
}

function append(p: HocuspocusProvider, ...nodes: Y.XmlElement[]): void {
  const fragment = body(p)
  fragment.insert(fragment.length, nodes)
}

/** 删掉正文里引用这个集合的某种块（顶层） */
function removeBlocks(p: HocuspocusProvider, name: string, collectionId: string): void {
  const fragment = body(p)
  p.document.transact(() => {
    for (let i = fragment.length - 1; i >= 0; i--) {
      const node = fragment.get(i)
      if (node instanceof Y.XmlElement && node.nodeName === name && node.getAttribute('collectionId') === collectionId) fragment.delete(i, 1)
    }
  })
}

/** 宿主页 + 连着它正文的协同连接（member） + 一个先插块、后建的内联集合（带一行） */
async function hostWithInline(t: Team): Promise<{ host: string; p: HocuspocusProvider; cid: string; row: string }> {
  const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
  const p = await connect(`page:${host}`, t.member.cookie)
  const cid = crypto.randomUUID()
  append(p, block('collection_inline', cid))
  const created = await postCollection(t.member.cookie, { id: cid, space_id: t.spaceId, parent_id: host, inline: true, title: '内嵌' })
  expect(created.status).toBe(201)
  const row = (await postRow(t.member.cookie, cid, { title: '行' })).body.id
  expect(await stateOf(cid)).toMatchObject({ deleted_at: null, trashed_by_block: false, ref_host: host })
  // 等宿主至少存储过一次（块进了正文索引）：之后「删块后没发生什么」的断言才是在存储之后看的
  await eventually(async () => expect(await bodyText(host)).toContain(`collection:${cid}`))
  expect(await stateOf(cid)).toMatchObject({ deleted_at: null })
  return { host, p, cid, row }
}

describe('「集合」块拥有内联集合', () => {
  test('删块 → 存储 → 集合连同行进回收站（trashed_by_block）并广播 changed；块回来 → 存储 → 恢复', async () => {
    const t = await team()
    const { p, cid, row } = await hostWithInline(t)
    const control = await watchControl(t.viewer.cookie)
    removeBlocks(p, 'collection_inline', cid)
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ trashed_by_block: true, deleted_at: expect.any(String) }))
    expect(await deletedAt(row)).not.toBeNull()
    await eventually(() => expect(control).toContain('changed'))
    // 撤销：块回来（新元素，同一个集合）
    append(p, block('collection_inline', cid))
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ deleted_at: null, trashed_by_block: false }))
    expect(await deletedAt(row)).toBeNull()
  })

  test('引用在任意深度都算（分栏里的块）；先插块、后建集合的中间态不报错，建好之后删块才会回收', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
    const p = await connect(`page:${host}`, t.member.cookie)
    const cid = crypto.randomUUID()
    const columns = new Y.XmlElement('columns')
    const column = new Y.XmlElement('column')
    columns.insert(0, [column])
    column.insert(0, [block('collection_inline', cid)])
    append(p, columns)
    expect(referencedInlineCollections(body(p))).toEqual(new Set([cid]))
    // 集合还不存在时就存储了一次（正文索引里已经有这个块）：什么都不发生
    await eventually(async () => expect(await bodyText(host)).toContain(`collection:${cid}`))
    expect((await postCollection(t.member.cookie, { id: cid, space_id: t.spaceId, parent_id: host, inline: true })).status).toBe(201)
    // 分栏里的块还在：别的编辑触发存储也不回收
    append(p, paragraph('别的编辑'))
    await eventually(async () => expect(await bodyText(host)).toContain('别的编辑'))
    expect(await stateOf(cid)).toMatchObject({ deleted_at: null, trashed_by_block: false })
    // 删掉整个分栏：回收
    p.document.transact(() => body(p).delete(0, 1))
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ trashed_by_block: true, deleted_at: expect.any(String) }))
  })

  test('侧栏回收（块还在）：之后存储不恢复它；块那边状态是 trashed', async () => {
    const t = await team()
    const { host, p, cid } = await hostWithInline(t)
    expect((await call('POST', `/api/pages/${cid}/trash`, t.member.cookie, {})).status).toBe(200)
    append(p, paragraph('侧栏删了以后又编辑'))
    await eventually(async () => expect(await bodyText(host)).toContain('侧栏删了以后又编辑'))
    expect(await stateOf(cid)).toMatchObject({ trashed_by_block: false, deleted_at: expect.any(String) })
    expect((await call('GET', `/api/collections/${cid}/state`, t.viewer.cookie)).body).toMatchObject({ state: 'trashed', parent_id: host })
    // 从回收站恢复后块直接可用；块仍在，之后存储也不动它
    expect((await call('POST', `/api/pages/${cid}/restore`, t.member.cookie, {})).status).toBe(200)
    append(p, paragraph('恢复以后'))
    await eventually(async () => expect(await bodyText(host)).toContain('恢复以后'))
    expect(await stateOf(cid)).toMatchObject({ deleted_at: null, trashed_by_block: false, ref_host: host })
  })

  test('块带走的回收被手动恢复：宿主再存储不再回收，只解除所有权；块再插回来重新登记，删块照常回收', async () => {
    const t = await team()
    const { host, p, cid, row } = await hostWithInline(t)
    removeBlocks(p, 'collection_inline', cid)
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ trashed_by_block: true, deleted_at: expect.any(String) }))
    // 用户在回收站里手动恢复（块仍不在正文里）
    expect((await call('POST', `/api/pages/${cid}/restore`, t.member.cookie, {})).status).toBe(200)
    append(p, paragraph('恢复以后再编辑'))
    await eventually(async () => expect(await bodyText(host)).toContain('恢复以后再编辑'))
    await eventually(async () => expect(await stateOf(cid)).toEqual({ deleted_at: null, trashed_by_block: false, ref_host: null }))
    expect(await deletedAt(row)).toBeNull()
    // 再编辑一次：它现在是宿主下的普通子集合，仍不回收
    append(p, paragraph('又一次编辑'))
    await eventually(async () => expect(await bodyText(host)).toContain('又一次编辑'))
    expect(await stateOf(cid)).toEqual({ deleted_at: null, trashed_by_block: false, ref_host: null })
    // 块插回来：存储后重新登记 ref_host；删掉块：照常回收
    append(p, block('collection_inline', cid))
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ deleted_at: null, ref_host: host }))
    removeBlocks(p, 'collection_inline', cid)
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ trashed_by_block: true, deleted_at: expect.any(String) }))
  })

  test('挪走以后：新宿主存储不回收它（ref_host 不是新宿主），删掉原宿主里的块也不回收它', async () => {
    const t = await team()
    const { host, p, cid } = await hostWithInline(t)
    const other = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '新宿主' })
    expect((await call('PATCH', `/api/pages/${cid}`, t.member.cookie, { parent_id: other })).status).toBe(200)
    const q = await connect(`page:${other}`, t.member.cookie)
    append(q, paragraph('新宿主的编辑'))
    await eventually(async () => expect(await bodyText(other)).toContain('新宿主的编辑'))
    expect(await stateOf(cid)).toMatchObject({ deleted_at: null, ref_host: host })
    removeBlocks(p, 'collection_inline', cid)
    await eventually(async () => expect(await bodyText(host)).not.toContain(`collection:${cid}`))
    expect(await stateOf(cid)).toMatchObject({ deleted_at: null, trashed_by_block: false })
  })

  test('链接视图块从不影响数据：增删链接不回收任何集合；只剩链接、「集合」块没了照样回收', async () => {
    const t = await team()
    const { host, p, cid } = await hostWithInline(t)
    const whole = await newCollection(t, { title: '整页集合' })
    append(p, block('collection_link', whole.id), block('collection_link', cid))
    await eventually(async () => expect(await bodyText(host)).toContain(`collection:${whole.id}`))
    removeBlocks(p, 'collection_link', whole.id)
    await eventually(async () => expect(await bodyText(host)).not.toContain(`collection:${whole.id}`))
    expect(await deletedAt(whole.id)).toBeNull()
    expect(await stateOf(cid)).toMatchObject({ deleted_at: null })
    // 链接视图不是所有者：删掉「集合」块，只剩指向它的链接视图，集合照样进回收站
    removeBlocks(p, 'collection_inline', cid)
    await eventually(async () => expect(await stateOf(cid)).toMatchObject({ trashed_by_block: true, deleted_at: expect.any(String) }))
    expect(await deletedAt(whole.id)).toBeNull()
  })
})

describe('GET /api/collections/:id/state', () => {
  test('活的 / 在回收站都能读（任意成员角色），非成员、不存在、不是集合同 404', async () => {
    const t = await team()
    const host = await postPage(t.owner.cookie, { space_id: t.spaceId, title: '宿主' })
    const created = await postCollection(t.owner.cookie, { space_id: t.spaceId, parent_id: host, inline: true, title: '状态' })
    const cid = created.body.id
    const live = await call('GET', `/api/collections/${cid}/state`, t.viewer.cookie)
    expect(live.status).toBe(200)
    expect(live.body).toEqual({ state: 'live', parent_id: host, title: '状态', inline: true })
    const whole = await newCollection(t)
    expect((await call('GET', `/api/collections/${whole.id}/state`, t.member.cookie)).body).toEqual({
      state: 'live',
      parent_id: null,
      title: '任务',
      inline: false,
    })
    expect((await call('POST', `/api/pages/${cid}/trash`, t.owner.cookie, {})).status).toBe(200)
    expect((await call('GET', `/api/collections/${cid}/state`, t.member.cookie)).body).toMatchObject({ state: 'trashed', parent_id: host })
    const outsider = await call('GET', `/api/collections/${cid}/state`, t.outsider.cookie)
    const missing = await call('GET', `/api/collections/${crypto.randomUUID()}/state`, t.owner.cookie)
    const notCollection = await call('GET', `/api/collections/${host}/state`, t.owner.cookie)
    for (const res of [outsider, missing, notCollection]) expect(res.status).toBe(404)
    expect(outsider.body).toEqual(missing.body)
    expect(notCollection.body).toEqual(missing.body)
    expect((await call('GET', `/api/collections/${cid}/state`, null)).status).toBe(401)
  })
})
