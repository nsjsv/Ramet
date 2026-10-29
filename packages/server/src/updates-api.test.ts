import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { insertSnapshot, maybeAutoSnapshot } from './collab.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 更新流水（updates 端点 + 作者落库）端到端用例，助手与序言沿用 snapshots.test.ts。

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
    headers: { cookie, 'content-type': 'application/json' },
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

// 造 doc:title fragment 一个段落 + prosemirror fragment 若干块(每块 paragraph > text)
function makePageDoc(title: string, blocks: string[]): Y.Doc {
  const doc = new Y.Doc()
  const titleParagraph = new Y.XmlElement('paragraph')
  const titleText = new Y.XmlText()
  titleText.insert(0, title)
  titleParagraph.insert(0, [titleText])
  doc.getXmlFragment('title').insert(0, [titleParagraph])
  doc.getXmlFragment('prosemirror').insert(
    0,
    blocks.map((text) => {
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, text)
      p.insert(0, [t])
      return p
    }),
  )
  return doc
}

// updates 端点的响应形状(与 routes/pages.ts 同构)
type UpdateEntry = {
  id: string
  title: string
  origin: string
  created_at: string
  author_id: string | null
  author_username: string | null
  actor: 'user' | 'agent'
  actor_agent: string | null
  summary: { kind: string; text: string }[]
  summary_total: number
}

