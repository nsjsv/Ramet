import { afterAll, beforeEach, expect, test } from 'vitest'
import * as Y from 'yjs'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { hashPassword, SESSION_COOKIE } from './auth.js'
import type { LinkMeta } from './link-preview.js'
import { truncateAll } from './test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const pool = getPool()
await initDb(pool)

// 抓取换成记账的假实现:路由测的是鉴权 / 闸门,真抓取在 link-preview.test.ts
const asked: string[] = []
let failNext = false
const s = await startServer(pool, 0, {
  linkPreview: {
    get: async (url): Promise<LinkMeta> => {
      asked.push(url)
      if (failNext) {
        failNext = false
        return { url }
      }
      return { url, title: `标题 ${url}` }
    },
  },
})
const base = `http://127.0.0.1:${s.port}`

beforeEach(async () => {
  await truncateAll(pool)
  asked.length = 0
})

afterAll(async () => {
  await s.close()
  await closePool()
})

async function login(): Promise<string> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [
    crypto.randomUUID(),
    'bm-alice',
    hashPassword('pw'),
    'user',
  ])
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bm-alice', password: 'pw' }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('登录未返回会话 cookie')
  return cookie
}

/** 页面正文直接写成「一个列表项里嵌一张书签」+「一段里有一颗网页提及」（验证任意深度、行内节点都认） */
async function writeBody(pageId: string, url: string, mentionUrl: string): Promise<void> {
  const doc = new Y.Doc()
  const body = doc.getXmlFragment('prosemirror')
  const list = new Y.XmlElement('bullet_list')
  const item = new Y.XmlElement('list_item')
  const card = new Y.XmlElement('bookmark')
  card.setAttribute('url', url)
  item.insert(0, [card])
  list.insert(0, [item])
  const para = new Y.XmlElement('paragraph')
  const mention = new Y.XmlElement('link_mention')
  mention.setAttribute('url', mentionUrl)
  para.insert(0, [new Y.XmlText('看 '), mention])
  body.insert(0, [list, para])
  await pool.query('DELETE FROM yjs_updates WHERE doc_name = $1', [`page:${pageId}`])
  await pool.query(
    `INSERT INTO yjs_documents (doc_name, state) VALUES ($1, $2)
     ON CONFLICT (doc_name) DO UPDATE SET state = EXCLUDED.state`,
    [`page:${pageId}`, Buffer.from(Y.encodeStateAsUpdate(doc))],
  )
}

test('登录端点:未登录 401;地址形状不对 400;正常给元信息并允许浏览器缓存', async () => {
  const q = (u: string) => `${base}/api/link-preview?url=${encodeURIComponent(u)}`
  expect((await fetch(q('https://example.com/'))).status).toBe(401)
  const cookie = await login()
  for (const bad of ['javascript:alert(1)', '/page/x', '']) {
    expect((await fetch(q(bad), { headers: { cookie } })).status).toBe(400)
  }
  const res = await fetch(q('https://example.com/a'), { headers: { cookie } })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
  // 没抓到（只有地址）只缓存十分钟
  failNext = true
  const miss = await fetch(q('https://example.com/down'), { headers: { cookie } })
  expect(await miss.json()).toEqual({ url: 'https://example.com/down' })
  expect(miss.headers.get('cache-control')).toBe('private, max-age=600')
  expect(await res.json()).toEqual({ url: 'https://example.com/a', title: '标题 https://example.com/a' })
  expect(asked).toEqual(['https://example.com/a', 'https://example.com/down'])
})

test('公开端点:只抓公开页正文里真有的书签 / 网页提及地址;没公开 / 别的地址 404 且一次都不抓', async () => {
  const cookie = await login()
  const page = (await (
    await fetch(`${base}/api/pages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
  ).json()) as { id: string }
  const url = 'https://example.com/card'
  const mentionUrl = 'https://example.com/mention'
  await writeBody(page.id, url, mentionUrl)
  const q = (u: string) => fetch(`${base}/api/public/pages/${page.id}/link-preview?url=${encodeURIComponent(u)}`)

  expect((await q(url)).status).toBe(404) // 还没公开
  const published = await fetch(`${base}/api/pages/${page.id}/publish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ published: true }),
  })
  expect(published.status).toBe(200)

  expect((await q('https://example.com/other')).status).toBe(404)
  expect((await q('javascript:alert(1)')).status).toBe(404)
  expect(asked).toEqual([])

  const ok = await q(url)
  expect(ok.status).toBe(200)
  expect(await ok.json()).toEqual({ url, title: `标题 ${url}` })
  expect((await q(mentionUrl)).status).toBe(200)
  expect(asked).toEqual([url, mentionUrl])
})
