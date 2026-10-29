/* ---------- agent 控制条 REST + SSE ----------
 * POST /api/pages/:id/continue   {agent?, team?} → 202 立即返回，进度走 SSE；忙 → 409。
 *                                 team 是计划 id（带队的执行轮，开工），先同步预检：计划属于本页、只有发起人（403）、
 *                                 必须还是草稿（409）、组长必须是出计划的那个 agent（409）、每个任务的负责人此刻发起人都能用
 *                                 （没权限 403 / 不可用 409），通过才 202；预检之后的翻转（draft → running）是原子的，
 *                                 并发的第二次开工在 SSE 里收到 error
 * POST /api/pages/:id/agent-prepare {agent}       选 agent 时预备会话（不生成），配置项走 SSE
 * POST /api/pages/:id/agent-config {agent, configId, value} 改会话配置（模型 / 思考程度）
 * POST /api/pages/:id/agent-cwd  {agent, cwd}     指定工作区（cwd 空串 = 回到执行端默认）
 * POST /api/pages/:id/agent-choice {agent}        记住本页的来源（没记过的页回落用户的全局默认）
 * POST /api/pages/:id/agent-tools {profile}       本页的工具档位 none / minimal / full（agents/tool-profile.ts；只落意图，不驱动机器，下一轮生效）
 * GET  /api/pages/:id/agent-dirs?agent=&path=     列执行端目录（工作区选择器；path 省略 = 当前工作区）
 * POST /api/pages/:id/stop                        取消当前生成
 * POST /api/pages/:id/stop-command {terminalId}   停止 agent 在 ACP 终端里跑的一条命令（只作用于这页正在跑的这一轮；
 *                                     同 stop，不要机器使用凭据）→ { ok }（false = 没有这条在跑的命令）
 * GET/POST /api/pages/:id/queue、DELETE /api/pages/:id/queue/:itemId、POST …/queue/:itemId/now  运行中排队发送（send-queue.ts）
 * POST /api/pages/:id/permission {agentId, requestId, optionId, content?} 审批应答：未匹配 404；选项会让会话进入
 *                                     「跳过全部确认」而不是机器主人 403；agent 所在机器不在线 409（审批留着）。
 *                                     提问（带 form）：optionId = accept（带 content）/ decline；答案不合表单 400 {message}
 * POST /api/pages/:id/replies/:replyId/regenerate → 202 原地重新生成这块回复（旧回答先进快照），也是失败的重试
 * GET  /api/agents                                可选 agent 列表，只含你能用的（你接入的机器 + 授权给你的机器；
 *                                     本机 agent 仅 admin 且需 RAMET_LOCAL_AGENTS=1）。每项带 machine：你对这台机器有
 *                                     machine 范围的使用权（项目面板入口的依据，见 routes/project.ts）
 * GET  /api/pages/:id/agent-events  SSE：choice、tool_profile（首帧）/ status / permission / commands / config / cwd / text / done / error
 * 机器所有权：凡是会让 connector 机器动起来的入口（continue / regenerate / permission / agent-config /
 *   agent-prepare / agent-dirs / agent-cwd / agent-choice，以及 @ 链、run_agent）都要求使用者是接入人或持有有效授权，
 *   否则 403 `{error:'forbidden', message:'这台机器属于 <主人>，需要他授权'}`；stop 只让机器停下来，不要求。
 * 权限：除 events 外要求页面写权限（owner / member）；events 任意可见角色可读。 */

import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv, type AuthUser } from '../auth.js'
import { pageAccess } from '../collab.js'
import type { AgentManager } from '../agents/manager.js'
import {
  AgentOfflineError,
  BadAnswerError,
  NoSessionError,
  NoUserMessageError,
  ReplyNotFoundError,
  UnknownAgentError,
  UnknownApprovalError,
  type RunTarget,
} from '../agents/manager-types.js'
import { ForbiddenError } from '../agents/posture.js'
import { QueueBadRequestError, QueueForbiddenError } from '../agents/send-queue.js'
import { TeamPlanError } from '../agents/team-plan.js'
import { isToolProfile } from '../agents/tool-profile.js'

