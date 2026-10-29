// ---------- AgentManager:页面级 agent 会话生命周期 ----------
//   - 页面互斥:同文档一个 agent 生成中,第二个 continue 拒绝(BusyError → 409)
//   - 适配器进程复用,闲置 10min 回收(回收 / server 重启后按需 session/load)
//   - 审批桥:待批审批归会话镜像(session-mirror.ts)→ SSE 广播 → POST permission(agentId + requestId)→ 应答 agent。
//     没有超时,只有答 / 停止该会话 / 会话被换掉 / 进程退出 / connector 终态断开才结束
// 一轮生成在 turn.ts，会话配置 / 预备在 session-config.ts，落库在 session-store.ts，类型与错误类在
// manager-types.ts；它们需要的 manager 状态经 host() 交出去（同 remote-run.ts 的 remoteHost）。

import * as Y from 'yjs'
import type { Pool } from 'pg'
import { loadDocFromDb, pageAccess, type DocWriter } from '../collab.js'
import { inheritedAttrs, userMessageElement } from './queue-message.js'
import { SendQueue } from './send-queue.js'
import { memoryBlockOfPage } from '../memories.js'
import { AcpAgent } from './acp.js'
import { listDirs, type DirListing } from './dirs.js'
import { lastUserMessageAttrs, mentionChain, redoTarget } from './doc.js'
import type { Conn, ConnectorHub, InflightPrompt, ResumePlan } from './hub.js'
import type { AgentAdapter, AgentConfig, AgentEvent, AskContent, ConfigOption, PermissionEvent } from './types.js'
import { IdleRecycler } from './idle.js'
import { mintPageToken, revokePageTokens, revokePageTokensOf, httpBaseFor, type GrantCtx, type PageTool } from '../page-read.js'
import type { ToolHost } from '../routes/ramet-tools.js'
import { approvalPreview } from './approval-detail.js'
import { askSummary, checkAskAnswer } from './ask-form.js'
import { OwnApprovals } from './own-approvals.js'
import { runSubAgent, type SubRunHost } from './sub-run.js'
import { TeamExec, type TeamRoundHost } from './team.js'
import { TeamPlanError, TeamPlans } from './team-plan.js'
import { TeamToolError } from './team.js'
import { agentPosture, authorize, ForbiddenError } from './posture.js'
import { assertCanUse, assertLocalOwner, inConnectorSpace, LOCAL_MACHINE, MachinePass, usableConnectors, type MachineScope } from './machine-access.js'
import { recordMachineUse } from './machine-grants.js'
import { RemoteAgent } from './remote-agent.js'
import { createRunState, type RunState } from './run-state.js'
import {
  planRemoteResume,
  requestCancel,
  requestCancelByPage,
  terminalStatus,
  type RemoteRunHost,
} from './remote-run.js'
import {
  AgentOfflineError,
  BadAnswerError,
  BusyError,
  NoUserMessageError,
  REMOTE_PREFIX,
  ReplyNotFoundError,
  UnknownAgentError,
  UnknownApprovalError,
  parseRemoteId,
  type ActiveRun,
  type AdapterEntry,
  type CatalogAgent,
  type ManagerHost,
  type PageState,
  type PendingApproval,
  type ResolvedAgent,
  type RunTarget,
} from './manager-types.js'
import { prepareSession, restoreMsgBefore, setSessionConfig } from './session-config.js'
import { SessionMirror } from './session-mirror.js'
import { effectiveCwd, loadChoice, loadToolProfile, persistConfigs, persistSession, saveChoice, saveToolProfile, saveWorkspace } from './session-store.js'
import type { ToolProfile } from './tool-profile.js'
import { runTurn } from './turn.js'

/** 关停时给 adapter 回应取消的时间（取消也带用量）；过了就不等它，直接收尾 */
const SHUTDOWN_GRACE_MS = 1500
/** 列目录是短请求：旧 connector 不认 `ls` 时不能挂到 hub 默认的 120s */
const LS_TIMEOUT_MS = 10_000

/** 适配器池里的原始条目，不对外。外面拿到的只有 view() 签出的操作人视图（AdapterEntry），
 *  原始适配器只在这个文件里被 kill / 取消 / 听事件 */
type PoolEntry = {
  shared: AcpAgent | RemoteAgent
  loaded: Set<string>
  key: string
  pageTokens: Map<string, string>
}

/** connector 上的 agent 的执行目标（含主人）：catalog / resolve / claimedAgent 同一口径 */
function remoteOf(conn: Conn, agentId: string): NonNullable<ResolvedAgent['remote']> {
  return { connectorId: conn.id, agentId, defaultCwd: conn.defaultCwd, ownerId: conn.ownerId }
}

/** 审批留痕的内容：批准了什么（审批标题与命令预览、选了哪个选项） */
function approvalDetail(
  approval: PermissionEvent,
  body: { agentId: string; requestId: string; optionId: string | null; content?: AskContent },
): Record<string, unknown> {
  const { command } = approvalPreview(approval.toolCall)
  return {
    agentId: body.agentId,
    requestId: body.requestId,
    optionId: body.optionId,
    optionName: approval.options.find((o) => o.optionId === body.optionId)?.name ?? null,
    title: approval.title,
    ...(command ? { command } : {}),
    // 提问：留答案摘要（密码类已打码），不留原始 content
    ...(approval.form ? { answer: askSummary(approval.form, body.optionId, body.content) } : {}),
  }
}

export class AgentManager {
  private pages = new Map<string, PageState>()
  /** runId → 在飞回合。页面槽之外还要这份：认领时按 hello 的 runId 找，不靠扫页面。 */
  private runIndex = new Map<string, RunState>()
  private adapters = new Map<string, PoolEntry>()
  /** 会话级状态（命令 / 配置 / 待批审批）按「页面 + agent」的镜像，中心只从这里读这些状态。
   *  宿主回调都是箭头函数，到用时才读 this.*（构造完成之后），所以可以放在字段初始化里（同 idle） */
  private mirror = new SessionMirror({
    broadcast: (pageId, ev) => this.broadcast(pageId, ev),
    persist: (pageId, agentId, values) => void persistConfigs(this.pool, pageId, agentId, values).catch(() => undefined),
    // 覆盖的寿命 = 回合在 runIndex 里的寿命，到 vacate 才结束，包括轮末还原（closeRun 先置 closed 再还原，
    // 还原产生的 config 事件也是临时的，落库会把页面从没设过的 model 钉成会话默认值）。
    // 扫 runIndex 而不是页面槽：认领回来却没抢到槽的回合也在覆盖期里
    overridden: (pageId, agentId, configId) => {
      for (const run of this.runIndex.values()) {
        if (run.pageId === pageId && run.adapterKey === agentId && configId in run.msgBefore) return true
      }
      return false
    },
    fold: (pageId, agentId, ev) => {
      const run = this.pages.get(pageId)?.run
      if (run?.adapterKey === agentId && run.sessionId === ev.sessionId) run.record?.permission(ev)
    },
  })
  /** Ramet 自己的审批（知识中枢的删除等）：不经 ACP 会话，由这里持有、广播、应答（own-approvals.ts） */
  private ownApprovals = new OwnApprovals((pageId, ev) => this.broadcast(pageId, ev))
  /** 各页各 agent 最近一次广播的生效工作区（pageId → agentId → cwd）。cwd 只在 prepare / 改绑时广播，
   *  而 prepare 常赶在 SSE 连上之前（刷新时两者同时发出）：不留一份给新订阅者回放，路径 chip 会回落成
   *  「默认目录」，像是设过的目录被忘了 */
  private cwds = new Map<string, Map<string, string>>()
  /** 页面上的运行被停止时要一并取消的东西（被叫 agent 的子运行）：pageId → 取消函数集 */
  private stopHandlers = new Map<string, Set<() => void>>()
  /** 带队的执行轮：runId → 调度组员的 TeamExec（send_back 端点按它找；轮末摘掉） */
  private teams = new Map<string, TeamExec>()
  /** 带队计划（落库、视图、改计划 / 取消 / 开工守卫）。依赖 this.pool，所以在构造函数体里建 */
  readonly plans: TeamPlans
  /** 运行中排队发送（send-queue.ts）：路由经它入队 / 撤回 / 立即发送；一轮结束时 release 调它派发 */
  readonly queue: SendQueue
  /** 在飞的 run_agent 子运行（不在 runIndex 里）：授权被收回时按「机器 + 人」当场取消 */
  private subRuns = new Set<{ connectorId: string; userId: string; cancel: () => void }>()
  /** 闲置回收（判据与 connector 同一份：busy = 在飞 prompt 或有待批审批）。远端 busy 时不 kill，
   *  那会摘掉事件监听、把在飞回复静默截断（见 idle.ts 与 AgentAdapter.busy） */
  private idle = new IdleRecycler(
    (key) => this.adapters.get(key)?.shared.busy === true,
    (key) => this.dropAdapter(key),
  )

