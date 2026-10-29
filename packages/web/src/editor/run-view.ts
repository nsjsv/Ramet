// ---------- 步骤展开后的常规展示：一步做了什么 ----------
// 执行命令 = `$ 命令` + 输出；读文件 = 路径 + 内容；修改 = 路径 + 逐行着色 diff；搜索 / 抓取 = 关键词或网址 + 结果；
// 子代理 = 任务 / 步骤 / 回答；其余 = 结果文字。认不出的形状一律退回结果文字，不猜；什么都没有就说没有。
// 原始调用信息（rawInput / rawOutput / _meta …）收在每一步的「高级」里（run-detail.ts 的 toolDetailHtml）。
// 过程页步骤块（run-step-view.ts）与回复里运行中的托盘（run-tray.ts）共用。全部内容经 escapeHtml。

import type { RunEntry, ToolEntry } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { foldDiff, lineDiff } from './line-diff'
import { commandOf, rec, subRunHtml } from './run-detail'
import { entryObject, escapeHtml } from './run-format'
import { stepExit } from './step-terminal'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 去掉整段包着的 ``` 围栏（agent 常把文件内容 / 命令输出包成代码块） */
function unfence(text: string): string {
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return m ? (m[1] ?? '') : text
}

/** 结果文字：content 里的文字块 → rawOutput 是字符串 → rawOutput 里常见的输出字段 → 子代理输出 */
function resultText(e: ToolEntry): string {
  const acp = rec(e.acp)
  const texts: string[] = []
  if (Array.isArray(acp.content)) {
    for (const raw of acp.content) {
      const c = rec(raw)
      const inner = rec(c.content)
      if (c.type === 'content' && typeof inner.text === 'string') texts.push(inner.text)
    }
  }
  if (texts.length) return unfence(texts.join('\n'))
  const out = acp.rawOutput
  if (typeof out === 'string') return unfence(out)
  const o = rec(out)
  const fields = ['output', 'formatted_output', 'aggregated_output', 'stdout', 'stderr', 'result', 'content', 'text']
    .map((k) => str(o[k]))
    .filter(Boolean)
  if (fields.length) return unfence(fields.join('\n'))
  return e.output ?? ''
}

/** 文件路径：locations 第一条 → rawInput 里常见的路径字段 → 列表行上的 detail */
function pathOf(e: ToolEntry): string {
  const acp = rec(e.acp)
  if (Array.isArray(acp.locations)) {
    const first = rec(acp.locations[0])
    if (typeof first.path === 'string' && first.path) return first.path
  }
  const input = rec(acp.rawInput)
  for (const k of ['file_path', 'path', 'filePath', 'abs_path', 'notebook_path']) {
    const v = str(input[k])
    if (v) return v
  }
  return e.detail ?? ''
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

/** 修改类：content 里的 diff → rawInput 的 old_string / new_string → rawInput.content（整份写入）→ 结果文字 */
function editView(e: ToolEntry): string {
  const acp = rec(e.acp)
  const diffs = (Array.isArray(acp.content) ? acp.content : []).map(rec).filter((c) => c.type === 'diff')
  if (diffs.length) return diffs.map((d) => diffBlock(str(d.path) || pathOf(e), str(d.oldText), str(d.newText))).join('')
  const input = rec(acp.rawInput)
  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    return diffBlock(pathOf(e), str(input.old_string), str(input.new_string))
  }
  if (typeof input.content === 'string') return diffBlock(pathOf(e), '', input.content)
  return pathRow(pathOf(e)) + outBlock(resultText(e))
}

function commandView(e: ToolEntry): string {
  const input = rec(rec(e.acp).rawInput)
  const command = commandOf(input) || entryObject(e)
  const desc = str(input.description).trim()
  const raw = rec(rec(e.acp).rawOutput)
  // ACP 终端里的命令：退出状态是服务端补的 acp.terminalExit；别的 agent 的命令看 rawOutput 里常见的退出码字段
  const term = stepExit(e)
  const code = term ? term.exitCode : typeof raw.exit_code === 'number' ? raw.exit_code : typeof raw.exitCode === 'number' ? raw.exitCode : null
  const ended = code ? COPY.run.exitCode(code) : term?.signal ? COPY.run.killedBy(term.signal) : ''
  return (
    `<pre class="rv-cmd"><span class="rv-prompt">$</span> ${escapeHtml(command)}</pre>` +
    (desc ? `<div class="rv-note">${escapeHtml(desc)}</div>` : '') +
    outBlock(resultText(e)) +
    (ended ? `<div class="rv-note is-bad">${escapeHtml(ended)}</div>` : '')
  )
}

/** 搜索 / 抓取：查询词或网址一行 + 结果 */
function queryView(e: ToolEntry): string {
  const input = rec(rec(e.acp).rawInput)
  const q = ['pattern', 'query', 'url', 'glob', 'search'].map((k) => str(input[k])).find(Boolean) || entryObject(e)
  const where = str(input.path)
  return (
    `<div class="rv-query">${iconSvg(e.kind === 'fetch' ? 'globe' : 'search', 13)}<span>${escapeHtml(q)}</span>` +
    (where ? `<span class="rv-where">${escapeHtml(where)}</span>` : '') +
    `</div>` +
    outBlock(resultText(e))
  )
}

/** 工具步骤的常规展示 */
export function toolViewHtml(e: ToolEntry): string {
  const acp = rec(e.acp)
  let body: string
  if (acp.subRun !== undefined) body = subRunHtml(acp.subRun)
  else if (e.kind === 'execute') body = commandView(e)
  else if (e.kind === 'read') body = pathRow(pathOf(e)) + outBlock(resultText(e))
  else if (e.kind === 'edit' || e.kind === 'delete' || e.kind === 'move') body = editView(e)
  else if (e.kind === 'search' || e.kind === 'fetch') body = queryView(e)
  else body = outBlock(resultText(e))
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
