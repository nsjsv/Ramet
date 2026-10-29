import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { COMPACT_THRESHOLD } from './collab.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import { truncateAll } from './test-helpers.js'

// 测试必须显式指向测试库(如 ramet_test)，防止误写开发库
if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

let pool = getPool()
await initDb(pool)
const cleanup: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  // 每个用例从空库出发，序列一并归零；users 被 pages / sessions / spaces 外键引用，须同一语句一并清
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

async function createPage(port: number, cookie: string): Promise<{ id: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({}),
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
  onStateless?: (data: { payload: string }) => void,
): HocuspocusProvider {
  // preserveConnection:false → destroy() 连底层 ws 一起断;
  // 否则 destroy 后服务端回关连接,客户端自动重连,会给下一个用例留幽灵连接。
  // WebSocketPolyfill 在类型上属于 ws provider 配置,故显式构造 HocuspocusProviderWebsocket。
  // onStateless 只在提供时传入:provider 构造时把监听原样注册,undefined 在 emit 时会炸
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: docName,
    document: doc,
    preserveConnection: false,
    ...(onStateless && { onStateless }),
  })
  cleanup.push(() => provider.destroy())
  return provider
}

// 造一个含指定文本的 Y.Doc 快照(模拟旧库存量快照行)
function makeSnapshot(text: string): Buffer {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

async function snapshotText(docName: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ state: Buffer }>('SELECT state FROM yjs_documents WHERE doc_name = $1', [docName])
  if (!rows[0]) return undefined
  const snapshot = new Y.Doc()
  Y.applyUpdate(snapshot, rows[0].state)
  return snapshot.getText('content').toString()
}

async function updateCount(docName: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_name = $1', [
    docName,
  ])
  return rows[0]!.n
}

test('双客户端收敛 → 增量落库 → 超阈值压缩快照 → 重启恢复', async () => {
  // 页面必须真实存在且归属连接者(ws 层校验 page:<id> 归属),先登录建页
  await createUser('alice')
  const s1 = await startServer(pool)
  cleanup.push(s1.close)
  const cookie = await login(s1.port, 'alice')
  const { id: pageId } = await createPage(s1.port, cookie)
  const docName = `page:${pageId}`
  const text = 'hello from A'
  const finalText = text + 'x'.repeat(COMPACT_THRESHOLD)

  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const a = connect(s1.port, docName, docA, cookie)
  const b = connect(s1.port, docName, docB, cookie)
  await vi.waitFor(() => {
    expect(a.synced).toBe(true)
    expect(b.synced).toBe(true)
  }, { timeout: 15_000, interval: 50 })

  docA.getText('content').insert(0, text)
  await vi.waitFor(() => {
    expect(docB.getText('content').toString()).toBe(text)
  }, { timeout: 15_000, interval: 50 })

  // 增量追加进 yjs_updates；未满阈值时 onStoreDocument 只做 no-op，快照行不出现
  await vi.waitFor(async () => {
    expect(await updateCount(docName)).toBeGreaterThanOrEqual(1)
  }, { timeout: 15_000, interval: 50 })
  expect(await snapshotText(docName)).toBeUndefined()

  // 再写满阈值：增量数超过 COMPACT_THRESHOLD → 快照被刷新、增量被清空、内容不丢
  for (let i = 0; i < COMPACT_THRESHOLD; i++) {
    docA.getText('content').insert(text.length + i, 'x')
  }
  await vi.waitFor(async () => {
    expect(await updateCount(docName)).toBe(0)
    expect(await snapshotText(docName)).toBe(finalText)
  }, { timeout: 20_000, interval: 100 })

  a.destroy()
  b.destroy()
  await s1.close()
  // "重启":断开连接池,重新连同一测试库(会话行在库里,cookie 跨重启有效)
  await closePool()
  pool = getPool()

  // 实例 2：重启后(库里只剩快照行),加载即快照命中,内容恢复
  const s2 = await startServer(pool)
  cleanup.push(s2.close)

  const docC = new Y.Doc()
  const c = connect(s2.port, docName, docC, cookie)
  await vi.waitFor(() => {
    expect(c.synced).toBe(true)
    expect(docC.getText('content').toString()).toBe(finalText)
  }, { timeout: 15_000, interval: 50 })
})

test('未压缩时重启：快照 + 按 seq 重放增量恢复内容(旧库只有快照行也兼容)', async () => {
  await createUser('alice')
  const s1 = await startServer(pool)
  cleanup.push(s1.close)
  const cookie = await login(s1.port, 'alice')
  const { id: pageId } = await createPage(s1.port, cookie)
  const docName = `page:${pageId}`

  // 预置一条旧式全量快照行(旧库升级场景)
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [
    docName,
    makeSnapshot('base'),
  ])

  // 连上后追加编辑 → 只落增量,不满足阈值不会压缩
  const docA = new Y.Doc()
  const a = connect(s1.port, docName, docA, cookie)
  await vi.waitFor(() => expect(a.synced).toBe(true), { timeout: 15_000, interval: 50 })
  expect(docA.getText('content').toString()).toBe('base') // 快照命中
  docA.getText('content').insert(4, ' + delta')
  await vi.waitFor(async () => {
    expect(await updateCount(docName)).toBeGreaterThanOrEqual(1)
  }, { timeout: 15_000, interval: 50 })

  a.destroy()
  await s1.close()
  // "重启":断开连接池,重新连同一测试库
  await closePool()
  pool = getPool()

  // 重启：加载 = 快照 + 重放增量,两段内容都不丢
  const s2 = await startServer(pool)
  cleanup.push(s2.close)

  const docB = new Y.Doc()
  const b = connect(s2.port, docName, docB, cookie)
  await vi.waitFor(() => {
    expect(b.synced).toBe(true)
    expect(docB.getText('content').toString()).toBe('base + delta')
  }, { timeout: 15_000, interval: 50 })
})

