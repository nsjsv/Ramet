/* ---------- 文字定位链接：`/page/<页>?block=<块>&text=<片段>[&n=<第几处>]` ----------
 * 块仍是主锚：只认 `block` 的客户端自然退回整块定位；`text` / `n` 是块内的精确位置。
 *   - 复制：框选菜单「复制链接」调 anchorOfRange，取选区起点所在的最近可寻址块（判定同 @ramet/shared/block-address）
 *     + 落在这个块里的那段字（跨块选区只取起点块里的部分，最多 TEXT_ANCHOR_MAX 字）+ 它是块里第几处同样的字。
 *   - 打开：Editor / PublicPage 读参数后调 focusTextAnchor，在块的文字里找第 n 处（不够 n 处取第一处），
 *     高亮并滚到视口中间；块在、字找不到（被改过）退回整块闪烁（focusBlockById）；块都不在返回 false（调用方再试）。
 *   - 高亮：textFlash 插件的 inline decoration（.text-link-flash 淡出），位置按 tr.mapping 跟着文档走，约 2.6s 后清掉。
 * 块的文字是块内所有 text 节点加带 leafText 的行内原子，按文档序直接拼（块之间不加分隔），复制与查找同一口径。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { isAddressable } from '@ramet/shared/block-address'
import { findBlock, focusBlockById } from './block-id'

/** 链接里带的字数上限：再长只取前这么多（高亮也只高亮这一段） */
export const TEXT_ANCHOR_MAX = 300

/** 高亮停留时长（含 CSS 淡出，见 editor-widgets.css 的 .text-link-flash） */
const FLASH_MS = 2600

export type TextAnchor = { blockId: string; text: string; n: number }

type Part = { text: string; start: number; atom: boolean }

/** 块里能读到的字，逐段记下文档位置（text 节点每个字一个位置；原子整体一个位置） */
function partsOf(block: PMNode, blockPos: number): Part[] {
  const parts: Part[] = []
  block.descendants((child, offset) => {
    const start = blockPos + 1 + offset
    if (child.isText) {
      if (child.text) parts.push({ text: child.text, start, atom: false })
    } else if (child.isLeaf && child.isInline) {
      const leafText = child.type.spec.leafText
      const text = leafText ? leafText(child) : ''
      if (text) parts.push({ text, start, atom: true })
    }
    return true
  })
  return parts
}

/** 文档位置 → 块文字里的偏移（落在两段之间 = 后一段的开头） */
function offsetAt(parts: Part[], pos: number): number {
  let acc = 0
  for (const p of parts) {
    if (pos <= p.start) return acc
    if (!p.atom && pos < p.start + p.text.length) return acc + (pos - p.start)
    acc += p.text.length
  }
  return acc
}

/** 块文字里 [a, b) → 文档位置区间（原子按整个节点算） */
function rangeAt(parts: Part[], a: number, b: number): { from: number; to: number } | null {
  let from = -1
  let to = -1
  let acc = 0
  for (const p of parts) {
    const end = acc + p.text.length
    if (from < 0 && a < end) from = p.atom ? p.start : p.start + (a - acc)
    if (b <= end) {
      to = p.atom ? p.start + 1 : p.start + (b - acc)
      break
    }
    acc = end
  }
  return from >= 0 && to > from ? { from, to } : null
}

/** text 在 hay 里出现的全部起点（允许重叠，同一处不重复计） */
function indicesOf(hay: string, text: string): number[] {
  const out: number[] = []
  for (let i = hay.indexOf(text); i !== -1; i = hay.indexOf(text, i + 1)) out.push(i)
  return out
}

/** pos 所在的最近可寻址块（判定同 @ramet/shared/block-address；withId 为真时还要求块已经有 id）。
 *  框选工具栏的转换 / 引用与复制链接都用它找这段字属于哪个块 */
