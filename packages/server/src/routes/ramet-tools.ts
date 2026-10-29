/* ---------- Ramet MCP 工具的中心端点（AI 回打中心，凭证走 Authorization: Bearer） ----------
 * 知识中枢（搜索 / 新建 / 移动 / 改名 / 移入回收站）、AI 互调（run_agent）与 skill 都在这里，按发起这一轮的用户
 * 的身份与权限执行：权限判定只用页面写入共用的闸门（pageRole / writable / parentOk / validParent / trashPageSubtree），
 * 不为 AI 另写一套。凭证绑着「哪一页上的哪个 agent」（page-read.ts 的 GrantCtx）：新建页默认放当前页下、
 * 审批弹在当前页、叫别的 agent 留痕在当前页的运行里，都靠它，AI 自己不传 pageId，冒充不了别的会话。
 * 必须挂在 files/search/pages 这些 `use('*', requireAuth)` 的子应用之前（同 pageReadRoutes）。
 *
 * 会等很久的端点（移入回收站要等用户批准、run_agent 要等被叫做完）先发头、定时吐空白保活，最后一段才是 JSON：
 * 否则 MCP 进程的 fetch 会在默认的 5 分钟头 / 体超时、nginx 会在 60 秒无数据时断开（审批不能超时）。 */

import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { myPersonalSpaceId } from '../clone.js'
import { writeDocState } from '../collab.js'
import type { OwnApprovals } from '../agents/own-approvals.js'
import { newPageDoc } from '../agents/markdown.js'
import type { SubRunResult } from '../agents/sub-run.js'
import { TeamToolError } from '../agents/team.js'
import { TeamPlanError } from '../agents/team-plan.js'
import { SubRunError } from '../agents/sub-run.js'
import { parseNew } from '../page-write.js'
import { isMinimalGrant, pageGrantOf, type GrantCtx } from '../page-read.js'
import { MINIMAL_TOOLS } from '../agents/tool-profile.js'
import {
  INSERT,
  SELECT,
  SET_PARENT,
  SET_TITLE,
  pageRole,
  parentOk,
  roleInSpace,
  trashPageSubtree,
  validParent,
  writable,
  type PageRow,
} from './pages.js'
import { searchPages } from './search.js'
import { listSkills, skillBody, skillByName, skillFileData, skillFileList } from '../skills.js'
import { addMemory, checkMemory } from '../memories.js'

/** manager.toolHost() 交给端点的能力（端点自己不碰 manager 的私有状态） */
export type ToolHost = {
  approvals: OwnApprovals
  /** 这个用户能叫的 agent（不含调用方自己） */
  agentsFor(user: { id: string; role: string }, callerAgentId: string): Promise<Array<{ id: string; label: string }>>
  runAgent(
    ctx: { pageId: string; callerAgentId: string; user: { id: string; role: string } },
    callee: { id: string; label: string },
    task: string,
    signal: AbortSignal,
  ): Promise<SubRunResult>
  /** 带队组长的两个工具（agents/team.ts）。凭证带的 team 上下文必须对得上一轮还在飞的带队轮，否则 round 回 null / 其余抛错 */
  team: {
    round(team: NonNullable<GrantCtx['team']>, user: { id: string; role: string }, pageId: string | null): Promise<
      | { tool: 'submit_plan'; candidates: Array<{ id: string; label: string }> }
      | { tool: 'send_back'; tasks: Array<{ id: string; title: string; status: string; backs: number }> }
      | null
    >
    submitPlan(team: NonNullable<GrantCtx['team']>, user: { id: string; role: string }, pageId: string | null, raw: unknown): Promise<{ planId: string }>
    sendBack(team: NonNullable<GrantCtx['team']>, user: { id: string; role: string }, pageId: string | null, taskId: string, feedback: string, signal: AbortSignal): Promise<SubRunResult>
  }
}

const HEARTBEAT_MS = 15_000

/** 读页面 / 读图片 / 改页面三个基础工具 + 知识中枢；run_agent 与 use_skill 按凭证 / 空间再加（见 GET /api/ramet/tools） */
const BASE_TOOLS = ['read_page', 'read_image', 'edit_page', 'search_pages', 'create_page', 'move_page', 'rename_page', 'trash_page']

type Granted = { user: { id: string; role: 'admin' | 'user' }; ctx: GrantCtx }