test('删除页面 → yjs_documents 与 yjs_updates 双表无残留', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')

  const page = await createPage(port, cookie)
  const docName = `page:${page.id}`

  // 预置快照行 + 连上写一条,让两张表都有数据可断言
  await pool.query('INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)', [
    docName,
    makeSnapshot('to be deleted'),
  ])
  const doc = new Y.Doc()
  const p = connect(port, docName, doc, cookie)
  await vi.waitFor(() => expect(p.synced).toBe(true), { timeout: 15_000, interval: 50 })
  doc.getText('content').insert(0, '!')
  await vi.waitFor(async () => {
    expect(await updateCount(docName)).toBeGreaterThanOrEqual(1)
  }, { timeout: 15_000, interval: 50 })
  p.destroy()

  const removed = await fetch(`http://127.0.0.1:${port}/api/pages/${page.id}`, { method: 'DELETE', headers: { cookie } })
  expect(removed.status).toBe(200)

  const docs = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM yjs_documents WHERE doc_name = $1', [
    docName,
  ])
  expect(docs.rows[0]!.n).toBe(0)
  expect(await updateCount(docName)).toBe(0)

  await s.close()
})

test('认证用户可连 control:global 信令文档', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const cookie = await login(s.port, 'alice')

  const doc = new Y.Doc()
  const control = connect(s.port, 'control:global', doc, cookie)
  await vi.waitFor(() => expect(control.synced).toBe(true), { timeout: 15_000, interval: 50 })
  // 纯信令文档:无内容可加载,不该被播种或同步出任何东西
  expect(doc.getXmlFragment('title').length).toBe(0)
  expect(doc.getText('content').toString()).toBe('')

  await s.close()
})

test('PATCH 改名 → control:global 收到 stateless "changed" 广播', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const { id: pageId } = await createPage(port, cookie)

  const payloads: string[] = []
  const control = connect(port, 'control:global', new Y.Doc(), cookie, ({ payload }) => {
    payloads.push(payload)
  })
  await vi.waitFor(() => expect(control.synced).toBe(true), { timeout: 15_000, interval: 50 })

  const renamed = await fetch(`http://127.0.0.1:${port}/api/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: '实时树' }),
  })
  expect(renamed.status).toBe(200)

  // 等广播到达;超时未到即失败
  await vi.waitFor(() => expect(payloads).toContain('changed'), { timeout: 15_000, interval: 50 })

  await s.close()
})

test('打开旧页 → 空 title fragment 从 DB 播种且落增量链;重启重开仍单段(不重播种出双排)', async () => {
  await createUser('alice')
  const s = await startServer(pool)
  cleanup.push(s.close)
  const port = s.port
  const cookie = await login(port, 'alice')
  const page = await createPage(port, cookie)
  const docName = `page:${page.id}`
  // 建页接口不收 title,PATCH 落库后再连,模拟"DB 有标题、Yjs 无标题"的旧页
  const renamed = await fetch(`http://127.0.0.1:${port}/api/pages/${page.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: '播种的标题' }),
  })
  expect(renamed.status).toBe(200)

  const doc = new Y.Doc()
  const p = connect(port, docName, doc, cookie)
  await vi.waitFor(() => expect(p.synced).toBe(true), { timeout: 15_000, interval: 50 })

  // 播种结构 paragraph > text,文本 = DB title
  const title = doc.getXmlFragment('title')
  expect(title.length).toBe(1)
  expect((title.get(0) as Y.XmlElement).get(0).toString()).toBe('播种的标题')

  // 播种必须落增量链:否则文档 unload 后下次加载会用新 clientID 重播种,
  // 与客户端 IDB 缓存里的旧种子合并成双排标题
  expect(await updateCount(docName)).toBe(1)

  // 重启服务端(内存文档丢弃,从快照+增量重建)后重开:重放的是同一颗 struct,仍单段
  await p.destroy()
  await s.close()
  const s2 = await startServer(pool)
  cleanup.push(s2.close)
  const doc2 = new Y.Doc()
  const p2 = connect(s2.port, docName, doc2, cookie)
  await vi.waitFor(() => expect(p2.synced).toBe(true), { timeout: 15_000, interval: 50 })
  const title2 = doc2.getXmlFragment('title')
  expect(title2.length).toBe(1)
  expect((title2.get(0) as Y.XmlElement).get(0).toString()).toBe('播种的标题')

  await p2.destroy()
  await s2.close()
})
