// ---------- 一轮 run 的原始调用详情（步骤展开后的「高级」；状态条、过程页、公开过程页共用） ----------
// 常规展示（命令 + 输出 / 读文件 / diff）在 run-view.ts，这里只管 agent 原样给了什么就画什么那一层（viewOf 的 raw）。
// 只读原始数据，不猜、不估算，未知 / 非文本数据一律 escapeHtml + 可读 JSON。
// 长内容不在这里截断（后端已限长），靠 .rd-pre 的滚动区显示。
// 是否需要重画由调用方的指纹决定（live-reply 的 sig / run-board 的 React 渲染），这里只产出 HTML。
import { acpToolView, isPlanApproval, stepVerb, subRunOf, viewOf, type RunInfo, type ToolDiff, type ToolEntry, type ToolView } from '@ramet/shared/run-model'
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

/** 原样载荷是任意 JSON：非对象一律当空对象，读取处再逐个 typeof 收窄 */
function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 一段 diff：路径 + 删掉的（红）+ 新的（绿）；old 为空 = 新建，不画红块 */
function diffItem(d: ToolDiff): string {
  const head = `<div class="rd-label">diff · ${escapeHtml(d.path)}</div>`
  const del = d.old ? `<pre class="rd-pre rd-del">${escapeHtml(d.old)}</pre>` : ''
  return `<div class="rd-item">${head}${del}<pre class="rd-pre rd-add">${escapeHtml(d.new)}</pre></div>`
}

/** 审批预览的载荷：输入（可选）/ diff / 结果文字 / 路径 */
function viewPayloadHtml(v: ToolView, withInput: boolean): string {
  const out: string[] = []
  if (withInput && v.raw && shown(v.raw.input)) out.push(PRE('输入', v.raw.input))
  for (const d of v.diffs ?? []) out.push(diffItem(d))
  if (v.result !== undefined) out.push(`<div class="rd-item"><div class="rd-label">内容</div><pre class="rd-pre">${escapeHtml(v.result)}</pre></div>`)
  if (v.path) out.push(`<div class="rd-item"><div class="rd-label">位置</div><div class="rd-loc">${escapeHtml(v.path)}</div></div>`)
  return out.join('')
}

/** 审批卡要预览的视图：事件带了 view 就以它为准，缺的字段（含原样输入）从原始 toolCall 推 */
export function permissionView(req: { view?: ToolView; toolCall?: Record<string, unknown> }): ToolView | undefined {
  if (!req.toolCall) return req.view
  const base = acpToolView(req.toolCall)
  return req.view ? { ...base, ...req.view } : base
}

/** 审批卡的预览（不猜）：有命令 → 等宽 `$ cmd`（+ 说明一行灰字）；否则画输入 / diff / 内容 / 路径
 *  （编辑类审批就是看到 diff 和路径）；都没有 → 空串。
 *  计划审批不画输入：输入是同一份计划的 JSON 转义，再画一遍只会把计划挤成一行 */
export function permissionPreviewHtml(req: { view?: ToolView; toolCall?: Record<string, unknown> }): string {
  const v = permissionView(req)
  if (!v) return ''
  if (isPlanApproval(req.toolCall)) {
    const body = viewPayloadHtml(v, false)
    return body ? `<div class="run-detail">${body}</div>` : ''
  }
  if (v.command) {
    const note = v.description ? `<div class="rd-cmd-note">${escapeHtml(v.description)}</div>` : ''
    return `<div class="run-detail"><pre class="rd-pre rd-cmd"><span class="rd-cmd-prompt">$</span> ${escapeHtml(v.command)}</pre>${note}</div>`
  }
  const body = viewPayloadHtml(v, true)
  return body ? `<div class="run-detail">${body}</div>` : ''
}

/** 子运行（run_agent）：被叫 agent 的任务、步骤与回答（服务端 sub-run.ts 写在这一步上，subRunOf 取），
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

/** 工具条目的展开详情：状态 / 父调用 / ID / 工具名、子运行、原样输入输出、子代理输出 / 思考、其余原样字段 */
export function toolDetailHtml(e: ToolEntry): string {
  const v = viewOf(e)
  const raw = v.raw ?? {}
  const out: string[] = []
  const metas = [meta('状态', e.status)]
  if (e.parentId) metas.push(meta('父调用', e.parentId))
  if (e.id) metas.push(meta('ID', e.id))
  if (v.tool) metas.push(meta('工具', v.tool))
  out.push(`<div class="rd-meta">${metas.join('')}</div>`)
  const sub = subRunOf(e)
  if (shown(sub)) out.push(subRunHtml(sub))
  if (shown(raw.input)) out.push(PRE('输入', raw.input))
  if (shown(raw.output)) out.push(PRE('输出', raw.output))
  if (e.thought) out.push(PRE('子代理思考', e.thought))
  if (e.output) out.push(PRE('子代理输出', e.output))
  for (const [k, value] of Object.entries(raw.extra ?? {})) out.push(PRE(k, value))
  if (e.truncated) out.push('<div class="rd-trunc">内容超限，已截断</div>')
  return `<div class="run-detail">${out.join('')}</div>`
}

/** 会话级附加信息：stopReason + 截断提示（info 里协议原样的元数据不再展示） */
export function infoHtml(info: RunInfo | undefined): string {
  if (!info) return ''
  const out: string[] = []
  if (info.stopReason) out.push(`<div class="rd-stop">停止原因：${escapeHtml(info.stopReason)}</div>`)
  if (info.truncated) out.push('<div class="rd-trunc">部分内容超限，已截断</div>')
  return out.join('')
}
