/**
 * 集合集成测试的公共底座：起一份完整 server（随机端口）+ 造数（用户 / 空间 / 集合 / 行）+ 带 cookie 的协同连接与信令收集。
 * 各测试文件 import 它即各自起服（vitest 按文件隔离模块实例）；钩子在 import 时注册到导入它的文件。
 */
import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import {
  parseCollection,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type PropJson,
  type RowsDelta,
} from '@ramet/shared/collection-model'
import type { RowsWindow } from '@ramet/shared/collection-query'
import { hashPassword } from '../auth.js'
import { appendDocUpdate, loadDocFromDb } from '../collab.js'
import { closePool, getPool, initDb } from '../db.js'
import { startServer } from '../index.js'
import { truncateAll } from '../test-helpers.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

export const pool = getPool()
await initDb(pool)
export const server = await startServer(pool)
export const base = `http://127.0.0.1:${server.port}`

const cleanup: (() => unknown)[] = []
/** 用例结束时要做的清理（断开协同连接、关额外起的服务），倒序执行 */
export function onCleanup(fn: () => unknown): void {
  cleanup.push(fn)
}

beforeEach(async () => {
  await truncateAll(pool)
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      await fn()
    } catch {
      // 单个清理失败不影响其余
    }
  }
})
afterAll(async () => {
  await server.close()
  await closePool()
})

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const WAIT = { timeout: 15_000, interval: 50 }
/** 等断言成立（协同增量、广播、异步落库都要等） */
export function eventually(check: () => unknown): Promise<unknown> {
  return vi.waitFor(check, WAIT)
}

// ---------- 用户与空间 ----------

export async function insertUser(username: string, role: 'user' | 'admin' = 'user', id: string = randomUUID()): Promise<string> {
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, username, hashPassword('pw-123456'), role])
  return id
}

export async function login(username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('登录未返回会话 cookie')
  return cookie
}

export type Who = { id: string; name: string; cookie: string }
export type Team = { spaceId: string; owner: Who; member: Who; viewer: Who; outsider: Who }

async function user(name: string, id?: string): Promise<Who> {
  const userId = await insertUser(name, 'user', id)
  return { id: userId, name, cookie: await login(name) }
}

/** 一个空间：owner / member / viewer 三个成员 + 一个不在空间里的 outsider。ids 可指定（人员排序要确定的 id 顺序） */
export async function team(ids: { owner?: string; member?: string } = {}): Promise<Team> {
  const owner = await user('zed-owner', ids.owner)
  const member = await user('amy-member', ids.member)
  const viewer = await user('bob-viewer')
  const outsider = await user('eve-outsider')
  const spaceId = randomUUID()
  await pool.query('INSERT INTO spaces (id, name, owner_id, is_personal) VALUES ($1, $2, $3, false)', [spaceId, '项目空间', owner.id])
  for (const [who, role] of [
    [owner, 'owner'],
    [member, 'member'],
    [viewer, 'viewer'],
  ] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [spaceId, who.id, role])
  }
  return { spaceId, owner, member, viewer, outsider }
}

// ---------- REST ----------

export async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed as T }
}

export type Created = { id: string; kind: string; title: string; space_id: string; parent_id: string | null; inline: boolean }

export function postCollection(cookie: string, body: Record<string, unknown>) {
  return call<Created>('POST', '/api/collections', cookie, body)
}

export function postRow(cookie: string, collectionId: string, body: Record<string, unknown> = {}) {
  return call<CollectionRow>('POST', `/api/collections/${collectionId}/rows`, cookie, body)
}

export function patchRow(cookie: string, collectionId: string, rowId: string, body: Record<string, unknown>) {
  return call<CollectionRow>('PATCH', `/api/collections/${collectionId}/rows/${rowId}`, cookie, body)
}

export function getRows(cookie: string, collectionId: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams(query).toString()
  return call<RowsWindow>('GET', `/api/collections/${collectionId}/rows${qs ? `?${qs}` : ''}`, cookie)
}

export function trashRows(cookie: string, collectionId: string, ids: unknown) {
  return call<{ trashed: string[] }>('POST', `/api/collections/${collectionId}/rows/trash`, cookie, { ids })
}

/** 窗口里的行 id（按窗口顺序） */
export async function windowIds(cookie: string, collectionId: string, query: Record<string, string> = {}): Promise<string[]> {
  const res = await getRows(cookie, collectionId, query)
  expect(res.status).toBe(200)
  return res.body.rows.map((r) => r.id)
}

/** 普通页面（POST /api/pages） */
export async function postPage(cookie: string, body: Record<string, unknown>): Promise<string> {
  const res = await call<{ id: string }>('POST', '/api/pages', cookie, body)
  expect(res.status).toBe(201)
  return res.body.id
}

export type Fixture = { id: string; schema: CollectionSchema; status: CollectionProp; todo: string; doing: string; done: string }

