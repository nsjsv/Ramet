// ---------- connector 运行时：出站 WSS 反连中心 ----------
// 跑在 agent 所在机器上：本机起 / 复用 ACP 进程、会话 new/load/prompt、取消、权限应答、事件回传。
// 文档、Yjs、上下文、hash 一律留在中心，这里不碰数据库。
//
// 断线后指数退避重连；被撤销（4403）打印原因后干净退出，等人工 start --repair 重新配对。
// 断线不取消在飞 prompt，回合寿命在本进程（inflight.ts），不在这条 socket 上。

import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { AcpAgent, errorText } from '../agents/acp.js'
import { listDirs } from '../agents/dirs.js'
import { loadAgents } from '../agents/registry.js'
import {
  CONNECTOR_PATH,
  CONNECTOR_REVOKED_CODE,
  CONNECTOR_TOKEN_HEADER,
  DRIVEN_SCOPE,
  isDrivenMsg,
  type CenterMsg,
  type DrivenMsg,
  type ConnMsg,
  type ConnectorAgentInfo,
} from '../agents/protocol.js'
import { connectorCaps } from '../agents/project-types.js'
import { PtyError } from '../agents/pty-types.js'
import { PreviewDenied } from '../agents/preview-types.js'
import { isSessionEvent, type AgentConfig, type AgentEvent } from '../agents/types.js'
import { pageToolServer, type PageTool } from '../page-read.js'
import { IdleRecycler } from '../agents/idle.js'
import { keepAlive } from '../agents/ws-heartbeat.js'
import { checkActor, pinOwner, readConnectorConfig, removeLocalGrants } from './access.js'
import { createInflight } from './inflight.js'
import { cloudOrigin, needsPair, pairAndSave } from './pair.js'
import { handleProject, WriteConflict } from './project.js'
import { PreviewForwarder } from './preview.js'
import { QuickRunner } from './quick.js'
import { loadNodePty, PtyManager, type PtyDeps, type PtyModule } from './pty.js'

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 15_000

export type ConnectorOptions = {
  /** 中心地址：http(s)://host[:port] 或 ws(s)://host[:port]（cloudOrigin 归一化） */
  cloud: string
  /** 强制重新配对（被撤销 / 换身份）。没有本地配置、或 cloud 与已配对的中心不同时，不给也会先配对（connector/pair.ts） */
  repair?: boolean
  /** 显示名（默认 hostname） */
  name?: string
  /** 本机默认工作目录（默认 process.cwd()） */
  cwd?: string
  tokenFile?: string
  /** 外部停止信号（测试/宿主进程用；CLI 走 SIGINT/SIGTERM） */
  signal?: AbortSignal
  log?: (line: string) => void
  /** 闲置回收窗口（默认 IDLE_AGENT_MS）；测试用：0 = 立即回收，验证在飞工作不会被回收 */
  idleMs?: number
  /** 测试注入：node-pty 的加载器（缺省真的去加载）。返回 null = 这台机器没有终端能力（hello 不带 terminal） */
  loadPty?: () => Promise<PtyModule | null>
  /** 测试注入：终端的上限 / 巡检（缺省用生产值） */
  ptyLimits?: Pick<PtyDeps, 'maxPerActor' | 'idleMs' | 'tickMs' | 'replayBytes'>
  /** 测试注入：随手 AI 本地通道的超时（缺省 60 秒） */
  quickTimeoutMs?: number
}

export function defaultTokenFile(): string {
  return join(homedir(), '.ramet', 'connector.json')
}

/** 把被第二道闸拒绝的驱动帧报回中心：带 rid 的请求回 err（code: 'forbidden'，中心据此回 403），
 *  prompt 另带 runId 供中心收掉这一轮；审批应答没有应答帧，只在本机日志留痕 */
