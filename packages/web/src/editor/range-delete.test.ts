import { describe, expect, test } from 'vitest'
import { deleteSelectionCommand } from './range-delete'
import { doc, h, li, p, posOf, reply, run, shape, stateAt, ul, userMsg } from './test-schema'

// 整块盖住的选区删成一个空段落；跨消息块边界的选区不并穿；其余跨段删除交给 PM 默认（返回 false）。

describe('deleteSelectionCommand', () => {
  test('盖住三个整块（首块是列表）：只剩一个空段落，不留空列表壳', () => {
    const d = doc(p('前'), ul(li('a', p('一'))), h('二'), p('三'), p('后'))
    const out = run(stateAt(d, posOf(d, '一'), posOf(d, '三') + 1), deleteSelectionCommand)!
    expect(shape(out.doc)).toBe('doc(paragraph("前") paragraph paragraph("后"))')
    expect(out.state.selection.$from.parent.content.size).toBe(0)
  })

  test('全文整块：剩一个空段落', () => {
    const d = doc(h('一'), p('二'))
    const out = run(stateAt(d, posOf(d, '一'), posOf(d, '二') + 1), deleteSelectionCommand)!
    expect(shape(out.doc)).toBe('doc(paragraph)')
  })

  test('跨消息块边界：两边各删各的，不合并', () => {
    const d = doc(userMsg(p('问题文字')), reply(p('回答前半回答后半')))
    const out = run(stateAt(d, posOf(d, '文字'), posOf(d, '回答后半')), deleteSelectionCommand)!
    expect(shape(out.doc)).toBe('doc(user_message(paragraph("问题")) agent_reply(paragraph("回答后半")))')
  })

  test('从段落选进 AI 回复中间：回复不被并到段落里', () => {
    const d = doc(p('正文甲乙'), reply(p('答一'), p('答二')))
    const out = run(stateAt(d, posOf(d, '乙'), posOf(d, '二')), deleteSelectionCommand)!
    expect(shape(out.doc)).toBe('doc(paragraph("正文甲") agent_reply(paragraph("二")))')
  })

  test('整条消息落在选区中间（两端都不在消息里）：放行默认（消息整块删、两边段落合并是对的）', () => {
    const d = doc(p('甲乙'), userMsg(p('问')), p('丙丁'))
    expect(run(stateAt(d, posOf(d, '乙'), posOf(d, '丁')), deleteSelectionCommand)).toBeNull()
  })

  test('普通跨段（没盖住整块、不涉消息）：放行默认', () => {
    const d = doc(p('甲乙'), p('丙丁'))
    expect(run(stateAt(d, posOf(d, '乙'), posOf(d, '丁')), deleteSelectionCommand)).toBeNull()
  })

  test('同一块内：放行默认', () => {
    const d = doc(p('甲乙丙'))
    expect(run(stateAt(d, posOf(d, '甲'), posOf(d, '丙')), deleteSelectionCommand)).toBeNull()
  })

  test('消息块内部的整块：替换成空段落，消息块留着', () => {
    const d = doc(reply(p('一'), h('二'), p('三')))
    const out = run(stateAt(d, posOf(d, '一'), posOf(d, '二') + 1), deleteSelectionCommand)!
    expect(shape(out.doc)).toBe('doc(agent_reply(paragraph paragraph("三")))')
  })
})
