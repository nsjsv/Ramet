// ---------- 项目面板各路由共用：页面可读 + machine 授权的守卫，以及各种失败 → HTTP ----------
// routes/project.ts（文件 / git）与 routes/project-pty.ts（终端）都先过这一关；判定的唯一实现在 agents/project.ts 的 projectContext
// （assertCanUse(..., 'machine')），这里只负责把它的结果翻成 HTTP。

import type { Context } from 'hono'
import type { Pool } from 'pg'
import type { AuthEnv } from '../auth.js'
import { pageAccess } from '../collab.js'
import type { ConnectorHub } from '../agents/hub.js'
import { ForbiddenError } from '../agents/posture.js'
import { UnknownAgentError } from '../agents/manager-types.js'
import { ConnectorOutdatedError, ProjectError, TerminalUnsupportedError } from '../agents/project-types.js'
import { MachineOfflineError, NotMachineAgentError, projectContext, type ProjectCtx } from '../agents/project.js'
import { writable } from './pages.js'

export type ProjectFailure = { status: 400 | 403 | 404 | 409; error: string; message: string }

/** 项目面板的各种失败 → HTTP 状态 + 机读 error + 人话 message。认得的都给人话；不认得的当 connector 侧失败（400），不是服务器 bug。
 *  REST（failure）与终端 WebSocket（routes/pty-socket.ts：关闭码 = 4000 + status）共用这一份 */
export function classifyFailure(err: unknown): ProjectFailure {
  if (err instanceof ForbiddenError) return { status: 403, error: 'forbidden', message: err.message }
  if (err instanceof NotMachineAgentError) return { status: 400, error: 'not a machine agent', message: err.message }
  if (err instanceof UnknownAgentError) return { status: 400, error: 'unknown agent', message: '这个 agent 当前不可用' }
  if (err instanceof MachineOfflineError) return { status: 409, error: 'machine offline', message: err.message }
  if (err instanceof TerminalUnsupportedError) return { status: 409, error: 'terminal unsupported', message: err.message }
  if (err instanceof ConnectorOutdatedError) return { status: 409, error: 'connector outdated', message: err.message }
  if (err instanceof ProjectError && err.forbidden) return { status: 403, error: 'forbidden', message: err.message }
  if (err instanceof ProjectError && err.notFound) return { status: 404, error: 'not found', message: err.message }
  if (err instanceof ProjectError && err.conflict) return { status: 409, error: 'conflict', message: err.message }
  return { status: 400, error: 'project failed', message: err instanceof Error ? err.message : String(err) }
}

export function failure(c: Context<AuthEnv>, err: unknown): Response {
  const { status, error, message } = classifyFailure(err)
  return c.json({ error, message }, status)
}

/** 页面可读 + machine 授权，过了返回上下文；不过返回响应。write = true（写文件）再加一条：页面可写（viewer 403，在 machine 授权之前判） */
export function makeGuard(pool: Pool, hub: ConnectorHub) {
  return async function guard(c: Context<AuthEnv>, opts: { write?: boolean } = {}): Promise<{ ctx: ProjectCtx; pageId: string } | Response> {
    const user = c.get('user')
    const pageId = c.req.param('id') ?? ''
    // 页面不存在 / 非成员 / 已回收：统一 404，不泄露存在性（viewer 可读，项目面板读不要求页面写权限）
    const role = await pageAccess(pool, pageId, user)
    if (!role) return c.json({ error: 'page not found' }, 404)
    if (opts.write && !writable(role)) return c.json({ error: 'forbidden', message: '你在这个空间里是只读成员，不能修改文件' }, 403)
    const agent = c.req.query('agent') ?? ''
    if (!agent) return c.json({ error: 'agent required' }, 400)
    try {
      return { ctx: await projectContext(pool, hub, pageId, agent, user), pageId }
    } catch (err) {
      return failure(c, err)
    }
  }
}