  constructor(
    private pool: Pool,
    private opts: {
      agents: AgentConfig[]
      hub: ConnectorHub
      getLiveDoc: (docName: string) => Y.Doc | undefined
      /** 机器人客户端连自身 ws 的端口(startServer resolve 后注入) */
      wsPort: () => number
      /** 中心自己的 HTTP 基址（AI 侧 MCP 进程按凭证打回中心用；见 page-read.ts） */
      httpBase: () => string
      /** 进程内密钥：升级 /collab 时对得上才把这批增量记成 AI 写的 */
      botSecret: string
      /** 归档出新过程页后广播树变更(客户端据此重拉页面列表) */
      notifyPagesChanged?: () => void
      /** 收件箱相关的状态变了（审批出现 / 结束、回合开始 / 结束）：index.ts 去抖后经 control:global 广播 'inbox'（只是「去重拉」，不带内容） */
      notifyInbox?: () => void
      /** 以某人身份写文档（hocuspocus 直连会话，collab.ts 的 createDocWriter）：排队消息派发时写用户消息。测试桩可以不给 */
      writeDoc?: DocWriter
    },
  ) {
    this.queue = new SendQueue(pool, {
      running: (pageId) => this.running(pageId),
      stop: (pageId) => this.stop(pageId),
      writable: async (pageId, user) => {
        const role = await pageAccess(pool, pageId, user)
        return role !== null && role !== 'viewer'
      },
      usable: async (user, agent) => {
        if (!agent) return null
        try {
          return (await this.resolve(agent, user)) ? null : '这条消息指定的 agent 当前不可用'
        } catch (err) {
          // 机器使用权不够（assertLocalOwner / assertCanUse 抛 ForbiddenError）
          return err instanceof Error ? err.message : String(err)
        }
      },
      writeMessage: async (pageId, user, text, images, agent) => {
        if (!this.opts.writeDoc) throw new Error('没有文档写入通道')
        await this.opts.writeDoc(
          `page:${pageId}`,
          user,
          (doc, origin) =>
            doc.transact(() => {
              const frag = doc.getXmlFragment('prosemirror')
              frag.insert(frag.length, [userMessageElement(text, images, { ...inheritedAttrs(frag, agent), author: user.id })])
            }, origin),
          'user',
        )
      },
      start: async (pageId, user, agent) => {
        if (this.running(pageId)) return 'busy'
        let target: RunTarget
        try {
          target = await this.resolveRun(pageId, { agent }, user)
        } catch (err) {
          return { reason: err instanceof UnknownAgentError ? '这条消息指定的 agent 当前不可用' : err instanceof Error ? err.message : String(err) }
        }
        if (this.running(pageId)) return 'busy'
        // 不等这一轮跑完；没有浏览器 cookie（派发不是某个请求）：机器人客户端用临时会话（openBotAsUser）
        void this.continue(pageId, target, user, null).catch(() => undefined)
        return 'ok'
      },
      broadcast: (pageId, ev) => this.broadcast(pageId, ev),
    })
    this.plans = new TeamPlans({
      pool,
      resolve: (agentId, user) => this.resolve(agentId, user),
      catalog: async (user) => (await this.catalog(user)).map((a) => ({ id: a.id, label: a.label })),
      listDirs: (pageId, agentId, path, user) => this.listWorkspaceDirs(pageId, agentId, path, user),
      broadcast: (pageId, ev) => this.broadcast(pageId, ev),
      liveTeam: (planId) => {
        for (const run of this.runIndex.values()) {
          if (run.team?.kind === 'exec' && run.team.planId === planId && !run.closed) return run.record?.state.team
        }
        return undefined
      },
    })
  }

  /** 本机直 spawn 的 agent（不含 connector 的） */
  agents(): AgentConfig[] {
    return this.opts.agents
  }

  /** 建立 / 加载会话时交给 AI 的能力，本地与 connector 共用：中心签发绑定该用户的
   *  短期凭证，AI 侧 MCP 进程按它回打中心的读行端点。已签过的凭证复用（同一用户重复 prepare / 续聊不再签新的）。
   *  这里只给凭证和中心地址；命令（node 与脚本路径）由拉起 AI 的进程自己拼
   *  （page-read.ts 的 pageToolServer），中心容器里的路径在 connector 那台机器上不存在。 */
  private pageReadTools(entry: AdapterEntry, user: { id: string; role: string }, agent: ResolvedAgent, pageId: string, profile: ToolProfile): PageTool[] {
    // 工具档位（tool-profile.ts）：无档不挂 MCP，精简档的凭证带档位（中心端点据此拦），不能叫别的 agent
    if (profile === 'none') return []
    const key = `${user.id}|${pageId}|${profile}`
    let token = entry.pageTokens.get(key)
    if (!token) {
      // 完整档的页面会话能叫别的 agent（run_agent），凭证绑着这一页与这个 agent
      token = mintPageToken(user.id, entry.key, profile === 'minimal'
        ? { pageId, agentId: agent.id, canDispatch: false, profile: 'minimal' }
        : { pageId, agentId: agent.id, canDispatch: true })
      entry.pageTokens.set(key, token)
    }
    return [this.toolGrant(agent, token)]
  }

  /** 凭证 + 中心地址，交给执行端的 PageTool。本机 agent 与中心同机，缺省可回环直连；connector 在别的机器上，
   *  没配 RAMET_PUBLIC_URL 就直接报错（回环地址对它是它自己） */
  private toolGrant(agent: ResolvedAgent, token: string): PageTool {
    const url = httpBaseFor(process.env.RAMET_PUBLIC_URL, agent.remote ? undefined : this.opts.httpBase())
    return { mcp: { url, token } }
  }

