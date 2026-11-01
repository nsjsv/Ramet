/* ---------- 划词评论的锚点 + 高亮插件 ----------
 * 锚点不写进文档（viewer 不能写 Y.Doc，PM mark 还会污染历史与 markdown 往返），只存在评论表里，前端解析：
 *   - from = 被评论文字第一个字的 Yjs 相对位置，to = 最后一个字的相对位置（不是区间末端：末端那个位置粘着的是区间后面的字，
 *     别人紧挨着区间末尾打字时高亮会跟着变长）。两者 base64 存储。
 *   - blockId / text / n 是文字兜底（editor/text-anchor.ts）：版本恢复、markdown 往返这类整片重建会让相对位置全部失效，
 *     块 id 靠 carryBlockIds 保住，按块里的字还能找回来。
 *   - 解析：相对位置都能解析且区间里有字 → 用它；否则按文字在块里找；都不行 = 原文已删除（抽屉里显示当时引用的原文）。
 * 高亮插件只画装饰、不加 schema，编辑页（editor-session.ts）与公开页（PublicPage.tsx）都要挂。
 * 远端改动（y-prosemirror 整篇 replace，mapping 不可靠）与串列表变化时按锚点全量重解析；本地改动按 mapping 平移。 */

import * as Y from 'yjs'
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from 'y-prosemirror'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { anchorOfRange, textAnchorRange } from '../editor/text-anchor'
import type { Anchor } from './comments-api'

/** y-prosemirror 绑定里解析相对位置要用的三样东西 */
export type YContext = { doc: Y.Doc; type: Y.XmlFragment; mapping: unknown }

export type Range = { from: number; to: number }

