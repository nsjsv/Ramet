// ---------- 一轮 run 的原始调用详情（步骤展开后的「高级」；状态条、过程页、公开过程页共用） ----------
// 常规展示（命令 + 输出 / 读文件 / diff）在 run-view.ts，这里只管 ACP 给了什么就画什么那一层。
// 只读原始数据，不猜、不估算，未知 / 非文本数据一律 escapeHtml + 可读 JSON。
// 长内容不在这里截断（后端已限长），靠 .rd-pre 的滚动区显示。
// 是否需要重画由调用方的指纹决定（live-reply 的 sig / run-board 的 React 渲染），这里只产出 HTML。
import { stepVerb, type RunInfo, type ToolEntry } from '@ramet/shared/run-model'
import { escapeHtml, fmtDuration } from './run-format'

function text(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const PRE = (label: string, value: unknown): string =>
  `<div class="rd-item"><div class="rd-label">${escapeHtml(label)}</div><pre class="rd-pre">${escapeHtml(text(value))}</pre></div>`

/** 显式 null = 已被清空，照画（缺省字段不画）——区分「没有」与「明确为空」 */
const shown = (value: unknown): boolean => value !== undefined

const meta = (label: string, value: string): string =>
  `<span class="rd-meta-item"><span class="rd-meta-k">${escapeHtml(label)}</span>${escapeHtml(value)}</span>`

/** ACP 载荷是任意 JSON：非对象一律当空对象，读取处再逐个 typeof 收窄 */
export function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 除指定键之外的全部字段（含 _meta / annotations / 未知扩展），有才画 */
function restItem(label: string, obj: Record<string, unknown>, exclude: Record<string, true>): string {
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !exclude[k]))
  return Object.keys(rest).length ? PRE(label, rest) : ''
}

function locationsHtml(value: unknown): string {
  if (!Array.isArray(value)) return shown(value) ? PRE('位置', value) : ''
  const rows = value.map((raw) => {
    const o = rec(raw)
    const path = typeof o.path === 'string' ? o.path : ''
    const line = o.line === undefined || o.line === null ? '' : `:${String(o.line)}`
    const extra = o._meta ? `<span class="rd-loc-meta">${escapeHtml(text(o._meta))}</span>` : ''
    return `<div class="rd-loc">${escapeHtml(path + line)}${extra}</div>`
  })
  return `<div class="rd-item"><div class="rd-label">位置</div>${rows.join('')}</div>`
}

/** ToolCallContent：content / diff / terminal / 未知 —— 各自的专有字段单独画，其余（_meta/annotations/未知）原样可查 */
function contentItem(raw: unknown): string {
  const c = rec(raw)
  if (c.type === 'diff') {
    const head = `<div class="rd-label">diff · ${escapeHtml(String(c.path ?? ''))}</div>`
    const lines = (['oldText', 'newText'] as const).map((k) => {
      if (c[k] === undefined) return ''
      const cls = k === 'oldText' ? 'rd-del' : 'rd-add'
      return `<pre class="rd-pre ${cls}">${escapeHtml(text(c[k]))}</pre>`
    })
    return `<div class="rd-item">${head}${lines.join('')}${restItem('diff 扩展', c, { type: true, path: true, oldText: true, newText: true })}</div>`
  }
  if (c.type === 'content') {
    const block = rec(c.content)
    const inner = typeof block.text === 'string' ? `<pre class="rd-pre">${escapeHtml(block.text)}</pre>` : PRE('内容', c.content)
    const extra = restItem('内容扩展', block, { type: true, text: true })
    return `<div class="rd-item"><div class="rd-label">内容</div>${inner}${extra}${restItem('content 扩展', c, { type: true, content: true })}</div>`
  }
  return PRE(c.type === 'terminal' ? '终端' : '内容', raw)
}

/** ACP 工具载荷的四块：rawInput / rawOutput / content（diff 等）/ locations。工具详情与审批预览共用这一个渲染 */
function payloadHtml(acp: Record<string, unknown>, withRawOutput: boolean): string {
  const out: string[] = []
  if (shown(acp.rawInput)) out.push(PRE('输入 rawInput', acp.rawInput))
  if (withRawOutput && shown(acp.rawOutput)) out.push(PRE('输出 rawOutput', acp.rawOutput))
  if (shown(acp.content)) {
    out.push(Array.isArray(acp.content) && acp.content.length ? acp.content.map(contentItem).join('') : PRE('内容', acp.content))
  }
  if (shown(acp.locations)) out.push(Array.isArray(acp.locations) && acp.locations.length === 0 ? PRE('位置', acp.locations) : locationsHtml(acp.locations))
  return out.join('')
}

/** rawInput 里的命令：字符串，或字符串数组（argv）用空格连；别的形状不认 */
export function commandOf(rawInput: unknown): string {
  const cmd = rec(rawInput).command
  if (typeof cmd === 'string') return cmd.trim()
  if (Array.isArray(cmd) && cmd.every((part) => typeof part === 'string')) return cmd.join(' ').trim()
  return ''
}

