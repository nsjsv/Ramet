/* ---------- Ramet MCP 工具的中心端点（AI 回打中心，凭证走 Authorization: Bearer） ----------
 * 知识中枢（搜索 / 新建 / 移动 / 改名 / 移入回收站）、AI 互调（run_agent）与 skill 都在这里，按发起这一轮的用户
 * 的身份与权限执行：权限判定只用页面写入共用的闸门（pageRole / writable / parentOk / validParent / trashPageSubtree），
 * 不为 AI 另写一套。凭证绑着「哪一页上的哪个 agent」（page-read.ts 的 GrantCtx）：新建页默认放当前页下、
 * 审批弹在当前页、叫别的 agent 留痕在当前页的运行里，都靠它，AI 自己不传 pageId，冒充不了别的会话。
 * 必须挂在 files/search/pages 这些 `use('*', requireAuth)` 的子应用之前（同 pageReadRoutes）。
 *
 * 会等很久的端点（移入回收站要等用户批准、run_agent 要等被叫做完）先发头、定时吐空白保活，最后一段才是 JSON：
 * 否则 MCP 进程的 fetch 会在默认的 5 分钟头 / 体超时、nginx 会在 60 秒无数据时断开（审批不能超时）。
 * Genet（凭证的 agentId 是 Genet，agents/assistant-agent.ts）不给同步嵌套的 run_agent，改给 dispatch_task：在 Genet 页下新建任务页、
 * 以用户的身份写进任务说明、交给他机器上的 agent 开跑，立即返回（写消息 + 开跑与排队派发同一份实现，agents/queue-host.ts）。
 * 用户点名了模型 / 思考程度时先在任务页上开好会话、写成页面级配置再开跑（agents/dispatch-config.ts）。
 * 派出去的任务做完由中心回报给 Genet（agents/task-watch.ts）；wait_task 是 Genet 必须拿到结果才能往下走时的同步等待。
 * Genet 的定时器（set_timer 等）在 timer-tools.ts、盯页面（watch_page 等）在 watch-tools.ts，注册在这个 app 上，闸门同派活。
 * Genet 读到外来事件（别人的评论、外部请求）之后、主人亲自说话之前，有副作用的端点（建 / 移 / 改名 / 删页、派活、定时器增删改）
 * 先在 Genet 页弹审批（ramet-consent.ts 的 guard；删页合进它原有的那张卡）。mark_handled（「不用处理」）在 mark-handled.ts；
 * reply_comment（以主人的名义回复评论，每次都先给主人看原文）在 comment-reply.ts。
 * 空间 AI（agents/space-ai.ts）的凭证收窄到一个空间：闸门只放行白名单里的端点，页面类端点再逐个判「这一页在不在这个空间」，
 * 不在的与不存在同一个 404；它弹的审批只给叫它的人批（only）。 */

