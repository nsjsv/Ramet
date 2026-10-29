import { describe, expect, test } from 'vitest'
import { turnRangeTr, turnUnits, type TurnAction } from './block-turn'
import { callout, code, doc, h, li, p, posOf, quote, reply, shape, stateAt, todo, toggle, ul } from './test-schema'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

// 单块与多块同一实现，多块逐个转换，目标是引用时整段包进一个引用，块 id 落到转换后承担这一块的节点上（见 block-turn.ts 文件头）。

const para: TurnAction = { kind: 'text', typeName: 'paragraph', attrs: {} }
const h2: TurnAction = { kind: 'text', typeName: 'heading', attrs: { level: 2 } }
const bullet: TurnAction = { kind: 'wrap', wrap: 'bullet_list' }
const todoAction: TurnAction = { kind: 'wrap', wrap: 'todo' }
const quoteAction: TurnAction = { kind: 'wrap', wrap: 'blockquote' }

function turn(d: PMNode, from: number, to: number, action: TurnAction): string {
  const tr = stateAt(d, 1).tr
  turnRangeTr(tr, from, to, action)
  return shape(tr.doc)
}

/** 第 i 个顶层块的 [起点, 终点) */
function block(d: PMNode, i: number): { from: number; to: number } {
  let off = 0
  for (let k = 0; k < i; k++) off += d.child(k).nodeSize
  return { from: off, to: off + d.child(i).nodeSize }
}

describe('turnRangeTr：单块', () => {
  test('段落 → 标题，id 保留', () => {
    const d = doc(p('甲', 'x'))
    expect(turn(d, 0, d.child(0).nodeSize, h2)).toBe('doc(heading#x("甲"))')
  })

  test('段落 → 待办：条目继承段落的 id', () => {
    const d = doc(p('甲', 'x'))
    expect(turn(d, 0, d.child(0).nodeSize, todoAction)).toBe('doc(bullet_list(list_item#x[ ](paragraph("甲"))))')
  })

  test('列表项 → 正文：段落继承条目 id', () => {
    const d = doc(ul(li('a', p('一'))))
    const itemPos = 1
    expect(turn(d, itemPos, itemPos + d.child(0).child(0).nodeSize, para)).toBe('doc(paragraph#a("一"))')
  })

  test('列表项 → 待办：只改壳', () => {
    const d = doc(ul(li('a', p('一'))))
    expect(turn(d, 1, 1 + d.child(0).child(0).nodeSize, todoAction)).toBe('doc(bullet_list(list_item#a[ ](paragraph("一"))))')
  })

  test('引用 → 无序列表：拍平后每段一个列表', () => {
    const d = doc(quote(p('甲'), p('乙')))
    expect(turn(d, 0, d.child(0).nodeSize, bullet)).toBe(
      'doc(bullet_list(list_item(paragraph("甲"))) bullet_list(list_item(paragraph("乙"))))',
    )
  })

  test('代码块 → 无序列表：文字搬过去', () => {
    const d = doc(code('x = 1'))
    expect(turn(d, 0, d.child(0).nodeSize, bullet)).toBe('doc(bullet_list(list_item(paragraph("x = 1"))))')
  })
})

describe('turnRangeTr：多块', () => {
  test('三块 → 标题：每块都转', () => {
    const d = doc(p('甲'), ul(li('a', p('一'))), p('乙'))
    expect(turn(d, 0, d.content.size, h2)).toBe('doc(heading("甲") heading#a("一") heading("乙"))')
  })

  test('三块 → 待办：各自成单条目列表', () => {
    const d = doc(p('甲', 'x'), h('乙', 1, 'y'))
    expect(turn(d, 0, d.content.size, todoAction)).toBe(
      'doc(bullet_list(list_item#x[ ](paragraph("甲"))) bullet_list(list_item#y[ ](paragraph("乙"))))',
    )
  })

  test('多块 → 引用：整段包进一个引用，列表项先拆成正文', () => {
    const d = doc(p('甲', 'x'), ul(todo('a', false, p('一'))), p('乙'))
    expect(turn(d, 0, d.content.size, quoteAction)).toBe('doc(blockquote#x(paragraph("甲") paragraph#a("一") paragraph("乙")))')
  })

  test('只转区间里的块', () => {
    const d = doc(p('甲'), p('乙'), p('丙'))
    const r = { from: block(d, 1).from, to: block(d, 2).to }
    expect(turn(d, r.from, r.to, h2)).toBe('doc(paragraph("甲") heading("乙") heading("丙"))')
  })
})

describe('turnUnits', () => {
  test('消息块、原子块不参与；列表下钻到条目', () => {
    const d = doc(p('甲'), reply(p('答')), ul(li('a', p('一'))))
    expect(turnUnits(d, 0, d.content.size)).toEqual([0, block(d, 2).from + 1])
  })

  test('单节点区间：只有它自己', () => {
    const d = doc(p('甲'), p('乙'))
    expect(turnUnits(d, block(d, 1).from, block(d, 1).to)).toEqual([block(d, 1).from])
    expect(posOf(d, '乙')).toBe(block(d, 1).from + 1)
  })
})

describe('turnRangeTr：提示框 / 折叠块', () => {
  test('段落 → 提示框：提示框继承段落 id', () => {
    const d = doc(p('甲', 'x'))
    expect(turn(d, 0, d.child(0).nodeSize, { kind: 'wrap', wrap: 'callout' })).toBe('doc(callout#x(paragraph("甲")))')
  })

  test('标题 → 折叠块：摘要必须是段落，字不变', () => {
    const d = doc(h('标题', 2, 'x'))
    expect(turn(d, 0, d.child(0).nodeSize, { kind: 'wrap', wrap: 'toggle' })).toBe('doc(toggle#x(paragraph("标题")))')
  })

  test('多块 → 折叠块：第一块当摘要，其余进正文', () => {
    const d = doc(p('一', 'x'), ul(li('a', p('二'))), p('三'))
    expect(turn(d, 0, d.content.size, { kind: 'wrap', wrap: 'toggle' })).toBe('doc(toggle#x(paragraph("一") paragraph#a("二") paragraph("三")))')
  })

  test('提示框 / 折叠块 → 正文：拍平', () => {
    const c = doc(callout('c', p('一'), p('二')))
    expect(turn(c, 0, c.child(0).nodeSize, para)).toBe('doc(paragraph#c("一") paragraph("二"))')
    const t = doc(toggle(p('摘要'), p('内容')))
    expect(turn(t, 0, t.child(0).nodeSize, para)).toBe('doc(paragraph("摘要") paragraph("内容"))')
  })

  test('引用 → 提示框：拍平后整段包进去', () => {
    const d = doc(quote(p('甲'), p('乙')))
    expect(turn(d, 0, d.child(0).nodeSize, { kind: 'wrap', wrap: 'callout' })).toBe('doc(callout(paragraph("甲") paragraph("乙")))')
  })
})
