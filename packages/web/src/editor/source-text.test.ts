import { Schema } from '@milkdown/kit/prose/model'
import { expect, test } from 'vitest'
import { sourceOf, textPatches, visibleParsed } from './source-text'

/* 不变量：相邻同类列表条目紧挨成一个列表、其余块空一行；看不见的块（序列化为空）不进文本；
 * 补丁套回旧文必得新文，且只改动变了的行 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    bullet_list: { group: 'block', content: 'text*' },
    ordered_list: { group: 'block', content: 'text*' },
    text: {},
  },
})
const node = (type: string, text: string) => schema.node(type, null, text ? [schema.text(text)] : [])
/** 假序列化器：段落原文、无序 `- `、有序 `1. ` */
const ser = (n: ReturnType<typeof node>) =>
  n.type.name === 'bullet_list' ? `- ${n.textContent}` : n.type.name === 'ordered_list' ? `1. ${n.textContent}` : n.textContent

test('列表条目紧挨、换类型 / 段落之间空一行、空段落不进文本', () => {
  const doc = schema.node('doc', null, [
    node('paragraph', 'intro'),
    node('bullet_list', 'a'),
    node('bullet_list', 'b'),
    node('ordered_list', 'x'),
    node('paragraph', ''),
    node('paragraph', 'end'),
  ])
  const { text, blocks } = sourceOf(doc, ser)
  expect(text).toBe('intro\n\n- a\n- b\n\n1. x\n\nend')
  expect(blocks.map((b) => b.textContent)).toEqual(['intro', 'a', 'b', 'x', 'end'])
  expect(visibleParsed([node('paragraph', ''), node('paragraph', 'k')]).map((b) => b.textContent)).toEqual(['k'])
})

function apply(text: string, patches: ReturnType<typeof textPatches>): string {
  let out = text
  for (const p of [...patches].reverse()) out = out.slice(0, p.from) + p.insert + out.slice(p.to)
  return out
}

test('补丁：只改变了的行，多处改动分开，末行换行差异也算', () => {
  const a = 'one\ntwo\nthree\nfour\nfive'
  const b = 'one\nTWO\nthree\nfour\nfive!\nsix'
  const patches = textPatches(a, b)
  expect(apply(a, patches)).toBe(b)
  expect(patches).toHaveLength(2)
  expect(patches[0]).toEqual({ from: 4, to: 8, insert: 'TWO\n' })
  expect(apply('x', textPatches('x', 'x\n'))).toBe('x\n')
  expect(textPatches('same', 'same')).toEqual([])
  expect(apply('', textPatches('', 'new'))).toBe('new')
  expect(apply('gone\n', textPatches('gone\n', ''))).toBe('')
})
