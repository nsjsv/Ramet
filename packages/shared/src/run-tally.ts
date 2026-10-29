// ---------- 一轮的统计口径：右上角岛 / 工作台面板 / 回复块 stats 共用 ----------
// 服务端收尾时（RunRecord.stats）算一次写进回复块 `stats`（fc / fa / fd / ag），停靠的岛不拉 record 就能画；
// 前端对在飞的一轮（store 里的 RunState）与打开的已结束的一轮（GET /api/runs/:id 的 record）现算。两端同一个函数，口径不会漂。
import { lineDiff } from './line-diff.js'
import type { RunEntry, StepKind, StepStatus, TeamState, ToolEntry } from './run-model.js'

export type TallyFile = { path: string; add: number; del: number }
/** 协作：sub = agent 自己开的子代理（被别的步骤 parentId 引用的那一步）；call = run_agent 叫来的 agent（acp.subRun）；team = 带队组员 */
export type TallyAgent = {
  id: string
  kind: 'sub' | 'call' | 'team'
  /** catalog id（带队组员 / run_agent 的被叫）；子代理没有，是这一轮的 agent 自己 */
  agent?: string
  label: string
  status: 'waiting' | 'running' | 'done' | 'failed'
}
export type SpendKey = 'edit' | 'term' | 'call' | 'read' | 'think'
export const SPEND_KEYS: readonly SpendKey[] = ['edit', 'term', 'call', 'read', 'think']

export type RunTally = {
  steps: number
  failed: number
  files: TallyFile[]
  agents: TallyAgent[]
  /** 时间花在哪（毫秒）：按顶层步骤的 kind 与 t / end 归类；think = 总时长 − 其余（思考与写回复） */
  spend: Record<SpendKey, number>
  /** 折进步骤的审批 / 提问次数（审批到达时 RunRecord.permission 往 acp.permission 写选项） */
  asks: number
}

const EDIT_KINDS: ReadonlySet<StepKind> = new Set(['edit', 'delete', 'move'])
const READ_KINDS: ReadonlySet<StepKind> = new Set(['read', 'search', 'fetch'])

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function stepState(status: StepStatus): TallyAgent['status'] {
  return status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'pending' ? 'waiting' : 'running'
}

/** 编辑类步骤改了哪些文件：ACP content 里的 diff（同一路径累加）；没有 diff 的按 locations / detail 记文件、0 / 0 */
function addFiles(e: ToolEntry, files: Map<string, TallyFile>): void {
  const touch = (path: string, add: number, del: number): void => {
    if (!path) return
    const f = files.get(path) ?? { path, add: 0, del: 0 }
    f.add += add
    f.del += del
    files.set(path, f)
  }
  const content = Array.isArray(e.acp?.content) ? e.acp.content : []
  let diffs = 0
  for (const item of content) {
    const d = rec(item)
    if (d?.type !== 'diff') continue
    diffs++
    let add = 0
    let del = 0
    for (const line of lineDiff(str(d.oldText), str(d.newText))) {
      if (line.t === '+') add++
      else if (line.t === '-') del++
    }
    touch(str(d.path), add, del)
  }
  if (diffs > 0) return
  const loc = Array.isArray(e.acp?.locations) ? rec(e.acp.locations[0]) : undefined
  touch(str(loc?.path) || e.detail || '', 0, 0)
}

export function runTally(state: { entries: readonly RunEntry[]; team?: TeamState }, totalMs: number): RunTally {
  const tools = state.entries.filter((e): e is ToolEntry => e.k === 'tool')
  const parents = new Set(tools.map((e) => e.parentId).filter((id): id is string => Boolean(id)))
  const files = new Map<string, TallyFile>()
  const agents: TallyAgent[] = []
  const spend: Record<SpendKey, number> = { edit: 0, term: 0, call: 0, read: 0, think: 0 }
  let failed = 0
  let asks = 0
  for (const e of tools) {
    if (e.status === 'failed') failed++
    if (rec(e.acp?.permission)) asks++
    if (EDIT_KINDS.has(e.kind) && e.status !== 'failed') addFiles(e, files)
    const sub = rec(e.acp?.subRun)
    if (sub) {
      const outcome = str(sub.outcome)
      const agent = str(sub.agent)
      agents.push({
        id: e.id,
        kind: 'call',
        ...(agent ? { agent } : {}),
        label: str(sub.label) || agent || e.title,
        status: !outcome ? stepState(e.status) : outcome === 'end' ? 'done' : 'failed',
      })
    } else if (parents.has(e.id)) {
      agents.push({ id: e.id, kind: 'sub', label: e.title, status: stepState(e.status) })
    }
    // 时间：只算顶层步骤（子代理里的步骤已经算在唤起它的那一步里）
    if (e.parentId || e.t === undefined || e.end === undefined) continue
    const ms = Math.max(0, e.end - e.t)
    if (sub || parents.has(e.id)) spend.call += ms
    else if (EDIT_KINDS.has(e.kind)) spend.edit += ms
    else if (e.kind === 'execute') spend.term += ms
    else if (READ_KINDS.has(e.kind)) spend.read += ms
  }
  for (const t of state.team?.tasks ?? []) {
    agents.push({
      id: `team:${t.id}`,
      kind: 'team',
      agent: t.assignee,
      label: t.title,
      status: t.status === 'pending' ? 'waiting' : t.status === 'running' ? 'running' : t.status === 'done' ? 'done' : 'failed',
    })
  }
  // 并行的步骤加起来可能超过总时长：思考取余数、不为负
  spend.think = Math.max(0, totalMs - spend.edit - spend.term - spend.call - spend.read)
  return { steps: tools.length, failed, files: [...files.values()], agents, spend, asks }
}
