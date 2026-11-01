// ---------- 工具步骤的中性视图：一步做了什么（命令 / 路径 / diff / 结果 / 退出状态），与 agent 用什么协议无关 ----------
// 驱动在发工具事件时填 `Step.view`；前端只经 viewOf 读，不认任何一家的原始载荷形状。
// 老记录（runs.record 永久保存）只有 ACP 原样载荷 `Step.acp`，由这里的 acpToolView 推出同一份视图，
// 所以这层兼容在 ACP 本身退役之后也要留着。推断规则只写在这一处：服务端（ACP 适配器产出 view）与前端
// （老数据回落）用的是同一个函数，两边不会各推各的。

import type { Step, StepKind } from './run-model.js'

export type ToolDiff = { path: string; old: string; new: string }
export type ToolExit = { code: number | null; signal: string | null }

/** 增量合并按字段：后到的覆盖先到的，缺省保持；raw 是一个字段，所以整体替换 */
export type ToolView = {
  /** 工具原名（agent 自己的叫法，只在「高级」里显示） */
  tool?: string
  /** 命令类：完整命令行 */
  command?: string
  /** agent 给这次调用写的一句说明（命令下面那行灰字），不是结果 */
  description?: string
  /** 命令在哪个目录跑；搜索 / 抓取类是搜索范围 */
  cwd?: string
  /** 读 / 写 / 编辑的主路径 */
  path?: string
  /** 编辑 / 整份写入（old 为空 = 新建）；path 已回落到主路径 */
  diffs?: ToolDiff[]
  /** 搜索词 / 抓取网址 */
  query?: string
  /** 结果文字（原样；前端负责去掉整段包着的代码围栏） */
  result?: string
  exit?: ToolExit
  /** 可停止的命令句柄（停止这条命令用）；没有 = 停不了 */
  handle?: string
  /** 原样载荷，只在「高级」里展示；extra 是认不出用途但不该丢的其余字段 */
  raw?: { input?: unknown; output?: unknown; extra?: Record<string, unknown> }
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const EDIT_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move'])
const PATH_KEYS = ['file_path', 'path', 'filePath', 'abs_path', 'notebook_path']
const QUERY_KEYS = ['pattern', 'query', 'url', 'glob', 'search']
const OUTPUT_KEYS = ['output', 'formatted_output', 'aggregated_output', 'stdout', 'stderr', 'result', 'content', 'text']
/** 已经变成视图字段（或步骤自己的字段）的 ACP 键，不再进 raw.extra；subRun 是 Ramet 自己写的子运行，单独展示 */
const RAW_CONSUMED: ReadonlySet<string> = new Set(['rawInput', 'rawOutput', 'name', 'title', 'kind', 'status', 'subRun'])

/** 增量合并：缺省（undefined）字段保持，显式值覆盖 */
export function mergeView(prev: ToolView | undefined, delta: ToolView): ToolView {
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(delta)) {
    if (v !== undefined) out[k] = v
  }
  return out as ToolView
}

/** 命令行：字符串，或字符串数组（argv）用空格连；别的形状不认 */
function commandOf(rawInput: unknown): string {
  const cmd = rec(rawInput).command
  if (typeof cmd === 'string') return cmd.trim()
  if (Array.isArray(cmd) && cmd.every((part) => typeof part === 'string')) return cmd.join(' ').trim()
  return ''
}

/** ACP 原样载荷 → raw：输入 / 输出原样，其余没被视图吃掉的字段进 extra（含 _meta 与未知扩展） */
function acpRaw(acp: Record<string, unknown>): NonNullable<ToolView['raw']> {
  const raw: NonNullable<ToolView['raw']> = {}
  if (acp.rawInput !== undefined) raw.input = acp.rawInput
  if (acp.rawOutput !== undefined) raw.output = acp.rawOutput
  const extra = Object.fromEntries(Object.entries(acp).filter(([k, v]) => !RAW_CONSUMED.has(k) && v !== undefined))
  if (Object.keys(extra).length > 0) raw.extra = extra
  return raw
}

/** 从 ACP 工具载荷（tool_call / tool_call_update 合并后的字段，或审批请求里的 toolCall）推出视图。
 *  kind 缺省取载荷里的 kind；认不出的形状就不填那个字段，不猜 */
