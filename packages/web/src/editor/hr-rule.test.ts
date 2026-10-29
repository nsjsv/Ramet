import { describe, expect, test } from 'vitest'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { insertHrBefore } from './markdown'
import { doc, li, p, posOf, shape, stateAt, ul } from './test-schema'

// 行首 "---" 输入规则（markdown.ts 的 insertHrBefore）：已打的 "--" 删掉、hr 插在段落之前，
// 段落留作下一行且光标在行首，不能落成 hr 的 NodeSelection（预设规则会落成那样）。

function typeHr(d: ReturnType<typeof doc>) {
  const start = posOf(d, '--')
  return insertHrBefore(stateAt(d, start + 2), start, start + 2)
}

describe('insertHrBefore', () => {
  test('空行打 --- → 分隔线 + 新的一行，光标在新行', () => {
    const tr = typeHr(doc(p('a'), p('--', 'x'), p('b')))!
    expect(shape(tr.doc)).toBe('doc(paragraph("a") hr paragraph#x paragraph("b"))')
    expect(tr.selection).not.toBeInstanceOf(NodeSelection)
    expect(tr.selection.empty).toBe(true)
    expect(tr.selection.$from.parent).toBe(tr.doc.child(2))
  })

  test('文档末尾也有承接的新行', () => {
    const tr = typeHr(doc(p('--')))!
    expect(shape(tr.doc)).toBe('doc(hr paragraph)')
    expect(tr.selection.$from.parent.type.name).toBe('paragraph')
  })

  test('标记后已有文字：文字留在下一行，光标在其行首', () => {
    const tr = typeHr(doc(p('--abc')))!
    expect(shape(tr.doc)).toBe('doc(hr paragraph("abc"))')
    expect(tr.selection.$from.parentOffset).toBe(0)
  })

  test('列表项首段放不下 hr：不转换', () => {
    expect(typeHr(doc(ul(li('a', p('--')))))).toBeNull()
  })
})
