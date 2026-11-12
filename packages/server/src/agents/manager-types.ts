// ---------- AgentManager 的公共类型、错误类与内部状态形状 ----------
// 从 manager.ts 抽出：turn.ts / session-config.ts / session-store.ts 也要这些类型，
// 而它们不该反过来依赖 manager（host 模式同 remote-run.ts 的 RemoteRunHost）。
import type * as Y from 'yjs'
import { toolOf } from '@ramet/shared/reply-stats'
import type { Pool } from 'pg'
import type { DocWriter } from '../collab.js'
import { grantUsable, type PageTool } from '../page-read.js'
import { isSpaceAiId } from './space-ai.js'
import type { MachinePass } from './machine-access.js'
import type { RunState } from './run-state.js'
import type { AgentPosture } from './posture.js'
import type { SessionMirror } from './session-mirror.js'
import type { SessionSync } from './session-sync.js'
import type { TeamRoundHost } from './team.js'
import type { ToolProfile } from './tool-profile.js'
import type { AgentAdapter, AgentConfig, AgentEvent, PermissionEvent } from './types.js'
import type { AgentNameHost } from './agent-names.js'

export class BusyError extends Error {
  constructor() {
    super('该页面已有 agent 正在生成')
  }
}

export class UnknownAgentError extends Error {
  constructor() {
    super('未配置该 agent')
  }
}

export class NoSessionError extends Error {
  constructor() {
    super('该页面还没有任何 agent 会话可修改配置')
  }
}

export class ReplyNotFoundError extends Error {
  constructor() {
    super('没有找到要重新生成的回复')
  }
}

export class NoUserMessageError extends Error {
  constructor() {
    super('这条回复之前没有用户消息，无从重新生成')
  }
}

/** 这块回复不能续跑（不是最后一块 / 没有失败或停止 / 带队的一轮）：路由回 409 not-resumable，前端改走重新生成 */
export class NotResumableError extends Error {
  constructor(readonly reason: 'not-last' | 'not-interrupted' | 'team') {
    super(
      reason === 'not-last'
        ? '只有最后一块回复能接着跑，这块请重新生成'
        : reason === 'team'
          ? '带队的一轮不能接着跑，请重新生成'
          : '这块回复没有失败或停止，不能接着跑',
    )
  }
}

/** 审批已经不在（已被别人答了 / 已结束） */
export class UnknownApprovalError extends Error {
  constructor() {
    super('这条审批已经结束')
  }
}

/** 提问的答案不合表单（多余的键 / 类型不对 / 必填为空 / 不在候选里 / 越界）：message 是给人看的原因，路由回 400 */
export class BadAnswerError extends Error {}

/** agent 所在的机器现在不在线：审批还留在那边，等它回来可以再答 */
export class AgentOfflineError extends Error {
  constructor() {
    super('agent 所在的机器不在线，审批还留着，上线后可以再答')
  }
}

/** 一页只用一种工具：页面第一块回复用的工具锁定这一页，接着对话的那一轮换成别的工具（任何机器）就拒绝（路由 409 tool-locked）。
 *  不同工具之间的上下文接不上，同一工具换机器可以。显式 @ 点名、带队组员、run_agent 的被叫不受限：它们各用自己的会话，
 *  对话内容靠补发（catch-up.ts，带署名）带过去，不是「接着对话的那个」 */
export class ToolLockedError extends Error {
  /** offline = 锁定的工具此刻一台能用的都没有（没指定 agent 时也不回落到别的工具） */
  constructor(readonly tool: string, offline = false) {
    // 工具名会显示在失败条上：空间 AI 的工具名就是它的内部 id，换成叫法（各家 CLI 的工具名本来就是可读的）
    const name = isSpaceAiId(tool) ? '空间 AI' : tool
    super(offline ? `这个对话用的是 ${name}，现在没有可用的 ${name}` : `这个对话用的是 ${name}，换工具请新开一页`)
  }
}

/** 这个 agent 能不能接着这一页的对话：没锁（lock = ''）或是同一个工具（哪台机器都行） */
export function fitsLock(lock: string, agentId: string): boolean {
  return !lock || toolOf(agentId) === lock
}

/** 页面 + agent 的会话记录。
 *  `seen` 与 `lastSyncedHash` 都为空是准备会话：会话已建（选 agent 时预备，为了拿到模型/思考程度等配置项；或刚新建、
 *  提示词还没发出去），但一次都没喂过文档，下一次生成必须「加载 + 全文重放」，不能走增量。 */
