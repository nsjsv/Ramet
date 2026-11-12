import { rametToolRoutes } from './routes/ramet-tools.js'
import { hookRoutes } from './routes/hooks.js'
import { aiGenRoutes } from './routes/ai-gen.js'
import { runAiGen, type AiGenDeps } from './ai-gen.js'
import { fillRow } from './ai-prop.js'
import { createPiStream } from './pi-models.js'
import { loadSecretKeyFromEnv } from './secret-box.js'
import { memoryRoutes } from './routes/memories.js'
import { skillRoutes } from './routes/skills.js'
import { favoriteRoutes } from './routes/favorites.js'
import { exportRoutes } from './routes/export.js'
import { backfillPageLinks } from './page-links.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getRequestListener } from '@hono/node-server'
import type { Pool } from 'pg'
import { closePool, getPool, initDb } from './db.js'
import { pagesRoutes } from './routes/pages.js'
import { PAGE_CHANGES_PRUNE_MS, prunePageChanges } from './page-sync.js'
import { blocksRoutes } from './routes/blocks.js'
import { spacesRoutes } from './routes/spaces.js'
import { spaceAiRoutes, watchSpaceAiConnections } from './routes/space-ai.js'
import { aiUsageRoutes } from './routes/ai-usage.js'
import { importRoutes } from './routes/import.js'
import { boardsRoutes } from './routes/boards.js'
import { collectionRoutes } from './routes/collections.js'
import { createProjector } from './collections/projector.js'
import { createFanout } from './collections/fanout.js'
import { collectionRelationRoutes } from './routes/collection-relations.js'
import { publicRoutes } from './routes/public.js'
import { filesRoutes } from './routes/files.js'
import { searchRoutes } from './routes/search.js'
import { linkPreviewRoutes } from './routes/link-preview.js'
import { createLinkPreview, type LinkPreview } from './link-preview.js'
import { adminRoutes, authRoutes, userFromRequest, type AuthEnv } from './auth.js'
import { createDocWriter, createHocuspocus, drainDocWrites, loadDocForRead, loadDocFromDb, notifyAgentsChanged, notifyInboxChanged, notifyBoardsChanged, notifyMemoriesChanged, notifyPagesChanged, notifyPreviewsChanged } from './collab.js'
import { loadAgents } from './agents/registry.js'
import { AgentManager } from './agents/manager.js'
import { ConnectorHub } from './agents/hub.js'
import { connectorUpgrade, isConnectorPath } from './agents/connector-ws.js'
import { PairingDesk } from './agents/pairing.js'
import { createTermWss, ptySocketUpgrade, TERM_PATH } from './routes/pty-socket.js'
import { agentsRoutes } from './routes/agents.js'
import { teamRoutes } from './routes/team.js'
import { sweepRunningPlans } from './agents/team-plan.js'
import { connectorsRoutes } from './routes/connectors.js'
import { connectorGrantRoutes } from './routes/connector-grants.js'
import { machinesRoutes } from './routes/machines.js'
import { projectRoutes } from './routes/project.js'
import { projectPtyRoutes } from './routes/project-pty.js'
import { previewRoutes, type PreviewRuntime } from './routes/previews.js'
import { csrfGuard, originAllowed } from './csrf.js'
import { webRootFromEnv, webStatic } from './web-static.js'
import { PreviewAccess } from './preview-access.js'
import { createPreviewServer } from './preview-server.js'
import { onMachineFirstUse, sweepGrants, type Disconnect } from './agents/machine-grants.js'
import { InboxPoke } from './inbox.js'
import { inboxRoutes } from './routes/inbox.js'
import { commentRoutes } from './routes/comments.js'
import { debugRoutes } from './routes/debug.js'
import { runsRoutes } from './routes/runs.js'
import { pageReadRoutes } from './page-read.js'
import { quickRoutes, type QuickDeps } from './routes/quick.js'
import { assistantRoutes } from './routes/assistant.js'
import type { AssistantDeps } from './agents/drivers/assistant/driver.js'
import { dropOuterClaudeSession } from './claude-session-env.js'
import { isHttpsRequest } from './request-proto.js'
import { createImgbedSync, type ImgbedSync } from './imgbed-sync.js'
import { TriggerHub } from './triggers/hub.js'
import type { AgentNameHost } from './agents/agent-names.js'
import { timerRoutes } from './routes/timers.js'
import { automationRoutes } from './routes/automations.js'
import { Consent } from './routes/ramet-consent.js'
import { isAssistantId, isAssistantPage } from './agents/assistant-agent.js'
import { createSafeFetch, type SafeFetch } from './endpoint-guard.js'
import { commentPosted, type PostedComment } from './triggers/sources/comment.js'
import { GenetCalls } from './comments/genet-call.js'
import { SpaceAiCalls } from './comments/space-ai-call.js'
import { mentionWatch } from './triggers/sources/mention.js'
import { PageWatch, type PageWatchDeps } from './triggers/sources/page-watch.js'
import { rowChanged, rowsAdded, type CollectionEventDeps } from './triggers/sources/collection.js'

