import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionProp } from '@ramet/shared/collection-model'
import type { Page, UpdateSummaryItem } from '../api'
import { COPY } from '../copy'
import { setSelf } from '../people'
import { syncCollectionPages } from './collection-store'
import { formulaText, orderSummary, propItemText, shownText, valueText } from './value-text'

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
    mail01: { name: '邮箱', type: 'email', pos: 9 },
    tel001: { name: '电话', type: 'phone', pos: 10 },
    file01: { name: '附件', type: 'files', pos: 11 },
    num002: { name: '编号', type: 'unique_id', pos: 12, cfg: { prefix: 'TASK' } },
    crby01: { name: '创建者', type: 'created_by', pos: 13 },
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

  test('邮箱 / 电话原样；日期区间「开始 → 结束」（存的开始晚于结束也按交换后的显示）', () => {
    expect(valueText(prop('mail01'), 'a@b.co', null)).toBe('a@b.co')
    expect(valueText(prop('tel001'), '+86 10 1234', null)).toBe('+86 10 1234')
    expect(valueText(prop('date01'), '2026-10-26/2026-10-30', null)).toBe('2026-10-26 → 2026-10-30')
    expect(valueText(prop('date01'), '2026-10-30/2026-10-26', null)).toBe('2026-10-26 → 2026-10-30')
  })

  test('文件：流水里只剩文件名（服务端摘要不给 id），直接读名字；完整的文件值也一样', () => {
    expect(valueText(prop('file01'), [{ name: 'a.png' }, { name: '报告.pdf' }], null)).toBe('a.png、报告.pdf')
    const full = { id: '0b8f6a52-3f6c-4c3e-9a51-2b1d7c9e4f01', name: 'a.png', mime: 'image/png', size: 1 }
    expect(valueText(prop('file01'), [full], null)).toBe('a.png')
    expect(valueText(prop('file01'), [{}, null], null)).toBe('（已失效的值）')
    expect(valueText(prop('file01'), 'x', null)).toBe('（已失效的值）')
    expect(propItemText({ kind: 'prop', prop: 'file01', from: [{ name: 'a.png' }], to: [{ name: 'a.png' }, { name: 'b.png' }] }, schema, null)).toBe(
      '附件：a.png → a.png、b.png',
    )
  })

  test('读出来的值：编号带前缀，创建者给名字', () => {
    setSelf({ id: 'me', username: '小明', avatar: null })
    expect(shownText(prop('num002'), 12, null)).toBe('TASK-12')
    expect(shownText(prop('crby01'), ['me'], null)).toBe('小明')
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

describe('关联与汇总的文字', () => {
  const B = '0b0c3c1e-6f7a-4b2c-9d8e-112233445566'
  const rel = parseCollection({ props: { rel001: { name: '项目', type: 'relation', pos: 0, cfg: { target: B, reverse: null } } } }).props[0]!
  const page = (id: string, title: string): Page => ({
    id,
    parent_id: B,
    title,
    kind: 'doc',
    created_at: '',
    space_id: 's1',
    published: false,
    publish_includes_runs: false,
    icon: null,
  })

  test('正向关联的流水：对方行的标题（页面列表里取），已不在的写占位', () => {
    syncCollectionPages([page('r1', '阿尔法'), page('r2', '')])
    expect(valueText(rel, ['r1', 'r2', 'gone'], null)).toBe(`阿尔法、${COPY.untitled}、已不在的行`)
    expect(propItemText({ kind: 'prop', prop: 'rel001', from: null, to: ['r1'] }, { v: 1, props: [rel], views: [] }, null)).toBe('设置 项目：阿尔法')
  })

  test('汇总：数字 / 占比 / 日期按输出类型，列表按目标属性逐项（目标定义在 refs）', () => {
    const rollup = (fn: string): CollectionProp => ({ id: 'sum001', name: '汇总', type: 'rollup', pos: 0, options: [], cfg: { relation: 'rel001', prop: 'p', fn: fn as never } })
    expect(shownText(rollup('sum'), 12.345, null)).toBe('12.35')
    expect(shownText(rollup('percent_checked'), 0.5, null)).toBe('50.0%')
    expect(shownText(rollup('earliest'), '2026-10-01', null)).toBe('2026-10-01')
    const refs = { sum001: { state: 'ok' as const, prop: { type: 'select' as const, options: [{ id: 'o1', name: '高', color: 'red' as const, pos: 0 }], cfg: {} } } }
    expect(shownText(rollup('show_original'), ['o1', 'o1'], null, refs)).toBe('高、高')
    expect(shownText(rollup('show_original'), [{ id: 'f', name: 'a.png', mime: 'image/png', size: 1 }, 'x'], null)).toBe('a.png、x')
  })
})

describe('公式结果的文字（复制与格子同口径）', () => {
  const formula = (output: CollectionProp['output']): CollectionProp => ({ id: 'fx0001', name: '公式', type: 'formula', pos: 0, options: [], cfg: {}, output })
  test('按输出类型：数字 15 位有效数字、是否写是 / 否、日期同日期格、列表用「、」连', () => {
    expect(shownText(formula('number'), 0.1 + 0.2, null)).toBe('0.3')
    expect(shownText(formula('number'), 1e21, null)).toBe('1e+21')
    expect(shownText(formula('text'), '✅ 完成', null)).toBe('✅ 完成')
    expect(shownText(formula('boolean'), false, null)).toBe(COPY.collection.history.no)
    expect(shownText(formula('date'), '2026-10-01/2026-10-03', null)).toBe('2026-10-01 → 2026-10-03')
    expect(shownText(formula('list'), ['甲', 2, true], null)).toBe(`甲、2、${COPY.collection.history.yes}`)
    expect(formulaText('text', '2026-10-01')).toBe('2026-10-01')
  })
})
