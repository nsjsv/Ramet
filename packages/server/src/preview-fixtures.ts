/**
 * 端口预览集成测试的公共底座，import 它就等于 import test-kit（起一份带预览监听的真服务），只给 preview-*.test.ts 用。
 * world()：13 种角色 + 一台脚本化机器（说协议、记下全部帧）；enterPreview()：票据 → 预览会话 cookie。
 */
import { expect } from 'vitest'
import { CONNECTOR_TOKEN_HEADER } from './agents/protocol.js'
import { pairMachine, type Machine } from './agents/scripted-machine.js'
import { agentsList, base, grantMachine, insertUser, login, pool, postJson, previewBase, waitFor } from './agents/test-kit.js'

export type Role =
  | 'mowner' | 'sowner' | 'gadmin' | 'plain' | 'agentOnly' | 'machineOnly' | 'both' | 'pending' | 'expired' | 'revoked' | 'viewer' | 'outsider' | 'outadmin'
export const ROLES: readonly Role[] = [
  'mowner', 'sowner', 'gadmin', 'plain', 'agentOnly', 'machineOnly', 'both', 'pending', 'expired', 'revoked', 'viewer', 'outsider', 'outadmin',
]
/** 能共享预览的：机器主人和有 machine 授权的人 */
export const ALLOWED: readonly Role[] = ['mowner', 'machineOnly', 'both']
export const DENIED = ROLES.filter((r) => !ALLOWED.includes(r))
/** 被拒的人拿到的状态码：页面都读不了的（不在空间里的人，含全局 admin）404，其余（含 viewer）403 */
export const refusedStatus = (role: Role): number => (role === 'outsider' || role === 'outadmin' ? 404 : 403)

export type World = {
  spaceId: string
  pageId: string
  id: Record<Role, string>
  cookie: Record<Role, string>
  agent: string
  m: Machine
  /** 各角色在这台机器上的授权 id（machine_grants.id） */
  grant: Partial<Record<Role, string>>
}

export async function world(caps: string[] = ['project', 'preview']): Promise<World> {
  const id = {} as Record<Role, string>
  const cookie = {} as Record<Role, string>
  for (const role of ROLES) {
    id[role] = await insertUser(role, role === 'gadmin' || role === 'outadmin' ? 'admin' : 'user')
    cookie[role] = await login(role)
  }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const role of ROLES) {
    if (role === 'sowner' || role === 'outsider' || role === 'outadmin') continue
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id[role], role === 'viewer' ? 'viewer' : 'member'])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const m = await pairMachine(space.id, id.mowner, 'box', caps)
  const w: World = { spaceId: space.id, pageId: page.id, id, cookie, agent: `c:${m.id}:claude`, m, grant: {} }
  await waitFor(async () => (await agentsList(cookie.mowner)).some((a) => a.id === w.agent))
  w.grant.agentOnly = await grantMachine(m.id, id.agentOnly, { scopes: ['agent'] })
  w.grant.machineOnly = await grantMachine(m.id, id.machineOnly, { scopes: ['machine'] })
  w.grant.both = await grantMachine(m.id, id.both, { scopes: ['agent', 'machine'] })
  w.grant.pending = await grantMachine(m.id, id.pending, { scopes: ['machine'], confirmed: false })
  w.grant.expired = await grantMachine(m.id, id.expired, { scopes: ['machine'], expiresInMs: -60_000 })
  w.grant.revoked = await grantMachine(m.id, id.revoked, { scopes: ['machine'], revoked: true })
  return w
}

export const api = (method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

export type PreviewItem = { id: string; port: number; path: string; machine: string; shared_by: string; mine: boolean; online: boolean; can_stop: boolean; created_at: number }

/** 共享一个端口，返回响应（201 时 body 带 id） */
export const share = (w: Pick<World, 'pageId' | 'agent'>, cookie: string, port: number, extra: Record<string, unknown> = {}): Promise<Response> =>
  api('POST', `/api/pages/${w.pageId}/project/previews`, cookie, { agent: w.agent, port, ...extra })

export async function shareOk(w: Pick<World, 'pageId' | 'agent'>, cookie: string, port: number, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await share(w, cookie, port, extra)
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

export async function list(w: Pick<World, 'pageId'>, cookie: string): Promise<{ enabled: boolean; previews: PreviewItem[] }> {
  const res = await api('GET', `/api/pages/${w.pageId}/previews`, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as { enabled: boolean; previews: PreviewItem[] }
}

/** 取票据 → 预览源上的进入地址 */
export async function ticketUrl(w: Pick<World, 'pageId'>, cookie: string, previewId: string): Promise<string> {
  const res = await api('POST', `/api/pages/${w.pageId}/previews/${previewId}/ticket`, cookie, {})
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  expect(url.startsWith(`${previewBase}/__ramet/enter?t=`)).toBe(true)
  return url
}

/** 进入预览源，不跟随重定向。headers 可以带上浏览器会带的 Ramet 登录 cookie */
export const visit = (url: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { redirect: 'manual', headers })

/** 完整进入一次，返回预览会话 cookie（`ramet_pv=<sid>`） */
export async function enterPreview(w: Pick<World, 'pageId'>, cookie: string, previewId: string): Promise<string> {
  const res = await visit(await ticketUrl(w, cookie, previewId))
  expect(res.status).toBe(302)
  const pv = pvCookie(res)
  if (!pv) throw new Error('进入预览没有设置 ramet_pv')
  return pv
}

export function pvCookie(res: Response): string | null {
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith('ramet_pv=')) ?? null
}

/** 在预览源上请求（带预览会话 cookie） */
export const viaPreview = (pv: string | null, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> =>
  fetch(`${previewBase}${path}`, { redirect: 'manual', ...init, headers: { ...(pv ? { cookie: pv } : {}), ...init.headers } })

/** 走完整个授权流程：主人网页发起，再在机器上用确认码确认。返回 grantId */
export async function grantVia(w: World, who: Role, scopes: Array<'agent' | 'machine'>): Promise<string> {
  const res = await api('POST', `/api/machines/${w.m.id}/grants`, w.cookie.mowner, {
    password: 'pw-123456', userId: w.id[who], username: who, machineName: 'box', scopes, days: 7, acknowledged: true,
  })
  expect(res.status).toBe(201)
  const { grantId, code } = (await res.json()) as { grantId: string; code: string }
  const done = await fetch(`${base}/api/connector/grants/${code}/confirm`, { method: 'POST', headers: { [CONNECTOR_TOKEN_HEADER]: w.m.token } })
  expect(done.status).toBe(200)
  return grantId
}

/** 机器一侧收到的预览帧 */
export const previewFrames = (m: Machine, actor?: string) =>
  m.driven().filter((f) => ['port-share', 'port-unshare', 'http-req', 'http-body', 'ws-open', 'ws-msg', 'ws-close'].includes(f.t) && (actor === undefined || f.actor === actor))

/** 预览源上最近一次转发给机器的 http-req */
export const lastHttpReq = (m: Machine) => m.of('http-req').at(-1)