export function acpToolView(acp: Record<string, unknown>, kind: string | undefined = str(acp.kind) || undefined): ToolView {
  const view: ToolView = {}
  const input = rec(acp.rawInput)
  const content = Array.isArray(acp.content) ? acp.content.map(rec) : []

  if (typeof acp.name === 'string' && acp.name) view.tool = acp.name
  const command = commandOf(acp.rawInput)
  if (command) view.command = command
  const description = str(input.description).trim()
  if (description) view.description = description
  // 搜索的 path 参数是在哪搜，不是读写的文件
  const cwd = kind === 'search' || kind === 'fetch' ? str(input.path) : str(input.cwd)
  if (cwd) view.cwd = cwd

  // 主路径：locations 第一条 → rawInput 里常见的路径字段
  const loc = Array.isArray(acp.locations) ? rec(acp.locations[0]) : {}
  const path = str(loc.path) || PATH_KEYS.map((k) => str(input[k])).find(Boolean) || ''
  if (path) view.path = path

  const query = QUERY_KEYS.map((k) => str(input[k])).find(Boolean)
  if (query) view.query = query

  // 结果文字：content 里的文字块 → rawOutput 是字符串 → rawOutput 里常见的输出字段
  const texts = content.filter((c) => c.type === 'content' && typeof rec(c.content).text === 'string').map((c) => str(rec(c.content).text))
  const out = acp.rawOutput
  const outFields = OUTPUT_KEYS.map((k) => str(rec(out)[k])).filter(Boolean)
  if (texts.length) view.result = texts.join('\n')
  else if (typeof out === 'string') view.result = out
  else if (outFields.length) view.result = outFields.join('\n')

  // 修改：content 里的 diff；编辑类没有 diff 时退到 rawInput 的 old_string / new_string → rawInput.content（整份写入）
  const diffs = content.filter((c) => c.type === 'diff').map((d) => ({ path: str(d.path) || path, old: str(d.oldText), new: str(d.newText) }))
  if (diffs.length) view.diffs = diffs
  else if (kind !== undefined && EDIT_KINDS.has(kind)) {
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      view.diffs = [{ path, old: str(input.old_string), new: str(input.new_string) }]
    } else if (typeof input.content === 'string') {
      view.diffs = [{ path, old: '', new: input.content }]
    }
  }

  // 退出状态：ACP 终端里的命令由服务端补 terminalExit；别的 agent 的命令看 rawOutput 里常见的退出码字段
  const term = rec(acp.terminalExit)
  if ('exitCode' in term || 'signal' in term) {
    view.exit = {
      code: typeof term.exitCode === 'number' ? term.exitCode : null,
      signal: typeof term.signal === 'string' && term.signal ? term.signal : null,
    }
  } else if (out && typeof out === 'object') {
    const o = rec(out)
    const code = typeof o.exit_code === 'number' ? o.exit_code : typeof o.exitCode === 'number' ? o.exitCode : null
    if (code !== null) view.exit = { code, signal: null }
  }

  const handle = content.find((c) => c.type === 'terminal' && typeof c.terminalId === 'string' && c.terminalId)
  if (handle) view.handle = str(handle.terminalId)

  const raw = acpRaw(acp)
  if (Object.keys(raw).length > 0) view.raw = raw
  return view
}

const EMPTY: ToolView = Object.freeze({}) as ToolView
/** 推断结果按 acp 对象缓存：同一份载荷返回同一个对象（前端拿引用身份当「详情变了没」的指纹） */
const fromAcp = new WeakMap<object, { kind: StepKind; view: ToolView }>()
/** view 与 acp 都有时的合成结果，按 view 对象缓存（acp 或 kind 变了重算） */
const layered = new WeakMap<object, { acp: object; kind: StepKind; view: ToolView }>()

function inferred(acp: Record<string, unknown>, kind: StepKind): ToolView {
  const hit = fromAcp.get(acp)
  if (hit && hit.kind === kind) return hit.view
  const view = acpToolView(acp, kind)
  fromAcp.set(acp, { kind, view })
  return view
}

/** 一步的视图：没有 acp 就是 view 本身；只有 acp（老记录）就从 acp 推；两者都有时按字段以 view 为准、缺的从 acp 补
 *  （ACP 适配器不重复传原样载荷 raw；中心补的退出状态也可能落在一个只有 acp 的老来源步骤上）。返回值只读（缓存共享） */
export function viewOf(step: Pick<Step, 'kind' | 'view' | 'acp'>): ToolView {
  const { view, acp, kind } = step
  if (!acp) return view ?? EMPTY
  if (!view) return inferred(acp, kind)
  const hit = layered.get(view)
  if (hit && hit.acp === acp && hit.kind === kind) return hit.view
  const out = { ...inferred(acp, kind), ...view }
  layered.set(view, { acp, kind, view: out })
  return out
}

/** 一步改了哪些文件（改动统计 run-tally 用）。diffs 里 path 为空的条目不算；没有 diff 时 path 是被改的那个文件（行数记 0 / 0）。
 *  带 ACP 工具载荷的步骤（老记录，以及 ACP 适配器还在产出的步骤）只认 content 里的 diff、退到 locations / detail：
 *  回复块 stats 当初就是按这个口径写死的，从视图推会多出 rawInput 里 old_string / new_string 的行数，同一轮前后统计对不上。
 *  没有 ACP 载荷的（原生驱动）读视图。原生驱动往 acp 里只放审批记录（permission）这类 Ramet 自己的键，不放这几项 */
const ACP_PAYLOAD_KEYS = ['content', 'locations', 'rawInput', 'rawOutput']
export function stepEdits(step: Pick<Step, 'kind' | 'view' | 'acp' | 'detail'>): { diffs: ToolDiff[]; path: string } {
  const acp = step.acp
  if (acp && ACP_PAYLOAD_KEYS.some((k) => acp[k] !== undefined)) {
    const content = Array.isArray(acp.content) ? acp.content.map(rec) : []
    const diffs = content.filter((c) => c.type === 'diff').map((d) => ({ path: str(d.path), old: str(d.oldText), new: str(d.newText) }))
    const loc = Array.isArray(acp.locations) ? rec(acp.locations[0]) : {}
    return { diffs, path: str(loc.path) || step.detail || '' }
  }
  const view = viewOf(step)
  return { diffs: view.diffs ?? [], path: view.path || step.detail || '' }
}

/** 计划审批（ACP kind = switch_mode，如 claude 的 ExitPlanMode）：要批的是 content 里的计划正文 */
export function isPlanApproval(toolCall: Record<string, unknown> | undefined): boolean {
  return toolCall?.kind === 'switch_mode' && Array.isArray(toolCall.content) && toolCall.content.some((c) => rec(c).type === 'content')
}

/** 子运行（run_agent 叫来的 agent）：服务端（sub-run.ts）放在这一步上的任务 / 步骤 / 回答，没有是 undefined */
export function subRunOf(step: Pick<Step, 'acp'>): unknown {
  return step.acp?.subRun
}