/** 计划审批（ACP kind = switch_mode，如 claude 的 ExitPlanMode「Ready to code?」）：要批的是 content 里的计划正文 */
export function isPlanApproval(toolCall: Record<string, unknown> | undefined): boolean {
  return toolCall?.kind === 'switch_mode' && Array.isArray(toolCall.content) && toolCall.content.some((c) => rec(c).type === 'content')
}

/** 审批卡的预览（只读 toolCall，不猜）：有命令 → 等宽 `$ cmd`（+ description 一行灰字）；
 *  否则画 content / diff / locations / rawInput（编辑类审批就是看到 diff 和路径）；都没有 → 空串。
 *  计划审批只画 content（计划正文）：rawInput 是同一份计划的 JSON 转义，再画一遍只会把计划挤成一行 */
export function permissionPreviewHtml(toolCall: Record<string, unknown> | undefined): string {
  if (!toolCall) return ''
  if (isPlanApproval(toolCall)) {
    const body = payloadHtml({ ...toolCall, rawInput: undefined }, false)
    return body ? `<div class="run-detail">${body}</div>` : ''
  }
  const command = commandOf(toolCall.rawInput)
  if (command) {
    const desc = rec(toolCall.rawInput).description
    const note = typeof desc === 'string' && desc.trim() ? `<div class="rd-cmd-note">${escapeHtml(desc.trim())}</div>` : ''
    return `<div class="run-detail"><pre class="rd-pre rd-cmd"><span class="rd-cmd-prompt">$</span> ${escapeHtml(command)}</pre>${note}</div>`
  }
  const body = payloadHtml(toolCall, false)
  return body ? `<div class="run-detail">${body}</div>` : ''
}

/** 子运行（run_agent）：被叫 agent 的任务、步骤与回答。服务端（sub-run.ts）把它放在这一步的 acp.subRun 里，
 *  步骤是瘦身形态（一行字 + 类型 / 状态 / 时间），完整原始载荷不留 */
export function subRunHtml(raw: unknown): string {
  const s = rec(raw)
  const outcome = s.outcome === 'cancelled' ? '已停止' : s.outcome === 'error' ? '出错' : '完成'
  const metas = [meta('被叫', String(s.label ?? s.agent ?? '')), meta('结果', outcome)]
  if (typeof s.ms === 'number') metas.push(meta('用时', fmtDuration(s.ms)))
  const steps = Array.isArray(s.entries) ? s.entries.map(rec) : []
  const rows = steps.map((e) => {
    const verb = stepVerb(String(e.k ?? ''), typeof e.kind === 'string' ? e.kind : undefined)
    return `<div class="rd-loc">${escapeHtml(`${verb} ${String(e.text ?? '')}${e.status === 'failed' ? ' · 失败' : ''}`)}</div>`
  })
  return (
    `<div class="rd-meta">${metas.join('')}</div>` +
    PRE('交给它的任务', s.task ?? '') +
    (rows.length ? `<div class="rd-item"><div class="rd-label">它做的步骤（${steps.length}）</div>${rows.join('')}</div>` : '') +
    (s.output ? PRE('它的回答', s.output) : '')
  )
}

/** 工具条目的展开详情：状态/父调用/ID、rawInput/rawOutput、content、locations、子代理输出/思考、_meta 及未知字段 */
export function toolDetailHtml(e: ToolEntry): string {
  const acp: Record<string, unknown> = e.acp ?? {}
  const out: string[] = []
  const status = typeof acp.status === 'string' ? acp.status : e.status
  const metas = [meta('状态', status)]
  const parent = e.parentId ?? (typeof acp.parentToolCallId === 'string' ? acp.parentToolCallId : undefined)
  if (parent) metas.push(meta('父调用', parent))
  if (e.id) metas.push(meta('ID', e.id))
  if (typeof acp.name === 'string') metas.push(meta('工具', acp.name))
  out.push(`<div class="rd-meta">${metas.join('')}</div>`)
  if (shown(acp.subRun)) out.push(subRunHtml(acp.subRun))
  out.push(payloadHtml(acp, true))
  if (e.thought) out.push(PRE('子代理思考', e.thought))
  if (e.output) out.push(PRE('子代理输出', e.output))
  if (shown(acp._meta)) out.push(PRE('_meta', acp._meta))
  out.push(
    restItem('其他 ACP 字段', acp, {
      rawInput: true,
      rawOutput: true,
      content: true,
      locations: true,
      _meta: true,
      name: true,
      title: true,
      kind: true,
      status: true,
      subRun: true,
    }),
  )
  if (e.truncated) out.push('<div class="rd-trunc">内容超限，已截断</div>')
  return `<div class="run-detail">${out.join('')}</div>`
}

/** 会话级附加信息：stopReason + 截断提示（info.acp 的原始 JSON 不再展示） */
export function infoHtml(info: RunInfo | undefined): string {
  if (!info) return ''
  const out: string[] = []
  if (info.stopReason) out.push(`<div class="rd-stop">停止原因：${escapeHtml(info.stopReason)}</div>`)
  if (info.truncated) out.push('<div class="rd-trunc">部分内容超限，已截断</div>')
  return out.join('')
}
