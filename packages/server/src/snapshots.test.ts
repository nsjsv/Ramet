import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { CHECKPOINT_EVERY, insertSnapshot, materializeSnapshot, maybeAutoSnapshot, noteEditor } from './collab.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test),防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)
const cleanup: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  // 每个用例从空库出发,序列归零;users 被 pages/sessions/spaces 外键引用,须同一语句一并清
  await truncateAll(pool)
})

afterAll(async () => {
  for (const fn of cleanup.reverse()) {
    try {
      await fn()
    } catch {
      // 兜底清理，单个失败不影响其余
    }
  }
  await closePool()
})

// 直插用户行(密码只走 hash),绕开 admin 接口,减少用例间依赖
async function createUser(username: string): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    hashPassword('password'),
    'user',
  ])
  return id
}

// 走真实登录拿 cookie,顺带覆盖 login 接口在协作链路里的可用性
async function login(port: number, username: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie || !cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

async function createPage(port: number, cookie: string, body: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

// provider 的 WebSocketPolyfill 只收 (url),包一层把会话 cookie 带进握手头
function cookieWebSocket(cookie: string) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie } })
    }
  }
}

function connect(
  port: number,
  docName: string,
  doc: Y.Doc,
  cookie: string,
): HocuspocusProvider {
  // preserveConnection:false → destroy() 连底层 ws 一起断;否则 destroy 后服务端回关连接,
  // 客户端自动重连,会给下一个用例留幽灵连接
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: docName,
    document: doc,
    preserveConnection: false,
  })
  cleanup.push(() => provider.destroy())
  return provider
}

// 造一个含标题+正文的页面全量快照(结构与线上一致:title/prosemirror 两个 fragment,
// 都是 paragraph > text)
function makeDocSnapshot(title: string, body: string): Buffer {
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, body)
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  const titleParagraph = new Y.XmlElement('paragraph')
  const titleText = new Y.XmlText()
  titleText.insert(0, title)
  titleParagraph.insert(0, [titleText])
  doc.getXmlFragment('title').insert(0, [titleParagraph])
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

function base64ToDoc(base64: string): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)))
  return doc
}

async function snapshotCount(pageId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM page_snapshots WHERE page_id = $1', [
    pageId,
  ])
  return rows[0]!.n
}

test('手动快照:POST → 201 立即出现在列表;详情 data 解码后与已编辑内容一致', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)
  const docName = `page:${pageId}`

  // 连上后编辑标题与正文(服务端 onLoadDocument 已播种空标题段落)
  const docA = new Y.Doc()
  const p = connect(port, docName, docA, cookie)
  await vi.waitFor(() => expect(p.synced).toBe(true), { timeout: 15_000, interval: 50 })
  const titleParagraph = docA.getXmlFragment('title').get(0) as Y.XmlElement
  ;(titleParagraph.get(0) as Y.XmlText).insert(0, '协同标题')
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '正文第一段')
  paragraph.insert(0, [text])
  docA.getXmlFragment('prosemirror').insert(0, [paragraph])
  // 等增量落库:服务端内存文档同源,POST 走活文档分支
  await vi.waitFor(async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_name = $1',
      [docName],
    )
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1)
  }, { timeout: 15_000, interval: 50 })

  const created = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(created.status).toBe(201)
  const item = (await created.json()) as { id: string; title: string; origin: string; created_at: string }
  expect(item.title).toBe('协同标题')
  expect(item.origin).toBe('manual')
  expect(item.created_at).toBeTruthy()

  const list = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, { headers: { cookie } })
  expect(list.status).toBe(200)
  const rows = (await list.json()) as { id: string; title: string; origin: string; created_at: string }[]
  expect(rows.some((r) => r.id === item.id)).toBe(true)

  // 详情的 data 是 base64,解码进临时 Y.Doc 后文本应与已编辑内容一致
  const detail = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots/${item.id}`, {
    headers: { cookie },
  })
  expect(detail.status).toBe(200)
  const body = (await detail.json()) as { data: string }
  const restored = base64ToDoc(body.data)
  expect((restored.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0).toString()).toBe('正文第一段')
  expect((restored.getXmlFragment('title').get(0) as Y.XmlElement).get(0).toString()).toBe('协同标题')

  const missing = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots/${crypto.randomUUID()}`, {
    headers: { cookie },
  })
  expect(missing.status).toBe(404)

  p.destroy()
  await s.close()
})

