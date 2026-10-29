/* ---------- 编辑器纯函数单测共用的最小 schema ----------
 * 节点名与 attrs 对齐真实 schema（commonmark / gfm 预设 + 自有块），只保留命令要用到的部分。
 * 只给 *.test.ts 用，不进运行时代码。 */

import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'

const id = { default: '' }
const cellAttrs = { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, alignment: { default: 'left' } }

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*', attrs: { id } },
    heading: { group: 'block', content: 'inline*', attrs: { id, level: { default: 1 } } },
    code_block: { group: 'block', content: 'text*', marks: '', code: true, attrs: { id, language: { default: '' } } },
    hr: { group: 'block', atom: true, attrs: { id } },
    blockquote: { group: 'block', content: 'block+', attrs: { id } },
    callout: { group: 'block', content: 'block+', attrs: { id, kind: { default: 'note' } } },
    toggle: { group: 'block', content: 'paragraph block*', attrs: { id } },
    bullet_list: { group: 'block', content: 'list_item+', attrs: { id, spread: { default: false } } },
    ordered_list: { group: 'block', content: 'list_item+', attrs: { id, order: { default: 1 }, spread: { default: false } } },
    list_item: { content: 'paragraph block*', attrs: { id, checked: { default: null } } },
    table: { group: 'block', content: 'table_header_row table_row+', tableRole: 'table', isolating: true, attrs: { id, colwidths: { default: '' } } },
    table_header_row: { content: '(table_header)*', tableRole: 'row' },
    table_row: { content: '(table_cell)*', tableRole: 'row' },
    table_header: { content: 'paragraph', tableRole: 'header_cell', isolating: true, attrs: cellAttrs },
    table_cell: { content: 'paragraph', tableRole: 'cell', isolating: true, attrs: cellAttrs },
    user_message: { group: 'block', content: 'block+', attrs: { id } },
    agent_reply: { group: 'block', content: 'block+', attrs: { id } },
  },
  marks: {
    link: { attrs: { href: {}, title: { default: null } }, inclusive: false },
    strong: {},
  },
})

const n = schema.nodes
export const p = (text = '', pid = '') => n.paragraph!.create({ id: pid }, text ? schema.text(text) : null)
export const h = (text: string, level = 1, hid = '') => n.heading!.create({ id: hid, level }, text ? schema.text(text) : null)
export const code = (text = '', cid = '') => n.code_block!.create({ id: cid }, text ? schema.text(text) : null)
export const li = (lid: string, ...content: PMNode[]) => n.list_item!.create({ id: lid }, content)
export const todo = (lid: string, checked: boolean, ...content: PMNode[]) => n.list_item!.create({ id: lid, checked }, content)
export const ul = (...items: PMNode[]) => n.bullet_list!.create(null, items)
export const ol = (...items: PMNode[]) => n.ordered_list!.create(null, items)
export const quote = (...blocks: PMNode[]) => n.blockquote!.create(null, blocks)
export const callout = (cid: string, ...blocks: PMNode[]) => n.callout!.create({ id: cid }, blocks)
export const toggle = (...blocks: PMNode[]) => n.toggle!.create(null, blocks)
export const userMsg = (...blocks: PMNode[]) => n.user_message!.create(null, blocks)
export const reply = (...blocks: PMNode[]) => n.agent_reply!.create(null, blocks)
export const doc = (...blocks: PMNode[]) => n.doc!.create(null, blocks)

/** 文档里第 n 次出现 marker 文字的位置（marker 本身是文字的一部分；返回其第一个字符之前的位置） */
export function posOf(d: PMNode, marker: string, nth = 0): number {
  let found = -1
  let count = 0
  d.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText) {
      let i = node.text!.indexOf(marker)
      while (i >= 0) {
        if (count === nth) {
          found = pos + i
          return false
        }
        count += 1
        i = node.text!.indexOf(marker, i + 1)
      }
    }
    return true
  })
  if (found < 0) throw new Error(`没有 ${marker}`)
  return found
}

/** 光标在 pos（或选区 anchor..head）的编辑器状态 */
export function stateAt(d: PMNode, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc: d, selection: TextSelection.create(d, anchor, head) })
}

/** 跑命令，返回结果文档（没 dispatch 返回 null） */
export function run(
  state: EditorState,
  command: (s: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
): { doc: PMNode; state: EditorState } | null {
  let out: { doc: PMNode; state: EditorState } | null = null
  command(state, (tr) => {
    const next = state.apply(tr)
    out = { doc: next.doc, state: next }
  })
  return out
}

/** 文档形状的紧凑写法：类型(文字 | 子块…)，attrs 只写 id（非空时）与 checked（非 null 时） */
export function shape(node: PMNode): string {
  if (node.isText) return JSON.stringify(node.text)
  const tags: string[] = []
  if (typeof node.attrs.id === 'string' && node.attrs.id) tags.push(`#${node.attrs.id}`)
  if (node.attrs.checked !== undefined && node.attrs.checked !== null) tags.push(node.attrs.checked ? '[x]' : '[ ]')
  const head = node.type.name + tags.join('')
  if (node.childCount === 0) return head
  const kids: string[] = []
  node.forEach((child) => kids.push(shape(child)))
  return `${head}(${kids.join(' ')})`
}