  /** run_agent 与带队的组员共用的子运行宿主（sub-run.ts） */
  private subRunHost(): SubRunHost {
    return {
      resolve: (agentId, user) => this.resolve(agentId, user),
      ensureAdapter: (agent) => this.ensureAdapter(agent),
      calleeTools: (entry, user, agent, pageId) => [
        // 被叫会话绑调用方的页面、不能再叫人（只嵌一层）；每个子运行一把新凭证，随适配器作废
        this.toolGrant(agent, mintPageToken(user.id, entry.key, { pageId, agentId: agent.id, canDispatch: false })),
      ],
      cwd: (pageId, agent) => effectiveCwd(this.pool, pageId, agent),
      memory: (pageId) => memoryBlockOfPage(this.pool, pageId),
      mirror: this.mirror,
      attachStep: (pageId, ev) => this.pages.get(pageId)?.run?.record?.tool(ev),
      onPageStop: (pageId, fn) => {
        let set = this.stopHandlers.get(pageId)
        if (!set) this.stopHandlers.set(pageId, (set = new Set()))
        set.add(fn)
        return () => {
          set.delete(fn)
          if (set.size === 0) this.stopHandlers.delete(pageId)
        }
      },
      track: (connectorId, userId, cancel) => {
        const tracked = { connectorId, userId, cancel }
        this.subRuns.add(tracked)
        return () => void this.subRuns.delete(tracked)
      },
      recordUse: (agent, userId, pageId, detail) => recordMachineUse(this.pool, agent, userId, 'run', pageId, detail),
    }
  }

  /** 带队的组长凭证（见 ManagerHost.teamTools） */
  private teamTools(entry: AdapterEntry, user: { id: string; role: string }, agent: ResolvedAgent, pageId: string, round: NonNullable<GrantCtx['team']>): PageTool[] {
    return [this.toolGrant(agent, mintPageToken(user.id, entry.key, { pageId, agentId: agent.id, canDispatch: false, team: round }))]
  }

  /** 这一轮带队的组长还在飞、且确实是这个人在这一页发起的（凭证只认这样的一轮；轮次结束时凭证已撤销，这里是第二道） */
  private teamRun(team: NonNullable<GrantCtx['team']>, userId: string, pageId: string | null): RunState | null {
    const run = this.runIndex.get(team.runId)
    return run && !run.closed && !run.cancelled && run.userId === userId && run.pageId === pageId && run.team?.kind === team.kind ? run : null
  }

  /** Ramet 工具的 HTTP 端点（routes/ramet-tools.ts）要的能力：自己的审批、可叫的 agent、叫 agent 执行、带队组长的两个工具 */
  toolHost(): ToolHost {
    const sub = this.subRunHost()
    return {
      approvals: this.ownApprovals,
      agentsFor: async (user, callerAgentId) =>
        (await this.catalog(user)).filter((a) => a.id !== callerAgentId).map((a) => ({ id: a.id, label: a.label })),
      runAgent: (ctx, callee, task, signal) => runSubAgent(sub, ctx, callee, task, signal),
      team: {
        // 凭证带的这一轮必须还在飞、阶段对得上，否则不列（旧的 MCP 进程再问也拿不到）
        round: async (team, user, pageId) => {
          const run = this.teamRun(team, user.id, pageId)
          if (!run) return null
          if (team.kind === 'plan') return { tool: 'submit_plan', candidates: await this.plans.candidates(user) }
          return { tool: 'send_back', tasks: this.teams.get(run.runId)?.tasks() ?? [] }
        },
        submitPlan: async (team, user, pageId, raw) => {
          const run = this.teamRun(team, user.id, pageId)
          if (!run || team.kind !== 'plan') throw new TeamPlanError(409, 'round over', '这一轮已经结束了，提交不了计划')
          return this.plans.submit(run, raw)
        },
        sendBack: async (team, user, pageId, taskId, feedback, signal) => {
          const run = this.teamRun(team, user.id, pageId)
          const exec = run && team.kind === 'exec' ? this.teams.get(run.runId) : undefined
          if (!exec) throw new TeamToolError('这一轮已经结束了，不能再打回')
          return exec.sendBack(taskId, feedback, signal)
        },
      },
    }
  }

  /** 带队的宿主能力（turn.ts 的 host.team）：计划、子运行宿主、登记执行轮的 TeamExec */
  private teamHost(): TeamRoundHost {
    return {
      plans: this.plans,
      sub: this.subRunHost(),
      track: (runId, exec) => {
        this.teams.set(runId, exec)
        return () => void this.teams.delete(runId)
      },
    }
  }

  /** 开工预检（POST /continue 带 team，202 之前同步判）：失败抛 TeamPlanError，路由转成干净的 4xx。见 team-plan.ts 的 precheckStart */
  async precheckTeamStart(pageId: string, planId: string, user: { id: string; role: string }, target: RunTarget): Promise<void> {
    // 带队要的工具只有完整档才有（tool-profile.ts），计划出完后换了档就不让开工
    if ((await loadToolProfile(this.pool, pageId)) !== 'full') {
      throw new TeamPlanError(409, 'tools_profile', '当前工具档位不支持带队，切到「完整」再开工')
    }
    return this.plans.precheckStart(pageId, planId, user, target.agent.id)
  }

  /** 可选 agent 清单 = 该用户能用的：本机 agents（仅 admin，且只有 RAMET_LOCAL_AGENTS=1 才存在）+ 该用户所在空间里
   * 在线且他能用（接入人或有 agent 授权，machine-access.ts）的 connector 的 agents。
   * 别人的机器、没授权给你的机器一律不出现（同空间、空间 owner、全局 admin 都一样）。
   * 离线 connector 不出现在这里（它的 agent 现在调不动），但设置页能看列表。
   * 每项带 posture（是否机器主人 / mode 能不能改 / 哪些值是「跳过全部确认」），前端据此禁用 / 隐藏。 */
  async catalog(user: { id: string; role: string }): Promise<CatalogAgent[]> {
    const out: CatalogAgent[] = []
    if (user.role === 'admin') {
      for (const a of this.opts.agents) {
        out.push({ id: a.id, label: a.label, logo: a.logo ?? null, posture: agentPosture(user, { local: a }), machine: false })
      }
    }
    const { rows } = await this.pool.query<{ space_id: string }>(
      'SELECT space_id FROM space_members WHERE user_id = $1',
      [user.id],
    )
    const usable = await usableConnectors(this.pool, user.id, 'agent')
    const machines = await usableConnectors(this.pool, user.id, 'machine')
    for (const spaceId of new Set(rows.map((r) => r.space_id))) {
      for (const conn of this.opts.hub.onlineOfSpace(spaceId)) {
        if (!usable.has(conn.id)) continue
        for (const a of conn.agents) {
          out.push({
            id: `${REMOTE_PREFIX}${conn.id}:${a.id}`,
            label: `${conn.name} · ${a.label}`,
            logo: a.logo ?? null,
            posture: agentPosture(user, { remote: remoteOf(conn, a.id) }),
            machine: machines.has(conn.id),
          })
        }
      }
    }
    return out
  }

