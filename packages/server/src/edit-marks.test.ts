/* ---------- 上次编辑（edit-marks.ts）----------
 * 前半直接驱动 trackEdits / flushEditMarks（本地 Y.Doc + 与 Hocuspocus 连接同形的 origin），断言归属规则；
 * 后半走真实协同连接与 GET /api/pages/:id/edit-marks，断言钩子接线、权限与头像可见性。 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { findBlockElement } from './block-ids.js'
import { flushEditMarks, readEditMarks, trackEdits, type EditMarks } from './edit-marks.js'
import { base, connectDoc, joinPageSpace, pool, postJson, setupPage, userIdOf, waitFor } from './agents/test-kit.js'

const by = (id: string, agent?: string) => ({ context: { user: { id }, actor: agent ? { kind: 'agent', agent } : undefined } })

function para(id: string | null, text = ''): Y.XmlElement {
  const el = new Y.XmlElement('paragraph')
  if (id) el.setAttribute('id', id)
  const t = new Y.XmlText()
  if (text) t.insert(0, text)
  el.insert(0, [t])
  return el
}

function listItem(id: string, text: string): Y.XmlElement {
  const li = new Y.XmlElement('list_item')
  li.setAttribute('id', id)
  li.insert(0, [para(null, text)])
  return li
}

function findById(root: Y.XmlFragment, id: string): Y.XmlElement {
  const el = findBlockElement(root, id)
  if (!el) throw new Error(`找不到块 ${id}`)
  return el
}

const textOf = (el: Y.XmlElement): Y.XmlText => el.get(0) as Y.XmlText

/** 一页 + alice（owner）+ bob / carol（member）；返回 page 行与三人 id */
async function fixture() {
  const { pageId } = await setupPage()
  await joinPageSpace(pageId, 'bob')
  await joinPageSpace(pageId, 'carol')
  const page = (await pool.query<{ id: string; space_id: string | null }>('SELECT id, space_id FROM pages WHERE id = $1', [pageId])).rows[0]!
  return { page, alice: await userIdOf('alice'), bob: await userIdOf('bob'), carol: await userIdOf('carol') }
}

/** 整页（block 缺省）或某块的标记，带上人名 / 头像；没有记录 → null */
function pick(m: EditMarks, block?: string) {
  const mark = block === undefined ? m.page : m.blocks[block]
  if (!mark) return null
  const user = mark.user_id ? m.users[mark.user_id] : undefined
  return { ...mark, username: user?.username ?? null, avatar: user?.avatar ?? null }
}

async function markOf(page: { id: string; space_id: string | null }, block?: string) {
  return pick(await readEditMarks(pool, page), block)
}

async function who(page: { id: string; space_id: string | null }, block?: string): Promise<string | null> {
  return (await markOf(page, block))?.username ?? null
}

test('两人各改一块：块各归各的，整页归最后一个', async () => {
  const { page, alice, bob } = await fixture()
  const doc = new Y.Doc()
  trackEdits(doc)
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => body.insert(0, [para('b1', 'one'), para('b2', 'two')]), by(alice))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page, 'b1')).toBe('alice')
  expect(await who(page, 'b2')).toBe('alice')
  expect(await who(page)).toBe('alice')

  doc.transact(() => textOf(findById(body, 'b2')).insert(3, '!'), by(bob))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page, 'b1')).toBe('alice')
  expect(await who(page, 'b2')).toBe('bob')
  expect(await who(page)).toBe('bob')
})

test('列表：改一项 = 这一项和所在顶层列表都算被改；新插的项也记上', async () => {
  const { page, alice, bob, carol } = await fixture()
  const doc = new Y.Doc()
  trackEdits(doc)
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    const list = new Y.XmlElement('bullet_list')
    list.setAttribute('id', 'L')
    list.insert(0, [listItem('I1', 'a'), listItem('I2', 'b')])
    body.insert(0, [list, para('P', 'p')])
  }, by(alice))
  await flushEditMarks(pool, page.id, doc)

  doc.transact(() => textOf(findById(body, 'I1').get(0) as Y.XmlElement).insert(1, 'x'), by(bob))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page, 'I1')).toBe('bob')
  expect(await who(page, 'L')).toBe('bob')
  expect(await who(page, 'I2')).toBe('alice')
  expect(await who(page, 'P')).toBe('alice')

  doc.transact(() => findById(body, 'L').insert(2, [listItem('I3', 'c')]), by(carol))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page, 'I3')).toBe('carol')
  expect(await who(page, 'L')).toBe('carol')
  expect(await who(page, 'I1')).toBe('bob')
})