test('历史列表分页:limit/before 续拉不重不漏,around 以目标为中心且带回更旧一条', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  // 直插 7 条(created_at 依次拉开);分页只看元数据,所以 data 用现成全量 update 即可
  const ids: string[] = []
  for (let i = 0; i < 7; i++) {
    const id = crypto.randomUUID()
    ids.push(id)
    await pool.query(
      `INSERT INTO page_snapshots (id, page_id, title, origin, data, created_at)
       VALUES ($1, $2, $3, 'manual', $4, (now() - ($5::int * interval '1 minute'))::text)`,
      [id, pageId, `版本 ${i}`, makeDocSnapshot(`版本 ${i}`, '内容'), i],
    )
  }
  const list = async (q: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots${q}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return (await res.json()) as { id: string; created_at: string }[]
  }

  // 首页倒序:ids[0] 最新(now),ids[6] 最旧(6 分钟前)
  const first = await list('?limit=3')
  expect(first.map((r) => r.id)).toEqual([ids[0]!, ids[1]!, ids[2]!])
  // 游标续拉:严格更早、不重不漏(游标 = 上一页最后一条的 created_at,含空格与 + 要编码)
  const second = await list(`?limit=3&before=${encodeURIComponent(first[2]!.created_at)}`)
  expect(second.map((r) => r.id)).toEqual([ids[3]!, ids[4]!, ids[5]!])
  const third = await list(`?limit=3&before=${encodeURIComponent(second[2]!.created_at)}`)
  expect(second[2]!.id).toBe(ids[5])
  expect(third.map((r) => r.id)).toEqual([ids[6]!])
  // 到底了:再往前什么都没有
  expect(await list(`?limit=3&before=${encodeURIComponent(third[0]!.created_at)}`)).toEqual([])
  // 缺省 limit:一页默认 50 条(历史读取必须带窗口)
  expect((await list('')).length).toBe(7)

  // around:目标及其更旧 limit 条(倒序)+ 更晚的最多 limit 条(紧邻目标的那些),整体仍倒序
  const around = await list(`?limit=2&around=${ids[4]!}`)
  expect(around.map((r) => r.id)).toEqual([ids[2]!, ids[3]!, ids[4]!, ids[5]!])
  // around 必须带回目标的前一条(前端对比要上一版)
  expect(around.findIndex((r) => r.id === ids[4])).toBeLessThan(around.length - 1)

  await s.close()
})