/** 关停时等在跑的 run 收尾（回复写进文档、过程归档）的上限 */
const SHUTDOWN_RUNS_MS = 5000
/** 机器授权到期清扫的间隔，见 agents/machine-grants.ts 的 sweepGrants */
const GRANT_SWEEP_MS = 60_000

/** 浏览器和机器人客户端走同一条 /collab。客户端可以随便带这个头，只有进程内密钥对得上才算 AI。 */
function collabActor(request: IncomingMessage, secret: string): { kind: 'user' | 'agent'; agent: string | null } {
  const raw = request.headers['x-ramet-bot']
  const got = Buffer.from((Array.isArray(raw) ? raw[0] : raw) ?? '')
  const expect = Buffer.from(secret)
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { kind: 'user', agent: null }
  const agentRaw = request.headers['x-ramet-agent']
  const agentHeader = (Array.isArray(agentRaw) ? agentRaw[0] : agentRaw) ?? ''
  let agent = agentHeader
  try {
    agent = decodeURIComponent(agentHeader)
  } catch {
    agent = agentHeader
  }
  return { kind: 'agent', agent: agent || null }
}

/** 端口预览的监听配置。port 0 = 随机端口；origin = 对外地址（拼进票据链接），缺省按请求的主机名 + 实际监听端口拼 */
export type PreviewOptions = { port: number; origin?: string; ticketTtlMs?: number; revalidateMs?: number }

/** 启动选项，只给测试用，生产全走默认 */
export type ServerOptions = {
  /** ⌘J：模型调用 / 主密钥 / DNS 解析可注入，测试里不真的打模型 */
  quick?: QuickDeps
  /** Genet：同上（它用的也是用户自己的模型连接） */
  assistant?: Omit<AssistantDeps, 'pool'>
  /** 端口预览：不传看环境变量 RAMET_PREVIEW_PORT / RAMET_PREVIEW_ORIGIN（没设即关闭）；null 明确关闭 */
  preview?: PreviewOptions | null
  /** 图床镜像：不传看环境变量 RAMET_IMGBED_*（没设即关闭）；测试注入自己建的实例 */
  imgbed?: ImgbedSync
  /** 网页书签元信息抓取：测试注入（放行本机地址）；缺省生产实现 */
  linkPreview?: LinkPreview
  /** 触发器（规则）的时钟与向外 webhook 的出站 fetch：测试注入；缺省真实时间、防护版 fetch（允许 http） */
  triggers?: { now?: () => Date; fetch?: SafeFetch }
}