test('只补 / 换块 id 不算编辑；id 在同一批里后补的，落库时按后补的 id 记', async () => {
  const { page, alice, carol } = await fixture()
  const doc = new Y.Doc()
  trackEdits(doc)
  const body = doc.getXmlFragment('prosemirror')
  // 同一批：alice 新建没有 id 的块，carol 的客户端随后补 id —— 块记给 alice（id 落库时才读）
  doc.transact(() => body.insert(0, [para(null, 'new')]), by(alice))
  doc.transact(() => (body.get(0) as Y.XmlElement).setAttribute('id', 'late'), by(carol))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page, 'late')).toBe('alice')
  expect(await who(page)).toBe('alice')

  // 已落库之后再换 id：既不改整页归属，也不给新 id 造记录
  doc.transact(() => (body.get(0) as Y.XmlElement).setAttribute('id', 'renamed'), by(carol))
  await flushEditMarks(pool, page.id, doc)
  expect(await who(page)).toBe('alice')
  expect(await markOf(page, 'renamed')).toBeNull()
})

test('AI 写入记成 agent；没有 context 的内部写入不算；标题只记整页；删掉的块不落库', async () => {
  const { page, alice, bob } = await fixture()
  const doc = new Y.Doc()
  trackEdits(doc)
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => body.insert(0, [para('sys', 'loaded')])) // 无 origin：同从库加载
  await flushEditMarks(pool, page.id, doc)
  expect(await markOf(page)).toBeNull()
  expect(await markOf(page, 'sys')).toBeNull()

  doc.transact(() => body.insert(1, [para('r1', 'reply')]), by(alice, 'fake'))
  await flushEditMarks(pool, page.id, doc)
  expect(await markOf(page, 'r1')).toMatchObject({ username: 'alice', actor: 'agent', actor_agent: 'fake' })

  doc.transact(() => {
    const title = doc.getXmlFragment('title')
    title.insert(0, [para(null, 'T')])
  }, by(bob))
  await flushEditMarks(pool, page.id, doc)
  expect(await markOf(page)).toMatchObject({ username: 'bob', actor: 'user', actor_agent: null })
  expect(await who(page, 'r1')).toBe('alice')

  doc.transact(() => body.insert(2, [para('gone', 'x')]), by(bob))
  doc.transact(() => body.delete(2, 1), by(bob))
  await flushEditMarks(pool, page.id, doc)
  expect(await markOf(page, 'gone')).toBeNull()
})

test('端到端：协同编辑经存储钩子落库，edit-marks 接口按权限读；头像只给仍在空间里的编辑者', async () => {
  const { cookie, pageId } = await setupPage()
  const bobCookie = await joinPageSpace(pageId, 'bob')
  const viewerCookie = await joinPageSpace(pageId, 'vera', { role: 'viewer' })
  const get = async (path: string, c: string) => fetch(`${base}${path}`, { headers: { cookie: c } })
  const infoOf = async (c: string, block?: string) => {
    const res = await get(`/api/pages/${pageId}/edit-marks`, c)
    return res.status === 200 ? pick((await res.json()) as EditMarks, block) : null
  }

  // 回落：还没有任何协同编辑时，整页取最新一条快照的作者
  expect((await postJson(`/api/pages/${pageId}/snapshots`, cookie)).status).toBe(201)
  expect(await infoOf(cookie)).toMatchObject({ username: 'alice', actor: 'user' })
  expect(await infoOf(cookie, 'nope')).toBeNull()

  await pool.query("UPDATE users SET avatar_file_id = 'avatar-file' WHERE username = 'bob'")
  const p = await connectDoc(pageId, bobCookie)
  try {
    p.document.transact(() => p.document.getXmlFragment('prosemirror').insert(0, [para('e2e', 'hi')]))
    await waitFor(async () => (await infoOf(cookie, 'e2e'))?.username === 'bob')
  } finally {
    p.destroy()
  }
  const info = await infoOf(viewerCookie)
  expect(info).toMatchObject({ username: 'bob', avatar: 'avatar-file', actor: 'user' })
  expect(Number.isNaN(Date.parse(info?.at ?? ''))).toBe(false)

  // bob 退出空间：名字照给，头像不再给
  await pool.query('DELETE FROM space_members WHERE user_id = $1', [await userIdOf('bob')])
  expect(await infoOf(cookie, 'e2e')).toMatchObject({ username: 'bob', avatar: null })

  // 非成员一律 404（不泄露存在性）
  expect((await get(`/api/pages/${pageId}/edit-marks`, bobCookie)).status).toBe(404)
})
