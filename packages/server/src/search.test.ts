import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
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

// 造数助手(同 collab.test.ts 风格)

async function insertUser(username: string, role = 'user'): Promise<string> {
  const id = crypto.randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    id,
    username,
    hashPassword('password'),
    role,
  ])
  return id
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie || !cookie.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

type PageCreated = { id: string }

async function createPage(cookie: string): Promise<PageCreated> {
  const res = await fetch(`${base}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: '{}',
  })
  expect(res.status).toBe(201)
  // 测试边界:响应是本服务产出的 JSON,与 blocks.test.ts 同款整体断言,无校验器可用
  return (await res.json()) as PageCreated
}

type PageHit = { id: string; title: string; snippet: string }

// ws 连接 + 往正文 fragment 写文本;销毁 provider 触发 onStoreDocument → content_text 落库
async function writeBody(cookie: string, pageId: string, text: string): Promise<void> {
  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${s.port}/collab`,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: `page:${pageId}`,
    document: doc,
    // preserveConnection:false → destroy() 连底层 ws 一起断,不留幽灵连接(同 collab.test.ts)
    preserveConnection: false,
  })
  await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 15_000, interval: 50 })
  doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('前缀 ' + text + ' 后缀')])
  provider.destroy()
  await vi.waitFor(async () => {
    const { rows } = await pool.query<{ t: string | null }>('SELECT content_text AS t FROM pages WHERE id = $1', [
      pageId,
    ])
    expect(rows[0]?.t ?? '').toContain(text)
  }, { timeout: 15_000, interval: 100 })
}

function cookieWebSocket(cookie: string) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie } })
    }
  }
}

const s =await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
cleanup.push(s.close)

test('未登录 401', async () => {
  const res = await fetch(`${base}/api/search?q=x`)
  expect(res.status).toBe(401)
})

test('标题与正文命中,snippet 取命中前后 ~60 字符', async () => {
  await insertUser('alice')
  const cookie = await login('alice')
  const { id: pageId } = await createPage(cookie)
  await pool.query('UPDATE pages SET title = $2 WHERE id = $1', [pageId, '会议纪要标题'])
  await writeBody(cookie, pageId, '独角兽量子段落')

  const res = await fetch(`${base}/api/search?q=量子`, { headers: { cookie } })
  expect(res.status).toBe(200)
  const hits = (await res.json()) as PageHit[]
  expect(hits).toHaveLength(1)
  expect(hits[0]!.id).toBe(pageId)
  expect(hits[0]!.title).toBe('会议纪要标题')
  expect(hits[0]!.snippet).toContain('独角兽量子段落')
})

// 原子块（page_ref/attachment/block_ref）的可见文字存在节点属性里；索引只收「读得见的文字」，
// 不 dump 结构属性 —— 否则 snippet 与 AI 上下文里会冒出 <page_ref icon="..."> 这类 markup 噪声
test('content_text 只收可见文字:原子块取显示属性,结构属性不进索引', async () => {
  await insertUser('alice')
  const cookie = await login('alice')
  const { id: pageId } = await createPage(cookie)

  const doc = new Y.Doc()
  const provider = new HocuspocusProvider({
    websocketProvider: new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${s.port}/collab`,
      WebSocketPolyfill: cookieWebSocket(cookie),
    }),
    name: `page:${pageId}`,
    document: doc,
    preserveConnection: false,
  })
  await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 15_000, interval: 50 })

  const frag = doc.getXmlFragment('prosemirror')
  const ref = new Y.XmlElement('page_ref')
  ref.setAttribute('id', 'blk-1')
  ref.setAttribute('pageId', 'other-page')
  ref.setAttribute('title', '子页面标题')
  ref.setAttribute('icon', 'emoji:🌍')
  const para = new Y.XmlElement('paragraph')
  para.insert(0, [new Y.XmlText('正文里的独有词')])
  frag.insert(0, [ref, para])
  provider.destroy()

  await vi.waitFor(
    async () => {
      const { rows } = await pool.query<{ t: string | null }>(
        'SELECT content_text AS t FROM pages WHERE id = $1',
        [pageId],
      )
      expect(rows[0]?.t ?? '').toContain('正文里的独有词')
    },
    { timeout: 15_000, interval: 100 },
  )

  const { rows } = await pool.query<{ t: string | null }>('SELECT content_text AS t FROM pages WHERE id = $1', [
    pageId,
  ])
  const text = rows[0]?.t ?? ''
  expect(text).toContain('子页面标题') // 块上读得见的文字照进索引
  expect(text).not.toContain('page_ref') // 节点名/结构属性一律不进
  expect(text).not.toContain('blk-1')
  expect(text).not.toContain('other-page')
  expect(text).not.toContain('emoji:')
})

test('正文命中返回 404 页之外:非成员搜不到他人空间页,admin 也搜不到', async () => {
  await insertUser('alice')
  await insertUser('mallory')
  await insertUser('root', 'admin')
  const alice = await login('alice')
  const mallory = await login('mallory')
  const root = await login('root')
  const { id: pageId } = await createPage(alice)
  await writeBody(alice, pageId, '机密内容标记')

  for (const [cookie, expectHit] of [
    [alice, true],
    [mallory, false],
    [root, false],
  ] as const) {
    const res = await fetch(`${base}/api/search?q=机密`, { headers: { cookie } })
    const hits = (await res.json()) as PageCreated[]
    expect(hits.some((h) => h.id === pageId)).toBe(expectHit)
  }
})

test('空 q 返回空数组;无命中返回空数组', async () => {
  await insertUser('alice')
  const cookie = await login('alice')
  for (const q of ['', '   ', '不存在的词']) {
    const res = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  }
})