export function addressableAt(doc: PMNode, pos: number, withId = true): { node: PMNode; pos: number; end: number } | null {
  const $pos = doc.resolve(pos)
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    const id: unknown = node.attrs.id
    if (!isAddressable(node.type.name, d === 1 ? null : $pos.node(d - 1).type.name)) continue
    if (withId && (typeof id !== 'string' || !id)) continue
    return { node, pos: $pos.before(d), end: $pos.end(d) }
  }
  return null
}

/** 文档里 [from, to) 这段字的定位锚。起点不在任何带 id 的可寻址块里、或那段字全是空白时返回 null */
export function anchorOfRange(doc: PMNode, from: number, to: number): TextAnchor | null {
  const block = addressableAt(doc, from)
  if (!block) return null
  const parts = partsOf(block.node, block.pos)
  const whole = parts.map((p) => p.text).join('')
  const a = offsetAt(parts, from)
  const b = offsetAt(parts, Math.min(to, block.end))
  const text = whole.slice(a, Math.min(b, a + TEXT_ANCHOR_MAX))
  if (!text.trim()) return null
  return { blockId: String(block.node.attrs.id), text, n: indicesOf(whole, text).filter((i) => i < a).length }
}

/** 块里第 n 处 text 的文档区间（不够 n 处取第一处，一处都没有返回 null） */
export function findTextInBlock(block: PMNode, blockPos: number, text: string, n: number): { from: number; to: number } | null {
  if (!text) return null
  const parts = partsOf(block, blockPos)
  const hits = indicesOf(parts.map((p) => p.text).join(''), text)
  const at = hits[n] ?? hits[0]
  return at === undefined ? null : rangeAt(parts, at, at + text.length)
}

/** 链接：同源绝对地址（跨端粘贴也能打开）；第一处不带 n */
export function textLinkHref(pageId: string, a: TextAnchor): string {
  return `${location.origin}/page/${pageId}?block=${a.blockId}&text=${encodeURIComponent(a.text)}${a.n ? `&n=${a.n}` : ''}`
}

/** 从 URL 参数读块内锚，没有 text 返回 null（只做块定位） */
export function textParam(params: URLSearchParams): { text: string; n: number } | null {
  const text = params.get('text')
  if (!text) return null
  const n = Number(params.get('n') ?? 0)
  return { text, n: Number.isInteger(n) && n > 0 ? n : 0 }
}

const flashKey = new PluginKey<DecorationSet>('textFlash')

/** 每个视图一个清除定时器：连着定位两次，上一次的定时器不能提前清掉这一次的高亮 */
const flashTimers = new WeakMap<EditorView, number>()

/** 高亮插件：meta 为区间就画，为 null 就清，其余事务跟着映射。编辑器与公开页都要挂 */
export const textFlash = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: flashKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const meta = tr.getMeta(flashKey) as { from: number; to: number } | null | undefined
          if (meta === null) return DecorationSet.empty
          if (meta) return DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'text-link-flash' })])
          return set.map(tr.mapping, tr.doc)
        },
      },
      props: { decorations: (state) => flashKey.getState(state) },
    }),
)

/** 定位到块里的那段字：高亮并滚到视口中间。块不在返回 false（调用方等下一次时机再试）；
 *  块在、字找不到退回整块闪烁，照样算定位成功 */
export function focusTextAnchor(view: EditorView, blockId: string, anchor: { text: string; n: number }): boolean {
  const found = findBlock(view.state.doc, blockId)
  if (!found) return false
  const range = findTextInBlock(found.node, found.pos, anchor.text, anchor.n)
  if (!range) return focusBlockById(view, blockId)
  view.dispatch(view.state.tr.setMeta(flashKey, range))
  const mark = view.dom.querySelector('.text-link-flash')
  const at = view.domAtPos(range.from).node
  const target = mark ?? (at instanceof Element ? at : at.parentElement)
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.clearTimeout(flashTimers.get(view))
  flashTimers.set(
    view,
    window.setTimeout(() => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, null))
    }, FLASH_MS),
  )
  return true
}
