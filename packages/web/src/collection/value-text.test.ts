import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionProp } from '@ramet/shared/collection-model'
import type { UpdateSummaryItem } from '../api'
import { setSelf } from '../people'
import { orderSummary, propItemText, valueText } from './value-text'

const schema = parseCollection({
  props: {
    stat01: {
      name: '状态',
      type: 'status',
      pos: 0,
      options: {
        todo01: { name: '未开始', color: 'gray', pos: 0, group: 'todo' },
        doing1: { name: '进行中', color: 'blue', pos: 1, group: 'doing' },
      },
    },
    tags01: { name: '标签', type: 'multi_select', pos: 1, options: { a00001: { name: '甲', color: 'red', pos: 0 }, b00001: { name: '乙', color: 'blue', pos: 1 } } },
    num001: { name: '工时', type: 'number', pos: 2 },
    chk001: { name: '完成', type: 'checkbox', pos: 3 },
    date01: { name: '截止', type: 'date', pos: 4 },
    text01: { name: '', type: 'text', pos: 5 },
    url001: { name: '链接', type: 'url', pos: 6 },
    pers01: { name: '负责人', type: 'person', pos: 7 },
    sel001: { name: '优先级', type: 'select', pos: 8, options: { hi0001: { name: '高', color: 'red', pos: 0 } } },
  },
  views: {},
})

const prop = (id: string): CollectionProp => schema.props.find((p) => p.id === id)!

describe('valueText：经 readValue 按当前定义读成文字', () => {
  test('各类型', () => {
    expect(valueText(prop('stat01'), 'doing1', null)).toBe('进行中')
    expect(valueText(prop('sel001'), 'hi0001', null)).toBe('高')
    expect(valueText(prop('tags01'), ['b00001', 'a00001'], null)).toBe('乙、甲')
    expect(valueText(prop('num001'), 2.5, null)).toBe('2.5')
    expect(valueText(prop('chk001'), true, null)).toBe('是')
    expect(valueText(prop('chk001'), false, null)).toBe('否')
    expect(valueText(prop('date01'), '2026-10-26', null)).toBe('2026-10-26')
    expect(valueText(prop('text01'), '备注', null)).toBe('备注')
    expect(valueText(prop('url001'), 'https://a.example', null)).toBe('https://a.example')
  })

  test('人员：自己取登录态的名字，不认识的人显示已退出', () => {
    setSelf({ id: 'me', username: '小明', avatar: null })
    expect(valueText(prop('pers01'), ['me', 'ghost'], null)).toBe('小明、已退出的成员')
  })

  test('解读不了（类型不符 / 选项已删）显示已失效的值', () => {
    expect(valueText(prop('stat01'), 'gone01', null)).toBe('（已失效的值）')
    expect(valueText(prop('num001'), 'abc', null)).toBe('（已失效的值）')
    expect(valueText(prop('tags01'), ['gone01'], null)).toBe('（已失效的值）')
  })
})

describe('propItemText：一行文案', () => {
  const item = (p: string, from: unknown, to: unknown) => ({ kind: 'prop' as const, prop: p, from, to })

  test('改值 / 设置 / 清空', () => {
    expect(propItemText(item('stat01', 'todo01', 'doing1'), schema, null)).toBe('状态：未开始 → 进行中')
    expect(propItemText(item('stat01', null, 'doing1'), schema, null)).toBe('设置 状态：进行中')
    expect(propItemText(item('stat01', 'todo01', null), schema, null)).toBe('清空 状态（原为 未开始）')
  })

  test('属性名为空用类型名；属性已删 / 定义未到只说改了', () => {
    expect(propItemText(item('text01', null, 'x'), schema, null)).toBe('设置 文本：x')
    expect(propItemText(item('gone01', 1, 2), schema, null)).toBe('改了 已删除的属性')
    expect(propItemText(item('stat01', 'todo01', 'doing1'), null, null)).toBe('改了 属性')
  })
})

describe('orderSummary：属性项按当前属性顺序，其余项原样在后', () => {
  test('排序稳定、已删属性排在属性项最后', () => {
    const items: UpdateSummaryItem[] = [
      { kind: 'prop', prop: 'gone01', from: 1, to: 2 },
      { kind: 'prop', prop: 'num001', from: 1, to: 2 },
      { kind: 'prop', prop: 'stat01', from: null, to: 'todo01' },
      { kind: 'edit', text: '正文' },
      { kind: 'title', text: '标题' },
    ]
    expect(orderSummary(items, schema).map((i) => (i.kind === 'prop' ? i.prop : i.kind))).toEqual(['stat01', 'num001', 'gone01', 'edit', 'title'])
    expect(orderSummary(items, null)).toEqual(items)
  })
})
