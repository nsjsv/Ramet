// ---------- 项目面板的 REST（中心只鉴权 + 转发给 connector，不碰用户机器的文件系统）----------
// GET /api/pages/:id/project?agent=<catalogId>             → { machine:{id,name,owner,online}, root, repo, branch, ahead?, behind?, caps, canUse:true, error? }
//                                                             （和下面几个一样：机器不在线 / connector 太旧 → 409；工作区目录本身有问题 → 200 带 error）
// GET /api/pages/:id/project/tree?agent=&path=             → { path, entries:[{name,type,size?,git?}], truncated }
// GET /api/pages/:id/project/read?agent=&path=             → { path, size, binary, text, truncated }
// GET /api/pages/:id/project/files?agent=                  → { files, truncated }      （⌘P 文件清单）
// GET /api/pages/:id/project/git-status?agent=             → { repo, branch, ahead?, behind?, files:[{path,mark,staged,from?,by?}], truncated }
//                                                             by = 本页哪个 agent（catalog id）改过这个文件；没有 = 不是 agent 改的
// GET /api/pages/:id/project/git-diff?agent=&path=         → { path?, diff, truncated }
// POST /api/pages/:id/project/write?agent=  { path, baseHash, content } → { path, hash }   （写文件：只改已存在的文本文件，见下）
//
// 权限（machine 范围）：页面可读 **并且** 对 agent 所在的机器有 machine 授权（接入人 ∨ 有效授权）。
// 只有 agent 授权的人、空间 owner、全局 admin 都是 403。读也算：别人的机器上的文件不是公开的。
// 状态码：非成员 / 页面不存在 404；agent 不是 connector 上的 400；机器不在你的空间里 / agent 已不在 400；
//         没有 machine 授权 403（文案带主人名）；机器不在线 409；connector 版本太旧 409 { error:'connector outdated' }；
//         connector 的第二道闸拒绝 403；路径越界 / 不存在 / 不是文件等 400（message 是人话）。
// 除 write 外全部只读。终端在 routes/project-pty.ts（同一个守卫）。
// 写文件（随手 AI 在代码查看器里收下改写）同样走 machine 范围，另加三条：页面可写（viewer 403，在 machine 授权之前判）、
// 非主人先留痕（action 'write'）再发帧、connector 没有 write 能力（老版本）409 connector outdated 且不发帧。
// 409 conflict = 文件已不是你读到的那一版（baseHash 不符）。成功后记一行 quick_writes，git-status 的 by 据此给 'quick'。

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import type { ConnectorHub } from '../agents/hub.js'
import { READ_MAX_BYTES, ProjectError } from '../agents/project-types.js'
import { askProject, recordProjectUse, touchedByAgents } from '../agents/project.js'
import { quickWrittenAt, recordQuickWrite, withAuthors } from '../agents/project-write.js'
import { failure, makeGuard } from './project-common.js'