async function listUpdates(port: number, cookie: string, pageId: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates`, { headers: { cookie } })
  return { res, rows: (await res.json()) as UpdateEntry[] }
}

test('updates 端点:两层快照 → DESC + 首条 create + 相邻对 diff(add/title)+ 作者名;非成员 404;空链 []', async () => {
  const aliceId = await createUser('alice')
  await createUser('bob') // 非成员
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  // 尚无快照时返回空数组
  const empty = await listUpdates(port, cookie, pageId)
  expect(empty.res.status).toBe(200)
  expect(empty.rows).toEqual([])

  // v1:标题一 + 一个块(带作者,模拟手动存版)
  const doc = makePageDoc('标题一', ['第一段'])
  const v1 = await insertSnapshot(pool, pageId, '标题一', 'manual', doc, aliceId)
  expect(v1).not.toBeNull()
  // v2:尾部新增一块 + 改标题
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, '第二段')
  p.insert(0, [t])
  doc.getXmlFragment('prosemirror').insert(1, [p])
  const v2 = await insertSnapshot(pool, pageId, '标题二', 'manual', doc, aliceId)
  expect(v2).not.toBeNull()

  const { res, rows } = await listUpdates(port, cookie, pageId)
  expect(res.status).toBe(200)
  expect(rows).toHaveLength(2)
  // 倒序,最新在前(同快照列表)
  expect(rows[0]!.id).toBe(v2!.id)
  expect(rows[1]!.id).toBe(v1!.id)

  // 首条快照是链锚点,无前驱,摘要为 create
  expect(rows[1]!.summary).toEqual([{ kind: 'create', text: '' }])
  expect(rows[1]!.summary_total).toBe(1)
  // 第二条是 v1 到 v2 的 diff:新增块 + 标题变更
  expect(rows[0]!.summary).toEqual([
    { kind: 'add', text: '第二段' },
    { kind: 'title', text: '标题二' },
  ])
  expect(rows[0]!.summary_total).toBe(2)
  expect(rows[0]!.origin).toBe('manual')
  expect(rows[0]!.created_at).toBeTruthy()
  expect(rows[0]!.author_id).toBe(aliceId)
  expect(rows[0]!.author_username).toBe('alice')
  expect(rows[1]!.author_username).toBe('alice')
  expect(rows[0]!.actor).toBe('user')
  expect(rows[0]!.actor_agent).toBeNull()

  // 非成员 404,不泄露存在性(与快照列表同守卫)
  const forbidden = await listUpdates(port, await login(port, 'bob'), pageId)
  expect(forbidden.res.status).toBe(404)

  await s.close()
})

test('updates 端点:summary 截 20 项,total 记截断前项数(25 处改动)', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  // v1:25 块;v2:每块首部插入一个字,25 处全变,超过 20 项上限
  const blocks1 = Array.from({ length: 25 }, (_, i) => `旧块${i}`)
  const doc = makePageDoc('t', blocks1)
  await insertSnapshot(pool, pageId, 't', 'manual', doc)
  for (let i = 0; i < 25; i++) {
    const para = doc.getXmlFragment('prosemirror').get(i) as Y.XmlElement
    ;(para.get(0) as Y.XmlText).insert(0, '改')
  }
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc)
  expect(v2).not.toBeNull()

  const { rows } = await listUpdates(port, cookie, pageId)
  expect(rows[0]!.summary).toHaveLength(20)
  expect(rows[0]!.summary_total).toBe(25)
  expect(rows[0]!.summary.every((item) => item.kind === 'edit')).toBe(true)
  // 没带作者的快照,作者字段为 NULL(LEFT JOIN 空行)
  expect(rows[0]!.author_id).toBeNull()
  expect(rows[0]!.author_username).toBeNull()

  await s.close()
})

test('updates 端点 ?limit:只回最新 N 条,首条仍以真实前驱为 diff 基线;非法值回默认窗口', async () => {
  const aliceId = await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  // v1、v2、v3 各加一块;created_at 同秒级,插入顺序即链序(同 created_at 按 id 兜底排序)
  const doc = makePageDoc('t', ['第一段'])
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  const addBlock = (text: string) => {
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    t.insert(0, text)
    p.insert(0, [t])
    doc.getXmlFragment('prosemirror').insert(doc.getXmlFragment('prosemirror').length, [p])
  }
  addBlock('第二段')
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  addBlock('第三段')
  const v3 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  expect(v1 && v2 && v3).toBeTruthy()

  // limit=1:只有 v3,且 diff 基线是 v2(摘要为 add 第三段),不能因截窗退回 create
  const one = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates?limit=1`, {
    headers: { cookie },
  })
  const rows1 = (await one.json()) as UpdateEntry[]
  expect(rows1).toHaveLength(1)
  expect(rows1[0]!.id).toBe(v3!.id)
  expect(rows1[0]!.summary).toEqual([{ kind: 'add', text: '第三段' }])
  expect(rows1[0]!.author_username).toBe('alice')

  // limit=2:v3 和 v2,各自对真实前驱 diff
  const two = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates?limit=2`, {
    headers: { cookie },
  })
  const rows2 = (await two.json()) as UpdateEntry[]
  expect(rows2.map((r) => r.id)).toEqual([v3!.id, v2!.id])
  expect(rows2[1]!.summary).toEqual([{ kind: 'add', text: '第二段' }])

  // before 游标续拉更早一页;v1 无前驱(窗口已含链首)仍是 create
  const older = await fetch(
    `http://127.0.0.1:${port}/api/pages/${pageId}/updates?limit=2&before=${encodeURIComponent(rows2[1]!.created_at)}`,
    { headers: { cookie } },
  )
  const rowsOlder = (await older.json()) as UpdateEntry[]
  expect(rowsOlder.map((r) => r.id)).toEqual([v1!.id])
  expect(rowsOlder[0]!.summary).toEqual([{ kind: 'create', text: '' }])

  // 非法 limit(0 / 负 / 小数 / 非数字)与缺省同:窗口默认 50,本例 3 条全给,v1 仍是 create
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const res = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates?limit=${bad}`, {
      headers: { cookie },
    })
    const rows = (await res.json()) as UpdateEntry[]
    expect(rows).toHaveLength(3)
    expect(rows[2]!.summary).toEqual([{ kind: 'create', text: '' }])
  }

  await s.close()
})

test('updates 窗口跨检查点:回放从窗口前的检查点起(链首数据坏了也不影响)', async () => {
  const aliceId = await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  const doc = makePageDoc('t', ['第一段'])
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  const addBlock = (text: string) => {
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    t.insert(0, text)
    p.insert(0, [t])
    doc.getXmlFragment('prosemirror').insert(doc.getXmlFragment('prosemirror').length, [p])
  }
  addBlock('第二段')
  const v2 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  addBlock('第三段')
  const v3 = await insertSnapshot(pool, pageId, 't', 'manual', doc, aliceId)
  expect(v1 && v2 && v3).toBeTruthy()

  // 把 v2 改造成检查点(data 写成该时刻全量,is_base = true),再把 v1 毒化。
  // 窗口只取最新 1 条时,状态必须从 v2 起回放,从链首起会读到毒化字节而炸
  const atV2 = new Y.Doc()
  for (const id of [v1!.id, v2!.id]) {
    const row = (await pool.query<{ data: Buffer }>('SELECT data FROM page_snapshots WHERE id = $1', [id])).rows[0]!
    Y.applyUpdate(atV2, row.data)
  }
  await pool.query("UPDATE page_snapshots SET data = $1, is_base = true WHERE id = $2", [
    Buffer.from(Y.encodeStateAsUpdate(atV2)),
    v2!.id,
  ])
  await pool.query("UPDATE page_snapshots SET data = '\\x00' WHERE id = $1", [v1!.id])

  const res = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}/updates?limit=1`, { headers: { cookie } })
  expect(res.status).toBe(200)
  const rows = (await res.json()) as UpdateEntry[]
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(v3!.id)
  expect(rows[0]!.summary).toEqual([{ kind: 'add', text: '第三段' }])

  await s.close()
})

