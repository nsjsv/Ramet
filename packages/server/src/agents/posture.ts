// ---------- 权限模式（posture）与机器主人 ----------
// 「跳过全部确认」= agent 自己的免审批档（claude 的 bypassPermissions、codex 的 agent-full-access）。
// 这一档让 agent 在机器上不经确认执行任何东西，所以只有机器主人能进：
//   - 本机 agent 的主人是服务器 admin；connector 上 agent 的主人是配对人（connectors.owner_id）
//   - 所有会把会话送进该档、或在该档下执行的入口都走同一个 authorize()，入口处不要各写一份判断：
//       set-config（改 mode）/ answer（审批选项把会话切进该档）/ run（会话此刻就在该档）
// 表只收录核实过的 agent；表外的（gemini、pi、自定义 id）mode 不可改，server 拒绝，前端不摆，不猜。
// 已知余量：表外厂商的未知提权路径（比如某个审批选项把会话切进全权）无法预先拦；
// run 检查保证非主人的下一轮不会在该档执行。
import type { ResolvedAgent } from './manager-types.js'

type Posture = {
  /** 「跳过全部确认」档的 mode 值 */
  unrestricted: readonly string[]
  /** 会把会话切进该档的审批选项（optionId） */
  elevating: readonly string[]
}

/** 键 = agent 自己的 id（本机配置里的 id / connector 上报的原始 id，不带 `c:<connectorId>:` 前缀） */
const POSTURE: Record<string, Posture> = {
  // 依据 claude-agent-acp 的 dist/session-mode.js、permissions/effects.js
  claude: { unrestricted: ['bypassPermissions'], elevating: ['exit-plan-bypass', 'exit-plan-clear-bypass'] },
  // 依据 codex-acp 的 dist/index.js
  codex: { unrestricted: ['agent-full-access'], elevating: [] },
  // `omp acp` / `opencode acp` 的 mode 只有 default / plan、build / plan，没有免审批档
  omp: { unrestricted: [], elevating: [] },
  opencode: { unrestricted: [], elevating: [] },
}

/** 某个 agent（原生 id，不带 `c:<connectorId>:` 前缀）的「跳过全部确认」档的 mode 值；表外的 agent 返回空（不猜）。
 *  随手 AI 的受限会话（connector/quick.ts）据此在运行前把会话切出这一档 */
export function unrestrictedModesOf(agentId: string): readonly string[] {
  return Object.hasOwn(POSTURE, agentId) ? POSTURE[agentId]!.unrestricted : []
}

export class ForbiddenError extends Error {}

export class ModeUnsupportedError extends Error {
  constructor() {
    super('这个 agent 的权限模式没有核实过，不能修改')
  }
}

/** GET /api/agents 每个 agent 带的：owner = 当前用户是不是这台机器的主人；modes = mode 能不能改；
 *  unrestricted = 「跳过全部确认」档的 mode 值（前端据此对非主人禁用这些选项） */
export type AgentPosture = { owner: boolean; modes: boolean; unrestricted: string[] }

type PostureUser = { id: string; role: string }
type PostureAgent = Pick<ResolvedAgent, 'local' | 'remote'>

export type AuthOp =
  | { kind: 'set-config'; category: string | null | undefined; value: string }
  | { kind: 'answer'; optionId: string | null }
  /** mode = 会话此刻的 mode（镜像里 category=mode 那一项的 currentValue） */
  | { kind: 'run'; mode: string | undefined }

function postureFor(agent: PostureAgent): Posture | null {
  const id = agent.local?.id ?? agent.remote?.agentId
  // hasOwn：agent id 是部署方 / connector 给的字符串，`constructor` 之类不能命中 Object.prototype
  return id !== undefined && Object.hasOwn(POSTURE, id) ? POSTURE[id]! : null
}

/** 机器主人：本机 agent 是 admin；connector agent 是配对人（老 connector 没有主人，谁都不是） */
function isOwner(user: PostureUser, agent: PostureAgent): boolean {
  return agent.local ? user.role === 'admin' : agent.remote?.ownerId === user.id
}

export function agentPosture(user: PostureUser, agent: PostureAgent): AgentPosture {
  const posture = postureFor(agent)
  return { owner: isOwner(user, agent), modes: posture !== null, unrestricted: [...(posture?.unrestricted ?? [])] }
}

/** 唯一判定函数。通过返回，不通过抛错：ForbiddenError 对应 403（run 时本轮失败并给出原因），
 *  ModeUnsupportedError 对应 400 */
export function authorize(user: PostureUser, agent: PostureAgent, op: AuthOp): void {
  const posture = postureFor(agent)
  const owner = isOwner(user, agent)
  if (op.kind === 'set-config') {
    if (op.category !== 'mode') return
    if (!posture) throw new ModeUnsupportedError()
    if (posture.unrestricted.includes(op.value) && !owner) {
      throw new ForbiddenError('「跳过全部确认」只有机器主人能开启')
    }
  } else if (op.kind === 'answer') {
    if (op.optionId && posture?.elevating.includes(op.optionId) && !owner) {
      throw new ForbiddenError('这个选项会让会话进入「跳过全部确认」，只有机器主人能选')
    }
  } else if (op.mode && posture?.unrestricted.includes(op.mode) && !owner) {
    throw new ForbiddenError('当前会话处于跳过全部确认，只有机器主人能发起；先切回其他模式')
  }
}
