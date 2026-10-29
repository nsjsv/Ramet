import { describe, expect, test } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import {
  duplicateBlocks,
  extendBlockSelection,
  indentBlocks,
  moveBlocks,
  selectBlockAtCursor,
  stepBlockSelection,
} from './block-ops'
import { blockSelectKey, type BlockSelectState } from './block-select-key'
import { doc, li, p, posOf, reply, run, shape, stateAt, ul } from './test-schema'
import { EditorState as State, Plugin, TextSelection } from '@milkdown/kit/prose/state'

// 块选区的键盘选择 / 副本 / 移动 / 缩进都按块整体操作，结果单事务，块选状态跟到新位置（见 block-ops.ts 文件头）。

/** 带块选插件的状态 */
function withBlockSelect(d: PMNode, sel: BlockSelectState | null, caret = 1): EditorState {
  const state = State.create({ doc: d, selection: TextSelection.create(d, caret), plugins: [blockSelectPlugin()] })
  return sel ? state.apply(state.tr.setMeta(blockSelectKey, sel)) : state
}

/** 只要状态的最小块选插件（与 block-select.ts 同一个 key、同样的 meta 语义） */
function blockSelectPlugin(): Plugin {
  return new Plugin({
    key: blockSelectKey,
    state: {
      init: () => ({ active: false, from: 0, to: 0 }),
      apply: (tr, value) => {
        const meta = tr.getMeta(blockSelectKey) as BlockSelectState | undefined
        if (meta !== undefined) return meta
        return tr.docChanged ? { active: false, from: 0, to: 0 } : value
      },
    },
  })
}

function span(d: PMNode, i: number): { from: number; to: number } {
  let off = 0
  for (let k = 0; k < i; k++) off += d.child(k).nodeSize
  return { from: off, to: off + d.child(i).nodeSize }
}

describe('选择', () => {
  test('Esc：顶层列表选到条目，AI 回复里选到子块', () => {
    const d = doc(ul(li('a', p('一'))), reply(p('答')))
    expect(selectBlockAtCursor(stateAt(d, posOf(d, '一')))).toEqual({ active: true, from: 1, to: 1 + d.child(0).child(0).nodeSize })
    const r = span(d, 1)
    expect(selectBlockAtCursor(stateAt(d, posOf(d, '答')))).toEqual({ active: true, from: r.from + 1, to: r.to - 1 })
  })

  test('↓ 按文档序走，有子块先进子块', () => {
    const d = doc(ul(li('a', p('父'), ul(li('b', p('子'))))), p('后'))
    const start = withBlockSelect(d, { active: true, from: 1, to: 1 + d.child(0).child(0).nodeSize })
    const next = stepBlockSelection(start, 1)!
    expect(d.nodeAt(next.from)?.attrs.id).toBe('b')
    const after = stepBlockSelection(withBlockSelect(d, next), 1)!
    expect(after.from).toBe(span(d, 1).from)
    const back = stepBlockSelection(withBlockSelect(d, after), -1)!
    expect(back.from).toBe(next.from)
  })

  test('Shift+↓ 扩、Shift+↑ 缩，越过锚点换向', () => {
    const d = doc(p('甲'), p('乙'), p('丙'))
    const one = withBlockSelect(d, { active: true, ...span(d, 1) })
    const down = extendBlockSelection(one, 1)!
    expect([down.from, down.to, down.head]).toEqual([span(d, 1).from, span(d, 2).to, 'end'])
    const back = extendBlockSelection(withBlockSelect(d, down), -1)!
    expect([back.from, back.to]).toEqual([span(d, 1).from, span(d, 1).to])
    const up = extendBlockSelection(withBlockSelect(d, back), -1)!
    expect([up.from, up.to, up.head]).toEqual([span(d, 0).from, span(d, 1).to, 'start'])
  })
})

describe('副本 / 移动', () => {
  test('Mod-D 块选两块：整段复制到后面，块选落到副本', () => {
    const d = doc(p('甲'), p('乙'), p('丙'))
    const state = withBlockSelect(d, { active: true, from: 0, to: span(d, 1).to })
    const out = run(state, duplicateBlocks)!
    expect(shape(out.doc)).toBe('doc(paragraph("甲") paragraph("乙") paragraph("甲") paragraph("乙") paragraph("丙"))')
    const sel = blockSelectKey.getState(out.state)!
    expect([sel.from, sel.to]).toEqual([span(d, 1).to, span(d, 1).to * 2])
  })

  test('Mod-D 没有块选：复制光标所在块，顶层列表项连列表一起，光标跟到副本', () => {
    const d = doc(ul(li('a', p('一'))), p('后'))
    const out = run(withBlockSelect(d, null, posOf(d, '一') + 1), duplicateBlocks)!
    expect(shape(out.doc)).toBe('doc(bullet_list(list_item#a(paragraph("一"))) bullet_list(list_item#a(paragraph("一"))) paragraph("后"))')
    expect(out.state.selection.from).toBe(posOf(d, '一') + 1 + d.child(0).nodeSize)
  })

  test('Mod-Shift-↑：块选整段与上一块换位', () => {
    const d = doc(p('甲'), p('乙'), p('丙'))
    const state = withBlockSelect(d, { active: true, from: span(d, 1).from, to: span(d, 2).to })
    const out = run(state, moveBlocks(-1))!
    expect(shape(out.doc)).toBe('doc(paragraph("乙") paragraph("丙") paragraph("甲"))')
    const sel = blockSelectKey.getState(out.state)!
    expect([sel.from, sel.to]).toEqual([0, span(d, 2).to - span(d, 0).to])
  })

  test('Mod-Shift-↓ 没有块选：光标所在块下移，光标跟着走', () => {
    const d = doc(p('甲'), p('乙'))
    const out = run(withBlockSelect(d, null, posOf(d, '甲')), moveBlocks(1))!
    expect(shape(out.doc)).toBe('doc(paragraph("乙") paragraph("甲"))')
    expect(out.state.doc.textBetween(out.state.selection.from, out.state.selection.from + 1)).toBe('甲')
  })

  test('已在顶上：吞键不改', () => {
    const d = doc(p('甲'), p('乙'))
    let dispatched = false
    expect(moveBlocks(-1)(withBlockSelect(d, null, posOf(d, '甲')), () => (dispatched = true))).toBe(true)
    expect(dispatched).toBe(false)
  })
})

describe('批量缩进', () => {
  test('块选两个列表块 Tab：都挂到前一条下面', () => {
    const d = doc(ul(li('a', p('一'))), ul(li('b', p('二'))), ul(li('c', p('三'))))
    const state = withBlockSelect(d, { active: true, from: span(d, 1).from, to: span(d, 2).to })
    const out = run(state, indentBlocks)!
    expect(shape(out.doc)).toBe(
      'doc(bullet_list(list_item#a(paragraph("一") bullet_list(list_item#b(paragraph("二")) list_item#c(paragraph("三"))))))',
    )
    expect(blockSelectKey.getState(out.state)?.active).toBe(true)
  })
})