test('手动快照:无活文档时从 DB 重建(快照 + 按 seq 重放增量 + 标题播种)', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)
  const docName = `page:${pageId}`

  // 不连 ws:预置 yjs_documents 全量快照行 + 一条增量(在 base 之上追加文本)
  const base = makeDocSnapshot('快照标题', 'base')
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [docName, base])
  const d1 = new Y.Doc()
  Y.applyUpdate(d1, base)
  const sv = Y.encodeStateVector(d1)
  const para = d1.getXmlFragment('prosemirror').get(0) as Y.XmlElement
  ;(para.get(0) as Y.XmlText).insert(4, ' + delta')
  await pool.query('INSERT INTO yjs_updates (doc_name, data) VALUES ($1, $2)', [
    docName,
    Buffer.from(Y.encodeStateAsUpdate(d1, sv)),
  ])

  const created = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(created.status).toBe(201)
  const item = (await created.json()) as { id: string; title: string }
  // 标题取自 Y.Doc title fragment(非 pages.title)
  expect(item.title).toBe('快照标题')

  const detail = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots/${item.id}`, {
    headers: { cookie },
  })
  expect(detail.status).toBe(200)
  const body = (await detail.json()) as { data: string }
  const restored = base64ToDoc(body.data)
  expect((restored.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0).toString()).toBe('base + delta')

  await s.close()
})

test('自动快照:生成;间隔内去重;最近一条拨回 6 分钟后再调重新生成', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const cookie = await login(s.port, 'alice')
  const { id: pageId } = await createPage(s.port, cookie)
  const docName = `page:${pageId}`

  const doc = new Y.Doc()
  const titleParagraph = new Y.XmlElement('paragraph')
  const titleText = new Y.XmlText()
  titleText.insert(0, '自动标题')
  titleParagraph.insert(0, [titleText])
  doc.getXmlFragment('title').insert(0, [titleParagraph])

  // 刚建的页面:只有标题 + 带块 id 的空段落,还没有任何版本 → 不记
  const blank = new Y.XmlElement('paragraph')
  blank.setAttribute('id', 'b1')
  blank.insert(0, [new Y.XmlText()])
  doc.getXmlFragment('prosemirror').insert(0, [blank])
  await maybeAutoSnapshot(pool, docName, doc)
  expect(await snapshotCount(pageId)).toBe(0)

  const first = new Y.XmlText()
  first.insert(0, '第一次编辑')
  const firstParagraph = new Y.XmlElement('paragraph')
  firstParagraph.insert(0, [first])
  doc.getXmlFragment('prosemirror').insert(1, [firstParagraph])
  await maybeAutoSnapshot(pool, docName, doc)
  const rows = await pool.query<{ origin: string; title: string }>(
    'SELECT origin, title FROM page_snapshots WHERE page_id = $1',
    [pageId],
  )
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]!.origin).toBe('auto')
  expect(rows.rows[0]!.title).toBe('自动标题')

  // 5 分钟内再调:间隔去重,不新增
  await maybeAutoSnapshot(pool, docName, doc)
  expect(await snapshotCount(pageId)).toBe(1)

  // 最近一条 auto 快照拨回 6 分钟前,且内容有变(零变更会被空增量闸跳过)时重新生成
  await pool.query(
    "UPDATE page_snapshots SET created_at = (now() - interval '6 minutes')::text WHERE page_id = $1",
    [pageId],
  )
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '第二次编辑的内容')
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  await maybeAutoSnapshot(pool, docName, doc)
  expect(await snapshotCount(pageId)).toBe(2)

  // 零变更再触发(拨旧绕过间隔闸):空增量闸跳过,不插行。空增量判定在 insertSnapshot 里,auto 与手动共用。
  // 只拨最新一条:两行同 created_at 时基准由 id 随机决出,可能相对旧基准解出非空增量
  await pool.query(
    `UPDATE page_snapshots SET created_at = (now() - interval '6 minutes')::text
     WHERE id = (SELECT id FROM page_snapshots WHERE page_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)`,
    [pageId],
  )
  await maybeAutoSnapshot(pool, docName, doc)
  expect(await snapshotCount(pageId)).toBe(2)

  await s.close()
})

test('自动快照:AI 写入不受 5 分钟去重挡住，并记成 agent', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const cookie = await login(s.port, 'alice')
  const { id: pageId } = await createPage(s.port, cookie)
  const doc = new Y.Doc()
  const title = new Y.XmlElement('paragraph')
  const titleText = new Y.XmlText()
  titleText.insert(0, '页')
  title.insert(0, [titleText])
  doc.getXmlFragment('title').insert(0, [title])
  const first = new Y.XmlElement('paragraph')
  const firstText = new Y.XmlText()
  firstText.insert(0, '用户先写的')
  first.insert(0, [firstText])
  doc.getXmlFragment('prosemirror').insert(0, [first])

  await maybeAutoSnapshot(pool, `page:${pageId}`, doc)
  expect(await snapshotCount(pageId)).toBe(1)

  const reply = new Y.XmlElement('paragraph')
  const replyText = new Y.XmlText()
  replyText.insert(0, 'AI 补的回复')
  reply.insert(0, [replyText])
  doc.getXmlFragment('prosemirror').insert(1, [reply])
  noteEditor(doc, { userId: null, kind: 'agent', agent: 'fake' })
  await maybeAutoSnapshot(pool, `page:${pageId}`, doc)
  expect(await snapshotCount(pageId)).toBe(2)

  const { rows } = await pool.query<{ actor: string; actor_agent: string | null }>(
    'SELECT actor, actor_agent FROM page_snapshots WHERE page_id = $1 ORDER BY created_at, id',
    [pageId],
  )
  expect(rows[0]).toEqual({ actor: 'user', actor_agent: null })
  expect(rows[1]).toEqual({ actor: 'agent', actor_agent: 'fake' })

  // 只有 AI 快照时，用户马上改也要另存一条（过程页归档后立刻改一个步骤）
  const pageOnlyAgent = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageOnlyAgent])
  const agentDoc = new Y.Doc()
  const line = new Y.XmlElement('run_step')
  const lineText = new Y.XmlText()
  lineText.insert(0, '读 acp.ts')
  line.insert(0, [lineText])
  agentDoc.getXmlFragment('prosemirror').insert(0, [line])
  noteEditor(agentDoc, { userId: null, kind: 'agent', agent: 'fake' })
  await maybeAutoSnapshot(pool, `page:${pageOnlyAgent}`, agentDoc)
  expect(await snapshotCount(pageOnlyAgent)).toBe(1)
  const edited = new Y.XmlText()
  edited.insert(0, '读 collab.ts')
  const editedLine = new Y.XmlElement('run_step')
  editedLine.insert(0, [edited])
  agentDoc.getXmlFragment('prosemirror').insert(1, [editedLine])
  noteEditor(agentDoc, { userId: null, kind: 'user', agent: null })
  await maybeAutoSnapshot(pool, `page:${pageOnlyAgent}`, agentDoc)
  expect(await snapshotCount(pageOnlyAgent)).toBe(2)

  await s.close()
})

test('版本永不删除:超检查点间隔也不裁行,历史全在且每个版本都能物化', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  const text = doc.getText('t')
  text.insert(0, 'A0')
  const expected: string[] = ['A0']
  const ids: string[] = []
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  ids.push(v1!.id)
  // 跨过检查点间隔,确保中间行既没被裁,也不影响后续读
  for (let i = 1; i <= CHECKPOINT_EVERY + 6; i++) {
    text.insert(text.length, `+${i}`)
    expected.push(text.toString())
    const r = await insertSnapshot(pool, pageId, 't', 'manual', doc)
    ids.push(r!.id)
  }
  // 行数等于版本数,没有任何删除路径
  expect(await snapshotCount(pageId)).toBe(CHECKPOINT_EVERY + 7)

  const { rows } = await pool.query<{ id: string; created_at: string }>(
    'SELECT id, created_at FROM page_snapshots WHERE page_id = $1 ORDER BY created_at ASC, id ASC',
    [pageId],
  )
  // 链序等于插入序,且 created_at 严格递增(物化应用序正确的前提)
  expect(rows.map((r) => r.id)).toEqual(ids)
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]!.created_at > rows[i - 1]!.created_at).toBe(true)
  }

  // 首版、检查点前一行、检查点行、检查点后一行、最新,物化都必须等于当时内容
  for (const j of [0, CHECKPOINT_EVERY - 1, CHECKPOINT_EVERY, CHECKPOINT_EVERY + 1, ids.length - 1]) {
    const d = await materializeSnapshot(pool, pageId, ids[j]!)
    expect(d).not.toBeNull()
    expect(d!.getText('t').toString()).toBe(expected[j]!)
  }
  // 他页快照 id 不在本页链上,返回 null(路由 404)
  expect(await materializeSnapshot(pool, pageId, crypto.randomUUID())).toBeNull()
})

test('增量链:首条全量锚点带 sv,小改动后第二条为增量(data 字节明显小于全量)', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '第一版的正文内容,写得足够长一些,放大全量与增量之间的字节差')
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  const v1 = await insertSnapshot(pool, pageId, '版本一', 'manual', doc)
  expect(v1).not.toBeNull()
  // 同一 doc 上小改动,第二条应为增量
  text.insert(0, '!')
  const v2 = await insertSnapshot(pool, pageId, '版本二', 'manual', doc)
  expect(v2).not.toBeNull()

  const rowOf = async (id: string) =>
    (
      await pool.query<{ data: Buffer; sv: Buffer | null }>(
        'SELECT data, sv FROM page_snapshots WHERE id = $1',
        [id],
      )
    ).rows[0]!
  const r1 = await rowOf(v1!.id)
  const r2 = await rowOf(v2!.id)
  expect(r1.data.byteLength).toBeGreaterThan(r2.data.byteLength) // delta < full
  expect(r1.sv).not.toBeNull() // 新行必带 sv(增量基准)
  expect(r2.sv).not.toBeNull()

  // 对外契约:GET 详情由服务端物化,返回全量 update 的 base64,内容为 v2 时刻
  const detail = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots/${v2!.id}`, {
    headers: { cookie },
  })
  expect(detail.status).toBe(200)
  const restored = base64ToDoc(((await detail.json()) as { data: string }).data)
  expect((restored.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0).toString()).toBe(
    '!第一版的正文内容,写得足够长一些,放大全量与增量之间的字节差',
  )

  await s.close()
})

