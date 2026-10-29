// ---------- 源码模式的 CodeMirror 6 配置：markdown 原文 + 排版样式 ----------
// 装饰依据编辑器自己的 remark 处理器（remarkCtx：gfm + 方言的数学扩展）解析出的 mdast 位置，
// 与写回解析是同一套 markdown 方言，不另带一套语法。最近一次解析的装饰放在 mdDeco 字段里，
// 文本变化后 HIGHLIGHT_MS 防抖重算，期间旧装饰随改动映射。样式类全部在 styles/source-mode.css：
//   标题行按级别放大（行装饰），加粗 / 斜体 / 删除线 / 行内码就地呈现，记号（# ** > - 围栏 …）淡色，
//   链接文字着色、(url) 淡色，代码块 / 公式块 / 表格行等宽，html 标签与注释淡色缩小，`[!…]` 标记段强调色。
// 编辑器随内容长高（不设高度、不出内部滚动条），视口计算跟着页面滚动走。

import {
  Annotation,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import type { TextPatch } from './source-text'

/** mdast 里用得到的部分（remark 解析结果，带源码偏移） */
export interface MdNode {
  type: string
  depth?: number
  /** link / image */
  url?: string
  alt?: string | null
  /** html */
  value?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MdNode[]
}

export type MdParse = (text: string) => MdNode

const HIGHLIGHT_MS = 120

/** 回流 / 规范化写入的事务：不算本地编辑 */
const remoteSync = Annotation.define<boolean>()

const markCache = new Map<string, Decoration>()
const lineCache = new Map<string, Decoration>()
const markDeco = (cls: string): Decoration => {
  let d = markCache.get(cls)
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })))
  return d
}
const lineDeco = (cls: string): Decoration => {
  let d = lineCache.get(cls)
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })))
  return d
}

const span = (node: MdNode | undefined): [number, number] | null => {
  const s = node?.position?.start.offset
  const e = node?.position?.end.offset
  return s === undefined || e === undefined ? null : [s, e]
}

const INLINE_CLASS: Record<string, string> = { strong: 'cm-md-strong', emphasis: 'cm-md-em', delete: 'cm-md-del' }