export type SavedSession = {
  sessionId: string
  cwd: string
  /** 这个会话看到的最后一个顶层块（发出提示词时就是那一轮的回复块 id）。下一轮只发它之后文档里新增的内容 + 新消息；
   *  这块被删了就只发新消息。文档前面的改动、空间记忆的变化都不让会话作废（上下文归 agent 自己的会话） */
  seen?: string | null
  /** 老记录才有：对「去掉最后一条用户消息的视图」算的 hash。没有 seen 时按它判一次能不能增量（相等 = 只追加了新消息），
   *  之后补记 seen；新写入不再带它 */
  lastSyncedHash?: string | null
  /** 这个会话的 MCP 进程手里是谁的页面凭证（最后一次建 / 加载会话时交付的那份）。会话只给同一个人复用：
   *  换人接着用，agent 回打中心就会带着上一个人的页面权限（能读他能读、你读不到的页）。
   *  老记录没有这个字段 = 谁都不复用（各页全文重放一次） */
  userId?: string
  /** 这个会话建 / 加载时交付的工具档位（tool-profile.ts）；没有 = full（老记录照常复用）。与页面档位不等 = 不复用 */
  tools?: ToolProfile
}

/** 可选 agent：本地直 spawn 的配置，或某个在线 connector 上的 agent（id 已带 c: 前缀）。
 *  posture 由当前请求的用户算出（owner 因人而异）。
 *  machine = 当前用户对这台机器有 machine 范围的使用权（接入人 ∨ 有效授权）：前端据此决定要不要给项目面板入口
 *  （不是 connector 上的 agent = false）；真正的判定在每个项目端点上再做一次，这个标记只管「要不要显示入口」 */
/** unavailable：这个 agent 现在用不了的原因（CLI 版本太旧等），前端置灰、不可选 */
export type CatalogAgent = { id: string; label: string; logo?: string | null; posture: AgentPosture; machine: boolean; unavailable?: string }

/** 解析后的执行目标：runTurn/ensureAdapter 只看这个，不再关心 agent 在哪台机器。
 *  pass 是操作人对这台机器的使用凭据：ResolvedAgent 只能由 manager.resolve（过 assertCanUse）造出，
 *  所以「手里有 ResolvedAgent」就等于「已经判定过这个人能用这台机器」；ensureAdapter 用的凭据就是它 */
export type ResolvedAgent = {
  id: string
  pass: MachinePass
  local?: AgentConfig
  /** ownerId = 配对人（connectors.owner_id），这台机器的主人；老 connector 为 null */
  remote?: { connectorId: string; agentId: string; defaultCwd: string; ownerId: string | null }
  /** 中心自己跑的 Genet（assistant-agent.ts）：不在任何机器上，没有工作区（cwd 恒为空）、不记机器使用、不搬会话；
   *  只在发起人自己的 Genet 页上才解析得出来 */
  assistant?: true
  /** 空间 AI（space-ai.ts，同时带 assistant）：页面所在的团队空间。凭证收窄到它，驱动按它认会话主体 */
  space?: { id: string }
}

/** 这一轮的执行目标（resolveRun / resolveRedo 的产物）：agent + 生效 cwd + 消息级配置覆盖。
 *  redo = 要原地重新生成的那块 agent_reply 的 id（缺省 = 往页尾追加一块新回复） */
export type RunTarget = {
  agent: ResolvedAgent
  cwd: string
  opts: Record<string, string>
  redo?: string
  /** 要接着跑（续跑）的那块 agent_reply 的 id：同一个会话、同一块回复、同一个过程页接着来（resume-turn.ts） */
  resume?: string
  /** 带队的执行轮（POST /continue {team: planId}）：这一轮要先由中心把计划里的组员跑完，组长最后交叉审查（team.ts） */
  team?: { planId: string }
}

/** 复合 id：c:<connectorId>:<agentId>（connectorId 是无冒号 uuid，agentId 自身可含冒号） */
export const REMOTE_PREFIX = 'c:'

export function parseRemoteId(id: string): { connectorId: string; agentId: string } | null {
  if (!id.startsWith(REMOTE_PREFIX)) return null
  const rest = id.slice(REMOTE_PREFIX.length)
  const i = rest.indexOf(':')
  if (i <= 0) return null
  return { connectorId: rest.slice(0, i), agentId: rest.slice(i + 1) }
}

export type PageState = {
  subscribers: Set<(ev: AgentEvent) => void>
  run: RunState | null
}

/** 会话交付工具时带的凭证（多份按序拼起来；没有工具 = ''）：AdapterEntry.loaded 记的就是它 */
export function credentialOf(tools: PageTool[]): string {
  return tools.map((t) => t.mcp.token).join(',')
}

/** 这个会话在本进程里加载过、且加载时交付的就是这一份凭证：可以直接接着用。凭证换了（过期签了新的）就得重新加载，
 *  agent 侧的 MCP 进程才会拿到新凭证；拿着死凭证接着用，它的每次工具调用都是 401 */
export function loadedWith(entry: Pick<AdapterEntry, 'loaded'>, sessionId: string, tools: PageTool[]): boolean {
  return entry.loaded.get(sessionId) === credentialOf(tools)
}