test('增量链物化:v1 编辑→v2→再编辑→v3,中间版本物化内容正确,不在链上返回 null', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, 'v1')
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  text.insert(2, '-二') // v2 时刻: 'v1-二'
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  text.insert(0, '三-') // v3 时刻: '三-v1-二'
  const v3 = await insertSnapshot(pool, pageId, 't', 'manual', doc)

  const bodyText = async (id: string) => {
    const d = await materializeSnapshot(pool, pageId, id)
    expect(d).not.toBeNull()
    return (d!.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0).toString()
  }
  expect(await bodyText(v1!.id)).toBe('v1')
  expect(await bodyText(v2!.id)).toBe('v1-二')
  expect(await bodyText(v3!.id)).toBe('三-v1-二')
  // 目标不在链上(不存在)返回 null,路由层映射 404
  expect(await materializeSnapshot(pool, pageId, crypto.randomUUID())).toBeNull()
})

test('旧格式兼容:sv NULL 的全量行在链首/链中都能作为增量基准,物化正确', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])

  // 链首:直插一条旧格式全量行(sv = NULL),模仿存量数据
  const oldDoc = new Y.Doc()
  const oldParagraph = new Y.XmlElement('paragraph')
  const oldText = new Y.XmlText()
  oldText.insert(0, '旧格式')
  oldParagraph.insert(0, [oldText])
  oldDoc.getXmlFragment('prosemirror').insert(0, [oldParagraph])
  const oldId = crypto.randomUUID()
  await pool.query(
    `INSERT INTO page_snapshots (id, page_id, title, origin, data, created_at)
     VALUES ($1, $2, '旧格式', 'manual', $3, (now() - interval '1 minute')::text)`,
    [oldId, pageId, Buffer.from(Y.encodeStateAsUpdate(oldDoc))],
  )

  // 在旧格式行之上小改,insertSnapshot 从其 data 现算状态向量(sv NULL 路径),产出增量
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(oldDoc))
  ;((doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, '+新')
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  expect(v2).not.toBeNull()
  const r2 = (
    await pool.query<{ data: Buffer; sv: Buffer | null }>('SELECT data, sv FROM page_snapshots WHERE id = $1', [
      v2!.id,
    ])
  ).rows[0]!
  expect(r2.data.byteLength).toBeLessThan(Buffer.from(Y.encodeStateAsUpdate(doc)).byteLength) // 增量 < 全量
  expect(r2.sv).not.toBeNull()

  // 链中:再插一条旧格式全量行(成为最新),其后再增量,链为 [旧全量, 增量, 旧全量, 增量]
  const midId = crypto.randomUUID()
  await pool.query(
    `INSERT INTO page_snapshots (id, page_id, title, origin, data, created_at)
     VALUES ($1, $2, 't', 'manual', $3, now()::text)`,
    [midId, pageId, Buffer.from(Y.encodeStateAsUpdate(doc))],
  )
  ;((doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, '改-')
  const v3 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  expect(v3).not.toBeNull()

  const bodyText = async (id: string) => {
    const d = await materializeSnapshot(pool, pageId, id)
    expect(d).not.toBeNull()
    return (d!.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0).toString()
  }
  expect(await bodyText(oldId)).toBe('旧格式')
  expect(await bodyText(v2!.id)).toBe('旧格式+新')
  expect(await bodyText(midId)).toBe('旧格式+新')
  expect(await bodyText(v3!.id)).toBe('改-旧格式+新')
})

