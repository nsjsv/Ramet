import { rametToolRoutes } from './routes/ramet-tools.js'
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
import { importRoutes } from './routes/import.js'
import { boardsRoutes } from './routes/boards.js'
import { collectionRoutes } from './routes/collections.js'
import { createProjector } from './collections/projector.js'
import { publicRoutes } from './routes/public.js'
import { filesRoutes } from './routes/files.js'
import { searchRoutes } from './routes/search.js'
import { adminRoutes, authRoutes, userFromRequest, type AuthEnv } from './auth.js'
import { createDocWriter, createHocuspocus, drainDocWrites, loadDocFromDb, notifyAgentsChanged, notifyInboxChanged, notifyMemoriesChanged, notifyPagesChanged, notifyPreviewsChanged } from './collab.js'
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
import { PreviewAccess } from './preview-access.js'
import { createPreviewServer } from './preview-server.js'
import { onMachineFirstUse, sweepGrants, type Disconnect } from './agents/machine-grants.js'
import { InboxPoke } from './inbox.js'
import { inboxRoutes } from './routes/inbox.js'
import { debugRoutes } from './routes/debug.js'
import { runsRoutes } from './routes/runs.js'
import { pageReadRoutes } from './page-read.js'
import { quickRoutes, type QuickDeps } from './routes/quick.js'
import { dropOuterClaudeSession } from './claude-session-env.js'
import { isHttpsRequest } from './request-proto.js'
import { createImgbedSync, type ImgbedSync } from './imgbed-sync.js'

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
  /** 随手 AI：模型调用 / 主密钥 / DNS 解析可注入，测试里不真的打模型 */
  quick?: QuickDeps
  /** 端口预览：不传看环境变量 RAMET_PREVIEW_PORT / RAMET_PREVIEW_ORIGIN（没设即关闭）；null 明确关闭 */
  preview?: PreviewOptions | null
  /** 图床镜像：不传看环境变量 RAMET_IMGBED_*（没设即关闭）；测试注入自己建的实例 */
  imgbed?: ImgbedSync
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
): Promise<{ port: number; previewPort: number | null; close: () => Promise<void>; sweepGrants: () => Promise<number> }> {
  const app = new Hono<AuthEnv>()
  app.use('*', cors({ origin: 'http://localhost:5173' }))
  // CSRF：改数据的 /api 请求，浏览器自报的来源必须是 Ramet 自己（预览源与 Ramet 同站不同源，里面的脚本不可信）。
  // 必须挂在所有子应用之前；无 Origin 的非浏览器请求（connector / MCP 的 Bearer、测试）放行
  app.use('/api/*', csrfGuard())
  // 图床镜像（imgbed-sync.ts）：读入口 302 到图床，上传后后台镜像；未配置时是空实现
  const imgbed = options.imgbed ?? createImgbedSync(pool)
  // 公开端点必须挂在 pages/spaces 之前：两者在自己子应用里 app.use('*', requireAuth)，
  // 会拦住注册序靠后的 /api/public/* 请求（Hono 按注册序组链，匿名请求没到 handler 就 401）
  app.route(
    '/',
    publicRoutes(
      pool,
      () => notifyPagesChanged(hocuspocus),
      (name) => hocuspocus.documents.get(name),
    ),
  )
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
  // 增量只发给正连着集合文档的连接。找集合文档惰性取，hocuspocus 随后才建好
  const projector = createProjector(pool, (name) => hocuspocus.documents.get(name))
  // AI 按行读页面 / 取图 / 写回文档（凭证走 Authorization: Bearer，不是 cookie）：必须挂在
  // files/search/pages 这些 `use('*', requireAuth)` 的子应用之前，否则请求先到它们就被 401 了。
  // 活文档查找与 blocksRoutes 一样用惰性引用
  const hocuspocus = createHocuspocus(pool, [projector.extension])
  // 收件箱刷新信号：300ms 去抖合并，经 control:global 广播 'inbox'（不带内容，前端收到后重拉 GET /api/inbox）
  const inbox = new InboxPoke(() => notifyInboxChanged(hocuspocus))
  const offFirstUse = onMachineFirstUse(() => inbox.poke())
  // AI 写回文档走 hocuspocus 自己的直连会话：写入内核（DocWriter）由此落盘（onChange 增量 + onStoreDocument 快照 / 正文索引）。
  // 第三个入参是活文档查找：read_page 与 edit_page 必须看同一份文档（内存有活文档就用那份），
  // 否则读到的原文拿去做 old 会在还没落盘的活文档上对不上
  app.route(
    '/',
    pageReadRoutes(pool, createDocWriter(() => hocuspocus), (name) => hocuspocus.documents.get(name)),
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
  // 目录树路由：目录 / 条目变更不广播，但删目录（树）会把页面移入回收站，页面树要跟着变，所以注入同一份页面广播回调
  app.route('/', boardsRoutes(pool, () => notifyPagesChanged(hocuspocus)))
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
  })
  // hello.inflight 对上 open_runs：还在跑的续上同一块回复，进程已经不跑的才收尸
  hub.setHelloHandler((id, inflight) => agentManager.resumeRemote(id, inflight))
  app.route('/', agentsRoutes(pool, agentManager))
  // 带队计划（GET / PATCH / cancel，开工走上面的 continue）：每条路由自带 requireAuth
  app.route('/', teamRoutes(pool, agentManager))
  // 收件箱（每条路由自带 requireAuth）：聚合审批 / 机器接入 / 使用申请 / 做完待看 / 在跑，只是视图
  app.route(
    '/',
    inboxRoutes(pool, {
      approvals: () => agentManager.pendingApprovals(),
      runs: () => agentManager.activeRuns(),
      localAgents: () => agentManager.agents().map((a) => ({ id: a.id, label: a.label })),
      onlineAgents: (connectorId) => hub.get(connectorId)?.agents,
    }),
  )
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
  // 随手 AI：用户的模型连接 + 单次调用（SSE）。requireAuth 限定在自己的路径，不用 '*'，挂载序无影响。
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
      resolve({
        port: actual,
        previewPort,
        // 立刻跑一次到期清扫，测试用
        sweepGrants: () => sweepGrants(pool, disconnect),
        close: async () => {
          if (closed) return
          closed = true
          clearInterval(sweeper)
          clearInterval(pruner)
          await imgbed.dispose()
          inbox.dispose()
          offFirstUse()
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