export function projectRoutes(pool: Pool, hub: ConnectorHub) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)

  const guard = makeGuard(pool, hub)

  const pathOf = (c: Context<AuthEnv>): string => c.req.query('path') ?? ''

  // 面板头：机器 / 目录 / 分支 / 在线。取分支要问 connector（git-status），所以机器不在线 / connector 太旧同样是 409；
  // 工作区目录本身有问题（不存在、没权限）是数据问题不是机器状态：200，原因放在 error 里，面板照样画
  app.get('/api/pages/:id/project', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    const { ctx, pageId } = g
    try {
      await recordProjectUse(pool, ctx, c.get('user').id, pageId, { op: 'open' })
      const head = {
        machine: { id: ctx.machine.id, name: ctx.machine.name, owner: ctx.machine.owner, online: ctx.machine.online },
        root: ctx.root,
        caps: ctx.caps,
        canUse: true as const,
      }
      try {
        const status = await askProject(hub, ctx, 'git-status', (rid, actor) => ({ t: 'git-status', rid, actor, root: ctx.root }))
        return c.json({
          ...head,
          repo: status.repo,
          branch: status.branch,
          ...(status.detached ? { detached: true } : {}),
          ...(status.ahead !== undefined ? { ahead: status.ahead } : {}),
          ...(status.behind !== undefined ? { behind: status.behind } : {}),
        })
      } catch (err) {
        // 只有「工作区本身的问题」才降级成 200 + error；机器离线 / 太旧 / 第二道闸拒绝照常是 409 / 403
        if (!(err instanceof ProjectError) || err.forbidden) throw err
        return c.json({ ...head, repo: false, branch: null, error: err.message })
      }
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/api/pages/:id/project/tree', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      const { op: _op, ...reply } = await askProject(hub, g.ctx, 'tree', (rid, actor) => ({ t: 'tree', rid, actor, root: g.ctx.root, path: pathOf(c) }))
      return c.json(reply)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/api/pages/:id/project/read', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      // 读别人的机器上的文件要留痕（主人自己读不记）；写不进审计就不读
      await recordProjectUse(pool, g.ctx, c.get('user').id, g.pageId, { op: 'read', path: pathOf(c).slice(0, 500) })
      const { op: _op, ...reply } = await askProject(hub, g.ctx, 'read', (rid, actor) => ({ t: 'read', rid, actor, root: g.ctx.root, path: pathOf(c) }))
      return c.json(reply)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/api/pages/:id/project/files', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      const { op: _op, ...reply } = await askProject(hub, g.ctx, 'files', (rid, actor) => ({ t: 'files', rid, actor, root: g.ctx.root }))
      return c.json(reply)
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/api/pages/:id/project/git-status', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      const { op: _op, ...reply } = await askProject(hub, g.ctx, 'git-status', (rid, actor) => ({ t: 'git-status', rid, actor, root: g.ctx.root }))
      // 谁改的：本页各轮 run 记录里 agent 改过的文件标上 agent；随手 AI 写的（比 agent 那一轮更近）标 'quick'；其余是用户自己改的（前端标「你」）
      if (reply.files.length === 0) return c.json(reply)
      const [touched, quick] = await Promise.all([
        touchedByAgents(pool, g.pageId, g.ctx.root),
        quickWrittenAt(pool, g.pageId, g.ctx.machine.id, g.ctx.root, reply.files.map((f) => f.path)),
      ])
      return c.json({ ...reply, files: withAuthors(reply.files, touched, quick) })
    } catch (err) {
      return failure(c, err)
    }
  })

  app.get('/api/pages/:id/project/git-diff', auth, async (c) => {
    const g = await guard(c)
    if (g instanceof Response) return g
    try {
      const path = c.req.query('path')
      await recordProjectUse(pool, g.ctx, c.get('user').id, g.pageId, { op: 'diff', ...(path ? { path: path.slice(0, 500) } : {}) })
      const { op: _op, ...reply } = await askProject(hub, g.ctx, 'git-diff', (rid, actor) => ({
        t: 'git-diff',
        rid,
        actor,
        root: g.ctx.root,
        ...(path ? { path } : {}),
      }))
      return c.json(reply)
    } catch (err) {
      return failure(c, err)
    }
  })

  // 写文件：body 上限留出 JSON 转义的余量（内容本身 ≤ READ_MAX_BYTES，connector 还会再判一次）
  app.post(
    '/api/pages/:id/project/write',
    auth,
    bodyLimit({ maxSize: READ_MAX_BYTES * 2 + 8192, onError: (c) => c.json({ error: 'too large', message: '内容超过 1MB，不能就地修改' }, 413) }),
    async (c) => {
      const g = await guard(c, { write: true })
      if (g instanceof Response) return g
      const body = (await c.req.json().catch(() => null)) as { path?: unknown; baseHash?: unknown; content?: unknown } | null
      const { path, baseHash, content } = body ?? {}
      if (typeof path !== 'string' || !path || path.length > 1000 || typeof baseHash !== 'string' || typeof content !== 'string') {
        return c.json({ error: 'bad request', message: '参数无效' }, 400)
      }
      if (Buffer.byteLength(content, 'utf8') > READ_MAX_BYTES) return c.json({ error: 'too large', message: '内容超过 1MB，不能就地修改' }, 413)
      const userId = c.get('user').id
      try {
        // 改别人的机器上的文件要留痕（主人自己写不记）；写不进审计就不写。不记内容，只记路径
        await recordProjectUse(pool, g.ctx, userId, g.pageId, { op: 'write', path: path.slice(0, 500) }, 'write')
        const { op: _op, ...reply } = await askProject(hub, g.ctx, 'write', (rid, actor) => ({
          t: 'write',
          rid,
          actor,
          root: g.ctx.root,
          path,
          baseHash,
          content,
        }))
        // 文件已经写下去了：标记失败不该让这次写入看起来失败（顶多改动页把它标成「你」）
        await recordQuickWrite(pool, g.pageId, g.ctx.machine.id, g.ctx.root, reply.path, userId).catch((err: unknown) =>
          console.error('[project] 记录随手 AI 写入失败', err),
        )
        return c.json(reply)
      } catch (err) {
        return failure(c, err)
      }
    },
  )

  return app
}