test('检查点:第 CHECKPOINT_EVERY 行是全量,物化只从最近检查点起回放(不塌到链首)', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  const text = doc.getText('t')
  text.insert(0, 'A0')
  const expected: string[] = ['A0']
  const ids: string[] = []
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  ids.push(v1!.id)
  for (let i = 1; i <= CHECKPOINT_EVERY + 1; i++) {
    text.insert(text.length, `+${i}`)
    expected.push(text.toString())
    const r = await insertSnapshot(pool, pageId, 't', 'manual', doc)
    ids.push(r!.id)
  }

  // base 下标恒为间隔的整数倍(0 = 锚点,CHECKPOINT_EVERY = 第一个中间检查点)
  const bases = (
    await pool.query<{ id: string }>(
      'SELECT id FROM page_snapshots WHERE page_id = $1 AND is_base ORDER BY created_at ASC, id ASC',
      [pageId],
    )
  ).rows.map((r) => r.id)
  expect(bases).toEqual([ids[0], ids[CHECKPOINT_EVERY]])

  // 毒化检查点之前的链:读取若从链首起回放,这里必然炸或内容错
  await pool.query("UPDATE page_snapshots SET data = '\\x00' WHERE page_id = $1 AND created_at < $2", [
    pageId,
    (await pool.query<{ created_at: string }>('SELECT created_at FROM page_snapshots WHERE id = $1', [
      ids[CHECKPOINT_EVERY]!,
    ])).rows[0]!.created_at,
  ])
  // 检查点本身、其后一行、最新一行都只从检查点起回放,物化仍正确
  for (const j of [CHECKPOINT_EVERY, CHECKPOINT_EVERY + 1, ids.length - 1]) {
    const d = await materializeSnapshot(pool, pageId, ids[j]!)
    expect(d).not.toBeNull()
    expect(d!.getText('t').toString()).toBe(expected[j]!)
  }
})

