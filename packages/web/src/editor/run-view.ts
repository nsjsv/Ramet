// ---------- 步骤展开后的常规展示：一步做了什么 ----------
// 执行命令 = `$ 命令` + 输出；读文件 = 路径 + 内容；修改 = 路径 + 逐行着色 diff；搜索 / 抓取 = 关键词或网址 + 结果；
// 子代理 = 任务 / 步骤 / 回答；其余 = 结果文字。认不出的形状一律退回结果文字，不猜；什么都没有就说没有。
// 数据只经 viewOf 读（与协议无关的步骤视图，老记录由它从原始载荷推出）；原样载荷收在「高级」里（run-detail.ts 的 toolDetailHtml）。
// 过程页步骤块（run-step-view.ts）与回复里运行中的托盘（run-tray.ts）共用。全部内容经 escapeHtml。

import { subRunOf, viewOf, type RunEntry, type ToolEntry, type ToolView } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { foldDiff, lineDiff } from './line-diff'
import { subRunHtml } from './run-detail'
import { entryObject, escapeHtml } from './run-format'

/** 去掉整段包着的 ``` 围栏（agent 常把文件内容 / 命令输出包成代码块） */
function unfence(text: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return m ? (m[1] ?? '') : text
}

/** 结果文字：视图里的结果 → 子代理 / 终端的实时输出 */
function resultText(e: ToolEntry, v: ToolView): string {
  return v.result !== undefined ? unfence(v.result) : (e.output ?? '')
}

/** 文件路径：视图里的主路径 → 列表行上的 detail */
function pathOf(e: ToolEntry, v: ToolView): string {
  return v.path || e.detail || ''
}

const pathRow = (path: string): string =>
  path ? `<div class="rv-path">${iconSvg('file', 13)}<span>${escapeHtml(path)}</span></div>` : ''

const outBlock = (text: string): string => (text ? `<pre class="rv-out">${escapeHtml(text)}</pre>` : '')

/** 一段 diff：路径头 + 逐行（+ / - / 空格）+ 折叠的未变行 */
function diffBlock(path: string, oldText: string, newText: string): string {
  const lines = foldDiff(lineDiff(oldText, newText)).map((l) => {
    if (l.t === '…') return `<div class="rv-dl is-fold">${escapeHtml(COPY.run.unchangedLines(l.n))}</div>`
    const cls = l.t === '+' ? ' is-add' : l.t === '-' ? ' is-del' : ''
    return `<div class="rv-dl${cls}"><span class="rv-sign">${l.t === ' ' ? '' : l.t}</span><span class="rv-code">${escapeHtml(l.s)}</span></div>`
  })
  return `<div class="rv-diff">${pathRow(path)}<div class="rv-lines">${lines.join('')}</div></div>`
}

/** 修改类：视图里的 diff（逐个）→ 路径 + 结果文字 */
function editView(e: ToolEntry, v: ToolView): string {
  if (v.diffs?.length) return v.diffs.map((d) => diffBlock(d.path || e.detail || '', d.old, d.new)).join('')
  return pathRow(pathOf(e, v)) + outBlock(resultText(e, v))
}

function commandView(e: ToolEntry, v: ToolView): string {
  const command = v.command || entryObject(e)
  const desc = v.description ?? ''
  const code = v.exit?.code ?? null
  const ended = code ? COPY.run.exitCode(code) : v.exit?.signal ? COPY.run.killedBy(v.exit.signal) : ''
  return (
    `<pre class="rv-cmd"><span class="rv-prompt">$</span> ${escapeHtml(command)}</pre>` +
    (desc ? `<div class="rv-note">${escapeHtml(desc)}</div>` : '') +
    outBlock(resultText(e, v)) +
    (ended ? `<div class="rv-note is-bad">${escapeHtml(ended)}</div>` : '')
  )
}

/** 搜索 / 抓取：查询词或网址一行（+ 搜索范围）+ 结果 */
function queryView(e: ToolEntry, v: ToolView): string {
  const q = v.query || entryObject(e)
  const where = v.cwd ?? ''
  return (
    `<div class="rv-query">${iconSvg(e.kind === 'fetch' ? 'globe' : 'search', 13)}<span>${escapeHtml(q)}</span>` +
    (where ? `<span class="rv-where">${escapeHtml(where)}</span>` : '') +
    `</div>` +
    outBlock(resultText(e, v))
  )
}

/** 工具步骤的常规展示 */
export function toolViewHtml(e: ToolEntry): string {
  const v = viewOf(e)
  const sub = subRunOf(e)
  let body: string
  if (sub !== undefined) body = subRunHtml(sub)
  else if (e.kind === 'execute') body = commandView(e, v)
  else if (e.kind === 'read') body = pathRow(pathOf(e, v)) + outBlock(resultText(e, v))
  else if (e.kind === 'edit' || e.kind === 'delete' || e.kind === 'move') body = editView(e, v)
  else if (e.kind === 'search' || e.kind === 'fetch') body = queryView(e, v)
  else body = outBlock(resultText(e, v))
  const fail = e.status === 'failed' ? `<div class="rv-fail">${escapeHtml(e.note ? `${COPY.run.stepFailed}：${e.note}` : COPY.run.stepFailed)}</div>` : ''
  const empty = body.replace(/<[^>]*>/g, '').trim() === '' ? `<div class="rv-empty">${escapeHtml(COPY.run.noResult)}</div>` : ''
  const trunc = e.truncated ? `<div class="rd-trunc">${escapeHtml(COPY.run.truncated)}</div>` : ''
  return fail + body + empty + trunc
}

/** 一步的常规展示：工具按类型画；思考 / 说明 = 全文（只读）。entry 缺（record 里找不到这一步）给一句说明 */
export function stepViewHtml(entry: RunEntry | undefined, k: string, text: string): string {
  if (k === 'tool') return entry?.k === 'tool' ? toolViewHtml(entry) : `<div class="rv-empty">${escapeHtml(COPY.run.noRecord)}</div>`
  const trunc = entry && entry.k !== 'tool' && entry.truncated ? `<div class="rd-trunc">${escapeHtml(COPY.run.truncated)}</div>` : ''
  return `<div class="rv-text">${escapeHtml(text)}</div>${trunc}`
}

/** 「高级」开关（卡片底部的小号灰字按钮）；data-act="adv" 由宿主的点击委托处理 */
export function advToggleHtml(open: boolean): string {
  return `<button type="button" class="run-adv-toggle" data-act="adv" aria-expanded="${String(open)}">${escapeHtml(COPY.run.advanced)}${iconSvg('chevron', 11)}</button>`
}