import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { myPersonalSpaceId } from '../clone.js'
import { withTransaction } from '../db.js'
import { purgePageRows } from '../page-purge.js'
import { isAssistantId, isAssistantPage, taskMention } from '../agents/assistant-agent.js'
import type { QueueHost } from '../agents/send-queue.js'
import type { DispatchConfigured, DispatchWant } from '../agents/dispatch-config.js'
import { AGENT_UNAVAILABLE } from '../agents/queue-host.js'
import { saveChoice } from '../agents/session-store.js'
import type { OwnApprovals } from '../agents/own-approvals.js'
import type { SubRunResult } from '../agents/sub-run.js'
import type { TaskWatch } from '../agents/task-watch.js'
import { TeamToolError } from '../agents/team.js'
import { TeamPlanError } from '../agents/team-plan.js'
import { SubRunError } from '../agents/sub-run.js'
import { createDocPage } from '../page-create.js'
import { isMinimalGrant, narrowedGrant, pageGrantOf, type GrantCtx } from '../page-read.js'
import { MINIMAL_TOOLS } from '../agents/tool-profile.js'
import { narrowedAllowed, pageInSpace, spaceTools } from '../agents/space-ai.js'
import {
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
import { memoryToolRoutes } from './memory-tools.js'
import { contextSpaceOf, saveContextSpace, taskSpace } from '../agents/space-context.js'
import { GUEST_AI_READONLY, isGuestOf } from '../agents/guest-gate.js'
import { timerToolRoutes, type TimerClock } from './timer-tools.js'
import { watchToolRoutes } from './watch-tools.js'
import type { AgentNameHost } from '../agents/agent-names.js'
import { heartbeatJson, consentTitle, type Consent, type Outcome } from './ramet-consent.js'
import { markHandled } from './mark-handled.js'
import { commentReplyRoutes } from './comment-reply.js'
import { collectionToolRoutes, rowCreator } from './collection-tools.js'
import { adoptIntoCollection, intoCollectionError } from '../collections/adopt.js'
import type { Projector } from '../collections/projector.js'
import type { GenetCalls } from '../comments/genet-call.js'
import type { PostedComment } from '../triggers/sources/comment.js'
import type { DocWriter } from '../collab.js'

/** manager.toolHost() 交给端点的能力（端点自己不碰 manager 的私有状态） */
export type ToolHost = {
  approvals: OwnApprovals
  /** 这个用户能叫的 agent（不含调用方自己）。unavailable = 现在用不了的原因（CLI 版本太旧等） */
  agentsFor(user: { id: string; role: string }, callerAgentId: string): Promise<Array<{ id: string; label: string; unavailable?: string }>>
  /** Genet 派活：判 agent 能不能用、以用户的身份写任务消息、开跑（排队派发的同一份宿主）；
   *  configure = 在任务页上开好会话、把指定的模型 / 思考程度写成页面级配置（不成 = 原因） */
  dispatch: Pick<QueueHost, 'usable' | 'writable' | 'running' | 'writeMessage' | 'start'> & {
    configure(pageId: string, user: { id: string; role: string }, agent: string, want: DispatchWant): Promise<DispatchConfigured>
  }
  /** Genet 派出去的任务：派活时登记（做完回报一次）、wait_task 等它做完；arm / disarm / notify 给定时触发（triggers/hub.ts） */
  tasks: Pick<TaskWatch, 'register' | 'owns' | 'wait' | 'arm' | 'disarm' | 'notify' | 'onEnd'>
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

/** 读页面 / 读图片 / 改页面三个基础工具 + 读写合集 + 知识中枢；run_agent 与 use_skill 按凭证 / 空间再加（见 GET /api/ramet/tools） */
const BASE_TOOLS = ['read_page', 'read_image', 'edit_page', 'read_collection', 'set_props', 'create_collection', 'edit_collection', 'search_pages', 'create_page', 'move_page', 'rename_page', 'trash_page']

type Granted = { user: { id: string; role: 'admin' | 'user' }; ctx: GrantCtx }

function bearer(c: Context): string {
  const header = c.req.header('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

async function granted(pool: Pool, c: Context): Promise<Granted | null> {
  const token = bearer(c)
  return token ? await pageGrantOf(pool, token) : null
}

/** 工具说明里列出的 skill 个数上限（再多的靠名字直接调用；索引太长会吃掉每个会话的上下文） */
const SKILL_INDEX_MAX = 100
/** 派活：任务页标题 / 任务说明的上限（说明与排队消息同一上限） */
const TASK_TITLE_MAX = 200
const TASK_TEXT_MAX = 100_000
/** 派活指定的模型 / 思考程度：选项值都很短，超长的截掉（截完对不上会回可选值） */
const CONFIG_WANT_MAX = 100

export function rametToolRoutes(
  pool: Pool,
  host: () => ToolHost,
  notify?: () => void,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  /** 空间公共记忆变了（agent 提议被点「记住」）：广播给在线端重拉记忆面板 */
  notifyMemories?: () => void,
  /** 定时器的时钟（TriggerHub，后建好，惰性取）；不给就用真实时间、增删改不通知 */
  timers?: () => TimerClock,
  /** consent = 外来事件之后 Genet 动手前先问主人（ramet-consent.ts）；write = 标记「不用处理」写 Genet 页；
   *  comments = Genet 代发的评论写成功之后（广播 + 收件箱 / 交给「评论找我」的触发），同界面上的回复；
   *  names = agent 显示名的原料（盯页面的规则列表里写动作用，惰性取） */
  extra: {
    consent?: Consent
    write?: DocWriter
    comments?: { changed(pageId: string): void; posted(c: PostedComment): void; calls?: () => Pick<GenetCalls, 'claim' | 'unclaim'> }
    names?: () => AgentNameHost
    /** create_page 建了一页（父页是合集时就是新增了一行，交给自动化；不等它） */
    created?: (parentId: string | null, pageIds: readonly string[], userId: string) => void
    /** 合集行的副本落库（set_props、在合集里建行；collections/projector.ts）；不给 = 这两条写路径 503 */
    projector?: Pick<Projector, 'flushRow'>
  } = {},
) {
  const app = new Hono()

  /** 有副作用的工具：读到过外来事件的 Genet 先弹审批（没接 consent 的测试桩直接执行） */
  const guard = async (c: Context, g: Granted, what: string, run: () => Promise<Outcome>): Promise<Response> => {
    if (extra.consent) return extra.consent.guarded(c, g, what, run)
    const out = await run()
    return c.json(out.body, out.status)
  }

  // 工具档位闸门（agents/tool-profile.ts）：精简档的凭证在这里只能问工具清单，其余端点一律 403 ——
  // 不只靠 MCP 进程不列出（凭证在 agent 那台机器上，绕过 MCP 直接打端点也得拦住）。读 / 图 / 写三个端点在 page-read.ts，不经这里
  // 空间 AI 的凭证同理，而且是白名单（space-ai.ts 的 narrowedAllowed）：以后新加的 /api/ramet/* 端点默认对它 403
  app.use('/api/ramet/*', async (c, next) => {
    const token = bearer(c)
    if (c.req.path !== '/api/ramet/tools' && isMinimalGrant(token)) {
      return c.json({ error: 'forbidden', message: '当前工具档位不提供这个工具' }, 403)
    }
    const narrowed = narrowedGrant(token)
    if (narrowed && !narrowedAllowed(c.req.method, c.req.path, narrowed.readOnly)) {
      return c.json({ error: 'forbidden', message: '这个会话不提供这个工具' }, 403)
    }
    return next()
  })

  /** 这把凭证用的空间 skill 库：空间 AI = 凭证上的空间；任务页记着目标空间（Genet 派活时记的）= 那个空间；
   *  别的 = 凭证绑的那页所在的空间（没绑页面 = 发起人自己那个空间）。发起人必须仍是成员。
   *  wanted = use_skill 指定的空间（只有 Genet 的工具说明里有这个参数）：空间 AI 只能是自己的空间，别的要是成员 */
  async function grantSpace(g: Granted, wanted?: string): Promise<string | null> {
    if (wanted) {
      if (g.ctx.space) return wanted === g.ctx.space ? wanted : null
      return (await roleInSpace(pool, g.user, wanted)) !== null ? wanted : null
    }
    const target = !g.ctx.space && g.ctx.pageId ? await contextSpaceOf(pool, g.ctx.pageId, g.user.id) : null
    if (target) return target
    const page = !g.ctx.space && g.ctx.pageId ? (await pool.query<PageRow>(SELECT, [g.ctx.pageId])).rows[0] : undefined
    const spaceId = g.ctx.space ?? (g.ctx.pageId ? (page?.space_id ?? null) : await myPersonalSpaceId(pool, g.user.id))
    return spaceId && (await roleInSpace(pool, g.user, spaceId)) !== null ? spaceId : null
  }

  /** 空间 AI 的凭证碰到别的空间的页：与不存在同响应（其余凭证不收窄） */
  async function outsideSpace(g: Granted, pageId: string): Promise<boolean> {
    return g.ctx.space !== undefined && !(await pageInSpace(pool, pageId, g.ctx.space))
  }

  /** 要等人批准的工具弹的卡：空间 AI 的只给叫它的人批（别的成员看得到这一页，但这是他叫的、按他的权限执行） */
  const onlyInvoker = (g: Granted): { only?: string } => (g.ctx.space ? { only: g.user.id } : {})

  /** 新建的页 / 合集放在哪：给了父页（可带 page: / collection: 记号）要存在、可写、在凭证的空间里；缺省 = 当前页下；
   *  没绑页面 = 空间顶层（空间 AI 是它空间的公共区，其余是发起人自己那个空间的私人区：没说放哪的东西先只给他自己看）。
   *  kind = 父页的种类（父页是合集时 create_page 建的是一行）；privateOwner = 顶层落点的区，有父页时跟父页 */
  async function placeFor(
    g: Granted,
    raw: unknown,
  ): Promise<{ parentId: string | null; spaceId: string; kind: string | null; privateOwner: string | null } | { status: 400 | 403 | 404 | 500; error: string }> {
    // 缺省放当前页下；空间 AI 在直接对话页（私人区）上时缺省放空间顶层：它建的东西是给空间的
    const here = g.ctx.pageId && g.ctx.space && !(await pageInSpace(pool, g.ctx.pageId, g.ctx.space)) ? null : g.ctx.pageId
    const parentId = typeof raw === 'string' && raw ? raw.replace(/^(collection|page):/, '') : here
    let spaceId: string
    let kind: string | null = null
    let privateOwner: string | null = null
    if (parentId) {
      const parent = await writablePage(g.user, parentId, g.ctx.space)
      if (!('page' in parent)) return parent
      if (!parent.page.space_id) return { status: 400, error: 'parent has no space' }
      spaceId = parent.page.space_id
      kind = parent.page.kind
    } else if (g.ctx.space) {
      // 空间 AI 没绑页面时建在它的空间顶层，不建到叫它的人的个人空间
      spaceId = g.ctx.space
    } else {
      const personal = await myPersonalSpaceId(pool, g.user.id)
      if (!personal) return { status: 500, error: 'personal space unavailable' }
      spaceId = personal
      privateOwner = g.user.id
    }
    if (!(await parentOk(pool, g.user, parentId, spaceId))) return { status: 400, error: 'parent not found' }
    return { parentId, spaceId, kind, privateOwner }
  }

  // 合集的读写（collection-tools.ts）：凭证、空间收窄与审批都用这里的
  const collectionTools = {
    pool,
    ...(getLiveDoc ? { getLiveDoc } : {}),
    ...(extra.write ? { write: extra.write } : {}),
    ...(extra.projector ? { projector: extra.projector } : {}),
    ...(notify ? { notify } : {}),
    granted: async (c: Context) => {
      const g = await granted(pool, c)
      if (!g) return null
      return {
        user: g.user,
        ...(g.ctx.space ? { space: g.ctx.space } : {}),
        guard: (what: string, run: () => Promise<Outcome>) => guard(c, g, what, run),
        parent: async (raw: unknown) => {
          const place = await placeFor(g, raw)
          return 'error' in place
            ? { status: place.status === 500 ? 400 : place.status, error: place.error }
            : { parentId: place.parentId, spaceId: place.spaceId, privateOwner: place.privateOwner }
        },
      }
    },
  }
  const createRow = rowCreator(collectionTools)

  /** 在 parentId 下（没有 = 空间顶层，privateOwner 定区）建一页：标题 + markdown 正文（page-create.ts） */
  async function insertPage(
    id: string,
    user: Granted['user'],
    place: { parentId: string | null; spaceId: string; privateOwner: string | null },
    title: string,
    text: string,
  ): Promise<void> {
    const { parentId, spaceId, privateOwner } = place
    await createDocPage(pool, user, { id, parentId, spaceId, title, text, privateOwner })
    extra.created?.(parentId, [id], user.id)
  }

  /** 页面闸门：存在 + 可见（不存在 / 非成员 / 不在空间 AI 凭证的空间里同响应 404）+ 可写（viewer 403）+ 不是访客（403：
   *  用户作为访客看到的页 AI 只能读，见 agents/guest-gate.ts） */
  async function writablePage(user: Granted['user'], id: string, space?: string): Promise<{ page: PageRow } | { status: 403 | 404; error: string }> {
    const page = (await pool.query<PageRow>(SELECT, [id])).rows[0]
    const role = page ? await pageRole(pool, user, page) : null
    // 空间 AI 的凭证只碰这个空间的公共区（私人页与不存在同一个 404）
    if (!page || role === null || (space !== undefined && (page.space_id !== space || page.private_owner !== null))) return { status: 404, error: 'page not found' }
    if (!writable(role)) return { status: 403, error: 'forbidden' }
    if (await isGuestOf(pool, user.id, id)) return { status: 403, error: GUEST_AI_READONLY }
    return { page }
  }

  /** 凭证是 Genet 的、绑的页是本人的 Genet 页 → 那一页（派活 / 等任务的闸门）；否则 null */
  async function genetHome(g: Granted): Promise<string | null> {
    const home = g.ctx.pageId
    return isAssistantId(g.ctx.agentId) && home && (await isAssistantPage(pool, g.user.id, home)) ? home : null
  }

  // 这把凭证能用哪些工具与可叫的 agent（MCP 进程据此决定列出什么；被叫的会话没有 run_agent）
  app.get('/api/ramet/tools', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    if (g.ctx.profile === 'minimal') return c.json({ tools: MINIMAL_TOOLS, agents: [], skills: [] })
    const skillsOf = async (spaceId: string | null) =>
      spaceId ? (await listSkills(pool, spaceId)).slice(0, SKILL_INDEX_MAX).map((s) => ({ name: s.name, description: s.description })) : []
    // 空间 AI：只有这个空间的读写工具（只读凭证只有读的），不列可叫的 agent
    if (g.ctx.space || g.ctx.readOnly) {
      const skills = await skillsOf(await grantSpace(g))
      return c.json({ tools: spaceTools(g.ctx.readOnly === true, skills.length > 0), agents: [], skills })
    }
    const agents = g.ctx.canDispatch && g.ctx.pageId ? await host().agentsFor(g.user, g.ctx.agentId) : []
    // Genet 派活（dispatch_task）而不同步叫人（run_agent）；可派的 agent 一个都没有也列出来，Genet 才能如实告诉用户
    const dispatcher = isAssistantId(g.ctx.agentId) && g.ctx.pageId !== null
    const skills = await skillsOf(await grantSpace(g))
    // 带队的组长凭证（只在对应的计划轮 / 执行轮、那一轮还在飞时）多一个工具：submit_plan / send_back；别的会话（含组员）没有
    const team = g.ctx.team ? await host().team.round(g.ctx.team, g.user, g.ctx.pageId) : null
    return c.json({
      // propose_memory 要有地方弹确认：凭证没绑页面就不列出
      tools: [
        ...BASE_TOOLS,
        ...(g.ctx.pageId ? ['propose_memory'] : []),
        ...(dispatcher
          ? [
              'read_space',
              'dispatch_task',
              'wait_task',
              'set_timer',
              'list_timers',
              'update_timer',
              'delete_timer',
              'watch_page',
              'list_watches',
              'unwatch_page',
              'mark_handled',
              'reply_comment',
            ]
          : agents.length > 0
            ? ['run_agent']
            : []),
        ...(skills.length > 0 ? ['use_skill'] : []),
        ...(team ? [team.tool] : []),
      ],
      agents,
      skills,
      ...(team ? { team } : {}),
    })
  })

  // skill：说明正文 + 文件清单（路径 / 大小 / sha256）。文件本身按需逐个取（/file），本地缓存里哈希一致的不再下载
  app.get('/api/ramet/skills/:name', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const spaceId = await grantSpace(g, c.req.query('space') || undefined)
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
    const spaceId = await grantSpace(g, c.req.query('space') || undefined)
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
    // 空间 AI 只搜得到它的空间
    const hits = await searchPages(pool, g.user, query, { limit, ...(g.ctx.space ? { publicIn: g.ctx.space } : {}) })
    return c.json({ results: hits.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet })) })
  })

  // 新建页面：默认放在当前页下（凭证绑的那一页）；给 parentId 则放在那页下，同空间。要对父页有写权
  app.post('/api/ramet/pages', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; text?: unknown; parentId?: unknown; props?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: 'title required' }, 400)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const place = await placeFor(g, body.parentId)
    if ('error' in place) return c.json({ error: place.error }, place.status)
    const { parentId } = place
    // 父页是合集：建的是一行，走与界面建行同一条路（带属性值、排在末尾、取号）
    if (parentId && place.kind === 'collection') {
      const row = await createRow(g.user, g.ctx.space, parentId, body.props)
      if ('error' in row) return c.json({ error: row.error }, row.status)
      return guard(c, g, `在合集「${row.collection.title || '无标题'}」里新建一行「${title}」`, async () => {
        const id = await row.create(title, text)
        if (!id) return { status: 404, body: { error: 'parent not found' } }
        extra.created?.(parentId, [id], g.user.id)
        notify?.()
        return { status: 200, body: { id, title, parentId } }
      })
    }
    if (body.props !== undefined) return c.json({ error: 'props 只在父页是合集时能用（新建的是合集里的一行）' }, 400)
    return guard(c, g, `新建页面「${title}」`, async () => {
      const id = randomUUID()
      await insertPage(id, g.user, place, title, text)
      notify?.()
      return { status: 200, body: { id, title, parentId } }
    })
  })

  app.post('/api/ramet/pages/:id/move', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id, g.ctx.space)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const body = (await c.req.json().catch(() => ({}))) as { parentId?: unknown }
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId.replace(/^(collection|page):/, '') : null
    if (parentId && (await outsideSpace(g, parentId))) return c.json({ error: 'parent not found' }, 404)
    if (!(await parentOk(pool, g.user, parentId, found.page.space_id))) return c.json({ error: 'parent not found (or in another space)' }, 400)
    if (!(await validParent(pool, id, parentId))) return c.json({ error: 'parent would create a cycle' }, 400)
    const refusal = await intoCollectionError(pool, found.page.kind, parentId)
    if (refusal) return c.json({ error: refusal }, 400)
    return guard(c, g, `把《${found.page.title || '无标题'}》移到${parentId ? ` page:${parentId} 之下` : '空间顶层'}`, async () => {
      await pool.query(SET_PARENT, [parentId, id])
      // 挪进了合集：补成一行，同侧栏拖进合集（collections/adopt.ts）
      if (extra.write && extra.projector) {
        const deps = { pool, write: extra.write, getLiveDoc: getLiveDoc ?? (() => undefined), projector: extra.projector }
        await adoptIntoCollection({ deps, ...(extra.created ? { rowsAdded: extra.created } : {}) }, g.user, id, found.page.parent_id, parentId, 'agent')
      }
      notify?.()
      return { status: 200, body: { ok: true, title: found.page.title, parentId } }
    })
  })

  app.post('/api/ramet/pages/:id/rename', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id, g.ctx.space)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return c.json({ error: 'title required' }, 400)
    return guard(c, g, `把《${found.page.title || '无标题'}》改名为「${title}」`, async () => {
      await pool.query(SET_TITLE, [title, id])
      notify?.()
      return { status: 200, body: { ok: true, title } }
    })
  })

  // 移入回收站：危险操作，等用户在当前页的审批条里批准（无超时），拒绝则不执行
  app.post('/api/ramet/pages/:id/trash', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const found = await writablePage(g.user, id, g.ctx.space)
    if (!('page' in found)) return c.json({ error: found.error }, found.status)
    const pageId = g.ctx.pageId
    // 没有绑页面 = 没有地方弹审批：不能静默放行
    if (!pageId) return c.json({ error: '这个会话没有绑定页面，没法弹出审批，不能删除' }, 403)
    const label = `page:${id}「${found.page.title || '无标题'}」`
    // 读到过外来事件的 Genet：起因写进这同一张卡，不另弹一张
    const what = `把页面「${found.page.title || '无标题'}」移入回收站`
    const cause = extra.consent ? await extra.consent.cause(g) : null
    return heartbeatJson(c, async () => {
      const { allowed } = await host().approvals.decide(
        { pageId, agentId: g.ctx.agentId },
        { title: cause ? consentTitle(cause, what) : what, toolCall: { kind: 'delete', title: '移入回收站', rawInput: { page: label } }, ...onlyInvoker(g) },
        c.req.raw.signal,
      )
      if (!allowed) return { rejected: true }
      return { ok: true, trashed: (await trashPageSubtree(pool, [id], notify)).length }
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
    // Genet 不同步叫人（它用 dispatch_task 派出去）：工具清单里没有，这里同样拦住
    if (!g.ctx.canDispatch || !g.ctx.pageId || isAssistantId(g.ctx.agentId)) return c.json({ error: '这个会话不能再叫别的 agent' }, 403)
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

  // Genet 派活：在 Genet 页下新建任务页、以用户的身份写入任务说明、交给 agent 开跑，立即返回（不等那一轮跑完）。
  // 先判 agent 能不能用（机器离线 / 没授权 / 版本太旧）再建页：派不出去时不留下一个空的任务页；之后写消息 / 开跑失败也把页删掉。
  // 带了 model / effort 才先开会话改配置（要等会话起来）：值对不上 / agent 不接受都算派不出去，同样删页，原因里列出可选值
  app.post('/api/ramet/dispatch', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const home = await genetHome(g)
    if (!home) return c.json({ error: '只有 Genet 能派活' }, 403)
    const parent = await writablePage(g.user, home)
    if (!('page' in parent)) return c.json({ error: parent.error }, parent.status)
    if (!parent.page.space_id) return c.json({ error: 'parent has no space' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; title?: unknown; task?: unknown; model?: unknown; effort?: unknown; space?: unknown }
    const agent = typeof body.agent === 'string' ? body.agent : ''
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX) : ''
    const task = typeof body.task === 'string' ? body.task.trim() : ''
    const wanted = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, CONFIG_WANT_MAX) : '') || undefined
    const want: DispatchWant = { model: wanted(body.model), effort: wanted(body.effort) }
    if (!agent) return c.json({ error: '要指定派给哪个 agent' }, 400)
    if (!title || !task) return c.json({ error: '任务要有标题和说明' }, 400)
    if (task.length > TASK_TEXT_MAX) return c.json({ error: `任务说明太长（最多 ${TASK_TEXT_MAX} 字）` }, 400)
    // 目标空间：任务在哪个空间里做，任务页上的 agent 带那个空间的约定、用那里的 skill（space-context.ts）
    const target = await taskSpace(pool, g.user.id, typeof body.space === 'string' && body.space ? body.space : undefined, task)
    if (target === 'not-member') return c.json({ error: '用户不在那个空间里，不能把任务派到那里' }, 400)
    const listed = (await host().agentsFor(g.user, g.ctx.agentId)).find((a) => a.id === agent)
    if (listed?.unavailable) return c.json({ error: `${listed.label} 现在用不了：${listed.unavailable}` }, 409)
    const id = randomUUID()
    // 任务页此刻还没有文档：锁定的工具为空，这一步只剩「这个人此刻能不能用这个 agent」，与排队派发同一个判定。
    // 没授权给出的是带主人名的原因；解析不出来对派活来说就是机器不在线、或者没有这个 agent
    const unusable = await host().dispatch.usable(id, g.user, agent)
    if (unusable) return c.json({ error: unusable === AGENT_UNAVAILABLE ? `${agent} 现在用不了：它所在的机器不在线，或者已经没有这个 agent` : unusable }, 409)
    const spaceId = parent.page.space_id
    return guard(c, g, `派活给 ${listed?.label ?? agent}：「${title}」`, async (): Promise<Outcome> => {
      await insertPage(id, g.user, { parentId: home, spaceId, privateOwner: null }, title, '')
      if (target) await saveContextSpace(pool, id, target.id)
      const dropPage = () => withTransaction(pool, (client) => purgePageRows(client, [id]))
      let configured: DispatchConfigured | null = null
      try {
        await saveChoice(pool, id, agent)
        if (want.model || want.effort) {
          configured = await host().dispatch.configure(id, g.user, agent, want)
          if ('error' in configured) {
            await dropPage()
            return { status: 409, body: { error: configured.error } }
          }
        }
        await host().dispatch.writeMessage(id, g.user, task, [], agent)
        await host().tasks.register({ pageId: id, homeId: home, userId: g.user.id, agent, label: listed?.label ?? agent })
        const started = await host().dispatch.start(id, g.user, agent)
        if (started !== 'ok') {
          await dropPage()
          return { status: 409, body: { error: started === 'busy' ? '任务页正忙' : started.reason } }
        }
      } catch (err) {
        await dropPage().catch(() => undefined)
        throw err
      }
      notify?.()
      return {
        status: 200,
        body: {
          pageId: id,
          title,
          agent,
          label: listed?.label ?? agent,
          mention: taskMention(title, id),
          ...(target ? { space: target.name } : {}),
          ...(configured && 'applied' in configured ? { applied: configured.applied } : {}),
        },
      }
    })
  })

  timerToolRoutes(app, {
    pool,
    genet: async (c) => {
      const g = await granted(pool, c)
      if (!g) return 401
      const home = await genetHome(g)
      return home ? { userId: g.user.id, home, guard: (what, run) => guard(c, g, what, run) } : 403
    },
    clock: () => timers?.() ?? { now: () => new Date(), changed: () => undefined, removed: async () => undefined },
  })

  watchToolRoutes(app, {
    pool,
    genet: async (c) => {
      const g = await granted(pool, c)
      if (!g) return 401
      const home = await genetHome(g)
      return home ? { user: g.user, home, guard: (what, run) => guard(c, g, what, run) } : 403
    },
    clock: () => timers?.() ?? { now: () => new Date(), changed: () => undefined, removed: async () => undefined },
    names: { localAgents: () => extra.names?.().localAgents() ?? [], onlineAgents: (id) => extra.names?.().onlineAgents(id) },
    ...(getLiveDoc ? { getLiveDoc } : {}),
  })

  collectionToolRoutes(app, collectionTools)
  // read_space 与 propose_memory（memory-tools.ts）
  memoryToolRoutes(app, { pool, granted: (c) => granted(pool, c), writablePage, approvals: () => host().approvals, ...(notifyMemories ? { notifyMemories } : {}) })

  commentReplyRoutes(app, {
    pool,
    genet: async (c) => {
      const g = await granted(pool, c)
      if (!g) return 401
      const home = await genetHome(g)
      return home ? { user: g.user, home } : 403
    },
    approvals: () => host().approvals,
    changed: (pageId) => extra.comments?.changed(pageId),
    posted: (posted) => extra.comments?.posted(posted),
    ...(extra.comments?.calls ? { calls: extra.comments.calls } : {}),
  })

  // Genet 标记「不用处理」：这一轮的回复带上 quiet（理由），对话里连同它处理的事件通知折成一行（mark-handled.ts）
  app.post('/api/ramet/mark-handled', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const home = await genetHome(g)
    if (!home) return c.json({ error: '只有 Genet 能标记「不用处理」' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown }
    const out = await markHandled({ pool, write: extra.write }, g.user, home, body.reason)
    return c.json(out.body, out.status)
  })

  // Genet 等一个任务做完（wait_task）：只等自己 Genet 页下的任务页；先发头保活。用户停掉 Genet 这一轮时等待由 manager.stop 作废（task-watch.ts 的 cancelWaits）
  app.post('/api/ramet/wait-task', async (c) => {
    const g = await granted(pool, c)
    if (!g) return c.json({ error: 'unauthorized' }, 401)
    const home = await genetHome(g)
    if (!home) return c.json({ error: '只有 Genet 能等任务' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { page?: unknown; minutes?: unknown }
    const pageId = typeof body.page === 'string' ? body.page.trim().replace(/^page:/, '') : ''
    if (!pageId) return c.json({ error: '要给出任务页（page:<id>）' }, 400)
    if (!(await host().tasks.owns(pageId, home, g.user))) return c.json({ error: '没有这个任务页（只能等 Genet 派出去的任务）' }, 404)
    const minutes = typeof body.minutes === 'number' ? body.minutes : NaN
    return heartbeatJson(c, () => host().tasks.wait(pageId, home, minutes, c.req.raw.signal))
  })

  return app
}
