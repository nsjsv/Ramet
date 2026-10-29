// ---------- 端口预览的 REST（Ramet 主端口；真正的流量走独立的预览源，见 preview-server.ts）----------
// POST   /api/pages/:id/project/previews        {agent, port, path?}   → 201 预览（共享一个端口）
//          权限 = 页面可写 + 对这台机器有 machine 授权（接入人 ∨ 有效授权；只有 agent 授权的人、空间 owner、全局 admin、viewer 都是 403）；
//          端口 1024–65535；每台机器最多 5 个共享中的预览；机器离线 / connector 太旧 409
// GET    /api/pages/:id/previews                → { enabled, previews:[{id,port,path,machine,shared_by,mine,online,can_stop,created_at}] }
//          页面可读的人（含 viewer）都能看，共享本身就是对本页读者开放；不需要 machine 授权
// POST   /api/pages/:id/previews/:pid/ticket    → { url }：一次性票据（60 秒、绑定 用户 + 预览），浏览器打开这个地址进入预览源
// DELETE /api/pages/:id/previews/:pid           → { ok }：共享人或机器主人可停
// 预览没开（没设 RAMET_PREVIEW_PORT）：共享 / 取票据回 409「服务器没有开启预览端口」，列表回空。
// 使用记录：非主人共享 / 停止共享记一条（action='preview'，写入在动作之前 await）；预览请求本身不记。

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { pageAccess } from '../collab.js'
import type { ConnectorHub } from '../agents/hub.js'
import { assertCanUse } from '../agents/machine-access.js'
import { recordMachineUse } from '../agents/machine-grants.js'
import { PreviewBusyError, PreviewLimitError, PreviewOfflineError, type Preview } from '../agents/preview-bridge.js'
import { PREVIEW_CAP, validPort, validPreviewPath } from '../agents/preview-types.js'
import { ConnectorOutdatedError } from '../agents/project-types.js'
import { MachineOfflineError, projectContext } from '../agents/project.js'
import type { PreviewAccess } from '../preview-access.js'
import { failure } from './project-common.js'
import { writable } from './pages.js'

/** 预览有没有开、对外地址是什么（index.ts 起监听后填） */
export type PreviewRuntime = {
  enabled: () => boolean
  /** 预览源（协议 + 主机 + 端口）。env 里配了用 env 的；否则按请求的主机名 + 预览监听的实际端口拼 */
  origin: (c: Context) => string
}

const DISABLED = { error: 'preview disabled', message: '服务器没有开启预览端口' }

const ownersOf = async (pool: Pool, connectorIds: string[]): Promise<Map<string, string | null>> => {
  if (connectorIds.length === 0) return new Map()
  const { rows } = await pool.query<{ id: string; owner_id: string | null }>('SELECT id, owner_id FROM connectors WHERE id = ANY($1::text[])', [connectorIds])
  return new Map(rows.map((r) => [r.id, r.owner_id]))
}

/** 页面已经被删 / 回收的预览不该继续占这台机器的名额 */
async function pruneDeadPages(pool: Pool, hub: ConnectorHub, connectorId: string): Promise<void> {
  const mine = hub.previews.ofMachine(connectorId)
  if (mine.length === 0) return
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM live_pages WHERE id = ANY($1::text[])', [[...new Set(mine.map((p) => p.pageId))]])
  const alive = new Set(rows.map((r) => r.id))
  for (const p of mine) if (!alive.has(p.pageId)) hub.previews.unshare(p.id)
}