export function yContextOf(state: EditorState): YContext | null {
  const binding = (ySyncPluginKey.getState(state) as { binding?: { doc: Y.Doc; type: Y.XmlFragment; mapping: unknown } | null } | undefined)
    ?.binding
  return binding ? { doc: binding.doc, type: binding.type, mapping: binding.mapping } : null
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** 把选区两端收进有字的地方：选区常以下一个块的开头结束（三击选段），那个位置前面没有字，「最后一个字」会落到块边界上 */
function trimRange(doc: PMNode, from: number, to: number): Range | null {
  while (from < to) {
    const $from = doc.resolve(from)
    if ($from.parent.inlineContent && $from.parentOffset < $from.parent.content.size) break
    from++
  }
  while (to > from) {
    const $to = doc.resolve(to)
    if ($to.parent.inlineContent && $to.parentOffset > 0) break
    to--
  }
  return from < to ? { from, to } : null
}

/** 选区 → 锚点。没有协同绑定、起点不在带 id 的块里、或选中的全是空白时返回 null（这时不能评论） */
export function encodeAnchor(doc: PMNode, y: YContext | null, from: number, to: number): Anchor | null {
  const range = trimRange(doc, from, to)
  if (!y || !range) return null
  const text = anchorOfRange(doc, range.from, range.to)
  if (!text) return null
  const rel = (pos: number): string =>
    toBase64(Y.encodeRelativePosition(absolutePositionToRelativePosition(pos, y.type, y.mapping as never) as Y.RelativePosition))
  return { from: rel(range.from), to: rel(range.to - 1), ...text }
}

/** 相对位置 → 文档位置；gone = 它粘着的那个字已经被删了（这时位置是那个字原来所在处） */
function resolveRel(y: YContext, b64: string): { pos: number; gone: boolean } | null {
  const bytes = fromBase64(b64)
  if (!bytes) return null
  const rel = Y.decodeRelativePosition(bytes)
  let gone = false
  if (rel.item) {
    // 删了又被撤销回来的字是一个新 item（原 item 的 redone 指过去），要跟着走，否则撤销删除后锚点永远算「已删」
    let id = rel.item
    for (let hops = 0; ; hops++) {
      const item = Y.getItem(y.doc.store, id)
      if (!(item instanceof Y.Item)) {
        gone = true
        break
      }
      if (item.redone && hops < 50) {
        id = Y.createID(item.redone.client, item.redone.clock + (id.clock - item.id.clock))
        continue
      }
      gone = item.deleted
      break
    }
  }
  const pos = relativePositionToAbsolutePosition(y.doc, y.type, rel, y.mapping as never)
  return pos == null ? null : { pos, gone }
}

/** 锚点 → 文档区间（规则见文件头）；null = 原文已删除 */
export function resolveAnchor(doc: PMNode, y: YContext | null, anchor: Anchor): Range | null {
  if (y) {
    try {
      const a = resolveRel(y, anchor.from)
      const b = resolveRel(y, anchor.to)
      if (a && b) {
        const to = b.gone ? b.pos : b.pos + 1
        if (a.pos < to && to <= doc.content.size && doc.textBetween(a.pos, to, '', '￼').trim()) return { from: a.pos, to }
      }
    } catch {
      // 相对位置来自别的文档历史（版本恢复前写的）/ 绑定的 mapping 还没跟上：交给文字兜底
    }
  }
  return textAnchorRange(doc, anchor)
}

/** 要画的一个高亮 */
export type CommentMark = { id: string; anchor: Anchor }

type HighlightState = {
  marks: CommentMark[]
  active: string | null
  deco: DecorationSet
  onOpen: ((threadId: string) => void) | null
}

type Meta = { marks: CommentMark[]; active: string | null; onOpen: ((threadId: string) => void) | null }

const highlightKey = new PluginKey<HighlightState>('commentHighlights')

function build(doc: PMNode, y: YContext | null, marks: CommentMark[], active: string | null): DecorationSet {
  const decos: Decoration[] = []
  for (const m of marks) {
    const r = resolveAnchor(doc, y, m.anchor)
    if (!r) continue
    decos.push(Decoration.inline(r.from, r.to, { class: m.id === active ? 'comment-mark is-active' : 'comment-mark', 'data-comment': m.id }))
  }
  return DecorationSet.create(doc, decos)
}

/** 远端改动（含撤销重做、首次同步）：y-prosemirror 的整篇替换让 mapping 失真，要按相对位置重解析 */
function fromYjs(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined
  return !!meta && (meta.isChangeOrigin === true || tr.docChanged)
}

export const commentHighlights = $prose(
  () =>
    new Plugin<HighlightState>({
      key: highlightKey,
      state: {
        init: () => ({ marks: [], active: null, deco: DecorationSet.empty, onOpen: null }),
        apply(tr, value, oldState, newState) {
          const meta = tr.getMeta(highlightKey) as Meta | undefined
          // 插件排在 ySync 之前时 newState 里还取不到它的状态；绑定对象本身不变，退回旧状态取
          const y = (): YContext | null => yContextOf(newState) ?? yContextOf(oldState)
          if (meta) return { ...meta, deco: build(tr.doc, y(), meta.marks, meta.active) }
          if (!tr.docChanged || value.marks.length === 0) return value
          if (fromYjs(tr)) return { ...value, deco: build(tr.doc, y(), value.marks, value.active) }
          return { ...value, deco: value.deco.map(tr.mapping, tr.doc) }
        },
      },
      props: {
        decorations: (state) => highlightKey.getState(state)?.deco,
        handleClick(view, _pos, event) {
          const el = (event.target as Element | null)?.closest?.('[data-comment]')
          const id = el?.getAttribute('data-comment')
          if (!id) return false
          highlightKey.getState(view.state)?.onOpen?.(id)
          return false // 照常落光标（可编辑时用户可能只是想点进这段字）
        },
      },
    }),
)

/** 宿主告诉插件现在要画哪些串、哪个是激活的、点了高亮找谁 */
export function setCommentMarks(view: EditorView, marks: CommentMark[], active: string | null, onOpen: ((threadId: string) => void) | null): void {
  if (view.isDestroyed || !highlightKey.getState(view.state)) return
  view.dispatch(view.state.tr.setMeta(highlightKey, { marks, active, onOpen } satisfies Meta))
}

/** 视图里解析一个锚点（抽屉判「原文已删除」、浮层定位、滚动到锚点都用它） */
export function commentRange(view: EditorView, anchor: Anchor): Range | null {
  return resolveAnchor(view.state.doc, yContextOf(view.state), anchor)
}

/** 把锚定的那段字滚到视口中间；锚点解析不出来、或正文此刻不可见（源码模式把它 display:none）返回 false */
export function scrollToAnchor(view: EditorView, anchor: Anchor): boolean {
  const range = commentRange(view, anchor)
  if (!range || view.dom.getClientRects().length === 0) return false
  const at = view.domAtPos(range.from).node
  const el = at instanceof Element ? at : at.parentElement
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return true
}
