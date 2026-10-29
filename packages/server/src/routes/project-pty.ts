// ---------- 项目面板的终端 REST（中心只鉴权 + 转发给 connector，不运行任何 shell）----------
// GET    /api/pages/:id/project/pty?agent=                       → { isOwner, ptys:[{ptyId,root,cols,rows,alive,exitCode,createdAt,mine,owner}] }
//                                                                   普通人只看到自己的；机器主人看到这台机器上所有人的（mine=false 的只能关）
// POST   /api/pages/:id/project/pty?agent=        {cols,rows}    → 201 { pty }（打开）
// DELETE /api/pages/:id/project/pty/:ptyId?agent=                → { ok }       pty 的主人或机器主人；已经不在 = 404
// 订阅（就绪 / 快照 / 输出 / 退出）、输入、改尺寸都走 WebSocket /term（routes/pty-socket.ts），这里没有 input / resize / stream，
// 只留一条路径。
//
// 权限 = 页面可读 + 对这台机器有 machine 授权（routes/project-common.ts 的守卫，和文件 / git 同一套）。
// 只有 agent 授权的人、空间 owner、全局 admin 都是 403，机器一侧一个帧都没有。终端（把这台电脑的 shell 交给他）归 machine 范围。
// pty 的归属由 connector 判（别人的 ptyId → 403 forbidden）；中心不替它记。
// 状态码同项目面板：机器不在线 409；connector 太旧 409 connector outdated；node-pty 没装上 409 terminal unsupported；终端不存在 404。
// 使用记录：非主人打开 / 关闭终端记 action='terminal'（detail.op；写入在动作之前 await）；每一行输入不记。

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import type { ConnectorHub } from '../agents/hub.js'
import { askProject, recordProjectUse } from '../agents/project.js'
import type { PtyInfo } from '../agents/pty-types.js'
import { failure, makeGuard } from './project-common.js'

/** 对外的终端描述：不带别人的 user id，只带「是不是我的」和主人的用户名（机器主人看列表时用） */
export type PublicPty = Omit<PtyInfo, 'actor'> & { mine: boolean; owner: string }

export const toPublic = (p: PtyInfo, me: string, names: Map<string, string>): PublicPty => {
  const { actor, ...rest } = p
  return { ...rest, mine: actor === me, owner: names.get(actor) ?? '' }
}

async function usernames(pool: Pool, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { rows } = await pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [ids])
  return new Map(rows.map((r) => [r.id, r.username]))
}

const asInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined)



export function projectPtyRoutes(pool: Pool, hub: ConnectorHub) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)
  const guard = makeGuard(pool, hub)

  const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
    const raw: unknown = await c.req.json().catch(() => null)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  }

  app.get('/api/pages/:id/project/pty', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      const me = c.get('user').id
      const reply = await askProject(hub, g.ctx, 'pty-list', (rid, actor) => ({ t: 'pty-list', rid, actor }))
      const names = await usernames(pool, [...new Set(reply.ptys.map((p) => p.actor))])
      return c.json({ isOwner: g.ctx.machine.ownerId === me, ptys: reply.ptys.map((p) => toPublic(p, me, names)) })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.post('/api/pages/:id/project/pty', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    const { ctx, pageId } = g
    const user = c.get('user')
    try {
      const b = await body(c)
      const cols = asInt(b.cols) ?? 0
      const rows = asInt(b.rows) ?? 0
      // 打开别人的机器上的终端要留痕（主人自己不记）；写不进审计就不打开
      await recordProjectUse(pool, ctx, user.id, pageId, { op: 'open', root: ctx.root }, 'terminal')
      const reply = await askProject(hub, ctx, 'pty-open', (rid, actor) => ({ t: 'pty-open', rid, actor, root: ctx.root, cols, rows }))
      return c.json({ pty: toPublic(reply.pty, user.id, new Map()) }, 201)
    } catch (err) {
      return failure(c, err)
    }
  })



  app.delete('/api/pages/:id/project/pty/:ptyId', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    const ptyId = c.req.param('ptyId')
    try {
      await recordProjectUse(pool, g.ctx, c.get('user').id, g.pageId, { op: 'close', ptyId }, 'terminal')
      await askProject(hub, g.ctx, 'pty-close', (rid, actor) => ({ t: 'pty-close', rid, actor, ptyId }))
      return c.json({ ok: true })
    } catch (err) {
      return failure(c, err)
    }
  })


  return app
}