test('created_at 单调:上一条被拨到未来时,新快照仍排在链尾(物化应用序不被倒挂)', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  doc.getText('t').insert(0, '一')
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  // 模拟倒挂:后插者事务先 BEGIN(now() 更早),这里直接把上一条拨到未来
  await pool.query("UPDATE page_snapshots SET created_at = '2999-01-01 00:00:00+00' WHERE id = $1", [v1!.id])
  doc.getText('t').insert(0, '二')
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  const rows = (
    await pool.query<{ id: string; created_at: string }>(
      'SELECT id, created_at FROM page_snapshots WHERE page_id = $1 ORDER BY created_at ASC, id ASC',
      [pageId],
    )
  ).rows
  expect(rows).toHaveLength(2)
  expect(rows[0]!.id).toBe(v1!.id) // v1 仍在链尾(最老)
  expect(rows[1]!.id).toBe(v2!.id) // 新行排在链尾,不倒挂
  const d = await materializeSnapshot(pool, pageId, v2!.id)
  expect(d!.getText('t').toString()).toBe('二一')
})

test('空增量跳过:内容零变化再存不插行,返回现有最新行', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '内容')
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  const v1 = await insertSnapshot(pool, pageId, '初版', 'manual', doc)
  expect(v1).not.toBeNull()
  // 未改任何内容再存(连点保存):不产生新行,返回现有最新行
  const again = await insertSnapshot(pool, pageId, '初版', 'manual', doc)
  expect(again).toEqual(v1)
  expect(await snapshotCount(pageId)).toBe(1)
})

test('改了又撤销:增量非空但内容与上一版相同,不插行;只改节点属性仍算一次修改', async () => {
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])
  const doc = new Y.Doc()
  const body = doc.getXmlFragment('prosemirror')
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '代办事项')
  paragraph.insert(0, [text])
  body.insert(0, [paragraph])
  const v1 = await insertSnapshot(pool, pageId, '代办', 'auto', doc)
  expect(v1).not.toBeNull()

  // 编辑器里的撤销:打字 / 加粗 / 删块再撤回,Yjs 状态往前走了(增量非空),读得见的内容没变
  const undo = new Y.UndoManager(body, { captureTimeout: 0 })
  text.insert(2, '一行新字')
  undo.undo()
  text.format(0, 2, { strong: true })
  undo.undo()
  body.delete(0, 1)
  undo.undo()
  expect(body.toString()).toBe('<paragraph>代办事项</paragraph>')
  const sv = (await pool.query<{ sv: Buffer }>('SELECT sv FROM page_snapshots WHERE id = $1', [v1!.id])).rows[0]!.sv
  expect(Y.decodeUpdate(Y.encodeStateAsUpdate(doc, sv)).structs.length).toBeGreaterThan(0)
  expect(await insertSnapshot(pool, pageId, '代办', 'auto', doc)).toEqual(v1)
  expect(await snapshotCount(pageId)).toBe(1)

  // 只改节点属性(勾选、块 id 等)是真修改;它的增量要包含上面那段撤销留下的 struct,物化仍正确
  ;(body.get(0) as Y.XmlElement).setAttribute('checked', 'true')
  const v2 = await insertSnapshot(pool, pageId, '代办', 'auto', doc)
  expect(v2!.id).not.toBe(v1!.id)
  const d = await materializeSnapshot(pool, pageId, v2!.id)
  expect(d!.getXmlFragment('prosemirror').toString()).toBe('<paragraph checked="true">代办事项</paragraph>')
  // 只改快照标题也算
  const v3 = await insertSnapshot(pool, pageId, '待办', 'auto', doc)
  expect(v3!.id).not.toBe(v2!.id)
  expect(await snapshotCount(pageId)).toBe(3)
})

