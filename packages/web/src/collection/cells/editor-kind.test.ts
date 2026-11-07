import { expect, test } from 'vitest'
import { PROP_TYPES, TITLE_PROP, type CollectionProp, type PropType } from '@ramet/shared/collection-model'
import { bulkEditable, editorKind, pickOnce, type EditorKind } from './editor-kind'

/* 不变量：每种类型恰好对应一种编辑器；系统生成的类型一律 none（表格、卡片、属性区、批量栏都据此锁住）。 */

const prop = (type: PropType): CollectionProp => ({ id: 'p00001', name: 'P', type, pos: 0, options: [], cfg: {} })

test('按类型选编辑器', () => {
  const expected: Record<PropType, EditorKind> = {
    text: 'inline',
    number: 'inline',
    url: 'inline',
    email: 'inline',
    phone: 'inline',
    select: 'popover',
    multi_select: 'popover',
    status: 'popover',
    person: 'popover',
    date: 'popover',
    files: 'popover',
    checkbox: 'toggle',
    created_time: 'none',
    edited_time: 'none',
    created_by: 'none',
    edited_by: 'none',
    unique_id: 'none',
    relation: 'popover',
    rollup: 'none',
    formula: 'none',
    button: 'none',
    ai: 'inline',
  }
  for (const type of PROP_TYPES) expect([type, editorKind(prop(type))]).toEqual([type, expected[type]])
  expect(editorKind(TITLE_PROP)).toBe('inline')
})

test('选一次就改完的只有单选与状态', () => {
  expect(PROP_TYPES.filter((type) => pickOnce(prop(type)))).toEqual(['select', 'status'])
})

test('关联：正向与反向都用行选择器；汇总只读；批量栏不收反向关联', () => {
  const forward: CollectionProp = { ...prop('relation'), cfg: { target: 'c', reverse: null, single: false } }
  const reverse: CollectionProp = { ...prop('relation'), cfg: { target: 'c', mirror: 'p00002' } }
  expect(editorKind(forward)).toBe('popover')
  expect(editorKind(reverse)).toBe('popover')
  expect(editorKind({ ...prop('rollup'), cfg: { relation: 'p00002', prop: 'title', fn: 'count' } })).toBe('none')
  expect(bulkEditable(forward)).toBe(true)
  expect(bulkEditable(reverse)).toBe(false)
  expect(bulkEditable(prop('created_by'))).toBe(false)
  expect(bulkEditable(prop('text'))).toBe(true)
})
