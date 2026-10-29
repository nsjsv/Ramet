import { describe, expect, test } from 'vitest'
import { indentCommand, outdentCommand } from './list-indent'
import { code, doc, li, ol, p, posOf, run, shape, stateAt, todo, ul } from './test-schema'

// 顶层单条目列表下 Tab 也能把条目挂到前一条下面；
// 反缩进只退嵌套条目；代码块里 Tab 按行缩进；其余位置返回 false 交给后面的 keymap。

describe('indentCommand：列表', () => {
  test('顶层单条目：挂到前一个列表的条目下面，新建同类型子列表', () => {
    const d = doc(ul(li('a', p('一'))), ul(li('b', p('二'))))
    const out = run(stateAt(d, posOf(d, '二')), indentCommand)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一") bullet_list(list_item#b(paragraph("二"))))))')
    expect(out.state.selection.$from.parent.textContent).toBe('二')
  })

  test('前一条已有同类型子列表：追加为它的最后一条', () => {
    const d = doc(ul(li('a', p('一'), ul(li('c', p('子'))))), ul(li('b', p('二'))))
    const out = run(stateAt(d, posOf(d, '二')), indentCommand)!
    expect(shape(out.doc)).toBe(
      'doc(bullet_list(list_item#a(paragraph("一") bullet_list(list_item#c(paragraph("子")) list_item#b(paragraph("二"))))))',
    )
  })

  test('有序挂到无序下面：子列表保持有序', () => {
    const d = doc(ul(li('a', p('一'))), ol(li('b', p('二'))))
    const out = run(stateAt(d, posOf(d, '二')), indentCommand)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一") ordered_list(list_item#b(paragraph("二"))))))')
  })

  test('待办的勾选状态跟着走', () => {
    const d = doc(ul(todo('a', false, p('一'))), ul(todo('b', true, p('二'))))
    const out = run(stateAt(d, posOf(d, '二')), indentCommand)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a[ ](paragraph("一") bullet_list(list_item#b[x](paragraph("二"))))))')
  })

  test('选区盖住两条：两条都挂到第一条下面', () => {
    const d = doc(ul(li('a', p('一'))), ul(li('b', p('二'))), ul(li('c', p('三'))))
    const out = run(stateAt(d, posOf(d, '二'), posOf(d, '三') + 1), indentCommand)!
    expect(shape(out.doc)).toBe(
      'doc(bullet_list(list_item#a(paragraph("一") bullet_list(list_item#b(paragraph("二")) list_item#c(paragraph("三"))))))',
    )
    expect(out.state.selection.$from.parent.textContent).toBe('二')
    expect(out.state.selection.$to.parent.textContent).toBe('三')
  })

  test('第一条（前面不是列表）：吞键不改文档', () => {
    const d = doc(p('前'), ul(li('a', p('一'))))
    let dispatched = false
    expect(indentCommand(stateAt(d, posOf(d, '一')), () => (dispatched = true))).toBe(true)
    expect(dispatched).toBe(false)
  })

  test('不在列表里：不拦', () => {
    const d = doc(p('正文'))
    expect(indentCommand(stateAt(d, posOf(d, '正文')))).toBe(false)
  })
})

describe('outdentCommand：列表', () => {
  test('嵌套条目退一级', () => {
    const d = doc(ul(li('a', p('一'), ul(li('b', p('二'))))))
    const out = run(stateAt(d, posOf(d, '二')), outdentCommand)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一")) list_item#b(paragraph("二"))))')
  })

  test('顶层条目：吞键不动', () => {
    const d = doc(ul(li('a', p('一'))))
    let dispatched = false
    expect(outdentCommand(stateAt(d, posOf(d, '一')), () => (dispatched = true))).toBe(true)
    expect(dispatched).toBe(false)
  })
})

describe('代码块缩进', () => {
  test('折叠光标：就地插两个空格', () => {
    const d = doc(code('ab'))
    const out = run(stateAt(d, posOf(d, 'b')), indentCommand)!
    expect(out.doc.textContent).toBe('a  b')
  })

  test('跨行选区：每行行首加两个空格，选到下一行行首不算那一行', () => {
    const d = doc(code('x\ny\nz'))
    const start = posOf(d, 'x')
    const out = run(stateAt(d, start, posOf(d, 'z')), indentCommand)!
    expect(out.doc.textContent).toBe('  x\n  y\nz')
  })

  test('反缩进：去掉至多两个空格', () => {
    const d = doc(code('    x\n y\nz'))
    const start = posOf(d, '    x')
    const out = run(stateAt(d, start, posOf(d, 'z') + 1), outdentCommand)!
    expect(out.doc.textContent).toBe('  x\ny\nz')
  })
})