export function previewRoutes(pool: Pool, hub: ConnectorHub, access: PreviewAccess, runtime: PreviewRuntime) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
    const raw: unknown = await c.req.json().catch(() => null)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  }

  /** 页面可读 + 预览属于这个页面，过了返回预览；否则返回响应 */
  async function previewOnPage(c: Context<AuthEnv>): Promise<{ preview: Preview; role: NonNullable<Awaited<ReturnType<typeof pageAccess>>> } | Response> {
    const pageId = c.req.param('id') ?? ''
    const role = await pageAccess(pool, pageId, c.get('user'))
    if (!role) return c.json({ error: 'page not found' }, 404)
    const preview = hub.previews.get(c.req.param('pid') ?? '')
    if (!preview || preview.pageId !== pageId) return c.json({ error: 'preview not found' }, 404)
    return { preview, role }
  }

  app.get('/api/pages/:id/previews', auth, async (c) => {
    const user = c.get('user')
    const pageId = c.req.param('id')
    if (!(await pageAccess(pool, pageId, user))) return c.json({ error: 'page not found' }, 404)
    const list = hub.previews.list(pageId)
    const owners = await ownersOf(pool, [...new Set(list.map((p) => p.connectorId))])
    return c.json({
      enabled: runtime.enabled(),
      previews: list.map((p) => ({
        id: p.id,
        port: p.port,
        path: p.path,
        machine: p.machineName,
        shared_by: p.sharedByName,
        mine: p.sharedBy === user.id,
        online: hub.online(p.connectorId),
        // 共享人或机器主人可以停
        can_stop: p.sharedBy === user.id || owners.get(p.connectorId) === user.id,
        created_at: p.createdAt,
      })),
    })
  })

  app.post('/api/pages/:id/project/previews', auth, async (c) => {
    if (!runtime.enabled()) return c.json(DISABLED, 409)
    const user = c.get('user')
    const pageId = c.req.param('id')
    const role = await pageAccess(pool, pageId, user)
    if (!role) return c.json({ error: 'page not found' }, 404)
    if (!writable(role)) return c.json({ error: 'forbidden', message: '只读成员不能共享预览' }, 403)
    const b = await body(c)
    if (typeof b.agent !== 'string' || !b.agent) return c.json({ error: 'agent required' }, 400)
    if (!validPort(b.port)) return c.json({ error: 'bad port', message: '端口要是 1024 到 65535 之间的整数' }, 400)
    const path = b.path === undefined || b.path === '' ? '/' : b.path
    if (!validPreviewPath(path)) return c.json({ error: 'bad path', message: '入口路径要以 / 开头，不能含空白或反斜杠' }, 400)
    try {
      // 与项目面板同一个判定：machine 范围的使用权（没有 → 403，机器一侧一个帧都没有）
      const ctx = await projectContext(pool, hub, pageId, b.agent, user)
      if (!ctx.machine.online) throw new MachineOfflineError()
      if (!ctx.caps.includes(PREVIEW_CAP)) throw new ConnectorOutdatedError('这台机器上的 connector 版本太旧，升级后才能用端口预览')
      await pruneDeadPages(pool, hub, ctx.machine.id)
      // 非主人共享要留痕给主人看；写不进审计就不共享
      await recordMachineUse(
        pool,
        { remote: { connectorId: ctx.machine.id, agentId: '', defaultCwd: '', ownerId: ctx.machine.ownerId } },
        user.id,
        'preview',
        pageId,
        { agent: ctx.agent, op: 'share', port: b.port },
      )
      const preview = await hub.previews.share({
        pageId,
        pass: ctx.pass,
        sharedByName: user.username,
        machineName: ctx.machine.name,
        port: b.port,
        path,
      })
      return c.json({ id: preview.id, port: preview.port, path: preview.path, machine: preview.machineName }, 201)
    } catch (err) {
      if (err instanceof PreviewLimitError) return c.json({ error: 'too many previews', message: err.message }, 409)
      if (err instanceof PreviewOfflineError) return failure(c, new MachineOfflineError())
      if (err instanceof PreviewBusyError) return c.json({ error: 'busy', message: err.message }, 503)
      return failure(c, err)
    }
  })

  app.post('/api/pages/:id/previews/:pid/ticket', auth, async (c) => {
    if (!runtime.enabled()) return c.json(DISABLED, 409)
    const found = await previewOnPage(c)
    if (found instanceof Response) return found
    const ticket = access.issueTicket(c.get('user').id, found.preview.id)
    if (!ticket) return c.json({ error: 'too many tickets', message: '操作太频繁，请稍后再试' }, 429)
    return c.json({ url: `${runtime.origin(c)}/__ramet/enter?t=${ticket}` })
  })

  app.delete('/api/pages/:id/previews/:pid', auth, async (c) => {
    const found = await previewOnPage(c)
    if (found instanceof Response) return found
    const { preview } = found
    const user = c.get('user')
    const ownerId = (await ownersOf(pool, [preview.connectorId])).get(preview.connectorId) ?? null
    const isSharer = preview.sharedBy === user.id
    const isOwner = ownerId === user.id
    if (!isSharer && !isOwner) return c.json({ error: 'forbidden', message: '只有共享的人或这台机器的主人能停止共享' }, 403)
    try {
      // 非主人停止共享也留痕；写不进审计就不停（主人自己的操作不记）
      await recordMachineUse(
        pool,
        { remote: { connectorId: preview.connectorId, agentId: '', defaultCwd: '', ownerId } },
        user.id,
        'preview',
        preview.pageId,
        { op: 'stop', port: preview.port },
      )
      // 署名：共享人停用他自己的凭据；主人停（别人共享的）用主人的——connector 按「署名人是共享人或本机主人」判
      const pass = isSharer ? preview.pass : await assertCanUse(pool, user, preview.connectorId, 'machine')
      hub.previews.unshare(preview.id, pass)
      return c.json({ ok: true })
    } catch (err) {
      return failure(c, err)
    }
  })

  return app
}
