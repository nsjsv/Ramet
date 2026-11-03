/* ---------- 公式编辑器的纯逻辑：出错区段、接受补全、插入函数、函数说明的检索、预览用哪一行、摘要（FormulaEditor.tsx 用） ----------
 * 补全候选与校验本身在 shared（complete / checkFormula），这里只管编辑器里怎么用它们。 */
import { FUNCTION_DOCS, type CollectionRow, type CollectionSchema, type CollectionView, type FormulaError, type FunctionGroup, type Suggestion } from '@ramet/shared/collection-model'
import { groupOrder } from '@ramet/shared/collection-query'
import { FORMULA_FN_DOCS } from './formula-docs'

/** 出错区段标红用的三段：位置是 UTF-16 下标（同 checkFormula）。空区段（如「少了右括号」指在末尾）至少标一个字，
 *  在末尾时标一个空格，不然什么都看不见 */
export function markParts(text: string, at: FormulaError['at']): { before: string; mark: string; after: string } | null {
  if (!at) return null
  const start = Math.max(0, Math.min(at[0], text.length))
  let end = Math.max(start, Math.min(at[1], text.length))
  if (end === start && start < text.length) end = start + 1
  return { before: text.slice(0, start), mark: text.slice(start, end) || ' ', after: text.slice(end) }
}

export type Edit = { text: string; caret: number }

/** 把 [from, to) 换成 insert，光标落在插入的字后面 */
export function insertText(text: string, from: number, to: number, insert: string): Edit {
  const a = Math.max(0, Math.min(from, text.length))
  const b = Math.max(a, Math.min(to, text.length))
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length }
}

/** 接受一个补全：函数名后面已经有左括号（改名字时）就不再补一个，光标越过它 */
export function applySuggestion(text: string, s: Suggestion): Edit {
  if (s.insert.endsWith('(') && text[s.to] === '(') {
    const out = insertText(text, s.from, s.to, s.insert.slice(0, -1))
    return { text: out.text, caret: out.caret + 1 }
  }
  return insertText(text, s.from, s.to, s.insert)
}

/** 补全列表里上下移动（到头绕回） */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((index + delta) % count) + count) % count
}

export type FnEntry = { name: string; signature: string; desc: string; example: string }
export type FnGroup = { group: FunctionGroup; items: FnEntry[] }

/** 侧栏的函数说明：按类分组（类与函数的顺序同 FUNCTION_DOCS），按函数名或说明里的字检索（不分大小写） */
export function docGroups(query: string): FnGroup[] {
  const q = query.trim().toLowerCase()
  const groups: FnGroup[] = []
  for (const doc of FUNCTION_DOCS) {
    const extra = Object.hasOwn(FORMULA_FN_DOCS, doc.name) ? FORMULA_FN_DOCS[doc.name]! : { desc: '', example: '' }
    if (q && !doc.name.toLowerCase().includes(q) && !extra.desc.toLowerCase().includes(q)) continue
    let group = groups.find((g) => g.group === doc.group)
    if (!group) {
      group = { group: doc.group, items: [] }
      groups.push(group)
    }
    group.items.push({ name: doc.name, signature: doc.signature, ...extra })
  }
  return groups
}

type WindowSource = { windowState: (viewId: string, scope?: { group?: string }) => { window: { rows: CollectionRow[] } | null } }

/** 预览用的行：这个视图已加载的第一行（不按组取的窗口；看板按组取，挨列找第一张卡片）。日历 / 时间线按日期范围取，
 *  没有现成的一行可拿 = undefined（预览不为它另发请求） */
export function previewRow(source: WindowSource, schema: CollectionSchema, view: CollectionView): CollectionRow | undefined {
  const first = source.windowState(view.id).window?.rows[0]
  if (first || view.groupBy === null) return first
  for (const group of groupOrder(schema, view.groupBy)) {
    const row = source.windowState(view.id, { group }).window?.rows[0]
    if (row) return row
  }
  return undefined
}

/** 属性设置里的公式摘要：空白（含换行）并成一个空格，超长截断加省略号（按码点，不切开半个 emoji） */
export function summary(display: string, max = 48): string {
  const flat = display.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}
