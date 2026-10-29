import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { parseCollection } from '@ramet/shared/collection-model'
import { propDiff, schemaDiff, summarizeChange, summaryState, SUMMARY_TEXT_MAX } from './updates.js'

// 集合的更新摘要：行的属性差异、集合页的属性定义 / 视图差异。纯函数，不连数据库

describe('propDiff：行的属性差异（每种存储类型的设置 / 清空 / 改值）', () => {
  // 每种存储类型一组：[属性 id, 值 A, 值 B]
  const cases: [string, unknown, unknown][] = [
    ['text01', '旧文字', '新文字'],
    ['num001', 1, 2.5],
    ['sel001', 'opta01', 'optb01'],
    ['multi1', ['opta01'], ['opta01', 'optb01']],
    ['stat01', 'todo01', 'doing1'],
    ['date01', '2026-10-01', '2026-10-26'],
    ['check1', true, false],
    ['url001', 'https://a.example', 'https://b.example'],
    ['pers01', ['u1'], ['u1', 'u2']],
  ]

  for (const [prop, a, b] of cases) {
    test(`${prop}：设置、改值、清空`, () => {
      expect(propDiff({}, { [prop]: a })).toEqual([{ kind: 'prop', prop, from: null, to: a }])
      expect(propDiff({ [prop]: a }, { [prop]: b })).toEqual([{ kind: 'prop', prop, from: a, to: b }])
      expect(propDiff({ [prop]: b }, {})).toEqual([{ kind: 'prop', prop, from: b, to: null }])
      expect(propDiff({ [prop]: a }, { [prop]: a })).toEqual([])
    })
  }

  test('键不存在与 null 同为空；多项按属性 id 排序', () => {
    expect(propDiff({ a: null }, {})).toEqual([])
    expect(propDiff({}, { zzz: 1, aaa: 'x', mmm: true })).toEqual([
      { kind: 'prop', prop: 'aaa', from: null, to: 'x' },
      { kind: 'prop', prop: 'mmm', from: null, to: true },
      { kind: 'prop', prop: 'zzz', from: null, to: 1 },
    ])
  })

  test('长文本截到 SUMMARY_TEXT_MAX；数组原样给；对象（脏数据）只给占位', () => {
    const long = '字'.repeat(SUMMARY_TEXT_MAX + 50)
    const [item] = propDiff({}, { t: long })
    expect(item).toEqual({ kind: 'prop', prop: 't', from: null, to: '字'.repeat(SUMMARY_TEXT_MAX) })
    expect(propDiff({}, { m: ['a', 'b'] })).toEqual([{ kind: 'prop', prop: 'm', from: null, to: ['a', 'b'] }])
    expect(propDiff({}, { o: { big: 'x'.repeat(5000) } })).toEqual([{ kind: 'prop', prop: 'o', from: null, to: {} }])
  })
})

/** 一份集合文档 JSON（同 Y.Map('collection').toJSON() 的形状） */
function collectionJson() {
  return {
    v: 1,
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
      prio01: { name: '优先级', type: 'select', pos: 1, options: {} },
    },
    views: {
      view01: { name: '表格', layout: 'table', pos: 0, filter: { all: [] }, sorts: [], groupBy: null, shown: null, widths: {} },
      view02: { name: '看板', layout: 'board', pos: 1, filter: { all: [] }, sorts: [], groupBy: 'stat01', shown: null, widths: {} },
    },
  }
}