test('权限:viewer 能看列表/详情但 POST 403;非成员一律 404;control 文档名 no-op', async () => {
  await createUser('alice')
  await createUser('bob') // 非成员
  await createUser('carol') // 将被邀请为 viewer
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const alice = await login(port, 'alice')
  const bob = await login(port, 'bob')
  const carol = await login(port, 'carol')

  const spaceRes = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ name: '共享空间' }),
  })
  expect(spaceRes.status).toBe(201)
  const space = (await spaceRes.json()) as { id: string }
  const inviteRes = await fetch(`http://127.0.0.1:${port}/api/spaces/${space.id}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: alice },
    body: JSON.stringify({ role: 'viewer' }),
  })
  expect(inviteRes.status).toBe(201)
  const invite = (await inviteRes.json()) as { token: string }
  const acceptRes = await fetch(`http://127.0.0.1:${port}/api/invites/${invite.token}/accept`, {
    method: 'POST',
    headers: { cookie: carol },
  })
  expect(acceptRes.status).toBe(200)
  const { id: pageId } = await createPage(port, alice, { space_id: space.id })

  // viewer 可见但只读:列表/详情 200,POST 403
  const vList = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, { headers: { cookie: carol } })
  expect(vList.status).toBe(200)
  const vPost = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, {
    method: 'POST',
    headers: { cookie: carol },
  })
  expect(vPost.status).toBe(403)
  // updates 端点同守卫:viewer 可读(只读信息)
  const vUpdates = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates`, {
    headers: { cookie: carol },
  })
  expect(vUpdates.status).toBe(200)
  expect(await vUpdates.json()).toEqual([])

  // 非成员 GET/POST 一律 404,不泄露存在性
  for (const cookie of [bob]) {
    const get = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, { headers: { cookie } })
    expect(get.status).toBe(404)
    const post = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/snapshots`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(post.status).toBe(404)
    // updates 端点同守卫:非成员 404 不泄露存在性
    const updates = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates`, {
      headers: { cookie },
    })
    expect(updates.status).toBe(404)
    const detail = await fetch(
      `http://127.0.0.1:${port}/api/pages/${pageId}/snapshots/${crypto.randomUUID()}`,
      { headers: { cookie } },
    )
    expect(detail.status).toBe(404)
  }

  // control 文档名走 maybeAutoSnapshot:no-op,不落任何快照
  await maybeAutoSnapshot(pool, 'control:global', new Y.Doc())
  const total = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM page_snapshots')
  expect(total.rows[0]!.n).toBe(0)

  await s.close()
})

test('删除页面 → page_snapshots 级联清空', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const page = await createPage(port, cookie)

  await pool.query('INSERT INTO page_snapshots (id, page_id, title, origin, data) VALUES ($1, $2, $3, $4, $5)', [
    crypto.randomUUID(),
    page.id,
    '待级联',
    'auto',
    makeDocSnapshot('待级联', '内容'),
  ])
  expect(await snapshotCount(page.id)).toBe(1)

  const removed = await fetch(`http://127.0.0.1:${port}/api/pages/${page.id}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  expect(removed.status).toBe(200)
  expect(await snapshotCount(page.id)).toBe(0)

  await s.close()
})