/** owner 在空间里建一个整页集合（带「状态」属性与默认表格视图） */
export async function newCollection(t: Team, body: Record<string, unknown> = {}): Promise<Fixture> {
  const res = await postCollection(t.owner.cookie, { space_id: t.spaceId, title: '任务', ...body })
  expect(res.status).toBe(201)
  const schema = await schemaOf(res.body.id)
  const status = schema.props[0]!
  const [todo, doing, done] = status.options.map((o) => o.id)
  return { id: res.body.id, schema, status, todo: todo!, doing: doing!, done: done! }
}

// ---------- 文档与副本 ----------

export async function schemaOf(collectionId: string): Promise<CollectionSchema> {
  return parseCollection((await loadDocFromDb(pool, `page:${collectionId}`)).getMap('collection').toJSON())
}

/** 行文档（从库里重建：快照 + 增量） */
export function rowDoc(rowId: string): Promise<Y.Doc> {
  return loadDocFromDb(pool, `page:${rowId}`)
}

/** 副本里这一行的 props；没有副本行 = undefined */
export async function replicaOf(rowId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query<{ props: Record<string, unknown> }>('SELECT props FROM collection_rows WHERE page_id = $1', [rowId])
  return rows[0]?.props
}

/** 在库里改集合文档（集合文档没被协同连接加载时用，模拟客户端改属性定义 / 视图）：追加一条增量，下次读到的就是改后的 */
export async function editCollection(collectionId: string, edit: (root: Y.Map<unknown>) => void): Promise<void> {
  const docName = `page:${collectionId}`
  const doc = await loadDocFromDb(pool, docName)
  const before = Y.encodeStateVector(doc)
  doc.transact(() => edit(doc.getMap<unknown>('collection')))
  await appendDocUpdate(pool, docName, Buffer.from(Y.encodeStateAsUpdate(doc, before)))
}

/** 写一个属性定义（Y 结构同 init-doc.ts：属性与 options 是 Y.Map，选项本身是普通值） */
export function addProp(root: Y.Map<unknown>, id: string, json: PropJson): void {
  const prop = new Y.Map<unknown>()
  ;(root.get('props') as Y.Map<unknown>).set(id, prop)
  prop.set('name', json.name)
  prop.set('type', json.type)
  prop.set('pos', json.pos)
  if (!json.options) return
  const options = new Y.Map<unknown>()
  prop.set('options', options)
  for (const [optionId, option] of Object.entries(json.options)) options.set(optionId, option)
}

/** 加一个视图（widths 是 Y.Map，其余是普通值） */
export function addView(root: Y.Map<unknown>, id: string, settings: Record<string, unknown>): void {
  const view = new Y.Map<unknown>()
  ;(root.get('views') as Y.Map<unknown>).set(id, view)
  const all: Record<string, unknown> = { name: id, layout: 'table', pos: 10, filter: { all: [] }, sorts: [], groupBy: null, shown: null, ...settings }
  for (const [key, value] of Object.entries(all)) view.set(key, value)
  view.set('widths', new Y.Map<unknown>())
}

// ---------- 协同连接 ----------

function cookieWebSocket(cookie: string) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie } })
    }
  }
}

/** 带 cookie 连一个协同文档并等到同步完。port 缺省连本文件的 server */
export async function connect(
  docName: string,
  cookie: string,
  opts: { doc?: Y.Doc; onStateless?: (payload: string) => void; port?: number } = {},
): Promise<HocuspocusProvider> {
  // preserveConnection:false → destroy() 连底层 ws 一起断，不给下一个用例留幽灵连接；ws provider 随后也销毁（清定时器）
  const websocketProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${opts.port ?? server.port}/collab`,
    WebSocketPolyfill: cookieWebSocket(cookie),
  })
  const onStateless = opts.onStateless
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: docName,
    document: opts.doc ?? new Y.Doc(),
    preserveConnection: false,
    ...(onStateless && { onStateless: ({ payload }: { payload: string }) => onStateless(payload) }),
  })
  onCleanup(() => {
    provider.destroy()
    websocketProvider.destroy()
  })
  await eventually(() => expect(provider.synced).toBe(true))
  return provider
}

/** 连上集合文档，收集合增量（只留 collection.rows） */
export async function watchCollection(collectionId: string, cookie: string): Promise<RowsDelta[]> {
  const deltas: RowsDelta[] = []
  await connect(`page:${collectionId}`, cookie, {
    onStateless: (payload) => {
      try {
        const parsed = JSON.parse(payload) as RowsDelta
        if (parsed.t === 'collection.rows') deltas.push(parsed)
      } catch {
        // 不是集合增量的信令：不收
      }
    },
  })
  return deltas
}

/** 连上 control:global，收全站信令（'changed' 等） */
export async function watchControl(cookie: string): Promise<string[]> {
  const payloads: string[] = []
  await connect('control:global', cookie, { onStateless: (payload) => payloads.push(payload) })
  return payloads
}

/** 增量里这一行的全部改动（按到达顺序） */
export function updatesOf(deltas: RowsDelta[], rowId: string) {
  return deltas.flatMap((d) => d.up.filter((u) => u.row.id === rowId))
}