export function agentsRoutes(pool: Pool, manager: AgentManager) {
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  // 任意页面角色可见（events 只读也行），非成员 / 不存在一律 404，不泄露存在性
  async function visibleUser(c: Context<AuthEnv>): Promise<AuthUser | null> {
    const user = c.get('user')
    const pageId = c.req.param('id') ?? ''
    return (await pageAccess(pool, pageId, user)) ? user : null
  }

  // 写权限：owner / member，viewer 只读
  async function writableUser(c: Context<AuthEnv>): Promise<AuthUser | null> {
    const user = c.get('user')
    const pageId = c.req.param('id') ?? ''
    const role = await pageAccess(pool, pageId, user)
    if (!role || role === 'viewer') return null
    return user
  }

  // 本机直 spawn 的 agents + 调用者所在空间里在线 connector 的 agents（离线的不出现：现在真调不动）
  app.get('/api/agents', (c) => manager.catalog(c.get('user')).then((list) => c.json(list)))

  app.post('/api/pages/:id/continue', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { agent?: string; team?: unknown }
    if (body.team !== undefined && (typeof body.team !== 'string' || !body.team)) return c.json({ error: 'invalid team' }, 400)
    if (manager.running(c.req.param('id') ?? '')) return c.json({ error: 'busy', message: '该页面已有 agent 正在生成' }, 409)
    // 执行目标先解析（优先级只在这里定：消息 attrs > 请求体 > 目录第一个），
    // 这样消息指定的 agent 不认识是干净的 400，而不是 202 之后的静默失败
    let target: RunTarget
    try {
      target = await manager.resolveRun(c.req.param('id') ?? '', body, user)
    } catch (err) {
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown agent', message: '这条消息指定的 agent 当前不可用' }, 400)
      }
      return c.json({ error: 'resolve failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
    // 带队的执行轮：预检通过才把计划 id 并进执行目标
    if (typeof body.team === 'string') {
      try {
        await manager.precheckTeamStart(c.req.param('id') ?? '', body.team, user, target)
      } catch (err) {
        if (err instanceof TeamPlanError) return c.json({ error: err.code, message: err.message }, err.status)
        throw err
      }
      target = { ...target, team: { planId: body.team } }
    }
    // 不 await 整个生成，202 立即返回，流式进度经 SSE 推送
    void manager
      .continue(c.req.param('id') ?? '', target, user, c.req.header('cookie') ?? '')
      .catch(() => undefined)
    return c.json({ ok: true }, 202)
  })

  // 重新生成 / 重试：对一块已有的回复再跑一轮，块 id 不变、内容原地换掉。目标先解析成干净的 4xx
  // （fire-and-forget 之后错误到不了响应体）：找不到回复 404，之前没有用户消息或 agent 已不可用 400，页面忙 409
  app.post('/api/pages/:id/replies/:replyId/regenerate', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const pageId = c.req.param('id') ?? ''
    let target: RunTarget
    try {
      target = await manager.resolveRedo(pageId, c.req.param('replyId') ?? '', user)
    } catch (err) {
      if (err instanceof ReplyNotFoundError) return c.json({ error: 'reply not found', message: err.message }, 404)
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof NoUserMessageError) return c.json({ error: 'no user message', message: err.message }, 400)
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown agent', message: '这块回复对应的 agent 当前不可用' }, 400)
      }
      return c.json({ error: 'resolve failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
    if (manager.running(pageId)) return c.json({ error: 'busy', message: '该页面已有 agent 正在生成' }, 409)
    void manager.continue(pageId, target, user, c.req.header('cookie') ?? '').catch(() => undefined)
    return c.json({ ok: true }, 202)
  })

  // 指定 / 清除该 agent 的工作区（cwd 空串 = 回到执行端默认）。只改用户指定这一层，
  // 旧会话是否作废由下一轮 / 下一次 prepare 的 cwd 一致性判定，端点不碰会话记录
  app.post('/api/pages/:id/agent-cwd', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { agent?: string; cwd?: string } | null
    if (!body || typeof body.agent !== 'string' || !body.agent || typeof body.cwd !== 'string') {
      return c.json({ error: 'agent/cwd required' }, 400)
    }
    try {
      const cwd = await manager.setWorkspace(c.req.param('id') ?? '', { agent: body.agent, cwd: body.cwd }, user)
      return c.json({ cwd })
    } catch (err) {
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof UnknownAgentError) return c.json({ error: 'unknown agent' }, 400)
      return c.json({ error: 'set cwd failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // 记住本页的来源：页面级意图（同工作区 / 配置项，协作者共享）
  app.post('/api/pages/:id/agent-choice', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { agent?: string } | null
    if (!body || typeof body.agent !== 'string' || !body.agent) return c.json({ error: 'agent required' }, 400)
    try {
      await manager.setChoice(c.req.param('id') ?? '', body.agent, user)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof UnknownAgentError) return c.json({ error: 'unknown agent', message: '这个 agent 当前不可用' }, 400)
      return c.json({ error: 'set choice failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // 本页的工具档位：页面级意图（同 choice），只要页面写权限，不碰任何机器，不需要机器授权
  app.post('/api/pages/:id/agent-tools', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { profile?: unknown } | null
    if (!body || !isToolProfile(body.profile)) return c.json({ error: 'profile must be none / minimal / full' }, 400)
    await manager.setToolProfile(c.req.param('id') ?? '', body.profile)
    return c.json({ ok: true })
  })

  // 列执行端目录（工作区选择器）；path 省略 = 该 agent 当前生效的工作区。
  // 机器由 manager 按 agent 判定：本机直读磁盘，远端经 WSS 问 connector
  app.get('/api/pages/:id/agent-dirs', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const agent = c.req.query('agent') ?? ''
    if (!agent) return c.json({ error: 'agent required' }, 400)
    try {
      const listing = await manager.listWorkspaceDirs(c.req.param('id') ?? '', agent, c.req.query('path') ?? '', user)
      return c.json(listing)
    } catch (err) {
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof UnknownAgentError) return c.json({ error: 'unknown agent' }, 400)
      // agent 侧列不出来（目录不存在 / connector 掉线 / 旧版本不认 ls）：把原因给前端，选择器就地显示
      return c.json({ error: 'list failed', message: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // 选 agent 时预备会话（不发起生成），会话建好后模型 / 思考程度等配置项经 SSE 推给前端。
  // 立即 202，不等 agent 冷启动（同 continue 的 fire-and-forget）：冷启动是分钟级的（claude 的 npx 适配器 >120s），
  // 同步等必然超时，生产 nginx /api 默认 proxy_read_timeout 60s，前端只看到 NetworkError，直连则撞 hub 的 120s 请求超时。
  // 只有未知 agent 这种能立刻判定的错误才同步 400，它决定 UI 能不能显示这个来源。
  app.post('/api/pages/:id/agent-prepare', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { agent?: string } | null
    if (!body || typeof body.agent !== 'string' || !body.agent) {
      return c.json({ error: 'agent required' }, 400)
    }
    const pageId = c.req.param('id') ?? ''
    // 解析一次即可判定认不认识这个 agent（纯目录 / DB 查询，不碰 agent 进程）
    try {
      if (!(await manager.resolve(body.agent, user))) {
        return c.json({ error: 'unknown agent', message: '这个 agent 当前不可用' }, 400)
      }
    } catch (err) {
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      throw err
    }
    // 起不来 / 超时 / connector 掉线：响应已经 202 了，改经 SSE 告知前端
    void manager.prepare(pageId, body.agent, user).catch((err: unknown) => {
      manager.notifyRunError(pageId, err instanceof Error ? err.message : String(err))
    })
    return c.json({ ok: true }, 202)
  })

  app.post('/api/pages/:id/stop', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    manager.stop(c.req.param('id'))
    return c.json({ ok: true })
  })

  // 运行中排队发送（agents/send-queue.ts）：页面可写才能看 / 排，撤回、立即发送只有排的人自己能做（403）
  app.get('/api/pages/:id/queue', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    return c.json(await manager.queue.list(c.req.param('id') ?? ''))
  })

  app.post('/api/pages/:id/queue', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    try {
      const item = await manager.queue.enqueue(c.req.param('id') ?? '', user, { agent: body.agent, kind: body.kind, text: body.text, images: body.images })
      return c.json({ item }, 201)
    } catch (err) {
      if (err instanceof QueueBadRequestError) return c.json({ error: 'bad request', message: err.message }, 400)
      throw err
    }
  })

  app.delete('/api/pages/:id/queue/:itemId', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    try {
      const back = await manager.queue.withdraw(c.req.param('id') ?? '', c.req.param('itemId') ?? '', user)
      return back ? c.json(back) : c.json({ error: 'not found' }, 404)
    } catch (err) {
      if (err instanceof QueueForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      throw err
    }
  })

  app.post('/api/pages/:id/queue/:itemId/now', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    try {
      const ok = await manager.queue.sendNow(c.req.param('id') ?? '', c.req.param('itemId') ?? '', user)
      return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
    } catch (err) {
      if (err instanceof QueueForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      throw err
    }
  })

  app.post('/api/pages/:id/stop-command', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { terminalId?: unknown } | null
    if (typeof body?.terminalId !== 'string' || !body.terminalId) return c.json({ error: 'terminalId required' }, 400)
    return c.json({ ok: manager.killCommand(c.req.param('id'), body.terminalId) })
  })

  app.post('/api/pages/:id/permission', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as
      | { agentId?: string; requestId?: string; optionId?: string | null; content?: unknown }
      | null
    if (!body?.agentId || !body.requestId) return c.json({ error: 'agentId/requestId required' }, 400)
    try {
      await manager.answerPermission(
        c.req.param('id') ?? '',
        { agentId: body.agentId, requestId: body.requestId, optionId: body.optionId ?? null, content: body.content },
        user,
      )
    } catch (err) {
      if (err instanceof UnknownApprovalError) return c.json({ error: 'unknown requestId' }, 404)
      // 提问的答案不合表单：提问仍然挂着，前端把原因显示在卡片上
      if (err instanceof BadAnswerError) return c.json({ error: 'bad answer', message: err.message }, 400)
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof AgentOfflineError) return c.json({ error: 'agent offline', message: err.message }, 409)
      throw err
    }
    return c.json({ ok: true })
  })

  // 修改 agent 会话配置（模型 / 思考程度），成功返回该会话当前 config options
  app.post('/api/pages/:id/agent-config', async (c) => {
    const user = await writableUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => null)) as
      | { agent?: string; configId?: string; value?: string }
      | null
    if (!body || typeof body.agent !== 'string' || !body.agent
      || typeof body.configId !== 'string' || !body.configId
      || typeof body.value !== 'string' || !body.value) {
      return c.json({ error: 'agent/configId/value required' }, 400)
    }
    try {
      const options = await manager.setConfig(c.req.param('id') ?? '', {
        agent: body.agent, configId: body.configId, value: body.value,
      }, user)
      return c.json({ options })
    } catch (err) {
      if (err instanceof UnknownAgentError) return c.json({ error: 'unknown agent' }, 400)
      if (err instanceof ForbiddenError) return c.json({ error: 'forbidden', message: err.message }, 403)
      if (err instanceof NoSessionError) return c.json({ error: 'no session', message: err.message }, 409)
      return c.json({ error: 'config rejected', message: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get('/api/pages/:id/agent-events', async (c) => {
    const user = await visibleUser(c)
    if (!user) return c.json({ error: 'page not found' }, 404)
    const pageId = c.req.param('id')
    // 本页记住的来源要先于别的事件到：前端在知道它之前不预备会话，否则会先冷启动一个全局默认 agent
    const [choice, profile] = await Promise.all([manager.choice(pageId), manager.toolProfile(pageId)])
    return streamSSE(c, async (stream) => {
      stream.writeSSE({ data: JSON.stringify({ type: 'choice', agentId: choice }) }).catch(() => undefined)
      stream.writeSSE({ data: JSON.stringify({ type: 'tool_profile', profile }) }).catch(() => undefined)
      // 首帧（当前状态 + 已收集的步骤快照）由 manager.subscribe 在订阅瞬间发出，
      // 新订阅者该先知道什么由状态所有者说了算，路由不自己拼
      const unsubscribe = manager.subscribe(pageId, async (ev) => {
        // 排队写出即可，stream 内部按序写，失败由下方 catch 兜底
        stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => undefined)
      })
      const heartbeat = setInterval(() => {
        // EventSource 会忽略未知事件名，前端监听 message 事件，不受影响
        stream.writeSSE({ data: '', event: 'ping' }).catch(() => undefined)
      }, 15_000)
      heartbeat.unref?.()
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      // streamSSE 回调返回即关流，这里挂住保持长连接，靠 abort 退出
      await new Promise<void>(() => undefined)
    })
  })

  return app
}