test('insertSnapshot author 落库:manual 直调传 authorId;auto 直调(无编辑者信息)为 NULL', async () => {
  const authorId = await createUser('alice')
  const pageId = crypto.randomUUID()
  await pool.query('INSERT INTO pages (id) VALUES ($1)', [pageId])

  const doc = makePageDoc('t', ['内容一'])
  const v1 = await insertSnapshot(pool, pageId, 't', 'manual', doc, authorId)
  expect(v1).not.toBeNull()

  // auto 路径直调:本地 doc 从未经过服务端 onChange,lastEditor WeakMap 为空,作者为 NULL
  const doc2 = makePageDoc('t', ['内容二'])
  await maybeAutoSnapshot(pool, `page:${pageId}`, doc2)

  const { rows } = await pool.query<{ origin: string; author_id: string | null }>(
    'SELECT origin, author_id FROM page_snapshots WHERE page_id = $1 ORDER BY created_at',
    [pageId],
  )
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual({ origin: 'manual', author_id: authorId })
  expect(rows[1]).toEqual({ origin: 'auto', author_id: null })
})

test('自动快照作者:ws 编辑断开触发 auto 快照,作者 = 最后编辑者', async () => {
  const aliceId = await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)
  const docName = `page:${pageId}`

  // 连上后编辑:服务端 onChange 记 lastEditor(alice)、置脏、增量落库
  const docA = new Y.Doc()
  const p = connect(port, docName, docA, cookie)
  await vi.waitFor(() => expect(p.synced).toBe(true), { timeout: 15_000, interval: 50 })
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, '自动快照正文')
  paragraph.insert(0, [text])
  docA.getXmlFragment('prosemirror').insert(0, [paragraph])
  await vi.waitFor(async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_name = $1',
      [docName],
    )
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1)
  }, { timeout: 15_000, interval: 50 })

  // 断开最后一条连接会立即触发 onStoreDocument,auto 快照带最后编辑者。
  // 等 2s debounce 自燃的结果相同,waitFor 两种都能等到
  p.destroy()
  await vi.waitFor(async () => {
    const { rows } = await pool.query<{ author_id: string | null }>(
      "SELECT author_id FROM page_snapshots WHERE page_id = $1 AND origin = 'auto'",
      [pageId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.author_id).toBe(aliceId)
  }, { timeout: 15_000, interval: 50 })

  await s.close()
})
