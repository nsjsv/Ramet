import { describe, expect, test } from 'vitest'
import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'
import { blockPreviewAt, applyQuickResult, selectionMarkdown, stripFence, textAfter, textBefore } from './quick-apply'
import { code, doc, h, li, p, posOf, schema, shape, stateAt, ul } from './test-schema'

/* 不变量（quick-apply.ts 文件头）：收下 = 一个事务；行内结果只换行内内容、所在块不动；整块替换把旧块 id 带给新块；
 * 放不进去返回 null 而不是半截写入。这里用最小 schema 直接测纯函数（解析 / 序列化由调用方给，测试里用假的）。 */

const blocks = (...nodes: PMNode[]): Fragment => Fragment.fromArray(nodes)
const apply = (state: ReturnType<typeof stateAt>, args: Omit<Parameters<typeof applyQuickResult>[1], 'markdown'> & { markdown?: string }) =>
  applyQuickResult(state, { markdown: '', ...args })
const result = (state: ReturnType<typeof stateAt>, tr: NonNullable<ReturnType<typeof applyQuickResult>>) => state.apply(tr)

describe('applyQuickResult：行内', () => {
  test('选区在一个段落里、结果是单个段落：只换那几个字，段落（含 id）不动，光标落在新文字之后', () => {
    const d = doc(p('hello world', 'a'))
    const from = posOf(d, 'world')
    const state = stateAt(d, from, from + 5)
    const tr = apply(state, { from, to: from + 5, replace: true, blocks: blocks(p('there')) })!
    const next = result(state, tr)
    expect(shape(next.doc)).toBe('doc(paragraph#a("hello there"))')
    expect(next.selection.from).toBe(from + 5)
    expect(next.selection.empty).toBe(true)
  })

  test('选中整个标题的文字：仍是标题，id 不变', () => {
    const d = doc(h('旧标题', 2, 'h1'))
    const from = posOf(d, '旧标题')
    const state = stateAt(d, from, from + 3)
    const tr = apply(state, { from, to: from + 3, replace: true, blocks: blocks(p('新标题')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(heading#h1("新标题"))')
  })

  test('列表项里的段落：行内替换不动列表结构', () => {
    const d = doc(ul(li('i1', p('买牛奶'))))
    const from = posOf(d, '买牛奶')
    const state = stateAt(d, from, from + 3)
    const tr = apply(state, { from, to: from + 3, replace: true, blocks: blocks(p('买两盒牛奶')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(bullet_list(list_item#i1(paragraph("买两盒牛奶"))))')
  })

  test('光标处起草（插入）：结果插在光标处，前后文字保留', () => {
    const d = doc(p('前后', 'a'))
    const at = posOf(d, '后')
    const state = stateAt(d, at)
    const tr = apply(state, { from: at, to: at, replace: false, blocks: blocks(p('中间')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(paragraph#a("前中间后"))')
  })

  test('结果段落是空的 → 放不进去（null）', () => {
    const d = doc(p('abc'))
    const state = stateAt(d, 1, 4)
    expect(apply(state, { from: 1, to: 4, replace: true, blocks: blocks(p('')) })).toBeNull()
    expect(apply(state, { from: 1, to: 4, replace: true, blocks: Fragment.empty })).toBeNull()
  })
})

describe('applyQuickResult：块', () => {
  test('选中整个段落、结果是多个块：整块换掉，第一块继承旧块 id（引用不悬空）', () => {
    const d = doc(p('前', 'x'), p('中间这段', 'mid'), p('后', 'y'))
    const from = posOf(d, '中间这段')
    const state = stateAt(d, from, from + 4)
    const tr = apply(state, { from, to: from + 4, replace: true, blocks: blocks(h('标题', 2), p('第二块')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(paragraph#x("前") heading#mid("标题") paragraph("第二块") paragraph#y("后"))')
  })

  test('选中相邻几个整段：内容没变的块保住 id；改了字的块在数量 / 类型对得上时也保住（身份跟着内容走）', () => {
    const d = doc(p('甲', 'a'), p('乙', 'b'), p('丙', 'c'))
    const from = posOf(d, '甲')
    const to = posOf(d, '乙') + 1
    const state = stateAt(d, from, to)
    const same = apply(state, { from, to, replace: true, blocks: blocks(p('甲'), p('新的乙')) })!
    expect(shape(result(state, same).doc)).toBe('doc(paragraph#a("甲") paragraph#b("新的乙") paragraph#c("丙"))')
    // 多出一块、数量对不上：只有原样没变的块保住 id（carryBlockIds 的规则），不乱猜
    const more = apply(state, { from, to, replace: true, blocks: blocks(p('甲'), p('新的乙'), h('追加', 3)) })!
    expect(shape(result(state, more).doc)).toBe('doc(paragraph#a("甲") paragraph("新的乙") heading("追加") paragraph#c("丙"))')
  })

  test('只选了半个段落、结果是块：与粘贴同一个拟合，前后文字都在', () => {
    const d = doc(p('前文后文'))
    const from = posOf(d, '后')
    const state = stateAt(d, 1, from)
    const tr = apply(state, { from: 1, to: from, replace: true, blocks: blocks(h('H', 1), p('P')) })!
    const text = result(state, tr).doc.textContent
    expect(text).toContain('H')
    expect(text).toContain('P')
    expect(text).toContain('后文')
  })

  test('光标在非空段落里、结果是块：插在这个段落之后', () => {
    const d = doc(p('已有文字', 'a'), p('下一段', 'b'))
    const at = posOf(d, '文字')
    const state = stateAt(d, at)
    const tr = apply(state, { from: at, to: at, replace: false, blocks: blocks(p('新一'), p('新二')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(paragraph#a("已有文字") paragraph("新一") paragraph("新二") paragraph#b("下一段"))')
  })

  test('光标在空段落里、结果是块：换掉这个空段落（不留空行）', () => {
    const d = doc(p('上', 'a'), p('', 'e'), p('下', 'b'))
    const state = stateAt(d, posOf(d, '上') + 2)
    const empty = posOf(d, '上') + 3
    const s2 = stateAt(d, empty)
    const tr = apply(s2, { from: empty, to: empty, replace: false, blocks: blocks(h('新', 2), p('内容')) })!
    expect(shape(result(s2, tr).doc)).toBe('doc(paragraph#a("上") heading("新") paragraph("内容") paragraph#b("下"))')
    expect(state).toBeTruthy()
  })
})

describe('applyQuickResult：代码块与越界', () => {
  test('代码块里：当纯文本换，去掉模型多包的围栏', () => {
    const d = doc(code('let a = 1', 'c'))
    const from = posOf(d, 'a = 1')
    const state = stateAt(d, from, from + 5)
    const tr = apply(state, { from, to: from + 5, replace: true, markdown: '```ts\nconst a = 2\n```', blocks: blocks(p('x')) })!
    expect(shape(result(state, tr).doc)).toBe('doc(code_block#c("let const a = 2"))')
  })

  test('范围越界 / 反向：null，文档不动', () => {
    const d = doc(p('abc'))
    const state = stateAt(d, 1)
    expect(apply(state, { from: 3, to: 99, replace: true, blocks: blocks(p('x')) })).toBeNull()
    expect(apply(state, { from: 3, to: 1, replace: true, blocks: blocks(p('x')) })).toBeNull()
  })

  test('目标位置不接受这种块（表格单元格只收段落）→ null，不抛', () => {
    const cell = schema.nodes.table_cell!.create(null, p('格'))
    const header = schema.nodes.table_header!.create(null, p('头'))
    const table = schema.nodes.table!.create(null, [
      schema.nodes.table_header_row!.create(null, [header]),
      schema.nodes.table_row!.create(null, [cell]),
    ])
    const d = doc(table)
    const at = posOf(d, '格')
    const state = stateAt(d, at, at + 1)
    const tr = apply(state, { from: at, to: at + 1, replace: true, blocks: blocks(h('标题', 1), ul(li('i', p('项')))) })
    // 要么放不进去（null），要么 PM 拟合成合法文档；绝不能抛、也不能产出非法文档
    if (tr) expect(() => result(state, tr).doc.check()).not.toThrow()
  })
})

describe('辅助函数', () => {
  const serialize = (d: PMNode): string => d.textContent

  test('selectionMarkdown：同块选区包成段落序列化；跨块按块序列化；代码块是纯文字', () => {
    const d = doc(p('一二三', 'a'), p('四五六', 'b'))
    const seen: string[] = []
    const spy = (n: PMNode): string => {
      seen.push(shape(n))
      return serialize(n)
    }
    const from = posOf(d, '二')
    expect(selectionMarkdown(stateAt(d, from, from + 2), from, from + 2, spy)).toBe('二三')
    expect(seen[0]).toBe('doc(paragraph("二三"))')
    const to = posOf(d, '五') + 1
    expect(selectionMarkdown(stateAt(d, from, to), from, to, spy)).toBe('二三四五')
    const c = doc(code('x = 1'))
    expect(selectionMarkdown(stateAt(c, 1, 6), 1, 6, () => 'SHOULD-NOT-BE-USED')).toBe('x = 1')
  })

  test('selectionMarkdown：序列化抛错 / 空串 → 退回纯文字', () => {
    const d = doc(p('原文'))
    expect(selectionMarkdown(stateAt(d, 1, 3), 1, 3, () => { throw new Error('x') })).toBe('原文')
    expect(selectionMarkdown(stateAt(d, 1, 3), 1, 3, () => '  ')).toBe('原文')
  })

  test('textBefore / textAfter：块之间换行，按字数截断', () => {
    const d = doc(p('第一段文字'), p('第二段文字'))
    const state = stateAt(d, 1)
    const mid = posOf(d, '第二段') + 3
    expect(textBefore(state, mid, 100)).toBe('第一段文字\n第二段')
    expect(textBefore(state, mid, 4)).toBe('\n第二段')
    expect(textAfter(state, mid, 100)).toBe('文字')
    expect(textAfter(state, 1, 3)).toBe('第一段')
  })

  test('stripFence：只剥最外层一对围栏', () => {
    expect(stripFence('```js\nlet a\n```')).toBe('let a')
    expect(stripFence('```\na\nb\n```\n')).toBe('a\nb')
    expect(stripFence('plain')).toBe('plain')
    expect(stripFence('```js\nunterminated')).toBe('```js\nunterminated')
  })

  test('blockPreviewAt：文本块里 = 这个块之后；其它位置原样', () => {
    const d = doc(p('abc'), p('def'))
    const state = stateAt(d, 1)
    expect(blockPreviewAt(state, 2)).toBe(5)
    expect(blockPreviewAt(state, 0)).toBe(0)
  })
})