function refuse(send: (msg: ConnMsg) => void, msg: DrivenMsg, message: string): void {
  switch (msg.t) {
    case 'permission':
    case 'http-body':
    case 'ws-msg':
    case 'ws-close':
      return
    case 'http-req': // 预览的流量帧没有 rid：按 reqId / wsId 回
      send({ t: 'http-fail', reqId: msg.reqId, status: 403, message })
      return
    case 'ws-open':
      send({ t: 'ws-end', wsId: msg.wsId, code: 1008, reason: message, opened: false })
      return
    default:
      send({ t: 'err', rid: msg.rid, ...(msg.t === 'prompt' ? { runId: msg.runId } : {}), message, code: 'forbidden' })
  }
}

/** 本机可用 agent：显式配置（RAMET_AGENTS / cwd 下 agents.json）优先，没配就自动检测本机已装 CLI */
export function localAgents(log: (line: string) => void): { configs: AgentConfig[]; agents: ConnectorAgentInfo[] } {
  const { agents: configs, source } = loadAgents()
  const agents: ConnectorAgentInfo[] = configs.map((a) => ({ id: a.id, label: a.label, logo: a.logo ?? null }))
  if (agents.length === 0) {
    // 零 agent 的连接器在线也毫无用处（中心列表里看不到任何可选 agent），必须显式报警
    log('警告：本机没有可用的 agent（自动检测也没找到）。连上去也没有可用项。')
    log('  自动检测认这些 ACP：omp（omp acp）、claude、codex、opencode（opencode acp）、pi、gemini（经 npx）；')
    log('  claude 还需要本机装有 node 才能跑包内适配器（或 npx 兜底）。')
    log('  也可以显式配 RAMET_AGENTS（JSON 数组），或在 connector 进程 cwd 放 agents.json，例如：')
    log(`  RAMET_AGENTS='[{"id":"omp","label":"omp","command":"omp","args":["acp"]}]'`)
  } else {
    const how = source === 'auto' ? '自动检测到' : source === 'env' ? '来自 RAMET_AGENTS' : '来自 agents.json'
    log(`本机 agent（${how}）: ${agents.map((a) => a.id).join(', ')}`)
  }
  return { configs, agents }
}

/** 只配对、不常驻（`start` 装后台服务前先在前台配对：链接打在终端里，确认完再转后台） */
export async function pairOnly(options: Pick<ConnectorOptions, 'cloud' | 'name' | 'cwd' | 'tokenFile' | 'log'>): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(`[connector] ${line}`))
  const { agents } = localAgents(log)
  const input = { name: options.name ?? hostname(), cwd: options.cwd ?? process.cwd(), agents }
  await pairAndSave(cloudOrigin(options.cloud), input, options.tokenFile ?? defaultTokenFile(), log)
}

