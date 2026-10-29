import { describe, expect, test } from 'vitest'
import { parseCollection, TITLE_PROP, type CollectionRow } from '@ramet/shared/collection-model'
import type { CollectionHandle } from '../collection-store'
import { applyChanges, changesBox, clearBox, pasteBox, setCells } from './range-ops'
import { createUndoStack } from './undo'

/* 不变量：动作只产出真正变了的格；粘贴按选项名认状态（单格内容填满选区、覆盖原值）；超出末行的部分只在允许续行时变成新行；
 * 撤销按「改前」写回，新动作清掉重做栈。 */

const schema = parseCollection({
  props: {
    sta001: {
      name: '状态',
      type: 'status',
      pos: 0,
      options: {
        o1: { name: '未开始', color: 'gray', pos: 0, group: 'todo' },
        o2: { name: '进行中', color: 'blue', pos: 1, group: 'doing' },
      },
    },
    txt001: { name: '文', type: 'text', pos: 1 },
  },
  views: { v1: { name: '表', layout: 'table', pos: 0, filter: { all: [] }, sorts: [], groupBy: null, shown: null, widths: {} } },
})
const prop = (id: string) => schema.props.find((p) => p.id === id)!
const cols = [TITLE_PROP, prop('sta001'), prop('txt001')]

const row = (id: string, props: Record<string, unknown> = {}): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position: 0,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})
const rows = [row('a', { sta001: 'o2' }), row('b', { sta001: 'o1' }), row('c')]

function fakeHandle() {
  const calls: { op: string; ids: string[]; set?: unknown; title?: string }[] = []
  const handle = {
    schema: () => schema,
    setValues: async (id: string, set: unknown) => (calls.push({ op: 'set', ids: [id], set }), true),
    setValuesMany: async (ids: string[], set: unknown) => (calls.push({ op: 'many', ids, set }), true),
    renameRow: async (id: string, title: string) => (calls.push({ op: 'rename', ids: [id], title }), true),
  } as unknown as CollectionHandle
  return { handle, calls }
}

describe('格子动作', () => {
  test('粘贴一个状态名：填满选区，覆盖不同的值；显示没变的格（含没设过、显示默认选项的）不算改动', () => {
    const { handle } = fakeHandle()
    const box = { r0: 0, r1: 2, c0: 1, c1: 1 }
    const { changes, extra, recognized } = pasteBox({ handle, rows, cols, box, spaceId: null }, '未开始', true)
    expect(changes).toEqual([{ rowId: 'a', propId: 'sta001', before: 'o2', after: 'o1' }])
    expect(extra).toEqual([])
    expect(recognized).toBe(true)
    // 认不出的状态名：不写；值没变的格也算认得出（选择器里粘贴不该退回筛选框）
    const one = { r0: 1, r1: 1, c0: 1, c1: 1 }
    expect(pasteBox({ handle, rows, cols, box: one, spaceId: null }, '没有这个', true).recognized).toBe(false)
    const same = pasteBox({ handle, rows, cols, box: one, spaceId: null }, '未开始', true)
    expect([same.changes, same.recognized]).toEqual([[], true])
    expect(pasteBox({ handle, rows, cols, box, spaceId: null }, '进行中', true).changes.map((c) => [c.rowId, c.before])).toEqual([
      ['b', 'o1'],
      ['c', null],
    ])
  })

  test('多行内容超出末行：允许续行才变成新行（名称 + 认得出的值）', () => {
    const { handle } = fakeHandle()
    const box = { r0: 2, r1: 2, c0: 0, c1: 0 }
    const text = 'x\t进行中\n新行\t未开始\t备注\n'
    const yes = pasteBox({ handle, rows, cols, box, spaceId: null }, text, true)
    expect(yes.changes).toEqual([
      { rowId: 'c', propId: 'title', before: 'c', after: 'x' },
      { rowId: 'c', propId: 'sta001', before: null, after: 'o2' },
    ])
    expect(yes.extra).toEqual([{ title: '新行', set: { sta001: 'o1', txt001: '备注' } }])
    expect(yes.area).toEqual({ r0: 2, r1: 2, c0: 0, c1: 1 })
    expect(pasteBox({ handle, rows, cols, box, spaceId: null }, text, false).extra).toEqual([])
  })

  test('清空只清可写的属性、跳过显示没变的格（状态清空仍显示默认选项）；选区编辑只记变了的行', () => {
    const { handle } = fakeHandle()
    expect(clearBox({ handle, rows, cols, box: { r0: 0, r1: 2, c0: 0, c1: 2 }, spaceId: null })).toEqual([
      { rowId: 'a', propId: 'sta001', before: 'o2', after: null },
    ])
    expect(setCells(rows, prop('sta001'), 'o2').map((c) => c.rowId)).toEqual(['b', 'c'])
  })

  test('写入：同一份 set 的行合成一批，名称逐行改名；撤销写「改前」', () => {
    const { handle, calls } = fakeHandle()
    const changes = [
      ...setCells(rows, prop('sta001'), 'o2'),
      ...setCells([rows[0]!], TITLE_PROP, '新名'),
    ]
    applyChanges(handle, changes, 'after')
    expect(calls).toEqual([
      { op: 'rename', ids: ['a'], title: '新名' },
      { op: 'many', ids: ['b', 'c'], set: { sta001: 'o2' } },
    ])
    calls.length = 0
    applyChanges(handle, changes, 'before')
    expect(calls).toEqual([
      { op: 'rename', ids: ['a'], title: 'a' },
      { op: 'set', ids: ['b'], set: { sta001: 'o1' } },
      { op: 'set', ids: ['c'], set: { sta001: null } },
    ])
    expect(changesBox(changes, new Map([['a', 0], ['c', 2]]), cols)).toEqual({ r0: 0, r1: 2, c0: 0, c1: 1 })
  })
})

test('撤销栈：撤销 / 重做成对，新动作清掉重做', () => {
  const stack = createUndoStack()
  const one = setCells([rows[0]!], prop('txt001'), '1')
  const two = setCells([rows[0]!], prop('txt001'), '2')
  stack.push(one)
  stack.push(two)
  stack.push([])
  expect(stack.undo()).toBe(two)
  expect(stack.redo()).toBe(two)
  expect(stack.redo()).toBeNull()
  expect(stack.undo()).toBe(two)
  stack.push(one)
  expect(stack.redo()).toBeNull()
  expect(stack.undo()).toBe(one)
  expect(stack.undo()).toBe(one)
  expect(stack.undo()).toBeNull()
})