  /** id → 执行目标，同时是机器使用权的唯一判定点：造出 ResolvedAgent 的只有这里，它带着 assertCanUse 签出的凭据。
   *  - 不存在 / 离线 / 调用者看不到这台机器（不在 connector 所在空间）返回 null（调用方当「未知 agent」）
   *  - 看得到但不是接入人、也没有有效的 agent 授权，抛 ForbiddenError（403，文案带主人名）
   *  授权判定在「是否在线」之前，离线不能成为绕过判定的缝；空间成员资格对所有人一视同仁（admin 没有特权）。 */
  async resolve(agentId: string, user: { id: string; role: string }): Promise<ResolvedAgent | null> {
    const local = this.opts.agents.find((a) => a.id === agentId)
    if (local) return { id: local.id, local, pass: assertLocalOwner(user, 'agent') }
    const parsed = parseRemoteId(agentId)
    if (!parsed) return null
    if (!(await inConnectorSpace(this.pool, user.id, parsed.connectorId))) return null
    const pass = await assertCanUse(this.pool, user, parsed.connectorId, 'agent')
    const conn = this.opts.hub.get(parsed.connectorId)
    if (!conn || !conn.agents.some((a) => a.id === parsed.agentId)) return null
    return { id: agentId, remote: remoteOf(conn, parsed.agentId), pass }
  }

  /** 收件箱的数据源（只读快照）：各页面上待批的审批（ACP 会话的 + Ramet 自己的）。谁看得到由 inbox.ts 判，这里不判 */
  pendingApprovals(): PendingApproval[] {
    return [
      ...this.mirror.allApprovals().map((a) => ({ ...a, own: false })),
      ...this.ownApprovals.list().map((a) => ({ ...a, own: true })),
    ]
  }

  /** 收件箱的数据源（只读快照）：在飞的回合（已开始收尾的不算） */
  activeRuns(): ActiveRun[] {
    return [...this.runIndex.values()]
      .filter((run) => !run.closed)
      .map((run) => ({ runId: run.runId, pageId: run.pageId, agentId: run.adapterKey, userId: run.userId, startedAt: run.startedAt }))
  }

  running(pageId: string): boolean {
    return this.pages.get(pageId)?.run != null
  }

  /** SSE 订阅:新订阅者先把当前状态同步过去(生成中 / 空闲 + 已收集的步骤),再接增量。
   * 广播无 replay,新连上来的客户端只能看到这之后的事件,过程面板离开 / 刷新后要靠这份快照重建,
   * 所以必须由状态所有者(这里)一次发全。
   * 会话级状态（每个已绑定 agent 的 commands / config / 待批）同理，由会话镜像回放 */
  subscribe(pageId: string, cb: (ev: AgentEvent) => void): () => void {
    const page = this.pages.get(pageId) ?? { subscribers: new Set(), run: null }
    this.pages.set(pageId, page)
    page.subscribers.add(cb)
    const run = page.run
    // 重放还没结束时不先发 running：快照还是空的，前端会把已有 live run 清掉，闪一帧「已中断」。
    // onResumed 里先发完整快照、再发 running。
    if (run?.record && !run.replay) {
      cb(run.record.snapshot(run.adapterKey))
      cb({ type: 'status', state: 'running' })
    } else if (!run?.replay) {
      cb(run ? { type: 'status', state: 'running' } : { type: 'status', state: 'idle' })
    }
    this.mirror.replay(pageId, cb)
    this.ownApprovals.replay(pageId, cb)
    // 排队区：库里查，晚一拍到（排队区不影响别的首帧）
    void this.queue.list(pageId).then((q) => page.subscribers.has(cb) && cb({ type: 'queue', ...q }), () => undefined)
    for (const [agentId, cwd] of this.cwds.get(pageId) ?? []) cb({ type: 'cwd', agentId, cwd })
    return () => page.subscribers.delete(cb)
  }

