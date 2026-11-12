import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { agentPickRoute, commentRangeAt } from './doc-mention-ai'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'paragraph block*' },
    user_message: { group: 'block', content: 'paragraph+' },
  },
})
const n = schema.nodes
const p = (text = '') => n.paragraph!.create(null, text ? schema.text(text) : null)
const doc = (...blocks: PMNode[]) => n.doc!.create(null, blocks)

/** 第 k 个文本块（文档序）的内容范围 */
function blockRange(d: PMNode, k: number): { from: number; to: number } {
  const all: Array<{ from: number; to: number }> = []
  d.descendants((node, at) => {
    if (node.isTextblock) all.push({ from: at + 1, to: at + 1 + node.content.size })
    return true
  })
  return all[k]!
}

describe('选中 agent 怎么落', () => {
  it('普通段落里的空间 AI 开评论框；`>>` 消息块里、或别的 agent 一律插 chip', () => {
    expect(agentPickRoute('ramet:space-ai', false)).toBe('comment')
    expect(agentPickRoute('ramet:space-ai', true)).toBe('chip')
    expect(agentPickRoute('ramet:assistant', false)).toBe('chip')
    expect(agentPickRoute('codex', false)).toBe('chip')
  })
})

describe('评论框锚在哪一段', () => {
  it('当前段有字：就是这一段的整段', () => {
    const d = doc(p('第一段'), p('这里有字'))
    const r = blockRange(d, 1)
    expect(commentRangeAt(d, r.to)).toEqual(r)
    expect(commentRangeAt(d, r.from)).toEqual(r)
  })

  it('当前段没字（`@AI` 删掉之后空了）：往前找最近一个有字的段', () => {
    const d = doc(p('最早'), p('前一段'), p('  '), p())
    expect(commentRangeAt(d, blockRange(d, 3).from)).toEqual(blockRange(d, 1))
  })

  it('列表里也按文档序往前找；后面的段不算', () => {
    const d = doc(p('标题'), n.bullet_list!.create(null, [n.list_item!.create(null, [p('条目一')]), n.list_item!.create(null, [p()])]), p('后面'))
    expect(commentRangeAt(d, blockRange(d, 2).from)).toEqual(blockRange(d, 1))
  })

  it('前面都没有字：null', () => {
    const d = doc(p(), p(), p('后面才有'))
    expect(commentRangeAt(d, blockRange(d, 1).from)).toBeNull()
  })
})
