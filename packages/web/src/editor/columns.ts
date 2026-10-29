/* ---------- 分栏 columns > column ----------
 * columns（有块 id）里是 2 栏以上的 column；column 是 isolating 容器（删除 / 合并不穿栏），它的直接子块各自可寻址
 * （@ramet/shared/block-address 的 ADDRESSABLE_CONTAINERS），手柄按横坐标选栏再下钻（block-handle.ts）。
 * markdown 写成 `<!-- columns -->` … `<!-- column -->` … `<!-- /columns -->`（html 注释，别处渲染时看不见，内容按顺序排列），
 * 识别在方言层。布局只靠 CSS（等宽 flex，窄屏竖排），没有 nodeView。块菜单的「取消分栏」把各栏内容按顺序拍平成兄弟块。 */

import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $nodeSchema } from '@milkdown/kit/utils'
import { COLUMN, COLUMNS } from '@ramet/shared/md-dialect'

export const columnsSchema = $nodeSchema('columns', () => ({
  group: 'block',
  content: 'column column+',
  defining: true,
  attrs: { id: { default: '' } },
  parseDOM: [{ tag: 'div[data-columns]' }],
  toDOM: (node) => ['div', { 'data-columns': '', class: 'columns', style: `--cols: ${node.childCount}` }, 0],
  parseMarkdown: {
    match: (node) => node.type === COLUMNS,
    runner: (state, node, type) => {
      state.openNode(type)
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'columns',
    runner: (state, node) => {
      state.addNode('html', undefined, '<!-- columns -->')
      node.forEach((column, _offset, i) => {
        if (i > 0) state.addNode('html', undefined, '<!-- column -->')
        state.next(column.content)
      })
      state.addNode('html', undefined, '<!-- /columns -->')
    },
  },
}))

export const columnSchema = $nodeSchema('column', () => ({
  content: 'block+',
  isolating: true,
  parseDOM: [{ tag: 'div[data-column]' }],
  toDOM: () => ['div', { 'data-column': '', class: 'column' }, 0],
  parseMarkdown: {
    match: (node) => node.type === COLUMN,
    runner: (state, node, type) => {
      state.openNode(type)
      state.next(node.children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'column',
    runner: (state, node) => {
      state.next(node.content) // 只在父节点之外单独序列化时用得到（正常由 columns 的 runner 逐栏写）
    },
  },
}))

/** n 栏，每栏一个空段落 */
export function columnsNode(view: EditorView, count: number): PMNode | null {
  const { columns, column, paragraph } = view.state.schema.nodes
  if (!columns || !column || !paragraph) return null
  return columns.create(null, Array.from({ length: count }, () => column.create(null, paragraph.create())))
}

/** 斜杠「两栏 / 三栏」：光标所在段落是空的就换掉它，否则插在它后面，光标进第一栏 */
export function insertColumns(view: EditorView, count: number): void {
  const node = columnsNode(view, count)
  if (!node) return
  const { $from } = view.state.selection
  const tr = view.state.tr
  let at: number
  if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0 && $from.depth >= 1) {
    at = $from.before()
    tr.replaceWith(at, $from.after(), node)
  } else {
    at = $from.depth >= 1 ? $from.after() : view.state.selection.to
    tr.insert(at, node)
  }
  tr.setSelection(TextSelection.create(tr.doc, at + 3)) // columns 开 + column 开 + 段落开
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** 取消分栏：各栏内容按顺序拍平成兄弟块（栏里的块各有 id，原样带走） */
export function unwrapColumns(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'columns') return
  const blocks: PMNode[] = []
  node.forEach((column) => column.forEach((child) => blocks.push(child)))
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, Fragment.fromArray(blocks))
  const caret = TextSelection.findFrom(tr.doc.resolve(pos), 1, true)
  if (caret) tr.setSelection(caret)
  view.dispatch(tr.scrollIntoView())
  view.focus()
}