/** 这个会话在本进程里加载着，手里的凭证（不管是谁的）也还用得上：改配置这类不交付新工具的操作可以直接用它，
 *  不必换成自己的凭证重新加载 */
export function loadedUsable(entry: Pick<AdapterEntry, 'loaded'>, sessionId: string): boolean {
  const cred = entry.loaded.get(sessionId)
  return typeof cred === 'string' && cred.split(',').filter(Boolean).every(grantUsable)
}

/** 适配器池条目的操作人视图：adapter 绑定了发起这次调用的人的凭据（远端：帧里的 actor 取自它），
 *  其余成员（loaded / key / pageTokens）与池里的条目共享引用。池里的原始适配器不对外，见 manager.ts 的 PoolEntry */
export type AdapterEntry = {
  adapter: AgentAdapter
  /** 本进程内已 loadSession / newSession 的会话 → 那时交付的凭证（credentialOf）；null = 不知道（认领回来的回合，
   *  凭证是上一个中心进程签的，已经作废）。进程被回收后清空、重新 load；凭证对不上也重新 load（loadedWith） */
  loaded: Map<string, string | null>
  /** 本适配器的 key（= agent id）：签发/撤销 read_page 凭证的 scope（见 page-read.ts） */
  key: string
  /** 交给 AI 的 Ramet MCP 凭证，按「用户 + 页面」各一把（凭证绑着页面：新建页默认放当前页下、审批弹在当前页、
   *  叫别的 agent 留痕在当前页的运行里）。随适配器条目一起作废：会话在适配器进程里，
   *  进程被回收/connector 掉线后那些 MCP 进程也随之消失 */
  pageTokens: Map<string, string>
}

/** AgentManager 交给 turn.ts / session-config.ts 的依赖面（同 remote-run.ts 的 RemoteRunHost）：
 *  自由函数不碰 manager 的私有状态，要什么从这里拿。 */
export type ManagerHost = {
  pool: Pool
  wsPort: () => number
  botSecret: string
  notifyPagesChanged?: () => void
  getLiveDoc(docName: string): Y.Doc | undefined
  broadcast(pageId: string, ev: AgentEvent): void
  /** pageId = 在哪一页上用（Genet 只在发起人自己的 Genet 页上解析得出来，见 manager.resolve） */
  resolve(agentId: string, user: { id: string; role: string }, pageId?: string): Promise<ResolvedAgent | null>
  ensureAdapter(agent: ResolvedAgent): AdapterEntry
  /** 适配器池里已有的条目（不创建），绑定到 pass 的操作人；key = agent id（catalog id） */
  adapterOf(key: string, pass: MachinePass): AdapterEntry | undefined
  /** 页面上在飞的回合；没有 = 空闲 */
  runOf(pageId: string): RunState | null | undefined
  /** 页面会话的 Ramet 工具，按档位发：none = 不挂（空数组）、minimal = 带档位的凭证、full = 现状 */
  pageReadTools(entry: AdapterEntry, user: { id: string; role: string }, agent: ResolvedAgent, pageId: string, profile: ToolProfile): PageTool[]
  /** 带队这一轮的组长凭证：每轮单独签（不进 pageTokens 缓存）、canDispatch=false、带 team 上下文（决定多出 submit_plan 还是 send_back），
   *  轮末按 runId 撤销。组长的 TTL 从这一刻起算，执行轮先跑组员，所以要在组员跑完之后再签 */
  teamTools(entry: AdapterEntry, user: { id: string; role: string }, agent: ResolvedAgent, pageId: string, round: { kind: 'plan' | 'exec'; runId: string; planId?: string }): PageTool[]
  /** 带队：计划与执行轮的能力（agents/team.ts） */
  team: TeamRoundHost
  /** 页面 + agent 的会话镜像：会话级状态（命令 / 配置 / 待批）中心只在这里读 */
  mirror: SessionMirror
  /** 会话记录在中心的副本：每轮收尾后的同步、换机器时的下发（session-sync.ts / session-move.ts） */
  sessions: SessionSync
  /** 这个人此刻能用的 agent 目录（续跑时原机器不在线，找同一工具的另一台） */
  catalog(user: { id: string; role: string }): Promise<CatalogAgent[]>
  /** agent 显示名的原料（补发内容里给别的 agent 的回复署名用，agent-names.ts） */
  agentNames: AgentNameHost
  /** 以某人身份写文档（collab.ts 的 createDocWriter）：续跑收尾往原过程页补步骤块。测试桩可以不给 */
  writeDoc?: DocWriter
}

/** 收件箱用的只读快照：某页面上此刻待批的一条审批。own = Ramet 自己的审批（trash_page 等，不经 agent 会话） */
export type PendingApproval = { pageId: string; agentId: string; event: PermissionEvent; own: boolean }

/** 收件箱用的只读快照：一个在飞（未收尾）的回合 */
export type ActiveRun = { runId: string; pageId: string; agentId: string; userId: string; startedAt: number }
