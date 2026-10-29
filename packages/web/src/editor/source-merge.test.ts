import { Schema, type Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { expect, test } from 'vitest'
import { alignBase, applyMerge, applyWhole, hasChanges, planMerge } from './source-merge'

/* 不变量：只替换本端改过的顶层块；没改的块零操作；改了的块保住 id 与 markdown 表达不了的属性；
 * 远端同期改的其它块保留、远端删掉的没改块不复活、远端删掉的改动块插回原处；看不见的空段落不碰；全删也留一个段落 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', attrs: { id: { default: '' } } },
    heading: { group: 'block', content: 'text*', attrs: { id: { default: '' }, level: { default: 1 } } },
    /** 有一个 markdown 表达得了的属性（kind）和一个表达不了的（author） */
    note: { group: 'block', content: 'paragraph+', attrs: { id: { default: '' }, kind: { default: 'a' }, author: { default: '' } } },
    text: {},
  },
})

/** 文档里的块（带 id） */
const p = (text: string, id = '') => schema.node('paragraph', { id }, text ? [schema.text(text)] : [])
const h = (text: string, level: number, id = '') => schema.node('heading', { id, level }, [schema.text(text)])
const note = (text: string, attrs: { id?: string; kind?: string; author?: string }) => schema.node('note', attrs, [p(text)])
/** 解析结果（没有 id）：同内容的文档块去掉 id */
const parsed = (node: PMNode): PMNode => {
  const strip = (n: PMNode): PMNode =>
    n.isText ? n : n.type.create({ ...n.attrs, ...('id' in n.attrs ? { id: '' } : {}), ...('author' in n.attrs ? { author: '' } : {}) }, n.content.content.map(strip), n.marks)
  return strip(node)
}
const docOf = (...blocks: PMNode[]) => schema.node('doc', null, blocks)

function merged(current: PMNode, base: PMNode[], user: PMNode[]): PMNode {
  const baseParsed = base.map(parsed)
  expect(alignBase(base, baseParsed)).toBe(-1)
  const tr = EditorState.create({ doc: current }).tr
  applyMerge(tr, planMerge(base, baseParsed, user))
  return tr.doc
}
const view = (doc: PMNode) => doc.content.content.map((n) => `${n.attrs.id || '?'}:${n.textContent}`)

test('没改：全是 keep，文档不变', () => {
  const base = [p('a', 'a'), h('t', 2, 'b')]
  const ops = planMerge(base, base.map(parsed), base.map(parsed))
  expect(hasChanges(ops)).toBe(false)
})

test('改字：原位替换且保住 id；改标题级别生效', () => {
  const base = [p('a', 'a'), h('t', 2, 'b'), p('c', 'c')]
  const out = merged(docOf(...base), base, [parsed(p('a2')), parsed(h('t', 3)), parsed(p('c'))])
  expect(view(out)).toEqual(['a:a2', 'b:t', 'c:c'])
  expect(out.child(1).attrs.level).toBe(3)
})

test('改了的块：markdown 表达不了的属性保留，用户真改的属性生效', () => {
  const base = [note('x', { id: 'n', kind: 'a', author: 'u1' })]
  const out = merged(docOf(...base), base, [parsed(note('y', { kind: 'b' }))])
  expect(out.child(0).attrs).toEqual({ id: 'n', kind: 'b', author: 'u1' })
  expect(out.child(0).textContent).toBe('y')
})

test('拆段：第一块保住 id，新段落插在它后面；并段：留下第一块的 id', () => {
  const base = [p('ab', 'a'), p('z', 'z')]
  expect(view(merged(docOf(...base), base, [parsed(p('a')), parsed(p('b')), parsed(p('z'))]))).toEqual(['a:a', '?:b', 'z:z'])
  const base2 = [p('a', 'a'), p('b', 'b'), p('z', 'z')]
  expect(view(merged(docOf(...base2), base2, [parsed(p('ab')), parsed(p('z'))]))).toEqual(['a:ab', 'z:z'])
})

test('顶部新增、末尾新增、删除', () => {
  const base = [p('a', 'a'), p('b', 'b')]
  expect(view(merged(docOf(...base), base, [parsed(p('new')), parsed(p('a')), parsed(p('b')), parsed(p('end'))]))).toEqual([
    '?:new',
    'a:a',
    'b:b',
    '?:end',
  ])
  expect(view(merged(docOf(...base), base, [parsed(p('b'))]))).toEqual(['b:b'])
})

test('远端同期改了别的块：保留远端版本；远端插的新块也保留', () => {
  const base = [p('a', 'a'), p('b', 'b'), p('c', 'c')]
  const current = docOf(p('a', 'a'), p('remote', 'r'), p('B远端', 'b'), p('c', 'c'))
  const out = merged(current, base, [parsed(p('a本端')), parsed(p('b')), parsed(p('c'))])
  expect(view(out)).toEqual(['a:a本端', 'r:remote', 'b:B远端', 'c:c'])
})

test('同一块双方都改：本端为准', () => {
  const base = [p('a', 'a')]
  expect(view(merged(docOf(p('远端', 'a')), base, [parsed(p('本端'))]))).toEqual(['a:本端'])
})

test('远端删了本端改的块：插回上一个落定块之后；远端删了本端没改的块：不复活', () => {
  const base = [p('a', 'a'), p('b', 'b'), p('c', 'c')]
  const current = docOf(p('a', 'a'), p('c', 'c'))
  expect(view(merged(current, base, [parsed(p('a')), parsed(p('b改')), parsed(p('c'))]))).toEqual(['a:a', 'b:b改', 'c:c'])
  expect(view(merged(current, base, [parsed(p('a')), parsed(p('b')), parsed(p('c改'))]))).toEqual(['a:a', 'c:c改'])
})

test('看不见的空段落不碰；本端新增插在锚点紧后', () => {
  const base = [p('a', 'a'), p('b', 'b')]
  const current = docOf(p('a', 'a'), p('', 'e'), p('b', 'b'))
  expect(view(merged(current, base, [parsed(p('a')), parsed(p('x')), parsed(p('b'))]))).toEqual(['a:a', '?:x', 'e:', 'b:b'])
})

test('整篇换成新内容：不多垫空段落；旧块全删', () => {
  const base = [p('a', 'a'), p('b', 'b')]
  expect(view(merged(docOf(...base), base, [parsed(h('x', 1)), parsed(h('y', 2))]))).toEqual(['?:x', '?:y'])
})

test('全删：文档留一个空段落', () => {
  const base = [p('a', 'a'), p('b', 'b')]
  const out = merged(docOf(...base), base, [])
  expect(out.childCount).toBe(1)
  expect(out.child(0).type.name).toBe('paragraph')
  expect(out.child(0).content.size).toBe(0)
})

test('alignBase：数量 / 类型对不上、缺 id、重复 id 都报出位置', () => {
  expect(alignBase([p('a', 'a')], [parsed(p('a')), parsed(p('b'))])).toBe(1)
  expect(alignBase([p('a', 'a')], [parsed(h('a', 1))])).toBe(0)
  expect(alignBase([p('a', '')], [parsed(p('a'))])).toBe(0)
  expect(alignBase([p('a', 'x'), p('b', 'x')], [parsed(p('a')), parsed(p('b'))])).toBe(1)
})

test('整篇退路：没改的块保住 id，按位置一一对应的改动块也保住', () => {
  const tr = EditorState.create({ doc: docOf(p('a', 'a'), p('b', 'b')) }).tr
  applyWhole(tr, [parsed(p('a')), parsed(p('b改'))])
  expect(view(tr.doc)).toEqual(['a:a', 'b:b改'])
})