describe('schemaDiff：集合页的属性定义 / 视图差异', () => {
  test('六种操作：新增 / 删除 / 修改属性，新增 / 删除 / 修改视图', () => {
    const base = collectionJson()
    const prev = parseCollection(base)

    const addProp = collectionJson()
    ;(addProp.props as Record<string, unknown>).due001 = { name: '截止', type: 'date', pos: 2 }
    expect(schemaDiff(prev, parseCollection(addProp))).toEqual([{ kind: 'schema', op: 'prop_add', text: '截止' }])

    const delProp = collectionJson()
    delete (delProp.props as Record<string, unknown>).prio01
    expect(schemaDiff(prev, parseCollection(delProp))).toEqual([{ kind: 'schema', op: 'prop_del', text: '优先级' }])

    // 改名、改类型、改选项、改位置都算修改属性（文字取新名）
    const renamed = collectionJson()
    renamed.props.prio01.name = '重要度'
    expect(schemaDiff(prev, parseCollection(renamed))).toEqual([{ kind: 'schema', op: 'prop_edit', text: '重要度' }])
    const retyped = collectionJson()
    retyped.props.prio01.type = 'multi_select'
    expect(schemaDiff(prev, parseCollection(retyped))).toEqual([{ kind: 'schema', op: 'prop_edit', text: '优先级' }])
    const recolored = collectionJson()
    recolored.props.stat01.options.doing1.color = 'red'
    expect(schemaDiff(prev, parseCollection(recolored))).toEqual([{ kind: 'schema', op: 'prop_edit', text: '状态' }])

    const addView = collectionJson()
    ;(addView.views as Record<string, unknown>).view03 = { name: '我的', layout: 'table', pos: 2 }
    expect(schemaDiff(prev, parseCollection(addView))).toEqual([{ kind: 'schema', op: 'view_add', text: '我的' }])

    const delView = collectionJson()
    delete (delView.views as Record<string, unknown>).view02
    expect(schemaDiff(prev, parseCollection(delView))).toEqual([{ kind: 'schema', op: 'view_del', text: '看板' }])

    // 筛选 / 排序 / 分组 / 显示属性 / 布局 / 名字 / 位置都算修改视图
    const edits: ((json: ReturnType<typeof collectionJson>) => void)[] = [
      (j) => (j.views.view01.name = '全部'),
      (j) => (j.views.view01.layout = 'board'),
      (j) => (j.views.view01.pos = 5),
      (j) => ((j.views.view01.filter as unknown) = { all: [{ prop: 'stat01', op: 'empty' }] }),
      (j) => ((j.views.view01.sorts as unknown) = [{ prop: 'prio01', dir: 'desc' }]),
      (j) => ((j.views.view01.groupBy as unknown) = 'stat01'),
      (j) => ((j.views.view01.shown as unknown) = ['prio01']),
    ]
    for (const edit of edits) {
      const json = collectionJson()
      edit(json)
      const items = schemaDiff(prev, parseCollection(json))
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ kind: 'schema', op: 'view_edit' })
    }
  })

  test('只改列宽不出项', () => {
    const json = collectionJson()
    json.views.view01.widths = { stat01: 300, title: 400 } as never
    expect(schemaDiff(parseCollection(collectionJson()), parseCollection(json))).toEqual([])
  })

  test('任一边不是集合页（null）= 无项', () => {
    expect(schemaDiff(null, parseCollection(collectionJson()))).toEqual([])
    expect(schemaDiff(parseCollection(collectionJson()), null)).toEqual([])
  })
})

describe('summarizeChange：拼接顺序与普通页面不变', () => {
  test('属性 → 集合定义 → 正文 → 标题', () => {
    const prevSchema = parseCollection(collectionJson())
    const json = collectionJson()
    json.props.prio01.name = '重要度'
    const items = summarizeChange(
      { title: '旧', blocks: ['旧段'], props: {}, schema: prevSchema },
      { title: '新', blocks: ['新段'], props: { stat01: 'doing1' }, schema: parseCollection(json) },
    )
    expect(items).toEqual([
      { kind: 'prop', prop: 'stat01', from: null, to: 'doing1' },
      { kind: 'schema', op: 'prop_edit', text: '重要度' },
      { kind: 'edit', text: '新段' },
      { kind: 'title', text: '新' },
    ])
  })

  test('普通页面（props 空、schema null）与只看正文 + 标题时一致', () => {
    const prev = { title: '旧', blocks: ['a', 'b'] }
    const cur = { title: '新', blocks: ['a', 'c'] }
    expect(summarizeChange({ ...prev, props: {}, schema: null }, { ...cur, props: {}, schema: null })).toEqual(summarizeChange(prev, cur))
    expect(JSON.stringify(summarizeChange({ ...prev, props: {}, schema: null }, { ...cur, props: {}, schema: null }))).toBe(
      JSON.stringify([
        { kind: 'edit', text: 'c' },
        { kind: 'title', text: '新' },
      ]),
    )
  })

  test('summaryState：读行文档的 props；集合页才解析集合定义', () => {
    const doc = new Y.Doc()
    doc.getMap<unknown>('props').set('stat01', 'doing1')
    const state = summaryState(doc, '行', false)
    expect(state).toMatchObject({ title: '行', blocks: [], props: { stat01: 'doing1' }, schema: null })
    const coll = new Y.Doc()
    const root = coll.getMap<unknown>('collection')
    const props = new Y.Map<unknown>()
    root.set('props', props)
    const prop = new Y.Map<unknown>()
    props.set('prio01', prop)
    prop.set('name', '优先级')
    prop.set('type', 'number')
    prop.set('pos', 0)
    expect(summaryState(coll, '集合', true).schema?.props.map((p) => p.name)).toEqual(['优先级'])
  })
})