  /** 服务关停。本机 agent 跟进程一起死，取消并收尾。
   *  远端回合的寿命在 connector 上：不 cancel、不 finalize、不删 open_runs。 */
  async shutdown(timeoutMs: number): Promise<void> {
    const active = [...this.runIndex.values()]
    if (active.length === 0) return
    for (const run of active) {
      if (run.remote) {
        run.hold = true
        for (const fn of [...(this.stopHandlers.get(run.pageId) ?? [])]) fn() // 带队的组员是中心驱动的，进程要退了就一并取消
        continue
      }
      run.shutdown = true
      this.stop(run.pageId)
    }
    const finishing = active.filter((run) => !run.hold)
    if (finishing.length === 0) return
    const all = Promise.all(finishing.map((run) => run.finished.promise))
    const wait = (ms: number): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, ms)
      return promise
    }
    await Promise.race([all, wait(Math.min(SHUTDOWN_GRACE_MS, timeoutMs))])
    for (const run of finishing) run.abort.resolve({ stopReason: 'cancelled' })
    await Promise.race([all, wait(timeoutMs)])
  }

  /** 应答一条审批（POST /permission）。requestId 只在单个进程内唯一（两个本机 agent 都会有 `perm-0`），
   *  所以按「页面 + agentId + requestId」找镜像里的那条。
   *  答审批 = 让那台机器去做（或不做）一件事，所以先过机器使用权（resolve，不是接入人也无授权抛 ForbiddenError 403），
   *  再看审批在不在。
   *  找不到抛 UnknownApprovalError(404)；agent 所在的机器不在线抛 AgentOfflineError(409)，审批留着可以再答；
   *  选项会把会话送进「跳过全部确认」而用户不是机器主人抛 ForbiddenError(403)。
   *  移除只由执行端的 permission_resolved 驱动，这里不动镜像。
   *  提问（带 form 的审批）：optionId 只能是 accept / decline，accept 的 content 按表单校验（不合抛 BadAnswerError 400）；
   *  送达后把「问题 → 答：…」写进那一步工具调用的 activity（运行条 / 过程页 / 下一轮的过程摘要都显示它） */
  async answerPermission(
    pageId: string,
    body: { agentId: string; requestId: string; optionId: string | null; content?: unknown },
    user: { id: string; role: string },
  ): Promise<void> {
    // Ramet 自己的审批（知识中枢的删除等）：这里持有，不经 ACP 会话，不碰任何人的机器
    if (this.ownApprovals.answer(pageId, body.agentId, body.requestId, body.optionId, user.id)) return
    const agent = await this.resolve(body.agentId, user)
    const approval = this.mirror.approval(pageId, body.agentId, body.requestId)
    if (!approval) throw new UnknownApprovalError()
    let content: AskContent | undefined
    if (approval.form) {
      if (body.optionId !== 'accept' && body.optionId !== 'decline') throw new BadAnswerError('提问只能提交或跳过')
      if (body.optionId === 'accept') {
        const checked = checkAskAnswer(approval.form, body.content)
        if (!checked.ok) throw new BadAnswerError(checked.error)
        content = checked.content
      }
    }
    const pooled = this.adapters.get(body.agentId)
    if (!agent || !pooled) throw new AgentOfflineError()
    authorize(user, agent, { kind: 'answer', optionId: body.optionId })
    // 非机器主人的批准要留痕（批准了什么）；写不进审计就不放行
    const answer = { agentId: body.agentId, requestId: body.requestId, optionId: body.optionId, ...(content ? { content } : {}) }
    await recordMachineUse(this.pool, agent, user.id, 'answer', pageId, approvalDetail(approval, answer))
    if (!this.view(pooled, agent.pass).adapter.respondPermission(body.requestId, body.optionId, content)) throw new AgentOfflineError()
    const toolCallId = approval.form?.toolCallId
    if (approval.form && toolCallId) {
      // 只写页面上正在跑的这一轮（同 fold）：组员会话的提问不在这里的 RunRecord 里
      const run = this.pages.get(pageId)?.run
      if (run?.adapterKey === body.agentId && run.sessionId === approval.sessionId) {
        run.record?.tool({ type: 'tool', id: toolCallId, activity: askSummary(approval.form, body.optionId, content) })
      }
    }
  }

  stop(pageId: string): void {
    // Ramet 自己挂着的审批按拒绝结束；被叫 agent 的子运行一并取消
    this.ownApprovals.cancelPage(pageId)
    for (const fn of [...(this.stopHandlers.get(pageId) ?? [])]) fn()
    const run = this.pages.get(pageId)?.run
    if (!run) {
      // 重启后、hello 认领前页面上没有内存里的 run。停止记在绑定行上，认领时放进 drop。
      void requestCancelByPage(this.pool, pageId).catch(() => undefined)
      return
    }
    run.cancelled = true
    if (run.remote) void requestCancel(this.pool, run.runId).catch(() => undefined)
    // 只取消这个会话：它的待批审批由执行端按取消应答并发 permission_resolved，镜像与前端据此清掉。
    // 同一进程上别的页面的会话（同 agent）的审批不受影响。
    // 停止不要机器使用凭据：取消只会让机器停下来、不会让它动起来（connector 侧同样不判 cancel 帧）。
    // 谁能停由路由的页面写权限决定，协作者能停掉页面上别人发起的一轮
    const entry = run.adapterKey ? this.adapters.get(run.adapterKey) : undefined
    if (run.sessionId && entry) entry.shared.cancel(run.sessionId)
  }

  /** 停止 agent 在 ACP 终端里跑的一条命令（terminal/kill）：只作用于这一页正在跑的那一轮的会话。
   *  和 stop 一样不要机器使用凭据（只会让机器停下来），谁能停由路由的页面写权限决定。
   *  false = 这一页没有在跑的一轮 / 终端不属于这个会话 / 已经退出（远端：帧没送出去） */
  killCommand(pageId: string, terminalId: string): boolean {
    const run = this.pages.get(pageId)?.run
    const entry = run?.adapterKey ? this.adapters.get(run.adapterKey) : undefined
    if (!run || run.closed || !run.sessionId || !entry) return false
    return entry.shared.killCommand(run.sessionId, terminalId)
  }

  /** 文档的正文 fragment：活文档优先，否则从库重建 */
  private async pageFragment(pageId: string): Promise<Y.XmlFragment> {
    const name = `page:${pageId}`
    const doc = this.opts.getLiveDoc(name) ?? (await loadDocFromDb(this.pool, name))
    return doc.getXmlFragment('prosemirror')
  }

  /** 本轮执行目标（前置解析）：消息 attrs > 请求体 > 目录第一个。
   *  独立成前置步骤：路由先 await 它，未知 agent 才能变成干净的 400。continue 是
   *  fire-and-forget（202 立即返回），它内部抛的错到不了客户端，会变成"点了没反应"。
   *  优先级只在这里算一次，路由不要再自己拼（两处各算必然漂移）。 */
  async resolveRun(
    pageId: string,
    body: { agent?: string },
    user: { id: string; role: string },
  ): Promise<RunTarget> {
    const msg = lastUserMessageAttrs(await this.pageFragment(pageId))
    const catalog = await this.catalog(user)
    // @ 点名：最后一条消息 @ 了几家、回复还没跑完，这一轮只跑「下一家」（按 @ 的顺序）。优先于消息 chip 与请求体，
    // 点名了谁就是谁；那一家不可用抛 UnknownAgentError，不悄悄换别家
    const mentioned = await this.nextMention(pageId)
    // attrs 指定的 agent 失效时不硬失败：connector 被撤销 / 改名后，消息里那个 id 再也
    // 解析不出来，直接 400 的话这条消息就永远发不出去且没有清除入口。
    // 指定了就用，失效了按「没指定」回落（请求体 → 目录第一个），与前端 chip 的
    // 回落规则同一口径（pickAgent）。前端也会收敛掉失效 attrs（message-chips 的 repairStaleAgent）。
    const specified = msg.agent !== ''
    const fromMsg = !mentioned && specified ? await this.resolve(msg.agent, user) : null
    const target = mentioned ?? (fromMsg ? msg.agent : body.agent || catalog[0]?.id)
    const agent = fromMsg ?? (target ? await this.resolve(target, user) : null)
    if (!agent) throw new UnknownAgentError()
    // 消息 attrs 里的 cwd / opts 属于消息 chip 选的那个 agent：这一轮换了别家（点名）就不沿用
    // （目录在另一台机器上可能不存在，config id 对别的 agent 无意义）
    const own = !mentioned || msg.agent === agent.id
    const cwd = (own && msg.cwd) || (await effectiveCwd(this.pool, pageId, agent))
    // opts 只在「指定了 agent 但那个 agent 失效」时丢弃：那些 config id 属于另一个 agent，
    // 下发给现在这个 agent 无意义。没指定 agent（或指定且有效）时照常生效。
    const opts = !own || (specified && !fromMsg && !mentioned) ? {} : msg.opts
    return { agent, cwd, opts }
  }

  /** @ 链里下一家：最后一条用户消息 @ 了几家而回复块数还不够，就是第 replied 个。
   *  链的进度就是文档本身（见 doc.ts 的 mentionChain），没有另一份状态 */
  private async nextMention(pageId: string): Promise<string | null> {
    const chain = mentionChain(await this.pageFragment(pageId))
    return chain && chain.replied < chain.agents.length ? chain.agents[chain.replied]! : null
  }

  /** 这一家成功收尾后接着跑 @ 链里的下一家（失败 / 停止不走到这里：链停住，等用户点「重试」/「继续剩下的」）。
   *  下一家的执行目标仍由 resolveRun 定（点名优先），不自动重试 */
  private async continueChain(pageId: string, user: { id: string; role: string }, cookieHeader: string | null): Promise<void> {
    try {
      if (!(await this.nextMention(pageId))) return
      await this.continue(pageId, await this.resolveRun(pageId, {}, user), user, cookieHeader)
    } catch (err) {
      this.notifyRunError(pageId, err instanceof Error ? err.message : String(err))
    }
  }

  /** 重新生成 / 重试的执行目标（POST /replies/:replyId/regenerate）：agent 取回复块自己的 `agent` 属性，
   *  cwd / opts 取它往前最近一条用户消息的（优先级同 resolveRun：消息 attrs > 页面级）。
   *  找不到回复抛 ReplyNotFoundError(404)；之前没有用户消息抛 NoUserMessageError(400)；
   *  那个 agent 已不可用抛 UnknownAgentError(400) */
  async resolveRedo(pageId: string, replyId: string, user: { id: string; role: string }): Promise<RunTarget> {
    const target = redoTarget(await this.pageFragment(pageId), replyId)
    if (!target.ok) throw target.reason === 'no-reply' ? new ReplyNotFoundError() : new NoUserMessageError()
    const agent = await this.resolve(target.agent, user)
    if (!agent) throw new UnknownAgentError()
    const { message } = target
    // opts 里是另一个 agent 的 config id 时无意义：消息指定了别的 agent 就不下发
    const opts = message.agent === '' || message.agent === agent.id ? message.opts : {}
    const cwd = message.cwd || (await effectiveCwd(this.pool, pageId, agent))
    return { agent, cwd, opts, redo: replyId }
  }

  /** 发起生成;立即返回,进度走 SSE。并发调用抛 BusyError(路由转 409) */
  async continue(
    pageId: string,
    target: RunTarget,
    user: { id: string; role: string },
    /** 发起请求的浏览器 cookie（机器人客户端用它连 /collab）；null = 不是某个请求发起的（排队派发），机器人用临时会话 */
    cookieHeader: string | null,
  ): Promise<void> {
    const page = this.pages.get(pageId) ?? { subscribers: new Set(), run: null }
    this.pages.set(pageId, page)
    if (page.run) throw new BusyError()
    const { agent, cwd, opts, redo } = target
    // 凭据属于发起这一轮的人：resolve 为 user 签的，不能拿别人的 ResolvedAgent 替他跑
    if (agent.pass.userId !== user.id) throw new ForbiddenError('机器使用凭据与发起人不一致')
    const run = createRunState({
      pageId,
      userId: user.id,
      adapterKey: agent.id,
      remote: agent.remote ? { connectorId: agent.remote.connectorId, agentId: agent.remote.agentId } : null,
      team: target.team ? { kind: 'exec', planId: target.team.planId } : null,
    })
    run.msgOpts = opts
    page.run = run
    this.runIndex.set(run.runId, run)
    this.broadcast(pageId, { type: 'status', state: 'running' })
    try {
      // 非机器主人的使用要留痕（发起 / 继续 / 重新生成 / @ 链的每一家都走这里）；写不进审计就不开跑
      await recordMachineUse(this.pool, agent, user.id, 'run', pageId, { agent: agent.id, cwd, ...(redo ? { redo } : {}), ...(target.team ? { team: target.team.planId } : {}) })
      // 带队的执行轮：draft → running 的原子翻转（并发的第二次开工 / 刚被取消 → 409，走下面的 catch）
      if (run.team?.kind === 'exec') await this.plans.begin(pageId, run.team, user)
      await runTurn(this.host(), pageId, agent, cwd, user, cookieHeader, run, redo)
    } catch (err) {
      // 失败原因必须到用户面前：status:error 只带「生成失败」这句通用文案，真正的原因
      // （connector 掉线 / agent 侧报错 / 请求超时）只有这里知道，走 error 通道，前端 RunErrorBar 读它。
      // 这条路径是 fire-and-forget（202 已回），响应体没机会说话。
      // 远端关停不是失败：占位块还要等下一个进程接，别在死掉的连接上推「生成失败」。
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[agent] ${pageId} ${message}`)
      if (!run.hold && !run.cancelled) this.notifyRunError(pageId, message, run.record?.replyId)
    } finally {
      // 带队：撤销本轮的组长凭证，执行轮把计划行收口（失败只记日志，不挡释放页面槽）
      await this.plans.endRound(run).catch((err: unknown) => console.error(`[team] 收尾失败(${pageId}): ${err instanceof Error ? err.message : String(err)}`))
      this.release(pageId, run, true)
    }
    if (run.ended) {
      await this.continueChain(pageId, user, cookieHeader)
      // 链跑完（或没有链）才轮到排队：链接着开了下一家时页面在忙，排队等那一家结束（它的 continue 会再调这里）
      this.queue.onRunEnd(pageId, 'end')
    }
  }

  /** 把一条失败原因推给订阅者（SSE）。给 fire-and-forget 的路径用：它们已经 202 回了，
   *  错误没法走响应体，不推就是「点了没反应」。有 replyId 的挂在那块回复的失败条上，没有的进运行错误条。 */
  notifyRunError(pageId: string, message: string, replyId?: string): void {
    this.broadcast(pageId, replyId ? { type: 'error', message, replyId } : { type: 'error', message })
  }

  private broadcast(pageId: string, ev: AgentEvent): void {
    // 没人订阅也要记，见 cwds 字段
    if (ev.type === 'cwd') {
      let byAgent = this.cwds.get(pageId)
      if (!byAgent) this.cwds.set(pageId, (byAgent = new Map()))
      byAgent.set(ev.agentId, ev.cwd)
    }
    // 收件箱的刷新信号：审批出现 / 结束、回合开始 / 收尾（status 只在这两个转变点广播；订阅时的首帧直发给订阅者，不经这里）
    if (ev.type === 'permission' || ev.type === 'permission_resolved' || ev.type === 'status' || ev.type === 'team_plan') this.opts.notifyInbox?.()
    const page = this.pages.get(pageId)
    if (!page) return
    for (const cb of page.subscribers) cb(ev)
  }

  /** 4403（撤销 / 拒绝 token）才摘掉适配器。普通掉线见 onConnectorDetached：进程可能还在，
   *  kill() 只是 removeAllListeners，会把在飞回复的监听摘掉。 */
  dropConnectorCaches(connectorId: string): void {
    for (const key of [...this.adapters.keys()]) {
      if (parseRemoteId(key)?.connectorId !== connectorId) continue
      this.dropAdapter(key)
    }
  }

  /** 此人在这台机器上的使用授权没了（收回 / 放弃 / 到期）：当场断开。由 machine-grants.ts 在授权判定已经为假之后调用，幂等。
   *  1. 他在这台机器上在飞的回合（含 server 重启后认领回来的）：占位块收成 error + 原因，取消该会话（停止记进 open_runs，断线也生效）；
   *     run_agent 子运行同样取消；
   *  2. 他在这台机器各适配器上的 MCP 短期凭证作废，池条目里的缓存一并清（「已加载」清掉，下一轮重新 load 才会拿新凭证）；
   *  3. 他的终端订阅（浏览器的 SSE）结束，他共享的端口预览全部停止；
   *  4. 通知 connector：本地名单删掉他、关掉他的全部终端与预览、取消 actor 是他的在飞 prompt（第二道闸，不依赖上面这些）。
   *  调用方保证此人不是机器主人、且已没有任何有效授权（finishAccess 判过）。 */
  revokeMachineAccess(connectorId: string, userId: string): void {
    this.endAgentAccess(connectorId, userId)
    this.opts.hub.ptys.dropUser(connectorId, userId)
    this.opts.hub.previews.dropUser(connectorId, userId) // 在飞的请求 / WebSocket 掐断，预览会话失效
    this.opts.hub.grantRevoked(connectorId, userId)
  }

  /** 授权收窄（换成了范围更小的新授权，此人仍有权限）：只收掉失去的那部分。
   *  agent 范围没了 → 同收回的 1、2；machine 范围没了 → 他的终端订阅结束、connector 关掉他的全部终端（不动本地名单：新授权的条目是刚写的） */
  reduceMachineAccess(connectorId: string, userId: string, lost: readonly MachineScope[]): void {
    if (lost.includes('agent')) this.endAgentAccess(connectorId, userId)
    if (lost.includes('machine')) {
      this.opts.hub.ptys.dropUser(connectorId, userId)
      this.opts.hub.previews.dropUser(connectorId, userId)
      this.opts.hub.accessReduced(connectorId, userId, 'machine')
    }
  }

  /** agent 范围的使用权没了：取消他的在飞回合与子运行、作废他的 MCP 凭证与池里的缓存 */
  private endAgentAccess(connectorId: string, userId: string): void {
    const reason = '你对这台机器的使用授权已收回，本轮已中止'
    for (const run of [...this.runIndex.values()]) {
      if (run.userId !== userId || run.remote?.connectorId !== connectorId || run.closed) continue
      run.revoked = reason
      run.cancelled = true
      this.teams.get(run.runId)?.cancelAll() // 带队的执行轮：组长的机器被收回，其它机器上的组员也一并取消
      this.notifyRunError(run.pageId, reason, run.record?.replyId)
      void requestCancel(this.pool, run.runId).catch(() => undefined)
      const entry = this.adapters.get(run.adapterKey)
      if (run.sessionId && entry) entry.shared.cancel(run.sessionId)
    }
    for (const sub of [...this.subRuns]) {
      if (sub.connectorId === connectorId && sub.userId === userId) sub.cancel()
    }
    this.opts.hub.cancelQuickOf(connectorId, userId, reason) // 随手 AI 本地通道里在飞的一次
    for (const [key, entry] of this.adapters) {
      if (parseRemoteId(key)?.connectorId !== connectorId) continue
      revokePageTokensOf(userId, key)
      for (const tokenKey of [...entry.pageTokens.keys()]) {
        if (tokenKey.startsWith(`${userId}|`)) entry.pageTokens.delete(tokenKey)
      }
      entry.loaded.clear()
    }
  }

  /** hub 在连接没了时调用。terminal=true 是 4403，进程不会再把回合跑完。 */
  onConnectorDetached(connectorId: string, terminal?: boolean): void {
    if (terminal) {
      this.dropConnectorCaches(connectorId)
      // 终态：这个 connector 上所有会话的待批不会再有人答，按结束处理并广播 resolved。
      // 非终态断开不动镜像，待批留着，重连后用 sessions 快照对账（快照里没有的当已结束）
      this.mirror.dropConnector(connectorId)
      return
    }
    for (const key of [...this.adapters.keys()]) {
      if (parseRemoteId(key)?.connectorId !== connectorId) continue
      const entry = this.adapters.get(key)
      if (!entry) continue
      // 断线时分不清进程还是不是同一个。loaded 留着的话，新进程下一轮会跳过 session/load，
      // agent 回 Unsupported ACP session。在飞的这一轮已经 load 过，清缓存不影响它。
      entry.loaded.clear()
      if (this.adapterHasRun(key) || entry.shared.busy) continue
      this.dropAdapter(key)
    }
  }

  /** hello.inflight 对上 open_runs。返回值原样进 welcome 的 resume/drop。 */
  resumeRemote(connectorId: string, inflight: InflightPrompt[]): Promise<ResumePlan> {
    return planRemoteResume(connectorId, inflight, this.remoteHost())
  }

  private adapterHasRun(adapterKey: string): boolean {
    for (const run of this.runIndex.values()) {
      if (run.adapterKey === adapterKey && !run.closed) return true
    }
    return false
  }

  private dropAdapter(key: string): void {
    const entry = this.adapters.get(key)
    if (!entry) return
    this.idle.clear(key)
    // 会话随适配器进程一起没了，签发给它的读页凭证也一并作废
    revokePageTokens(key)
    entry.shared.kill()
    this.adapters.delete(key)
  }

  /** 适配器进程池。闲置回收与 connector 共用同一份判据（busy = 在飞 prompt 或有待批审批）：远端适配器
   *  busy 时 kill 掉只会摘掉事件监听、把在飞回复静默截断，所以只续期。
   *  拿适配器必须先有 ResolvedAgent（过了机器使用权判定，带着 pass）；返回的是绑定了这个人的视图，
   *  远端的每一帧驱动指令都带着他的 actor（hub.driven / connector 第二道闸）。 */
  private ensureAdapter(agent: ResolvedAgent): AdapterEntry {
    const key = agent.id
    const existing = this.adapters.get(key)
    // 还没起过进程的 AcpAgent（刚被并行调用建出来、第一次 newSession 还没轮到）不是僵尸，复用别杀（见 AcpAgent.pristine）
    if (existing && (existing.shared.alive || (existing.shared instanceof AcpAgent && existing.shared.pristine))) {
      this.idle.arm(key)
      return this.view(existing, agent.pass)
    }
    if (existing) existing.shared.kill()
    // 远端：同一 connector 的同一 agent 共用 hub 持有的一个 RemoteAgent（同一 WSS 连接，会话级副本在里面）
    const shared = agent.local
      ? new AcpAgent(agent.local)
      : this.opts.hub.remote(agent.remote!.connectorId, agent.remote!.agentId)
    const created: PoolEntry = { shared, loaded: new Set(), key, pageTokens: new Map() }
    this.adapters.set(key, created)
    this.idle.arm(key)
    // 会话级事件的常驻监听：每个适配器装一次，按 sessionId 找页面（找不到就丢，之后的 bind 用执行端快照补齐）。
    // 监听不驱动机器，用原始适配器即可
    this.mirror.listen(key, shared)
    return this.view(created, agent.pass)
  }

  /** 池条目 → 操作人视图。凭据必须是签给这个适配器所在机器的（远端由 RemoteAgent.as 校验，本机在这里校验） */
  private view(pooled: PoolEntry, pass: MachinePass): AdapterEntry {
    let adapter: AgentAdapter
    if (pooled.shared instanceof RemoteAgent) adapter = pooled.shared.as(pass)
    else {
      if (!(pass instanceof MachinePass) || pass.machine !== LOCAL_MACHINE) throw new Error('凭据不是签给本机 agent 的')
      adapter = pooled.shared
    }
    return { adapter, loaded: pooled.loaded, key: pooled.key, pageTokens: pooled.pageTokens }
  }

  /** 指定 / 清除该 (页面, agent) 的工作区（POST /agent-cwd）：cwd 空串 = 清除覆盖。
   *  只落"意图"，目录能不能用由下一次 session/new 说了算（prepare 会立刻建立 / 报错） */
  async setWorkspace(
    pageId: string,
    body: { agent: string; cwd: string },
    user: { id: string; role: string },
  ): Promise<string> {
    const agent = await this.resolve(body.agent, user)
    if (!agent) throw new UnknownAgentError()
    const cwd = body.cwd.trim()
    await saveWorkspace(this.pool, pageId, agent.id, cwd)
    const effective = await effectiveCwd(this.pool, pageId, agent)
    this.broadcast(pageId, { type: 'cwd', agentId: agent.id, cwd: effective })
    return effective
  }

  /** 本页的工具档位（SSE 首帧由路由读它发给新订阅者）；没设过 = full */
  toolProfile(pageId: string): Promise<ToolProfile> {
    return loadToolProfile(this.pool, pageId)
  }

  /** 设本页的工具档位（POST /agent-tools）：只落意图，下一轮生效（会话复用时比较档位，不等就新建并全文重放）；广播给本页所有订阅者 */
  async setToolProfile(pageId: string, profile: ToolProfile): Promise<void> {
    await saveToolProfile(this.pool, pageId, profile)
    this.broadcast(pageId, { type: 'tool_profile', profile })
  }

  /** 本页记住的来源（SSE 首帧由路由读它发给新订阅者）；没有 = '' */
  choice(pageId: string): Promise<string> {
    return loadChoice(this.pool, pageId)
  }

  /** 记住本页的来源（POST /agent-choice）：只认调用者此刻调得动的 agent；广播给本页所有订阅者（协作者的输入卡跟着换） */
  async setChoice(pageId: string, agentId: string, user: { id: string; role: string }): Promise<void> {
    const agent = await this.resolve(agentId, user)
    if (!agent) throw new UnknownAgentError()
    await saveChoice(this.pool, pageId, agent.id)
    this.broadcast(pageId, { type: 'choice', agentId: agent.id })
  }

  /** 列执行端目录（GET /agent-dirs）：本机直读磁盘；远端经 WSS 让 connector 在它那台机器上列。
   *  path 省略 = 当前生效工作区 */
  async listWorkspaceDirs(
    pageId: string,
    agentId: string,
    path: string,
    user: { id: string; role: string },
  ): Promise<DirListing> {
    const agent = await this.resolve(agentId, user)
    if (!agent) throw new UnknownAgentError()
    const want = path.trim() || (await effectiveCwd(this.pool, pageId, agent))
    if (agent.local) return listDirs(want)
    const msg = await this.opts.hub.request(
      agent.pass,
      (rid, actor) => ({ t: 'ls', rid, actor, path: want }),
      LS_TIMEOUT_MS,
    )
    if (msg.t !== 'res' || !msg.dirs) {
      throw new Error(msg.t === 'err' ? msg.message : 'connector 未返回目录列表')
    }
    return msg.dirs
  }

  /** 修改某 agent 的会话配置(POST /agent-config);成功返回该会话当前全部 config options */
  async setConfig(
    pageId: string,
    body: { agent: string; configId: string; value: string },
    user: { id: string; role: string },
  ): Promise<ConfigOption[]> {
    return setSessionConfig(this.host(), pageId, body, user)
  }

  /** 选 agent 时预备会话（POST /agent-prepare）：只建 / 加载会话，不发起生成，好让前端立刻拿到模型 / 思考程度等配置项（实现见 session-config.ts） */
  async prepare(pageId: string, agentId: string, user: { id: string; role: string }): Promise<void> {
    return prepareSession(this.host(), pageId, agentId, user)
  }

  /** chained = 由 continue 收尾：正常结束时 @ 点名链可能接着跑下一家，排队要等链跑完再触发（continue 在 continueChain 之后调） */
  private release(pageId: string, run: RunState, chained = false): void {
    this.vacate(pageId, run)
    this.idle.arm(run.adapterKey)
    run.finished.resolve()
    // 远端关停不是结局：不广播「服务重启，本轮已中止」，占位块还是 o:run。
    if (run.hold && !run.ended) return
    this.broadcast(pageId, terminalStatus(run))
    // 排队发送：正常结束才自动发下一条，手动停止 / 出错则暂停（插队的停止除外，见 send-queue.ts）
    const outcome = run.ended ? 'end' : run.shutdown ? 'shutdown' : run.cancelled && !run.revoked ? 'cancelled' : 'error'
    if (!(chained && outcome === 'end')) this.queue.onRunEnd(pageId, outcome)
  }

  private vacate(pageId: string, run: RunState): void {
    this.runIndex.delete(run.runId)
    const page = this.pages.get(pageId)
    if (page?.run === run) page.run = null
  }

  /** 认领回来的回合（server 重启后 hello.inflight 对上 open_runs）的执行目标。凭据由调用方给（发起那一轮的人，
   *  授权此刻重新判过，见 remoteHost.passFor），这里不造 */
  private claimedAgent(catalogId: string, cwd: string, pass: MachinePass): ResolvedAgent | null {
    const parsed = parseRemoteId(catalogId)
    if (!parsed) return null
    const conn = this.opts.hub.get(parsed.connectorId)
    return {
      id: catalogId,
      pass,
      remote: conn
        ? remoteOf(conn, parsed.agentId)
        : { connectorId: parsed.connectorId, agentId: parsed.agentId, defaultCwd: cwd, ownerId: null },
    }
  }

  /** turn.ts / session-config.ts 的依赖面（同 remoteHost：自由函数不碰私有状态）。 */
  private host(): ManagerHost {
    return {
      pool: this.pool,
      wsPort: this.opts.wsPort,
      botSecret: this.opts.botSecret,
      notifyPagesChanged: this.opts.notifyPagesChanged,
      getLiveDoc: (docName) => this.opts.getLiveDoc(docName),
      broadcast: (pageId, ev) => this.broadcast(pageId, ev),
      resolve: (agentId, user) => this.resolve(agentId, user),
      ensureAdapter: (agent) => this.ensureAdapter(agent),
      adapterOf: (key, pass) => {
        const pooled = this.adapters.get(key)
        return pooled ? this.view(pooled, pass) : undefined
      },
      runOf: (pageId) => this.pages.get(pageId)?.run,
      pageReadTools: (entry, user, agent, pageId, profile) => this.pageReadTools(entry, user, agent, pageId, profile),
      teamTools: (entry, user, agent, pageId, round) => this.teamTools(entry, user, agent, pageId, round),
      team: this.teamHost(),
      mirror: this.mirror,
    }
  }

  private remoteHost(): RemoteRunHost {
    return {
      pool: this.pool,
      wsPort: this.opts.wsPort,
      botSecret: this.opts.botSecret,
      notifyPagesChanged: this.opts.notifyPagesChanged,
      broadcast: (pageId, ev) => this.broadcast(pageId, ev),
      notifyRunError: (pageId, message, replyId) => this.notifyRunError(pageId, message, replyId),
      findRun: (runId) => this.runIndex.get(runId),
      watch: (pageId, run) => {
        this.runIndex.set(run.runId, run)
        const page = this.pages.get(pageId) ?? { subscribers: new Set(), run: null }
        this.pages.set(pageId, page)
        if (page.run && page.run !== run) return false
        page.run = run
        return true
      },
      release: (pageId, run) => this.release(pageId, run),
      vacate: (pageId, run) => this.vacate(pageId, run),
      passFor: async (userId, connectorId) => {
        try {
          return await assertCanUse(this.pool, { id: userId }, connectorId, 'agent')
        } catch (err) {
          if (err instanceof ForbiddenError) return null
          throw err
        }
      },
      attach: (pageId, catalogId, pass, sessionId, cwd) => {
        const agent = this.claimedAgent(catalogId, cwd, pass)
        if (!agent) return
        const entry = this.ensureAdapter(agent)
        entry.loaded.add(sessionId)
        this.mirror.bind(pageId, catalogId, sessionId, entry.adapter)
      },
      persistFinalHash: async (pageId, catalogId, sessionId, cwd, hash, userId, tools) => {
        if (sessionId) await persistSession(this.pool, pageId, catalogId, sessionId, cwd, hash, userId, tools)
      },
      restoreBefore: (catalogId, pass, sessionId, before) => {
        const pooled = this.adapters.get(catalogId)
        return restoreMsgBefore(pooled ? this.view(pooled, pass) : undefined, sessionId, before)
      },
      bind: (runId, handlers) => this.opts.hub.bindRun(runId, handlers),
    }
  }
}
