/* ---------- 代码查看器里的 ⌘J：选中行、替换行、就地 diff 的纯函数 ----------
 * 行号一律 1 起、闭区间 [from, to]。文本按 `\n` 切行，行尾的 `\r` 算在这一行里（CRLF 文件改完仍是 CRLF）。
 * 这里只算文字，不碰 DOM / 网络：选区怎么从页面上取、结果怎么写回，在 use-code-quick.tsx。 */

import type { DiffLine } from './diff-parse'

/** 一次最多送给模型的选中文字（服务端 TEXT_MAX 同值）：超了就让用户少选几行，而不是悄悄截断 */
export const CODE_SELECTION_MAX = 20_000
/** 前后文给模型多少字（服务端再按行截到 40 行 / 2000 字） */
const CONTEXT_CHARS = 2000

export interface LineRange {
  from: number
  to: number
}

/** 每行连同它的行尾（`\n` 或 `\r\n`）一起切；最后一行没有换行就没有行尾。空文本 = 没有行 */
function splitKeepEol(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/)
}

const withoutEol = (line: string): string => line.replace(/\r?\n$/, '')

/** 字符偏移 [start, end) → 它盖住的行。终点落在行首（刚好选到上一行的换行为止）不算选了那一行；
 *  空选区 / 全是空白的选区返回 null（模型没有可改的东西） */
export function selectionLines(text: string, start: number, end: number): LineRange | null {
  const a = Math.max(0, Math.min(start, end))
  const b = Math.min(text.length, Math.max(start, end))
  if (b <= a) return null
  const lineAt = (offset: number): number => {
    let n = 1
    for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++
    return n
  }
  const from = lineAt(a)
  // 终点前一个字符所在的行（终点在行首时，前一个字符是上一行的换行）
  const to = Math.max(from, lineAt(b - 1))
  const picked = selectedText(text, { from, to })
  return picked.trim() === '' ? null : { from, to }
}

/** 这几行的原文（带行尾，最后一行若在文件末尾且没有换行就没有） */
export function selectedText(text: string, r: LineRange): string {
  return splitKeepEol(text).slice(r.from - 1, r.to).join('')
}

/** 给模型的前后文：选区之前 / 之后各取靠近选区的一小段 */
export function contextAround(text: string, r: LineRange): { text: string; before: string; after: string } {
  const lines = splitKeepEol(text)
  return {
    text: lines.slice(r.from - 1, r.to).join(''),
    before: lines.slice(0, r.from - 1).join('').slice(-CONTEXT_CHARS),
    after: lines.slice(r.to).join('').slice(0, CONTEXT_CHARS),
  }
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/

/** 模型的原始输出 → 用来替换这几行的代码。去掉整段外面包的代码块围栏（提示词禁止，但模型偶尔还是会包）和首尾的空行；
 *  原文自己就带围栏（比如在改 markdown 里的代码块）时围栏是内容，一律不剥。
 *  partial = 流式生成中：围栏还没收尾，开头那一行围栏也先不画。清理完是空的返回 ''（调用方当"没有结果"） */
export function cleanReplacement(raw: string, original: string, partial = false): string {
  let s = raw.replace(/\r\n/g, '\n')
  if (!/^[ \t]*(`{3,}|~{3,})/m.test(original)) {
    const trimmed = s.replace(/^\n+|\n+$/g, '')
    const fenced = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/.exec(trimmed)
    if (fenced) s = fenced[2] ?? ''
    else if (partial && FENCE_LINE.test(trimmed)) s = trimmed.includes('\n') ? trimmed.slice(trimmed.indexOf('\n') + 1) : ''
  }
  return s.replace(/^\n+/, '').replace(/\n+$/, '')
}

/** 把 [from, to] 行换成 replacement（已清理过的），保持文件原有的换行风格：CRLF 文件里新行也用 CRLF；
 *  被换的最后一行在文件末尾没有换行，新内容末尾也不加。replacement 是空 = 删掉这几行 */
export function replaceLines(text: string, r: LineRange, replacement: string): string {
  const lines = splitKeepEol(text)
  const crlf = /\r\n/.test(text)
  const last = lines[r.to - 1] ?? ''
  const eol = last.endsWith('\r\n') ? '\r\n' : last.endsWith('\n') ? '\n' : ''
  const body = (crlf ? replacement.replace(/\r?\n/g, '\r\n') : replacement.replace(/\r\n/g, '\n'))
  const middle = body === '' ? '' : body + eol
  return lines.slice(0, r.from - 1).join('') + middle + lines.slice(r.to).join('')
}

/** 就地 diff 的行：被换掉的原文（del）+ 新内容（add），前后各留几行不变的上下文。
 *  trim = true（生成完之后）再把头尾没变的行挪回上下文，只标真正改了的；生成中不挪（后面还没写完，尾部对不上） */
export function previewRows(text: string, r: LineRange, replacement: string, opts: { trim: boolean; context?: number }): DiffLine[] {
  const ctx = opts.context ?? 3
  const all = splitKeepEol(text).map(withoutEol)
  const oldLines = all.slice(r.from - 1, r.to)
  const newLines = replacement === '' ? [] : replacement.split('\n')
  let head = 0
  let tail = 0
  if (opts.trim) {
    while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
    while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  }
  const rows: DiffLine[] = []
  const firstCtx = Math.max(1, r.from - ctx)
  if (firstCtx > 1) rows.push({ kind: 'hunk', text: '' })
  for (let n = firstCtx; n < r.from; n++) rows.push({ kind: 'ctx', text: all[n - 1] ?? '', old: n, new: n })
  // new 行号：选区之前的行数没变，所以新旧行号在选区开头是对齐的
  for (let i = 0; i < head; i++) rows.push({ kind: 'ctx', text: oldLines[i] ?? '', old: r.from + i, new: r.from + i })
  for (let i = head; i < oldLines.length - tail; i++) rows.push({ kind: 'del', text: oldLines[i] ?? '', old: r.from + i })
  for (let i = head; i < newLines.length - tail; i++) rows.push({ kind: 'add', text: newLines[i] ?? '', new: r.from + i })
  const shift = newLines.length - oldLines.length
  for (let i = oldLines.length - tail; i < oldLines.length; i++) {
    rows.push({ kind: 'ctx', text: oldLines[i] ?? '', old: r.from + i, new: r.from + i + shift })
  }
  const lastCtx = Math.min(all.length, r.to + ctx)
  for (let n = r.to + 1; n <= lastCtx; n++) rows.push({ kind: 'ctx', text: all[n - 1] ?? '', old: n, new: n + shift })
  if (lastCtx < all.length) rows.push({ kind: 'hunk', text: '' })
  return rows
}