/** RAMET_PREVIEW_PORT / RAMET_PREVIEW_ORIGIN → 预览配置；没设或写坏了返回 undefined（预览关闭） */
export function previewFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewOptions | undefined {
  const raw = env.RAMET_PREVIEW_PORT?.trim()
  if (!raw) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[preview] RAMET_PREVIEW_PORT=${raw} 不是合法端口，端口预览保持关闭`)
    return undefined
  }
  let origin: string | undefined
  if (env.RAMET_PREVIEW_ORIGIN?.trim()) {
    try {
      origin = new URL(env.RAMET_PREVIEW_ORIGIN.trim()).origin
    } catch {
      console.error(`[preview] RAMET_PREVIEW_ORIGIN=${env.RAMET_PREVIEW_ORIGIN} 不是合法地址，改用请求的主机名拼`)
    }
  }
  return { port, ...(origin ? { origin } : {}) }
}

export function startServer(
  pool: Pool,
  port = 0,
  options: ServerOptions = {},
): Promise<{
  port: number
  previewPort: number | null
  close: () => Promise<void>
  sweepGrants: () => Promise<number>
  triggers: Pick<TriggerHub, 'tick' | 'emit' | 'causedBy' | 'touched'>
}> {
  const app = new Hono<AuthEnv>()
  app.use('*', cors({ origin: 'http://localhost:5173' }))
  // CSRF：改数据的 /api 请求，浏览器自报的来源必须是 Ramet 自己（预览源与 Ramet 同站不同源，里面的脚本不可信）。
  // 必须挂在所有子应用之前；无 Origin 的非浏览器请求（connector / MCP 的 Bearer、测试）放行
  app.use('/api/*', csrfGuard())
  // 前端产物（web-static.ts）：同样必须在子应用之前，否则匿名打开页面被它们的 requireAuth 拦成 401
  app.use('*', webStatic(webRootFromEnv()))
  // 图床镜像（imgbed-sync.ts）：读入口 302 到图床，上传后后台镜像；未配置时是空实现
  const imgbed = options.imgbed ?? createImgbedSync(pool)
  // 公开端点必须挂在 pages/spaces 之前：两者在自己子应用里 app.use('*', requireAuth)，
  // 会拦住注册序靠后的 /api/public/* 请求（Hono 按注册序组链，匿名请求没到 handler 就 401）
  // 网页书签元信息：登录端点与公开页端点共用一份内存缓存
  const linkPreview = options.linkPreview ?? createLinkPreview()
  app.route(
    '/',
    publicRoutes(
      pool,
      () => notifyPagesChanged(hocuspocus),
      (name) => hocuspocus.documents.get(name),
      linkPreview,
    ),
  )
  app.route('/', linkPreviewRoutes(pool, linkPreview))
  // 收到外部请求（routes/hooks.ts）：不登录、只认地址里的密钥，同样挂在 requireAuth 子应用之前；触发器后建好，惰性取
  app.route('/', hookRoutes({ pool, hub: () => triggers }))
  app.route('/', authRoutes(pool))
  // 删号连带删掉他接入的机器：断开在线连接并让目录重拉（hub 在后面才建好，箭头函数请求到达时才求值）
  app.route(
    '/',
    adminRoutes(
      pool,
      (connectorIds, reason) => {
        for (const id of connectorIds) hub.closeOne(id, reason)
        if (connectorIds.length > 0) {
          notifyAgentsChanged(hocuspocus)
          inbox.poke()
        }
      },
      // hocuspocus 在后面才建好，同上
      () => notifyPagesChanged(hocuspocus),
    ),
  )
  // 机器上的授权确认 / 本机收回：connector token 认证（不是 cookie），同样必须挂在 requireAuth 子应用之前。
  // 收回即断落在 agentManager（后面才建好），惰性取
  const disconnect: Disconnect = (connectorId, userId) => agentManager.revokeMachineAccess(connectorId, userId)
  // 目录变了，收件箱里的机器类条目（待批准的接入、使用申请）多半也变了，一起通知。连接器路由与授权收回都走它
  const notifyAgents = (): void => {
    notifyAgentsChanged(hocuspocus)
    inbox.poke()
  }
  app.route('/', connectorGrantRoutes(pool, { disconnect, reduce: (connectorId, userId, lost) => agentManager.reduceMachineAccess(connectorId, userId, lost), notify: notifyAgents }))
  // 集合的行属性投影器（collections/projector.ts）：挂在协同实例上，行文档的 Y.Map('props') 一变就写可查询副本，
  // 增量只发给正连着集合文档的连接。找集合文档惰性取，hocuspocus 随后才建好。
  // 扇出（collections/fanout.ts）登记加载着的集合文档：增量发出前补关联 / 汇总的计算值，并让依赖它的集合跟着重算
  const fanout = createFanout(pool, (name) => hocuspocus.documents.get(name), () => projector)
  // 行属性改了交给自动化「属性改了」（triggers/sources/collection.ts）：触发器后建好，惰性取，后台跑
  const collectionEvents = (): CollectionEventDeps => ({ pool, hub: triggers, getLiveDoc: (name) => hocuspocus.documents.get(name) })
  const projector = createProjector(pool, (name) => hocuspocus.documents.get(name), fanout.enrich, (change) =>
    triggers.background(() => rowChanged(collectionEvents(), change)),
  )
  // 有页建在 / 挪到某页下：那一页是合集就按「新增了一行」触发（建行的各条写路径都调它）
  const rowsAddedTo = (parentId: string | null, ids: readonly string[], actorId: string): void => {
    if (parentId) triggers.background(() => rowsAdded(collectionEvents(), parentId, ids, actorId))
  }
  // AI 按行读页面 / 取图 / 写回文档（凭证走 Authorization: Bearer，不是 cookie）：必须挂在
  // files/search/pages 这些 `use('*', requireAuth)` 的子应用之前，否则请求先到它们就被 401 了。
  // 活文档查找与 blocksRoutes 一样用惰性引用
  // 正文 @我（triggers/sources/mention.ts）：每次存盘之后对一遍正文里的 @，新 @ 到的人进收件箱、按他的规则触发。触发器后建好，惰性取。
  // 盯页面（triggers/sources/page-watch.ts）：每次存盘记下别人的改动攒着，到点由触发器的时钟收走汇报
  const pageWatch: PageWatch = new PageWatch((): PageWatchDeps => ({ pool, hub: triggers, getLiveDoc: (name) => hocuspocus.documents.get(name) }))
  const hocuspocus = createHocuspocus(pool, [
    projector.extension,
    fanout.extension,
    mentionWatch(() => ({ pool, hub: triggers, poke: () => inbox.poke() })),
    pageWatch.extension(),
  ])
  // 收件箱刷新信号：300ms 去抖合并，经 control:global 广播 'inbox'（不带内容，前端收到后重拉 GET /api/inbox）
  const inbox = new InboxPoke(() => notifyInboxChanged(hocuspocus))
  const offFirstUse = onMachineFirstUse(() => inbox.poke())
  const offSpaceAiConnections = watchSpaceAiConnections(pool, () => notifyPagesChanged(hocuspocus))
  // 外来事件之后 Genet 动手前先问主人（routes/ramet-consent.ts）：读 Genet 页的活文档判，审批挂在 Ramet 自己的审批上（agentManager 后建，惰性取）
  const consent = new Consent({
    pool,
    genetHome: async (g) => (isAssistantId(g.ctx.agentId) && g.ctx.pageId && (await isAssistantPage(pool, g.user.id, g.ctx.pageId)) ? g.ctx.pageId : null),
    fragment: async (pageId) => (await loadDocForRead(pool, `page:${pageId}`, (name) => hocuspocus.documents.get(name))).getXmlFragment('prosemirror'),
    approvals: () => agentManager.toolHost().approvals,
  })
  // AI 写回文档走 hocuspocus 自己的直连会话：写入内核（DocWriter）由此落盘（onChange 增量 + onStoreDocument 快照 / 正文索引）。
  // 第三个入参是活文档查找：read_page 与 edit_page 必须看同一份文档（内存有活文档就用那份），
  // 否则读到的原文拿去做 old 会在还没落盘的活文档上对不上
  app.route(
    '/',
    pageReadRoutes(pool, createDocWriter(() => hocuspocus), (name) => hocuspocus.documents.get(name), consent),
  )
  // Ramet 工具的中心端点（知识中枢 / run_agent，同样走 Bearer 凭证）：同一条挂载序理由。
  // agentManager 在后面才建好，这里惰性取
  app.route(
    '/',
    rametToolRoutes(
      pool,
      () => agentManager.toolHost(),
      () => notifyPagesChanged(hocuspocus),
      (name) => hocuspocus.documents.get(name),
      () => notifyMemoriesChanged(hocuspocus),
      // 触发器在 agentManager 之后才建好，同上
      () => triggers,
      // Genet 代发的评论（reply_comment）与界面上的回复走同一条：广播 + 收件箱 + 「评论找我」的触发（下面的 commentsChanged / posted，惰性取）
      {
        consent,
        write: createDocWriter(() => hocuspocus),
        comments: { changed: (pageId) => commentsChanged(pageId), posted: (c) => posted(c), calls: () => genetCalls },
        names: () => agentNameHost,
        created: rowsAddedTo,
        projector,
      },
    ),
  )
  // 空间 skill 库的 REST（只管 /api/skills 一族，自带 requireAuth）。正文写回走同一个 DocWriter，
  // 读正文优先看活文档，与 read_page / edit_page 同口径
  app.route(
    '/',
    skillRoutes({
      pool,
      write: createDocWriter(() => hocuspocus),
      getLiveDoc: (name) => hocuspocus.documents.get(name),
      notify: () => notifyPagesChanged(hocuspocus),
    }),
  )
  // 空间公共记忆的 REST（/api/spaces/:id/memories 一族，每条路由自带 requireAuth）。增删后广播 'memories'
  app.route('/', memoryRoutes(pool, () => notifyMemoriesChanged(hocuspocus)))
  // 收藏（只有自己可见）+ 页面的反向链接：读正文同样活文档优先
  app.route('/', favoriteRoutes(pool, (name) => hocuspocus.documents.get(name)))
  app.route('/', exportRoutes(pool, (name) => hocuspocus.documents.get(name)))
  // files 自己管 auth（POST 挂 requireAuth，GET 刻意公开），没有全局中间件；
  // 挂载序同 publicRoutes：必须在 pages/spaces 之前，否则被它们的 requireAuth('*') 拦截
  app.route('/', filesRoutes(pool, imgbed))
  // 搜索（全量 requireAuth）：必须在 pages/spaces 之前，理由同 files
  app.route('/', searchRoutes(pool))
  app.route(
    '/',
    pagesRoutes(
      pool,
      () => notifyPagesChanged(hocuspocus),
      // 手动快照取当前内容：内存有活文档（协同中）直接编码，避免重放增量
      (name) => hocuspocus.documents.get(name),
      () => notifyBoardsChanged(hocuspocus),
      createDocWriter(() => hocuspocus),
      rowsAddedTo,
      projector,
    ),
  )
  // 块文本端点（提及快照）：同样活文档优先，补 id 插件刚写入的块 id 立即可读
  app.route('/', blocksRoutes(pool, (name) => hocuspocus.documents.get(name)))
  app.route(
    '/',
    spacesRoutes(
      pool,
      () => notifyPagesChanged(hocuspocus),
      // 成员被移出空间 / 降为只读：他在该空间接入的机器已在库里删掉，这里断开在线连接（4403，connector 不再重连）并让目录重拉。
      // hub 在后面才建好，箭头函数请求到达时才求值
      (connectorIds, reason) => {
        for (const id of connectorIds) hub.closeOne(id, reason)
        if (connectorIds.length > 0) notifyAgents()
      },
    ),
  )
  // 空间 AI 的配置（每条路由自带 requireAuth）：改了经同一个广播让在线端重拉空间列表（列表里带 ai）
  app.route('/', spaceAiRoutes(pool, () => notifyPagesChanged(hocuspocus)))
  // AI 使用量（每条路由自带 requireAuth）
  app.route('/', aiUsageRoutes(pool))
  // 目录树路由：目录 / 条目变更不广播，但删目录（树）会把页面移入回收站，页面树要跟着变，所以注入同一份页面广播回调
  app.route(
    '/',
    boardsRoutes(
      pool,
      () => notifyPagesChanged(hocuspocus),
      () => notifyBoardsChanged(hocuspocus),
      createDocWriter(() => hocuspocus),
    ),
  )
  // 集合：每条路由各自挂 requireAuth，不挂 '*' 中间件。
  // 改值经 DocWriter 写进行文档（记给用户）后，等投影器把副本落库再响应；只有改了页面列表的操作才广播 changed
  app.route(
    '/',
    collectionRoutes({
      pool,
      write: createDocWriter(() => hocuspocus),
      getLiveDoc: (name) => hocuspocus.documents.get(name),
      notify: () => notifyPagesChanged(hocuspocus),
      projector,
      rowsAdded: rowsAddedTo,
    }),
  )
  // 关联的定义（跨两份集合文档）、单行取数、属性定义：同样每条路由各自挂 requireAuth
  app.route(
    '/',
    collectionRelationRoutes({
      pool,
      write: createDocWriter(() => hocuspocus),
      getLiveDoc: (name) => hocuspocus.documents.get(name),
    }),
  )
  // 导入（markdown / Obsidian zip）与从模板新建：各自挂 requireAuth，不挂 '*' 中间件
  app.route('/', importRoutes(pool, () => notifyPagesChanged(hocuspocus), (name) => hocuspocus.documents.get(name), (id) => imgbed.enqueue(id)))

  // agent 控制条：continue / stop / permission + SSE + agent 列表
  let wsPort = 0
  // 中心本机的 HTTP 基址（回环端口，listen 之后才知道）。不是给 connector 用的地址：
  // 对外地址（RAMET_PUBLIC_URL）只在 AgentManager.pageReadTools 解析，本机 agent 用这里当缺省，
  // connector 没配就报错，绝不把回环地址发给别的机器。
  const httpBase = (): string => `http://127.0.0.1:${wsPort}`
  const hub = new ConnectorHub(
    pool,
    () => notifyAgentsChanged(hocuspocus),
    // 非终结掉线只清 loaded，4403 才摘适配器。在飞的远端回合不在这里收尾。
    (connectorId, terminal) => agentManager.onConnectorDetached(connectorId, terminal),
  )
  // 配对台：待浏览器确认的 connector 申请（只在内存）。建了机器就提醒收件箱（成员接入要空间 owner 批准）
  const desk = new PairingDesk(pool, () => inbox.poke())
  const botSecret = randomBytes(16).toString('hex')
  const agentManager = new AgentManager(pool, {
    // 中心默认不运行任何 agent：服务器只做界面与中转，agent / 终端 / 工作区都在用户自己的机器上（connector 接入）。
    // 显式 RAMET_LOCAL_AGENTS=1 才加载服务器本机的 agent（RAMET_AGENTS / agents.json / 自动检测）；
    // 开启后它们的主人是全局 admin，非 admin 用不了（machine-access.ts）
    agents: process.env.RAMET_LOCAL_AGENTS === '1' ? loadAgents().agents : [],
    hub,
    botSecret,
    getLiveDoc: (name) => hocuspocus.documents.get(name),
    wsPort: () => wsPort,
    httpBase,
    // 过程归档新增了子页面，广播树变更，在线端重拉页面列表
    notifyPagesChanged: () => notifyPagesChanged(hocuspocus),
    notifyInbox: () => inbox.poke(),
    // 排队消息派发时以排队的人的身份写进文档（同 AI 写回的直连会话，记成用户自己的编辑）
    writeDoc: createDocWriter(() => hocuspocus),
    assistant: options.assistant,
  })
  // hello.inflight 对上 open_runs：还在跑的续上同一块回复，进程已经不跑的才收尸
  hub.setHelloHandler((id, inflight) => agentManager.resumeRemote(id, inflight))
  app.route('/', agentsRoutes(pool, agentManager))
  // 带队计划（GET / PATCH / cancel，开工走上面的 continue）：每条路由自带 requireAuth
  app.route('/', teamRoutes(pool, agentManager))
  // Genet 页（POST /api/me/assistant）与任务状态（GET /api/pages/run-status）：每条路由自带 requireAuth。
  // 任务状态读正文活文档优先（与 read_page 同口径），在飞 / 待批问 agentManager
  app.route(
    '/',
    assistantRoutes(pool, {
      status: {
        pool,
        running: (pageId) => agentManager.running(pageId),
        approvals: () => agentManager.pendingApprovals(),
        fragment: async (pageId) => (await loadDocForRead(pool, `page:${pageId}`, (name) => hocuspocus.documents.get(name))).getXmlFragment('prosemirror'),
      },
      notifyPagesChanged: () => notifyPagesChanged(hocuspocus),
    }),
  )
  // 触发器（定时器）：到点先落记录再派发（triggers/hub.ts）。依赖都从现成出口拿：排队发送、派发前的权限重判、任务回报的通知链；
  // 目标是任务页时走排队发送，观察者把排队项的结局写回触发记录。时钟在监听成功后才起
  const toolHost = agentManager.toolHost()
  // agent 显示名的原料（agents/agent-names.ts）：触发器的回报抬头与收件箱共用
  const agentNameHost: AgentNameHost = {
    localAgents: () => agentManager.agents().map((a) => ({ id: a.id, label: a.label })),
    onlineAgents: (connectorId) => hub.get(connectorId)?.agents,
  }
  // AI 块的生成：模型请求同 Genet（测试注入假的），主密钥同 Genet
  const aiGenDeps: AiGenDeps = {
    pool,
    write: createDocWriter(() => hocuspocus),
    getLiveDoc: (name) => hocuspocus.documents.get(name),
    stream: options.assistant?.stream ?? createPiStream(),
    secretKey: options.assistant?.secretKey === undefined ? loadSecretKeyFromEnv() : options.assistant.secretKey,
  }
  const triggers = new TriggerHub({
    pool,
    ...(options.triggers?.now ? { now: options.triggers.now } : {}),
    queue: agentManager.queue,
    host: toolHost.dispatch,
    names: agentNameHost,
    tasks: toolHost.tasks,
    poke: () => inbox.poke(),
    // 动作：外来事件叫 agent 前的审批、改属性 / 新建页行（写文档 + 等副本落库）、向外 webhook（出站防护，内网地址拒绝）
    approvals: toolHost.approvals,
    write: createDocWriter(() => hocuspocus),
    getLiveDoc: (name) => hocuspocus.documents.get(name),
    projector,
    fetch: options.triggers?.fetch ?? createSafeFetch({ allowHttp: true }),
    pagesChanged: () => notifyPagesChanged(hocuspocus),
    rowsAdded: rowsAddedTo,
    aiGen: (user, pageId, blockId) => runAiGen(aiGenDeps, user, pageId, blockId),
    aiProp: (user, collectionId, propId, rowId) => fillRow({ ...aiGenDeps, projector }, user, collectionId, propId, rowId),
    watch: pageWatch,
  })
  agentManager.queue.observe(triggers.queueObserver)
  // AI 页「自动」分页（规则）、老的「定时」别名与时区上报（每条路由自带 requireAuth）
  app.route('/', timerRoutes(pool, triggers))
  app.route('/', automationRoutes({ pool, clock: triggers, names: agentNameHost, getLiveDoc: (name) => hocuspocus.documents.get(name), hub: triggers }))
  // AI 块（ai-gen.ts）：页面上点「生成」；规则的「刷新 AI 块」动作经触发器的 aiGen 走同一份
  app.route('/', aiGenRoutes({ ...aiGenDeps, projector, background: (work) => triggers.background(work) }))
  // 收件箱（每条路由自带 requireAuth）：聚合审批 / 机器接入 / 使用申请 / 做完待看 / 在跑，只是视图
  app.route(
    '/',
    inboxRoutes(pool, {
      approvals: () => agentManager.pendingApprovals(),
      runs: () => agentManager.activeRuns(),
      ...agentNameHost,
    }),
  )
  // 页面评论（每条路由自带 requireAuth）。写成功后：页面文档上广播 {t:'comments'}（同页在线的人重拉评论，
  // 只有连着这一页的人收得到，不经全员的 control 通道），收件箱也刷新（回复 / @ / 新开串都可能给别人添条目）
  // 新串 / 回复另交给「评论找我」的触发（triggers/sources/comment.ts）：后台跑，评论接口不等它
  const commentsChanged = (pageId: string): void => {
    hocuspocus.documents.get(`page:${pageId}`)?.broadcastStateless(JSON.stringify({ t: 'comments' }))
    inbox.poke()
  }
  // 评论里 @Genet（comments/genet-call.ts）：与任务回报同一条写 Genet 页的链；Genet 页上一轮结束时给呼叫收尾
  const genetCalls = new GenetCalls({ pool, notify: toolHost.tasks.notify, changed: commentsChanged })
  toolHost.tasks.onEnd((pageId, outcome, error, startedAt) => genetCalls.runEnded(pageId, outcome, error, startedAt))
  // 评论里 @空间 AI（comments/space-ai-call.ts）：在中心直接跑一轮、以 AI 的名义回在串里；它的回复同样交给 posted（不会再叫醒它自己）
  const spaceAiCalls = new SpaceAiCalls({
    pool,
    runner: (agent) => agentManager.spaceAiRunner(agent),
    changed: commentsChanged,
    posted: (c) => posted(c),
  })
  const posted = (c: PostedComment): void => {
    triggers.background(() => commentPosted({ pool, hub: triggers }, c))
    triggers.background(() => genetCalls.posted(c))
    triggers.background(() => spaceAiCalls.posted(c))
  }
  app.route('/', commentRoutes(pool, commentsChanged, posted))
  // 过程页 record（只读视图）
  app.route('/', runsRoutes(pool))
  // connector：浏览器确认配对 + 列表 + 批准 / 拒绝 / 撤销
  app.route('/', connectorsRoutes(pool, hub, desk, notifyAgents))
  // 机器授权（网页端）：机器列表 / 使用申请 / 授权 / 收回 / 使用记录
  app.route('/', machinesRoutes(pool, { hub, disconnect, notify: notifyAgents, inbox: () => inbox.poke() }))
  // 项目面板（文件树 / 读文件 / git 只读）：页面可读 + 对机器有 machine 授权；只做鉴权与转发，每条路由自带 requireAuth
  app.route('/', projectRoutes(pool, hub))
  // 项目面板的终端（pty 在 connector 上，输出经 SSE 回浏览器）：同一个守卫，machine 范围
  app.route('/', projectPtyRoutes(pool, hub))
  // 端口预览（共享 / 列表 / 票据 / 停止）：每条路由自带 requireAuth。流量走独立的预览监听（preview-server.ts），不在这个端口上
  const previewCfg = options.preview === null ? undefined : (options.preview ?? previewFromEnv())
  const previewAccess = new PreviewAccess(previewCfg?.ticketTtlMs ? { ticketTtlMs: previewCfg.ticketTtlMs } : {})
  const previewServer = previewCfg ? createPreviewServer({ pool, hub, access: previewAccess, ...(previewCfg.revalidateMs !== undefined ? { revalidateMs: previewCfg.revalidateMs } : {}) }) : null
  let previewPort: number | null = null
  const previewRuntime: PreviewRuntime = {
    enabled: () => previewPort !== null,
    origin: (c) => {
      if (previewCfg?.origin) return previewCfg.origin
      const host = (c.req.header('host') ?? 'localhost').replace(/:\d+$/, '')
      return `${isHttpsRequest(c) ? 'https' : 'http'}://${host}:${previewPort}`
    },
  }
  // 预览登记变了：作废它的会话 / 票据，并通知在线客户端重拉这一页的预览列表
  hub.previews.onEvent = (ev) => {
    if (ev.type === 'removed') previewAccess.dropPreview(ev.preview.id)
    notifyPreviewsChanged(hocuspocus, ev.preview.pageId)
  }
  app.route('/', previewRoutes(pool, hub, previewAccess, previewRuntime))
  // ⌘J：用户的模型连接 + 单次调用（SSE）。requireAuth 限定在自己的路径，不用 '*'，挂载序无影响。
  // 本地通道（经 connector 在用户自己的机器上跑一次 agent）借 AgentManager 的 resolve（机器使用权的唯一判定）与 catalog
  app.route(
    '/',
    quickRoutes(pool, options.quick, {
      hub,
      resolve: (agentId, user) => agentManager.resolve(agentId, user),
      catalog: (user) => agentManager.catalog(user),
    }),
  )
  // 客户端诊断上报（登录态）：前端采集的交互事件落到 server 日志，排查环境相关故障用
  app.route('/', debugRoutes(pool))

  // Hocuspocus 外挂 http server 时自己接 ws 升级；认证通过后才 handleUpgrade，
  // 所以无需 wss 的 connection 监听，直接在 upgrade 回调里调 handleConnection
  const wss = new WebSocketServer({ noServer: true })
  // 网页终端（/term）单独一个：开压缩、限单条消息大小（routes/pty-socket.ts）
  const termWss = createTermWss()

  const server = createServer(getRequestListener(app.fetch))
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost')
    // connector 走独立路径（header token 认证，与浏览器 cookie 认证互不影响）
    if (isConnectorPath(pathname)) {
      connectorUpgrade(wss, pool, hub, desk, request, socket, head)
      return
    }
    // 网页终端：Origin 在里面校验，鉴权在升级之后（失败原因要以消息告诉浏览器）
    if (pathname === TERM_PATH) {
      ptySocketUpgrade(termWss, pool, hub, request, socket, head)
      return
    }
    if (pathname !== '/collab' && !pathname.startsWith('/collab/')) {
      socket.destroy()
      return
    }
    // 浏览器握手带的 Origin 必须是 Ramet 自己（同 csrf.ts）：否则预览页里的脚本能带着登录 cookie 连进协同。没带 Origin = 非浏览器，放行
    if (!originAllowed(request.headers.origin, request.headers.host)) {
      socket.destroy()
      return
    }
    // 升级即验会话：无效直接销毁 socket，连握手都不给。
    // 会话查询是异步的，先查完再 handleUpgrade：等待期间 socket 未被写入，不影响后续握手
    userFromRequest(pool, request)
      .then((user) => {
        if (!user) {
          socket.destroy()
          return
        }
        // user 装进 defaultContext，onConnect / onLoadDocument / onChange 都能从 context 读到。
        // actor 只有机器人客户端带对密钥时才是 agent，浏览器编辑仍是 user
        const actor = collabActor(request, botSecret)
        wss.handleUpgrade(request, socket, head, (ws) => hocuspocus.handleConnection(ws, request, { user, actor }))
      })
      .catch(() => socket.destroy())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, async () => {
      const actual = (server.address() as { port: number }).port
      wsPort = actual
      // 进程重启后不可能还有在跑的执行轮（组员阶段由中心驱动），残留的 running 计划清扫成 error
      await sweepRunningPlans(pool).catch((err: unknown) => console.error('[team] 启动清扫失败:', err))
      // 预览监听起不来（端口被占等）不拖垮主服务，记日志，预览保持关闭
      if (previewServer && previewCfg) {
        try {
          previewPort = await previewServer.listen(previewCfg.port)
        } catch (err) {
          console.error(`[preview] 预览端口 ${previewCfg.port} 监听失败，端口预览保持关闭:`, err)
        }
      }
      let closed = false
      // 到期的机器授权每分钟扫一次（unref，不拖住进程退出）
      const sweeper = setInterval(() => {
        sweepGrants(pool, disconnect).then(
          (n) => {
            if (n > 0) notifyAgents()
          },
          (err: unknown) => console.error('[grants] 到期清扫失败:', err),
        )
      }, GRANT_SWEEP_MS)
      sweeper.unref()
      // 页面变更日志（增量同步用）：启动时清一次，之后每小时一次（删 7 天前的行、推进 floor）
      const prune = (): void => {
        prunePageChanges(pool).catch((err: unknown) => console.error('[page-sync] 清理变更日志失败:', err))
      }
      prune()
      const pruner = setInterval(prune, PAGE_CHANGES_PRUNE_MS)
      pruner.unref()
      // 存量补传 + 定时探测 / 扫描：监听成功后才起，失败只记日志
      imgbed.start()
      triggers.start()
      // 上一个进程没跑完的评论呼叫结成 failed（排队只在内存里）；只动这个进程开始之前写下的
      await spaceAiCalls.recover().catch((err: unknown) => console.error('[space-ai] 收尾遗留的评论呼叫失败', err))
      resolve({
        port: actual,
        previewPort,
        // 立刻跑一次到期清扫，测试用
        sweepGrants: () => sweepGrants(pool, disconnect),
        // 立刻扫一次到期的触发器，测试用（配合注入的时钟）
        triggers: {
          tick: () => triggers.tick(),
          emit: (e) => triggers.emit(e),
          causedBy: (pageId) => triggers.causedBy(pageId),
          touched: (pageId, depth) => triggers.touched(pageId, depth),
        },
        close: async () => {
          if (closed) return
          closed = true
          clearInterval(sweeper)
          clearInterval(pruner)
          // 评论里叫空间 AI 的在跑的那几次停掉（它们挂在触发器的后台活里，不停的话下面要等模型说完）
          spaceAiCalls.dispose()
          // 先停时钟、等在派发的那一趟做完（派发要写文档，必须在 hocuspocus.destroy 之前）
          await triggers.dispose()
          await imgbed.dispose()
          inbox.dispose()
          offFirstUse()
          offSpaceAiConnections()
          // 先让在跑的 run 收尾：运行中的正文只在内存里，收尾要经机器人客户端写进文档，
          // 所以必须排在 hocuspocus.destroy 之前（之后就没有连接可写了）
          await agentManager.shutdown(SHUTDOWN_RUNS_MS)
          await hocuspocus.destroy()
          // 客户端拿到同步确认时，onChange 里的写库可能还在路上，等它们落完再返回
          await drainDocWrites(hocuspocus)
          // 行属性副本：等还在路上的写入落库（之后连接池就要关了）
          await projector.drain()
          // 升级成 ws 的连接已脱离 http server 的连接跟踪，closeAllConnections 管不到；
          // 残留的 ws 连接会让 server.close() 永久挂起，必须显式断干净
          for (const client of wss.clients) client.terminate()
          for (const client of termWss.clients) client.terminate()
          termWss.close()
          await previewServer?.close()
          hub.closeAll('server 关闭')
          wss.close()
          server.closeAllConnections()
          await new Promise<void>((res) => server.close(() => res()))
        },
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // 端口固定 3789：vite proxy 与 CORS 白名单都依赖它
  const port = 3789
  // 在 Claude Code 里起的（npm run dev）时，外层会话的变量别带进本机 agent 与终端
  dropOuterClaudeSession()
  try {
    // 开发（npm run dev）默认开预览端口 3790；生产由 docker-compose.prod.yml 显式设置，其余情况不设即关闭
    if (process.env.npm_lifecycle_event === 'dev' && !process.env.RAMET_PREVIEW_PORT) process.env.RAMET_PREVIEW_PORT = '3790'
    const pool = getPool()
    await initDb(pool)
    const { port: actual, close } = await startServer(pool, port)
    console.log(`server listening on http://localhost:${actual}`)
    // 反向链接索引：给没建过的页补上（后台逐页，不挡启动）
    void backfillPageLinks(pool, async (id) => (await loadDocFromDb(pool, `page:${id}`)).getXmlFragment('prosemirror')).then((n) => {
      if (n > 0) console.log(`[links] 补了 ${n} 个页面的反向链接索引`)
    })
    // 部署重启和 tsx watch 重启都发 SIGTERM：先收尾在跑的 run 再退出，否则回复停在占位状态
    let stopping = false
    const onSignal = (signal: string): void => {
      if (stopping) return
      stopping = true
      console.log(`[server] 收到 ${signal},收尾在跑的 agent 后退出`)
      // 连接池最后关：pool.end 会等在飞的写入（收尾那一笔的增量落库）完成
      close()
        .then(() => closePool())
        .catch((err: unknown) => console.error('server 关闭失败:', err))
        .finally(() => process.exit(0))
    }
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
  } catch (err) {
    // 连不上库就别起服务
    console.error('server 启动失败:', err)
    process.exit(1)
  }
}