function bearer(c: Context): string {
  const header = c.req.header('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

async function granted(pool: Pool, c: Context): Promise<Granted | null> {
  const token = bearer(c)
  return token ? await pageGrantOf(pool, token) : null
}

/** 先发头、定时吐空白、最后一段 JSON：长等待的端点共用（见文件头） */
function heartbeatJson(c: Context, work: () => Promise<unknown>): Response {
  c.header('content-type', 'application/json; charset=utf-8')
  c.header('cache-control', 'no-cache')
  c.header('x-accel-buffering', 'no')
  return stream(c, async (s) => {
    const timer = setInterval(() => void s.write(' '), HEARTBEAT_MS)
    try {
      const result = await work().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
      await s.write(JSON.stringify(result))
    } finally {
      clearInterval(timer)
    }
  })
}

/** 工具说明里列出的 skill 个数上限（再多的靠名字直接调用；索引太长会吃掉每个会话的上下文） */
const SKILL_INDEX_MAX = 100

export function rametToolRoutes(
  pool: Pool,
  host: () => ToolHost,
  notify?: () => void,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  /** 空间公共记忆变了（agent 提议被点「记住」）：广播给在线端重拉记忆面板 */
  notifyMemories?: () => void,
) {
  const app = new Hono()

  // 工具档位闸门（agents/tool-profile.ts）：精简档的凭证在这里只能问工具清单，其余端点一律 403 ——
  // 不只靠 MCP 进程不列出（凭证在 agent 那台机器上，绕过 MCP 直接打端点也得拦住）。读 / 图 / 写三个端点在 page-read.ts，不经这里
  app.use('/api/ramet/*', async (c, next) => {
    if (c.req.path !== '/api/ramet/tools' && isMinimalGrant(bearer(c))) {
      return c.json({ error: 'forbidden', message: '当前工具档位不提供这个工具' }, 403)
    }
    return next()
  })

  /** 这把凭证用的空间 skill 库：凭证绑的那页所在的空间（没绑页面 = 发起人的个人空间），发起人必须仍是成员 */
  async function grantSpace(g: Granted): Promise<string | null> {
    const page = g.ctx.pageId ? (await pool.query<PageRow>(SELECT, [g.ctx.pageId])).rows[0] : undefined
    const spaceId = g.ctx.pageId ? (page?.space_id ?? null) : await myPersonalSpaceId(pool, g.user.id)
    return spaceId && (await roleInSpace(pool, g.user, spaceId)) !== null ? spaceId : null
  }

  /** 页面闸门：存在 + 可见（不存在 / 非成员同响应 404）+ 可写（viewer 403） */
  async function writablePage(user: Granted['user'], id: string): Promise<{ page: PageRow } | { status: 403 | 404; error: string }> {
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    if (!page || role === null) return { status: 404, error: 'page not found' }
    if (!writable(role)) return { status: 403, error: 'forbidden' }
    return { page }
  }

  // 这把凭证能用哪些工具与可叫的 agent（MCP 进程据此决定列出什么；被叫的会话没有 run_agent）
  app.get('/api/ramet/tools', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (g.ctx.profile === 'minimal') return c.json({ tools: MINIMAL_TOOLS, agents: [], skills: [] })
    const agents = g.ctx.canDispatch && g.ctx.pageId ? await host().agentsFor(g.user, g.ctx.agentId) : []
    const spaceId = await grantSpace(g)
    const skills = spaceId ? (await listSkills(pool, spaceId)).slice(0, SKILL_INDEX_MAX).map((s) => ({ name: s.name, description: s.description })) : []
    // 带队的组长凭证（只在对应的计划轮 / 执行轮、那一轮还在飞时）多一个工具：submit_plan / send_back；别的会话（含组员）没有
    const team = g.ctx.team ? await host().team.round(g.ctx.team, g.user, g.ctx.pageId) : null
    return c.json({
      // propose_memory 要有地方弹确认：凭证没绑页面就不列出
      tools: [...BASE_TOOLS, ...(g.ctx.pageId ? ['propose_memory'] : []), ...(agents.length > 0 ? ['run_agent'] : []), ...(skills.length > 0 ? ['use_skill'] : []), ...(team ? [team.tool] : [])],
      agents,
      skills,
      ...(team ? { team } : {}),
    })
  })

  // skill：说明正文 + 文件清单（路径 / 大小 / sha256）。文件本身按需逐个取（/file），本地缓存里哈希一致的不再下载
  app.get('/api/ramet/skills/:name', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const spaceId = await grantSpace(g)
    const info = spaceId ? await skillByName(pool, spaceId, c.req.param('name')) : null
    if (!info) return c.json({ error: `没有叫 ${c.req.param('name')} 的 skill` }, 404)
    return c.json({
      spaceId: info.spaceId,
      name: info.name,
      description: info.description,
      body: await skillBody({ pool, getLiveDoc }, info.id),
      files: await skillFileList(pool, info.id),
    })
  })

  app.get('/api/ramet/skills/:name/file', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const spaceId = await grantSpace(g)
    const info = spaceId ? await skillByName(pool, spaceId, c.req.param('name')) : null
    const data = info ? await skillFileData(pool, info.id, c.req.query('path') ?? '') : null
    if (!data) return c.json({ error: 'file not found' }, 404)
    c.header('content-type', 'application/octet-stream')
    return c.body(new Uint8Array(data))
  })

  app.post('/api/ramet/search', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { query?: unknown; limit?: unknown }
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return c.json({ error: 'query required' }, 400)
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.min(Math.max(Math.floor(body.limit), 1), 30) : 10
    const hits = await searchPages(pool, g.user, query, { limit })
    return c.json({ results: hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet })) })
  })

  // 新建页面：默认放在当前页下（凭证绑的那一页）；给 parentId 则放在那页下，同空间。要对父页有写权
  app.post('/api/ramet/pages', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; text?: unknown; parentId?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: 'title required' }, 400)
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : (g.ctx.pageId ?? null)
    let spaceId: string
    if (parentId) {
      const parent = await writablePage(g.user, parentId)
      if (!('page' in parent)) return c.json({ error: parent.error }, parent.status)
      if (!parent.page.space_id) return c.json({ error: 'parent has no space' }, 400)
      spaceId = parent.page.space_id
    } else {
      const personal = await myPersonalSpaceId(pool, g.user.id)
      if (!personal) return c.json({ error: 'personal space unavailable' }, 500)
      spaceId = personal
    }
    if (!(await parentOk(pool, g.user, parentId, spaceId))) return c.json({ error: 'parent not found' }, 400)
    const id = randomUUID()
    await pool.query(INSERT, [id, parentId, g.user.id, spaceId, true])
    await pool.query(SET_TITLE, [title, id])
    // 正文：标题 + markdown 落成块（建页时没有活连接，直接写整份文档状态；同过程页归档的做法）
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    await writeDocState(pool, `page:${id}`, newPageDoc(title, text ? parseNew(text) : []))
    notify?.()
    return c.json({ id, title, parentId })
  })

  app.post('/api/ramet/pages/:id/move', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const body = (await c.req.json().catch(() => ({}))) as { parentId?: unknown }
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null
    if (!(await parentOk(pool, g.user, parentId, found.page.space_id))) return c.json({ error: 'parent not found (or in another space)' }, 400)
    if (!(await validParent(pool, id, parentId))) return c.json({ error: 'parent would create a cycle' }, 400)
    await pool.query(SET_PARENT, [parentId, id])
    notify?.()
    return c.json({ ok: true, title: found.page.title, parentId })
  })

  app.post('/api/ramet/pages/:id/rename', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: 'title required' }, 400)
    await pool.query(SET_TITLE, [title, id])
    notify?.()
    return c.json({ ok: true, title })
  })

  // 移入回收站：危险操作，等用户在当前页的审批条里批准（无超时），拒绝则不执行
  app.post('/api/ramet/pages/:id/trash', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const pageId = g.ctx.pageId
    // 没有绑页面 = 没有地方弹审批：不能静默放行
    if (!pageId) return c.json({ error: '这个会话没有绑定页面，没法弹出审批，不能删除' }, 403)
    const label = `page:${id}「${found.page.title || '无标题'}」`
    return heartbeatJson(c, async () => {
      const allowed = await host().approvals.request(
        { pageId, agentId: g.ctx.agentId },
        { title: `把页面「${found.page.title || '无标题'}」移入回收站`, toolCall: { kind: 'delete', title: '移入回收站', rawInput: { page: label } } },
        c.req.raw.signal,
      )
      if (!allowed) return { rejected: true }
      return { ok: true, trashed: (await trashPageSubtree(pool, [id], notify)).length }
    })
  })

  // 提议记一条空间公共记忆：先判能不能写（空 / 超长 / 空间已满 → 直接回告 agent，不打扰用户），再在当前页弹审批「记住这条？」
  // （无超时、也进收件箱）。用户点「记住」才写（记在点的人名下，来源 = 当前页）；点「不用」/ 这一轮被停止 / 调用方断开 = 不写
  app.post('/api/ramet/memories/propose', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const pageId = g.ctx.pageId
    // 没有绑页面 = 没有地方弹确认：不能静默写入
    if (!pageId) return c.json({ error: '这个会话没有绑定页面，没法弹出确认，不能提议记忆' }, 403)
    const found = await writablePage(g.user, pageId)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const spaceId = found.page.space_id
    if (!spaceId) return c.json({ error: '这个页面不在任何空间里，没法记忆' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
    const checked = await checkMemory(pool, spaceId, typeof body.text === 'string' ? body.text : '')
    if (!checked.ok) return c.json({ error: checked.message }, checked.reason === 'empty' ? 400 : 413)
    const text = checked.text
    const brief = text.replace(/\s+/g, ' ')
    return heartbeatJson(c, async () => {
      const decision = await host().approvals.decide(
        { pageId, agentId: g.ctx.agentId },
        {
          title: `记住这条？「${brief.length > 60 ? `${brief.slice(0, 60)}…` : brief}」`,
          toolCall: { kind: 'other', title: '记住这条', content: [{ type: 'content', content: { type: 'text', text } }] },
          labels: { allow: '记住', reject: '不用' },
        },
        c.req.raw.signal,
      )
      if (!decision.allowed || !decision.by) return { declined: true }
      // 等待期间页面可能被回收 / 搬走：写入时按页面此刻所在的空间再判一次
      const now = (await pool.query<PageRow>(SELECT, [pageId])).rows[0]
      if (!now?.space_id) return { error: '页面已经不存在了，没有记下' }
      const res = await addMemory(pool, now.space_id, text, decision.by, pageId)
      if (!res.ok) return { error: res.message }
      notifyMemories?.()
      return { ok: true, id: res.memory.id }
    })
  })

  // 带队·组长提交计划（计划轮的 submit_plan）：凭证必须带 plan 阶段的 team 上下文，且那一轮还在飞。落成草稿，用户在计划卡上确认后才开工。
  // 校验不过 400（message 写给组长看，改了重交）；这一轮已结束 / 已被开工取消 409
  app.post('/api/ramet/team/plan', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (g.ctx.team?.kind !== 'plan') return c.json({ error: '这个会话不是带队的计划轮，不能提交计划' }, 403)
    try {
      return c.json(await host().team.submitPlan(g.ctx.team, g.user, g.ctx.pageId, await c.req.json().catch(() => null)))
    } catch (err) {
      if (err instanceof TeamPlanError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })

  // 带队·组长打回（执行轮的 send_back）：把某个任务打回给组员重做，同步等新结果（先发头保活）。
  // 凭证必须带 exec 阶段的 team 上下文；次数 / 状态 / 并发的约束在 TeamExec.sendBack 里
  app.post('/api/ramet/team/send-back', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (g.ctx.team?.kind !== 'exec') return c.json({ error: '这个会话不是带队的执行轮，不能打回任务' }, 403)
    const team = g.ctx.team
    const body = (await c.req.json().catch(() => ({}))) as { taskId?: unknown; feedback?: unknown }
    const taskId = typeof body.taskId === 'string' ? body.taskId : ''
    const feedback = typeof body.feedback === 'string' ? body.feedback : ''
    return heartbeatJson(c, () =>
      host()
        .team.sendBack(team, g.user, g.ctx.pageId, taskId, feedback, c.req.raw.signal)
        .catch((err: unknown) => {
          if (err instanceof TeamToolError) return { error: err.message }
          throw err
        }),
    )
  })

  // 叫别的 agent 做子任务：同步等它做完（先发头保活）。只有能叫人的会话（凭证 canDispatch）
  app.post('/api/ramet/run-agent', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (!g.ctx.canDispatch || !g.ctx.pageId) return c.json({ error: '这个会话不能再叫别的 agent' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; task?: unknown }
    const task = typeof body.task === 'string' ? body.task.trim() : ''
    if (!task) return c.json({ error: 'task required' }, 400)
    const agents = await host().agentsFor(g.user, g.ctx.agentId)
    const callee = agents.find((a) => a.id === body.agent)
    if (!callee) return c.json({ error: '没有这个 agent，或你不能用它' }, 400)
    const pageId = g.ctx.pageId
    return heartbeatJson(c, () =>
      host()
        .runAgent({ pageId, callerAgentId: g.ctx.agentId, user: g.user }, callee, task, c.req.raw.signal)
        .catch((err: unknown) => {
          if (err instanceof SubRunError) return { error: err.message }
          throw err
        }),
    )
  })

  return app
}