/** 常驻运行；进程收到 SIGINT/SIGTERM 时收尾退出 */
export async function runConnector(options: ConnectorOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(`[connector] ${line}`))
  const origin = cloudOrigin(options.cloud)
  const tokenFile = options.tokenFile ?? defaultTokenFile()
  const name = options.name ?? hostname()
  const cwd = options.cwd ?? process.cwd()
  const { configs, agents } = localAgents(log)

  const config = readConnectorConfig(tokenFile)
  const token = config && !options.repair && !needsPair(config, origin)
    ? config.token
    : await pairAndSave(origin, { name, cwd, agents }, tokenFile, log, options.signal)

  const adapters = new Map<string, AcpAgent>()
  /** 闲置回收：到期时适配器 busy（在飞 prompt）就续期，绝不 SIGTERM 掉正在跑的轮次 */
  const idle = new IdleRecycler(
    (agentId) => adapters.get(agentId)?.busy === true,
    (agentId) => {
      adapters.get(agentId)?.kill()
      adapters.delete(agentId)
    },
    { idleMs: options.idleMs },
  )
  /** sessionId → 承载它的请求（按事件自带的 sessionId 路由回中心的请求） */
  const sessionRid = new Map<string, string>()
  /** 在飞 prompt 的操作人（runId → actor）：中心通知某人的授权被收回时，按人取消他的在飞轮次 */
  const promptActors = new Map<string, string>()
  let current: WebSocket | null = null
  /** 往**当前**连接发一帧；没连上 / 写失败返回 false（inflight 据此留着缓冲；会话级帧丢了也不要紧：
   *  重连后的 sessions 快照会补齐） */
  function sendCurrent(msg: ConnMsg): boolean {
    const ws = current
    if (!ws || ws.readyState !== ws.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }
  const flight = createInflight({
    send: sendCurrent,
    // 中心不要的回合才走到这里。用户点停止走 cancel 消息，不经过这条。
    cancel: (agent, sessionId) => {
      adapters.get(agent)?.cancel(sessionId)
    },
    log,
  })
  // 终端：node-pty 只在这个进程里动态加载。装不上 → 不声明 terminal 能力，中心对这台机器的终端接口回 409（其余能力不受影响）
  const ptyModule = await (options.loadPty ?? loadNodePty)()
  if (!ptyModule) log('提示：node-pty 没装上，这台机器不支持项目面板的终端（agent 与文件功能照常）')
  const pty = ptyModule
    ? new PtyManager(ptyModule, {
        send: sendCurrent,
        isOwner: (actor) => readConnectorConfig(tokenFile)?.ownerId === actor,
        protect: [dirname(tokenFile)],
        // 本机名单是权威：授权到期 / 被收窄的人，终端在巡检时关掉（中心的通知只是更快）
        stillAllowed: (actor) => checkActor(tokenFile, actor, 'machine').ok,
        backlog: () => current?.bufferedAmount ?? 0,
        log,
        ...options.ptyLimits,
      })
    : null
  // 端口预览：把本机 127.0.0.1:<端口> 转给中心。登记只在内存里，每次（重新）welcome 清空，中心再登记一遍
  const preview = new PreviewForwarder({
    send: sendCurrent,
    isOwner: (actor) => readConnectorConfig(tokenFile)?.ownerId === actor,
    // 本机名单是权威：共享人的授权到期 / 被收窄 / 被收回，他共享的预览就不再转发
    stillAllowed: (actor) => checkActor(tokenFile, actor, 'machine').ok,
    backlog: () => current?.bufferedAmount ?? 0,
    log,
  })
  /** 在飞 prompt 的 rid 不能被后来的 new/load 盖掉（config 本来就不写）。
   *  盖掉之后流式事件会走到已经结束的请求上，中心直接丢，回复消失。 */
  function rememberRid(sessionId: string, rid: string): void {
    if (flight.ownerRid(sessionId)) return
    sessionRid.set(sessionId, rid)
  }
  let backoff = RECONNECT_MIN_MS
  let shutdown: (() => void) | null = null
  /** 收尾中（SIGINT/SIGTERM/abort）：断开与退避定时器都不许再拉起连接。
   *  否则 shutdown 杀掉 agent 进程后连接 1s 又连回来，中心看着一切正常，实际它持有的会话全没了。 */
  let stopping = false

  // 随手 AI 本地通道：受限会话里跑一次 agent（临时空目录、不给工具、读写 / 终端 / 审批全拒、60 秒），见 quick.ts
  const quick = new QuickRunner({
    adapter: (agentId) => ensureAdapter(agentId),
    send: sendCurrent,
    log,
    ...(options.quickTimeoutMs !== undefined ? { timeoutMs: options.quickTimeoutMs } : {}),
  })

  function ensureAdapter(agentId: string): AcpAgent {
    const existing = adapters.get(agentId)
    if (existing && existing.alive) {
      // 请求到达即重设回收窗口（与"在飞工作"共同构成"空闲"的定义）
      idle.arm(agentId)
      return existing
    }
    if (existing) existing.kill()
    const cfg = configs.find((a: AgentConfig) => a.id === agentId)
    if (!cfg) throw new Error(`本机未配置 agent ${agentId}`)
    const adapter = new AcpAgent(cfg, cwd)
    adapters.set(agentId, adapter)
    idle.arm(agentId)
    // 常驻监听：会话级事件（命令 / 配置 / 审批）不论有没有 prompt 在飞都作为 `session` 帧发给中心。
    // 同时让"忙→闲"真正开始计时：busy 期间回收器只会续期，事件（含审批结束）到来时在这里重新起算
    adapter.on((ev) => {
      idle.arm(agentId)
      // 随手 AI 的受限会话是用完即弃的，不对中心露面（中心没有页面对应它）
      if (isSessionEvent(ev) && ev.sessionId && !adapter.isRestricted(ev.sessionId)) {
        sendCurrent({ t: 'session', agent: agentId, sessionId: ev.sessionId, ev })
      }
    })
    return adapter
  }

  /** 中心只发能力凭证（地址 + token），命令用本机的 node 与这份代码旁边的 MCP 脚本拼。
   *  中心是容器 / 另一台机器，它的 process.execPath 与脚本路径在这台机器上不存在，
   *  整份配置发过来会让 session/new|load 一律 Internal error。 */
  function tools(grants: PageTool[] | undefined): PageTool[] {
    // 提前炸：凭证里缺地址在这台机器上就没法拼命令，建会话前把原因说出来（别拖到进程静默失败）
    for (const g of grants ?? []) pageToolServer(g)
    return grants ?? []
  }

  /** 本进程所有活会话的全量快照（hello 后推一次，中心据此对账） */
  function sessionsSnapshot(): Extract<ConnMsg, { t: 'sessions' }>['list'] {
    return [...adapters].flatMap(([agent, adapter]) =>
      adapter.knownSessions().map((sessionId) => ({ agent, sessionId, state: adapter.sessionState(sessionId) })),
    )
  }

  function connect(): void {
    if (stopping) return
    // 新 socket 在 welcome 之前只缓冲。重放还是取消，等中心的 resume/drop。
    flight.onDisconnect()
    // 握手超时：网络不通 / 代理吞了连接时别永远卡在「连接中」（超时会走 close → 重连）
    const ws = new WebSocket(`${origin}${CONNECTOR_PATH}`, { headers: { [CONNECTOR_TOKEN_HEADER]: token }, handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    current = ws
    const send = (msg: ConnMsg): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    }

    ws.on('open', () => {
      backoff = RECONNECT_MIN_MS
      // 中心那头没了这边可能收不到关闭通知（代理 / 休眠 / 换网）：心跳判死 → terminate → close → 重连
      keepAlive(ws, () => log('心跳超时：和中心的连接已经断了，重连'))
      // inflight 只报身份。事件日志留在进程里，等 welcome.resume 按 after 补。
      send({ t: 'hello', name, defaultCwd: cwd, agents, inflight: flight.helloList(), caps: connectorCaps(pty !== null) })
      // 全量会话快照：断线期间发生的审批 / 命令 / 配置变化靠它对账（快照里没有的会话中心当已结束）
      send({ t: 'sessions', list: sessionsSnapshot() })
    })

    ws.on('message', (data) => {
      let msg: CenterMsg
      try {
        msg = JSON.parse(String(data)) as CenterMsg
      } catch {
        return
      }
      // 第二道闸：驱动机器的帧必须带 actor，且 actor 是本机主人或在本地授权名单里。不通过 → 回报错误，不执行
      if (isDrivenMsg(msg)) {
        const verdict = checkActor(tokenFile, msg.actor, DRIVEN_SCOPE[msg.t])
        if (!verdict.ok) {
          log(`拒绝 ${msg.t} 指令（actor=${String(msg.actor)}）：${verdict.reason}`)
          refuse(send, msg, verdict.reason)
          return
        }
      }
      switch (msg.t) {
        case 'welcome':
          log(`已连上中心（connectorId=${msg.connectorId}）`)
          preview.reset() // 预览登记以中心为准：清空，中心随后把还在共享的再登记一遍
          // 旧配置没有主人：首次由中心告知并钉住，之后固定（access.ts）。已钉住的不接受改写
          if (msg.ownerId) {
            const pinned = pinOwner(tokenFile, msg.ownerId)
            if (pinned === 'pinned') log('已记录这台机器的主人')
            else if (pinned === 'conflict') log('警告：中心告知的机器主人与本机记录的不一致，仍以本机记录为准')
          }
          flight.onWelcome(msg.resume, msg.drop)
          break
        case 'new':
          log(`指令 new agent=${msg.agent} cwd=${msg.cwd}`)
          void (async () => {
            try {
              const adapter = ensureAdapter(msg.agent)
              const { sessionId } = await adapter.newSession(msg.cwd, tools(msg.tools))
              rememberRid(sessionId, msg.rid)
              send({ t: 'res', rid: msg.rid, sessionId, state: adapter.sessionState(sessionId) })
            } catch (err) {
              const message = errorText(err)
              log(`new 失败 ${message}`)
              send({ t: 'err', rid: msg.rid, message })
            }
          })()
          break
        case 'load':
          log(`指令 load agent=${msg.agent} session=${msg.sessionId}`)
          void (async () => {
            try {
              const adapter = ensureAdapter(msg.agent)
              await adapter.loadSession(msg.sessionId, msg.cwd, tools(msg.tools))
              rememberRid(msg.sessionId, msg.rid)
              send({ t: 'res', rid: msg.rid, state: adapter.sessionState(msg.sessionId) })
            } catch (err) {
              const message = errorText(err)
              log(`load 失败 ${message}`)
              send({ t: 'err', rid: msg.rid, message })
            }
          })()
          break
        case 'ls':
          // 列本机目录（中心侧的工作区选择器）：目录只有本机看得见，中心拿到的是绝对路径
          void (async () => {
            try {
              send({ t: 'res', rid: msg.rid, dirs: await listDirs(msg.path) })
            } catch (err) {
              send({ t: 'err', rid: msg.rid, message: errorText(err) })
            }
          })()
          break
        case 'tree':
        case 'read':
        case 'files':
        case 'git-status':
        case 'git-diff':
        case 'write':
          // 项目面板（读 + 写已存在的文本文件）：已过第二道闸（machine 范围）；路径约束与体积约束在 project.ts。
          // 配置目录（长期 token + 授权名单）不对网页开放，哪怕工作区恰好把它圈了进去
          void handleProject(msg, { protect: [dirname(tokenFile)] }).then(
            (project) => send({ t: 'res', rid: msg.rid, project }),
            (err: unknown) => send({ t: 'err', rid: msg.rid, message: errorText(err), ...(err instanceof WriteConflict ? { code: 'conflict' as const } : {}) }),
          )
          break
        case 'pty-open':
        case 'pty-input':
        case 'pty-resize':
        case 'pty-close':
        case 'pty-attach':
        case 'pty-detach':
        case 'pty-list':
          // 终端：已过第二道闸（machine 范围）；pty 的归属（只有打开它的人能输入 / 订阅，关闭还允许机器主人）在 PtyManager 里判
          if (!pty) {
            send({ t: 'err', rid: msg.rid, message: '这台机器上的 connector 不支持终端（node-pty 没装上）' })
            break
          }
          void pty.handle(msg).then(
            (project) => send({ t: 'res', rid: msg.rid, project }),
            (err: unknown) =>
              send({
                t: 'err',
                rid: msg.rid,
                message: errorText(err),
                ...(err instanceof PtyError && err.kind !== 'failed' ? { code: err.kind === 'forbidden' ? ('forbidden' as const) : ('not_found' as const) } : {}),
              }),
          )
          break
        case 'port-share':
        case 'port-unshare':
          // 端口预览的登记 / 撤销（已过第二道闸）：共享人必须是 machine 范围的人，最多 5 个，端口 1024–65535
          try {
            send({ t: 'res', rid: msg.rid, project: preview.control(msg) })
          } catch (err) {
            send({ t: 'err', rid: msg.rid, message: errorText(err), ...(err instanceof PreviewDenied && err.forbidden ? { code: 'forbidden' as const } : {}) })
          }
          break
        case 'http-req':
        case 'http-body':
        case 'ws-open':
        case 'ws-msg':
        case 'ws-close':
          // 预览的流量帧（已过第二道闸）：只连 127.0.0.1:<登记的端口>；每帧再按记录里的共享人判一次（connector/preview.ts）
          preview.stream(msg)
          break
        case 'quick':
          // 随手 AI 本地通道（已过第二道闸：agent 范围）。受限会话里跑一次，文本增量 quick-delta，结束 res / err
          quick.start(msg)
          break
        case 'quick-cancel':
          // 非驱动帧：只让机器停下来（同 cancel），不判 actor
          if (typeof msg.rid === 'string') quick.cancel(msg.rid)
          break
        case 'prompt':
          log(`指令 prompt agent=${msg.agent} session=${msg.sessionId} run=${msg.runId} blocks=${msg.blocks.length}`)
          void (async () => {
            // 同一个 runId 已经在跑就别再 prompt 一次：后一次会把前一次的 seq 冲掉。
            if (!flight.begin({ runId: msg.runId, agent: msg.agent, sessionId: msg.sessionId, rid: msg.rid })) {
              log(`忽略重复 prompt runId=${msg.runId}`)
              return
            }
            // 直接写：这个请求就是在飞 prompt，rememberRid 会因为 owner 已经是它而跳过。
            sessionRid.set(msg.sessionId, msg.rid)
            promptActors.set(msg.runId, msg.actor)
            let off = (): void => {}
            try {
              const adapter = ensureAdapter(msg.agent)
              // 轮次监听只转发轮次事件（text / thought / tool / usage / info …）：会话级事件归常驻监听。
              // 事件按 sessionId 归属（同一进程可能同时跑多个会话）。
              // rid 用这一轮 prompt 自己的，不读 sessionRid——后者会被后来的请求盯上。
              off = adapter.on((ev: AgentEvent) => {
                if (isSessionEvent(ev)) return
                const sid = 'sessionId' in ev ? ev.sessionId : undefined
                if (sid && sid !== msg.sessionId) return
                flight.push(msg.runId, ev)
              })
              const res = await adapter.prompt(msg.sessionId, msg.blocks)
              log(`prompt 结束 stopReason=${res.stopReason}`)
              flight.finish(msg.runId, {
                t: 'end',
                stopReason: res.stopReason,
                ...(res.usage ? { usage: res.usage } : {}),
              })
            } catch (err) {
              const message = errorText(err)
              log(`prompt 失败 ${message}`)
              flight.finish(msg.runId, { t: 'err', message })
            } finally {
              off()
              promptActors.delete(msg.runId)
            }
          })()
          break
        case 'grant-revoked': {
          // 非驱动帧，只会减少权限：从本地名单删掉此人并取消他的在飞 prompt。只读 userId，帧里别的字段都不理，
          // 本地名单永远不会因为中心的帧多出一个人。对机器主人的收回无效（主人不靠名单）
          if (typeof msg.userId !== 'string' || !msg.userId) break
          if (readConnectorConfig(tokenFile)?.ownerId === msg.userId) {
            log(`忽略对机器主人的收回（userId=${msg.userId}）`)
            break
          }
          const removed = removeLocalGrants(tokenFile, { userId: msg.userId })
          log(`授权已收回 userId=${msg.userId}（本机名单删除 ${removed} 条）`)
          pty?.closeActor(msg.userId) // 他在这台机器上开的终端当场关掉
          preview.closeActor(msg.userId) // 他共享的预览当场撤掉
          quick.cancelActor(msg.userId) // 他在飞的随手 AI 当场中止
          for (const [runId, actor] of promptActors) {
            const running = actor === msg.userId ? flight.running(runId) : undefined
            if (running) adapters.get(running.agent)?.cancel(running.sessionId)
          }
          break
        }
        case 'access-reduced':
          // 非驱动帧，只会减少权限：此人 machine 范围的使用权没了（换成了只有 agent 的新授权）→ 关他的全部终端。
          // 不动本地名单（新授权的本地条目是刚写进去的）；对机器主人无效（主人不靠授权）
          if (typeof msg.userId !== 'string' || !msg.userId || msg.scope !== 'machine') break
          if (readConnectorConfig(tokenFile)?.ownerId === msg.userId) break
          pty?.closeActor(msg.userId)
          preview.closeActor(msg.userId)
          break
        case 'kill-cmd':
          // 非驱动帧：停止 agent 在 ACP 终端里跑的一条命令。只让机器停下来，不判 actor；会话对不上的由适配器忽略
          if (typeof msg.agent === 'string' && typeof msg.sessionId === 'string' && typeof msg.terminalId === 'string') {
            adapters.get(msg.agent)?.killCommand(msg.sessionId, msg.terminalId)
          }
          break
        case 'cancel':
          if (msg.runId) {
            // 按回合取消。终态已经产生的不能再 cancel 会话（结果还在缓冲里，等 resume 带走）。
            const running = flight.running(msg.runId)
            if (running) adapters.get(running.agent)?.cancel(running.sessionId)
          } else {
            adapters.get(msg.agent)?.cancel(msg.sessionId)
          }
          break
        case 'config':
          log(`指令 config agent=${msg.agent} session=${msg.sessionId} ${msg.configId}=${msg.value}`)
          void (async () => {
            try {
              const configOptions = await ensureAdapter(msg.agent).setConfigOption(
                msg.sessionId,
                msg.configId,
                msg.value,
              )
              // 不要动 sessionRid：它属于「正在跑的那个请求」，改配置可能与在飞 prompt 同会话，
              // 覆盖后 prompt 的流式事件会被路由到这个已结束的 rid 上（hub 直接丢弃 → 回复消失）
              send({ t: 'res', rid: msg.rid, configOptions })
            } catch (err) {
              send({ t: 'err', rid: msg.rid, message: errorText(err) })
            }
          })()
          break
        case 'permission':
          // 只记选项不记 content：提问的答案里可能有密码类输入
          log(`审批应答 agent=${msg.agent} requestId=${msg.requestId} option=${String(msg.optionId)}`)
          adapters.get(msg.agent)?.respondPermission(msg.requestId, msg.optionId, msg.content)
          break
        case 'bye':
          ws.close()
          break
        default:
          break
      }
    })

    ws.on('close', (code, reason) => {
      // socket 断了不是这一轮的结果，这里不 cancel。agent 继续跑，事件留在 inflight，
      // 下一次 welcome 再决定重放还是取消。
      if (current === ws) {
        flight.onDisconnect()
        pty?.onDisconnect() // 中心没了 = 终端没有订阅者了（输出留在回放缓冲里，重连后 attach 补齐）
        preview.reset() // 中心没了 = 在飞的预览请求没有人要了；登记也清掉，重连后中心会再登记
      }
      // 收尾路径（SIGINT/SIGTERM/abort）：进程该退出了，不许再重连
      if (stopping) return
      // 只有当前这条断了才重连：已经被取代的旧连接晚到的 close 再触发一次重连，会多出一条连接把当前的顶掉
      if (current !== ws) return
      if (code === CONNECTOR_REVOKED_CODE) {
        // 被撤销/换掉：这不是网络抖动，重连只会被反复拒绝；干净退出（顶层 await 悬空会让 node 以 13 退出）
        log(`连接被中心拒绝（${code} ${reason.toString() || 'token 无效或已撤销'}）；请执行 start --repair 重新配对`)
        shutdown?.()
        return
      }
      log(`连接断开（${code}），${Math.round(backoff / 1000)}s 后重连`)
      // 重连定时器不能 unref：中心重启 / 网络抖动时它往往是进程里唯一还活着的句柄，unref 掉 Node 会立刻退出
      // （顶层 await 悬空，code 13，connector 再也不会重连）。退出只走 shutdown()（SIGINT/SIGTERM）与 4403 两条路。
      setTimeout(() => {
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
        connect()
      }, backoff)
    })

    ws.on('error', (err) => log(`连接错误：${err.message}`))
  }

  connect()

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (stopping) return
      stopping = true
      current?.close()
      for (const adapter of adapters.values()) adapter.kill()
      pty?.dispose()
      preview.dispose()
      quick.dispose()
      // 进程信号监听随收尾摘掉（进程内多次起停 connector 的宿主 / 测试里不会越攒越多）
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    shutdown = stop
    options.signal?.addEventListener('abort', stop, { once: true })
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
