import { describe, expect, test } from 'vitest'
import { mergeIntoPrevious, stripBlockStyle } from './block-backspace'
import { callout, code, doc, h, li, ol, p, posOf, quote, reply, run, shape, stateAt, todo, toggle, ul, userMsg } from './test-schema'

// 不变量（见 block-backspace.ts 文件头）：块首第一次退格去掉这一块的样式，第二次才与上一块合并；
// 不在样式块的第一个文字位置一律不拦（返回 false 交给后面的 keymap）。

function strip(d: ReturnType<typeof doc>, marker: string) {
  const state = stateAt(d, posOf(d, marker))
  return run(state, stripBlockStyle)
}

describe('stripBlockStyle：去样式', () => {
  test('上一块也是列表时，块首退格把这一条变正文（不并进上一条）', () => {
    const d = doc(ul(li('a', p('一'))), ul(li('b', p('二'))))
    const out = strip(d, '二')!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一"))) paragraph#b("二"))')
    expect(out.state.selection.$from.parent.textContent).toBe('二')
  })

  test('空列表项退格变空正文', () => {
    const d = doc(ol(li('a', p('一'))), ol(li('b', p())))
    const state = stateAt(d, d.content.size - 3)
    const out = run(state, stripBlockStyle)!
    expect(shape(out.doc)).toBe('doc(ordered_list(list_item#a(paragraph("一"))) paragraph#b)')
  })

  test('待办同样变正文；子列表成为后面的块', () => {
    const d = doc(ul(todo('t', false, p('做事'), ul(li('c', p('子'))))))
    const out = strip(d, '做事')!
    expect(shape(out.doc)).toBe('doc(paragraph#t("做事") bullet_list(list_item#c(paragraph("子"))))')
  })

  test('嵌套条目退一级而不是直接变正文', () => {
    const d = doc(ul(li('a', p('父'), ul(li('b', p('子'))))))
    const out = strip(d, '子')!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("父")) list_item#b(paragraph("子"))))')
  })

  test('标题变正文并保住块 id', () => {
    const d = doc(p('前'), h('标题', 2, 'hid'))
    expect(shape(strip(d, '标题')!.doc)).toBe('doc(paragraph("前") paragraph#hid("标题"))')
  })

  test('空代码块变正文；有内容的代码块不拦', () => {
    const empty = doc(p('前'), code('', 'cid'))
    expect(shape(run(stateAt(empty, empty.content.size - 1), stripBlockStyle)!.doc)).toBe('doc(paragraph("前") paragraph#cid)')
    const full = doc(p('前'), code('x = 1'))
    expect(strip(full, 'x = 1')).toBeNull()
  })

  test('引用首段移出引用，其余段留在引用里', () => {
    const d = doc(quote(p('甲'), p('乙')))
    expect(shape(strip(d, '甲')!.doc)).toBe('doc(paragraph("甲") blockquote(paragraph("乙")))')
  })

  test('只有一段的提示框整个解包，段落继承提示框的 id', () => {
    const d = doc(callout('cid', p('提示')))
    expect(shape(strip(d, '提示')!.doc)).toBe('doc(paragraph#cid("提示"))')
  })

  test('折叠块摘要处退格：整个解包', () => {
    const d = doc(toggle(p('摘要'), p('内容')))
    expect(shape(strip(d, '摘要')!.doc)).toBe('doc(paragraph("摘要") paragraph("内容"))')
  })

  test('消息块里的列表也能去样式（列表的容器是消息块）', () => {
    const d = doc(userMsg(ul(li('a', p('问')))))
    expect(shape(strip(d, '问')!.doc)).toBe('doc(user_message(paragraph#a("问")))')
  })
})

describe('stripBlockStyle：不拦', () => {
  test('不在块首', () => {
    const d = doc(ul(li('a', p('一二'))))
    expect(run(stateAt(d, posOf(d, '二')), stripBlockStyle)).toBeNull()
  })

  test('普通顶层段落', () => {
    const d = doc(p('甲'), p('乙'))
    expect(strip(d, '乙')).toBeNull()
  })

  test('条目里的第二段（续段）', () => {
    const d = doc(ul(li('a', p('一'), p('续'))))
    expect(strip(d, '续')).toBeNull()
  })

  test('消息块、AI 回复的直接段落', () => {
    expect(strip(doc(p('前'), userMsg(p('问'))), '问')).toBeNull()
    expect(strip(doc(p('前'), reply(p('答'))), '答')).toBeNull()
  })

  test('非折叠选区', () => {
    const d = doc(ul(li('a', p('一二'))))
    const at = posOf(d, '一')
    expect(run(stateAt(d, at, at + 1), stripBlockStyle)).toBeNull()
  })
})

describe('mergeIntoPrevious：第二次退格把字并进前一块最后一行', () => {
  test('段落接在列表后：并进最后一条的末尾，不被搬进列表变成新条目', () => {
    const d = doc(ul(li('a', p('一'))), p('二', 'pid'))
    const out = run(stateAt(d, posOf(d, '二')), mergeIntoPrevious)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一二"))))')
    expect(out.state.selection.from).toBe(posOf(out.doc, '二'))
  })

  test('嵌套列表：并进最深的最后一行', () => {
    const d = doc(ul(li('a', p('一'), ul(li('b', p('子'))))), p('二'))
    const out = run(stateAt(d, posOf(d, '二')), mergeIntoPrevious)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一") bullet_list(list_item#b(paragraph("子二"))))))')
  })

  test('段落接在引用后：并进引用最后一段', () => {
    const d = doc(quote(p('甲'), p('乙')), p('丙'))
    const out = run(stateAt(d, posOf(d, '丙')), mergeIntoPrevious)!
    expect(shape(out.doc)).toBe('doc(blockquote(paragraph("甲") paragraph("乙丙")))')
  })

  test('前一块是消息块 / 普通段落 / 代码块：不拦', () => {
    const afterMsg = doc(userMsg(p('问')), p('后'))
    expect(run(stateAt(afterMsg, posOf(afterMsg, '后')), mergeIntoPrevious)).toBeNull()
    const plain = doc(p('甲'), p('乙'))
    expect(run(stateAt(plain, posOf(plain, '乙')), mergeIntoPrevious)).toBeNull()
  })

  test('去样式与合并连起来：列表项退格两次 = 并进上一条', () => {
    const d = doc(ul(li('a', p('一'))), ul(li('b', p('二'))))
    const first = run(stateAt(d, posOf(d, '二')), stripBlockStyle)!
    const second = run(first.state, mergeIntoPrevious)!
    expect(shape(second.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一二"))))')
  })
})