/** mdast → 装饰 */
function decorate(doc: Text, root: MdNode): DecorationSet {
  const out: Range<Decoration>[] = []
  const len = doc.length
  const mark = (cls: string, from: number, to: number): void => {
    if (from >= 0 && to <= len && to > from) out.push(markDeco(cls).range(from, to))
  }
  const lines = (cls: string, from: number, to: number): void => {
    if (from < 0 || from > len) return
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
      out.push(lineDeco(cls).range(line.from))
      if (line.to >= Math.min(to, len) || line.number >= doc.lines) break
    }
  }
  /** 行首记号（引用的 `>`、列表的 `-` / `1.` / `- [ ]`）：在 [from, to) 内逐行匹配 */
  const linePrefix = (cls: string, from: number, to: number, re: RegExp): void => {
    if (from < 0 || from > len) return
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
      const hit = re.exec(line.text)
      if (hit) mark(cls, line.from + hit.index, line.from + hit.index + hit[0].length)
      if (line.to >= Math.min(to, len) || line.number >= doc.lines) break
    }
  }

  const walk = (node: MdNode): void => {
    const range = span(node)
    const kids = node.children ?? []
    if (range) {
      const [s, e] = range
      const first = span(kids[0])
      const last = span(kids[kids.length - 1])
      switch (node.type) {
        case 'heading': {
          lines(`cm-md-h${Math.min(6, Math.max(1, node.depth ?? 1))}`, s, e)
          if (doc.sliceString(s, s + 1) === '#') mark('cm-md-mark', s, first ? first[0] : e)
          else if (last) mark('cm-md-mark', last[1], e) // setext：下划线那一行
          break
        }
        case 'strong':
        case 'emphasis':
        case 'delete': {
          mark(INLINE_CLASS[node.type]!, s, e)
          if (first && last) {
            mark('cm-md-mark', s, first[0])
            mark('cm-md-mark', last[1], e)
          }
          break
        }
        case 'inlineCode':
        case 'inlineMath': {
          mark('cm-md-code', s, e)
          const fence = /^[`$]+/.exec(doc.sliceString(s, Math.min(e, s + 16)))?.[0].length ?? 0
          if (fence) {
            mark('cm-md-mark', s, s + fence)
            mark('cm-md-mark', e - fence, e)
          }
          break
        }
        case 'link': {
          if (first && last && first[0] > s) {
            mark('cm-md-mark', s, first[0])
            mark('cm-md-link', first[0], last[1])
            mark('cm-md-url', last[1], e)
          } else mark('cm-md-link', s, e) // 自动链接 / 裸 URL
          break
        }
        case 'image':
        case 'definition':
          mark('cm-md-url', s, e)
          break
        case 'blockquote':
          linePrefix('cm-md-mark', s, e, /^[ \t]*(?:>[ \t]?)+/)
          linePrefix('cm-md-callout', s, e, /(?<=^[ \t]*(?:>[ \t]?)+)\[![^\]\n]*\]/)
          break
        case 'listItem':
          linePrefix('cm-md-list', s, Math.min(e, doc.lineAt(s).to), /(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?(?=[ \t]|$)/)
          break
        case 'code':
        case 'math': {
          lines('cm-md-codeline', s, e)
          const head = doc.lineAt(s)
          const tail = doc.lineAt(Math.max(s, Math.min(e, len)))
          if (/^[ \t]*(?:`{3,}|~{3,}|\${2,})/.test(head.text)) mark('cm-md-fence', head.from, head.to)
          if (tail.number > head.number && /^[ \t]*(?:`{3,}|~{3,}|\${2,})[ \t]*$/.test(tail.text)) mark('cm-md-fence', tail.from, tail.to)
          return
        }
        case 'table':
          lines('cm-md-table', s, e)
          break
        case 'html':
          mark('cm-md-html', s, e)
          return
        case 'thematicBreak':
          mark('cm-md-mark', s, e)
          return
      }
    }
    kids.forEach(walk)
  }
  walk(root)
  return Decoration.set(out, true)
}

const mdParser = Facet.define<MdParse, MdParse | null>({ combine: (values) => values[0] ?? null })
const setDeco = StateEffect.define<DecorationSet>()

function analyze(doc: Text, parse: MdParse | null): DecorationSet {
  if (!parse) return Decoration.none
  try {
    return decorate(doc, parse(doc.toString()))
  } catch (err) {
    console.warn('[source] markdown 解析失败', err)
    return Decoration.none
  }
}

/** 最近一次解析出的样式装饰；解析之后的改动按 changes 映射，防抖重解析时整份换掉 */
const mdDeco = StateField.define<DecorationSet>({
  create: (state) => analyze(state.doc, state.facet(mdParser)),
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setDeco)) return e.value
    return tr.docChanged ? deco.map(tr.changes) : deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const reparse = ViewPlugin.fromClass(
  class {
    timer = 0
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate): void {
      if (!u.docChanged) return
      window.clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.run(), HIGHLIGHT_MS)
    }
    run(): void {
      if (this.view.composing) {
        // 组字中换装饰会打断输入法，组字完再算
        this.timer = window.setTimeout(() => this.run(), HIGHLIGHT_MS)
        return
      }
      const state = this.view.state
      this.view.dispatch({ effects: setDeco.of(analyze(state.doc, state.facet(mdParser))) })
    }
    destroy(): void {
      window.clearTimeout(this.timer)
    }
  },
)

/** 布局覆盖：透明底、正文字体、零内边距、不出内部滚动条（随内容长高，滚动交给页面）。写在主题里才压得住 CodeMirror 的基础主题 */
const layout = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: 'inherit', overflow: 'visible' },
  '.cm-content': { padding: '0', caretColor: 'var(--ink)', minHeight: 'calc(100vh - 336px)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--accent-tint)',
  },
})

export interface SourceCmOptions {
  parse: MdParse
  readOnly: boolean
  /** 本地编辑（回流写入不算） */
  onLocalEdit: () => void
  onBlur: () => void
}

export function sourceExtensions(opts: SourceCmOptions): Extension[] {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    layout,
    EditorState.readOnly.of(opts.readOnly),
    EditorView.editable.of(!opts.readOnly),
    EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': '源码' }),
    mdParser.of(opts.parse),
    mdDeco,
    reparse,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(remoteSync))) opts.onLocalEdit()
      if (u.focusChanged && !u.view.hasFocus) opts.onBlur()
    }),
  ]
}

/** 回流：套用最小补丁，不进撤销栈（撤销历史随补丁映射），不算本地编辑 */
export function applyPatches(view: EditorView, patches: readonly TextPatch[]): void {
  if (!patches.length) return
  view.dispatch({
    changes: patches.map((p) => ({ from: p.from, to: p.to, insert: p.insert })),
    annotations: [remoteSync.of(true), Transaction.addToHistory.of(false)],
  })
}
