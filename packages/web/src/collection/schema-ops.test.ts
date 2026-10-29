import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { newStatusOptions, newView, parseCollection, pickView, readValue, TITLE_PROP_ID } from '@ramet/shared/collection-model'
import {
  addOption,
  addProp,
  addView,
  deleteOption,
  deleteProp,
  deleteView,
  moveOption,
  moveProp,
  moveView,
  posAt,
  renameProp,
  renameView,
  restoreCollection,
  restoreRowProps,
  setFilter,
  setGroupBy,
  setLayout,
  setPropType,
  setShown,
  setSorts,
  setWidth,
  toggleShown,
  updateOption,
} from './schema-ops'

/* 不变量：每个操作写进 Y 结构后，toJSON → parseCollection 读回的就是预期的属性定义 / 视图（与服务端 init-doc 同形）；
 * 并发语义靠层级：props / 属性 / options / views / 视图 / widths 是 Y.Map，两人同时加选项能合并。 */

/** 同服务端 collections/init-doc.ts 的新集合：一个「状态」属性 + 一个表格视图 */
function newDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const root = doc.getMap<unknown>('collection')
    root.set('v', 1)
    const props = new Y.Map<unknown>()
    root.set('props', props)
    const status = new Y.Map<unknown>()
    props.set('sts001', status)
    status.set('name', '状态')
    status.set('type', 'status')
    status.set('pos', 0)
    const options = new Y.Map<unknown>()
    status.set('options', options)
    for (const [id, option] of Object.entries(newStatusOptions())) options.set(id, option)
    const views = new Y.Map<unknown>()
    root.set('views', views)
    const view = new Y.Map<unknown>()
    views.set('tbl001', view)
    const { widths, ...settings } = newView('表格', 'table', 0)
    for (const [key, value] of Object.entries(settings)) view.set(key, value)
    const widthMap = new Y.Map<unknown>()
    view.set('widths', widthMap)
    for (const [key, value] of Object.entries(widths)) widthMap.set(key, value)
  })
  return doc
}

const read = (doc: Y.Doc) => parseCollection(doc.getMap('collection').toJSON())

describe('posAt', () => {
  test('两端外扩 1，中间取中点', () => {
    expect(posAt([], 0)).toBe(0)
    expect(posAt([0, 1], 0)).toBe(-1)
    expect(posAt([0, 1], 2)).toBe(2)
    expect(posAt([0, 1], 1)).toBe(0.5)
    expect(posAt([0, 1], 99)).toBe(2)
  })
})

describe('属性', () => {
  test('加属性：排在最后，各类型的选项表', () => {
    const doc = newDoc()
    const text = addProp(doc, ' 备注 ', 'text')
    const sel = addProp(doc, '优先级', 'select')
    const sts = addProp(doc, '进度', 'status')
    const schema = read(doc)
    expect(schema.props.map((p) => p.id)).toEqual(['sts001', text, sel, sts])
    expect(schema.props.find((p) => p.id === text)).toMatchObject({ name: '备注', type: 'text', options: [] })
    expect(schema.props.find((p) => p.id === sel)?.options).toEqual([])
    expect(schema.props.find((p) => p.id === sts)?.options.map((o) => o.group)).toEqual(['todo', 'doing', 'done'])
    // 属性本身是 Y.Map（并发改名 / 改类型各自后写为准）
    expect(doc.getMap('collection').get('props')).toBeInstanceOf(Y.Map)
    expect((doc.getMap('collection').get('props') as Y.Map<unknown>).get(sel)).toBeInstanceOf(Y.Map)
  })

  test('改名、删属性', () => {
    const doc = newDoc()
    const id = addProp(doc, 'a', 'number')
    renameProp(doc, id, '工时')
    expect(read(doc).props.find((p) => p.id === id)?.name).toBe('工时')
    deleteProp(doc, id)
    expect(read(doc).props.map((p) => p.id)).toEqual(['sts001'])
  })

  test('改类型只改 type：选项保留，改回去还在；读值按新类型', () => {
    const doc = newDoc()
    const id = addProp(doc, '级别', 'select')
    const hi = addOption(doc, id, '高', 'red')!
    setPropType(doc, id, 'text')
    const asText = read(doc).props.find((p) => p.id === id)!
    expect(asText.type).toBe('text')
    expect(readValue(asText, hi)).toBe(hi) // 文本读得出（是个字符串）
    setPropType(doc, id, 'number')
    expect(readValue(read(doc).props.find((p) => p.id === id)!, hi)).toBeUndefined()
    setPropType(doc, id, 'select')
    const back = read(doc).props.find((p) => p.id === id)!
    expect(back.options.map((o) => o.id)).toEqual([hi])
    expect(readValue(back, hi)).toBe(hi)
  })

  test('换成状态且没有选项：补三个默认选项；单选的选项换成状态按「未开始」', () => {
    const doc = newDoc()
    const empty = addProp(doc, 'x', 'text')
    setPropType(doc, empty, 'status')
    expect(read(doc).props.find((p) => p.id === empty)?.options).toHaveLength(3)
    const sel = addProp(doc, 'y', 'select')
    addOption(doc, sel, 'A', 'blue')
    setPropType(doc, sel, 'status')
    expect(read(doc).props.find((p) => p.id === sel)?.options.map((o) => [o.name, o.group])).toEqual([['A', 'todo']])
  })

  test('调顺序', () => {
    const doc = newDoc()
    const a = addProp(doc, 'a', 'text')
    const b = addProp(doc, 'b', 'text')
    moveProp(doc, b, 0)
    expect(read(doc).props.map((p) => p.id)).toEqual([b, 'sts001', a])
    moveProp(doc, 'sts001', 99)
    expect(read(doc).props.map((p) => p.id)).toEqual([b, a, 'sts001'])
  })
})

describe('选项', () => {
  test('增、改名、改色、删', () => {
    const doc = newDoc()
    const id = addProp(doc, '标签', 'multi_select')
    const a = addOption(doc, id, 'A', 'gray')!
    const b = addOption(doc, id, 'B', 'blue')!
    expect(read(doc).props.find((p) => p.id === id)?.options.map((o) => o.id)).toEqual([a, b])
    updateOption(doc, id, a, { name: 'AA', color: 'red' })
    expect(read(doc).props.find((p) => p.id === id)?.options[0]).toMatchObject({ id: a, name: 'AA', color: 'red' })
    deleteOption(doc, id, a)
    expect(read(doc).props.find((p) => p.id === id)?.options.map((o) => o.id)).toEqual([b])
    expect(addOption(doc, 'nope00', 'x', 'gray')).toBeNull()
  })

  test('状态选项：加到所给组，组内排序与换组', () => {
    const doc = newDoc()
    const doing = addOption(doc, 'sts001', '评审中', 'purple', 'doing')!
    const prop = () => read(doc).props.find((p) => p.id === 'sts001')!
    expect(prop().options.filter((o) => o.group === 'doing').map((o) => o.id).at(-1)).toBe(doing)
    moveOption(doc, 'sts001', doing, 0)
    expect(prop().options.filter((o) => o.group === 'doing')[0]?.id).toBe(doing)
    moveOption(doc, 'sts001', doing, 99, 'done')
    expect(prop().options.find((o) => o.id === doing)?.group).toBe('done')
    expect(prop().options.at(-1)?.id).toBe(doing)
  })

  test('两端同时加选项能合并（选项表是 Y.Map）', () => {
    const a = newDoc()
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const id = addProp(a, 'sel', 'select')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    addOption(a, id, '甲', 'red')
    addOption(b, id, '乙', 'blue')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const names = (doc: Y.Doc) => read(doc).props.find((p) => p.id === id)!.options.map((o) => o.name).sort()
    expect(names(a)).toEqual(['乙', '甲'].sort())
    expect(names(b)).toEqual(names(a))
  })
})

describe('视图', () => {
  test('建、改名、排序、删（至少留一个）', () => {
    const doc = newDoc()
    const v2 = addView(doc, '第二个', 'table')
    expect(read(doc).views.map((v) => v.id)).toEqual(['tbl001', v2])
    renameView(doc, v2, '我的')
    moveView(doc, v2, 0)
    expect(read(doc).views.map((v) => [v.id, v.name])).toEqual([
      [v2, '我的'],
      ['tbl001', '表格'],
    ])
    expect(deleteView(doc, v2)).toBe(true)
    expect(deleteView(doc, 'tbl001')).toBe(false)
    expect(read(doc).views.map((v) => v.id)).toEqual(['tbl001'])
  })

  test('看板视图默认按第一个状态 / 单选属性分组', () => {
    const doc = newDoc()
    const board = addView(doc, '看板', 'board')
    expect(pickView(read(doc), board)).toMatchObject({ layout: 'board', groupBy: 'sts001' })
  })

  test('换布局：切到看板且没分组时补第一个状态 / 单选属性；已分组的不动；切回表格分组留着', () => {
    const doc = newDoc()
    const sel = addProp(doc, '优先级', 'select')
    setLayout(doc, 'tbl001', 'board')
    expect(pickView(read(doc), 'tbl001')).toMatchObject({ layout: 'board', groupBy: 'sts001' })
    setGroupBy(doc, 'tbl001', sel)
    setLayout(doc, 'tbl001', 'table')
    setLayout(doc, 'tbl001', 'board')
    expect(pickView(read(doc), 'tbl001')).toMatchObject({ layout: 'board', groupBy: sel })
    setLayout(doc, 'tbl001', 'table')
    expect(pickView(read(doc), 'tbl001')).toMatchObject({ layout: 'table', groupBy: sel })
  })

  test('换布局：没有可分组的属性时看板不分组（画空状态）', () => {
    const doc = newDoc()
    deleteProp(doc, 'sts001')
    setLayout(doc, 'tbl001', 'board')
    expect(pickView(read(doc), 'tbl001')).toMatchObject({ layout: 'board', groupBy: null })
    expect(addView(doc, '看板', 'board')).toBeTruthy()
    expect(read(doc).views.every((v) => v.groupBy === null)).toBe(true)
  })

  test('筛选、排序、分组、显示属性、列宽各自保存，互不影响', () => {
    const doc = newDoc()
    const num = addProp(doc, '工时', 'number')
    const other = addView(doc, '另一个', 'table')
    setFilter(doc, 'tbl001', { all: [{ prop: num, op: 'gt', value: 3 }] })
    setSorts(doc, 'tbl001', [{ prop: TITLE_PROP_ID, dir: 'desc' }, { prop: num, dir: 'asc' }])
    setGroupBy(doc, 'tbl001', 'sts001')
    setShown(doc, 'tbl001', [num, TITLE_PROP_ID])
    setWidth(doc, 'tbl001', TITLE_PROP_ID, 10)
    setWidth(doc, 'tbl001', num, 180.4)
    const view = pickView(read(doc), 'tbl001')
    expect(view.filter).toEqual({ all: [{ prop: num, op: 'gt', value: 3 }] })
    expect(view.sorts).toEqual([
      { prop: TITLE_PROP_ID, dir: 'desc' },
      { prop: num, dir: 'asc' },
    ])
    expect(view.groupBy).toBe('sts001')
    expect(view.shown).toEqual([num])
    expect(view.widths).toEqual({ [TITLE_PROP_ID]: 40, [num]: 180 })
    expect(pickView(read(doc), other)).toMatchObject({ filter: { all: [] }, sorts: [], groupBy: null, shown: null, widths: {} })
  })

  test('隐藏 / 显示列：null 先展开成显式列表，显示的接在末尾', () => {
    const doc = newDoc()
    const a = addProp(doc, 'a', 'text')
    toggleShown(doc, 'tbl001', 'sts001', false)
    expect(pickView(read(doc), 'tbl001').shown).toEqual([a])
    toggleShown(doc, 'tbl001', a, true) // 已显示：不动
    expect(pickView(read(doc), 'tbl001').shown).toEqual([a])
    toggleShown(doc, 'tbl001', 'sts001', true)
    expect(pickView(read(doc), 'tbl001').shown).toEqual([a, 'sts001'])
  })

  test('删属性后视图里引用它的设置被忽略，属性回来（恢复版本）设置也回来', () => {
    const doc = newDoc()
    const num = addProp(doc, '工时', 'number')
    setSorts(doc, 'tbl001', [{ prop: num, dir: 'asc' }])
    const saved = Y.encodeStateAsUpdate(doc)
    deleteProp(doc, num)
    expect(pickView(read(doc), 'tbl001').sorts).toEqual([])
    const restored = new Y.Doc()
    Y.applyUpdate(restored, saved)
    expect(pickView(read(restored), 'tbl001').sorts).toEqual([{ prop: num, dir: 'asc' }])
  })
})

describe('restoreCollection：恢复集合页的某个版本（字段级同步）', () => {
  const snap = (doc: Y.Doc): unknown => doc.getMap('collection').toJSON()
  /** 记下一次操作产生的协同增量条数 */
  function updatesDuring(doc: Y.Doc, fn: () => void): number {
    let n = 0
    const count = (): void => {
      n++
    }
    doc.on('update', count)
    fn()
    doc.off('update', count)
    return n
  }

  test('删属性 / 改名 / 加视图 / 删视图 / 改筛选与列宽 / 删选项之后恢复：读回与那个版本一致', () => {
    const doc = newDoc()
    const prio = addProp(doc, '优先级', 'select')
    addOption(doc, prio, '高', 'red')
    const board = addView(doc, '看板', 'board')
    setWidth(doc, 'tbl001', 'sts001', 300)
    const version = snap(doc)
    const expected = parseCollection(version)

    deleteProp(doc, prio)
    renameProp(doc, 'sts001', '进度')
    const status = read(doc).props[0]!
    deleteOption(doc, 'sts001', status.options[0]!.id)
    addView(doc, '新视图', 'table')
    deleteView(doc, board)
    setFilter(doc, 'tbl001', { all: [{ prop: 'sts001', op: 'empty' }] })
    setWidth(doc, 'tbl001', 'sts001', 120)
    addProp(doc, '备注', 'text')

    restoreCollection(doc, version)
    expect(read(doc)).toEqual(expected)
  })

  test('新建出来的结构与 addProp / addView 一致：属性、选项表、视图、列宽是 Y.Map，选项本身是普通值', () => {
    const doc = newDoc()
    const prio = addProp(doc, '优先级', 'select')
    addOption(doc, prio, '高', 'red')
    const board = addView(doc, '看板', 'board')
    setWidth(doc, board, prio, 222)
    const version = snap(doc)
    deleteProp(doc, prio)
    deleteView(doc, board)

    restoreCollection(doc, version)
    const root = doc.getMap<unknown>('collection')
    const prop = (root.get('props') as Y.Map<unknown>).get(prio)
    expect(prop).toBeInstanceOf(Y.Map)
    const options = (prop as Y.Map<unknown>).get('options')
    expect(options).toBeInstanceOf(Y.Map)
    for (const option of (options as Y.Map<unknown>).values()) expect(option).not.toBeInstanceOf(Y.AbstractType)
    const view = (root.get('views') as Y.Map<unknown>).get(board) as Y.Map<unknown>
    expect(view).toBeInstanceOf(Y.Map)
    expect(view.get('widths')).toBeInstanceOf(Y.Map)
    expect(view.toJSON()).toMatchObject({ layout: 'board', groupBy: 'sts001', shown: null, sorts: [], filter: { all: [] } })
    expect(read(doc).views.find((v) => v.id === board)?.widths).toEqual({ [prio]: 222 })
  })

  test('没变的字段不写：恢复到与当前相同的版本不产生增量；别人同时改的其他字段不被覆盖', () => {
    const doc = newDoc()
    const version = snap(doc)
    expect(updatesDuring(doc, () => restoreCollection(doc, version))).toBe(0)

    // 本端恢复（只改回属性名），对端同时改视图名：合并后两边的改动都在
    renameProp(doc, 'sts001', '进度')
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    renameView(peer, 'tbl001', '全部任务')
    restoreCollection(doc, version)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    expect(read(doc)).toEqual(read(peer))
    expect(read(doc).props[0]!.name).toBe('状态')
    expect(read(doc).views[0]!.name).toBe('全部任务')
  })

  test('改类型留下的旧选项不被清掉：版本里是文本类型，恢复后选项表仍在，改回状态还能用', () => {
    const doc = newDoc()
    const options = read(doc).props[0]!.options
    setPropType(doc, 'sts001', 'text')
    const version = snap(doc)
    setPropType(doc, 'sts001', 'status')
    restoreCollection(doc, version)
    expect(read(doc).props[0]!.type).toBe('text')
    setPropType(doc, 'sts001', 'status')
    expect(read(doc).props[0]!.options).toEqual(options)
  })

  test('反方向：版本里是状态、当前改成了文本，恢复只改回类型，没变的选项不重写', () => {
    const doc = newDoc()
    const version = snap(doc)
    setPropType(doc, 'sts001', 'text')
    const props = doc.getMap<unknown>('collection').get('props') as Y.Map<unknown>
    const optionMap = (props.get('sts001') as Y.Map<unknown>).get('options') as Y.Map<unknown>
    let touched = 0
    optionMap.observe((event) => {
      touched += event.keysChanged.size
    })
    restoreCollection(doc, version)
    expect(read(doc).props[0]!.type).toBe('status')
    expect(touched).toBe(0)
    expect(read(doc)).toEqual(parseCollection(version))
  })

  test('脏快照不崩：坏条目跳过，读回与 parseCollection(快照) 一致', () => {
    for (const dirty of [null, 42, 'x', { props: 5, views: [] }, { props: { __proto__: 1, 'BAD!': {}, ok0001: { name: 'x', type: 'weird' }, ok0002: { name: 3, type: 'number' } } }]) {
      const doc = newDoc()
      expect(() => restoreCollection(doc, dirty)).not.toThrow()
      expect(read(doc)).toEqual(parseCollection(dirty))
    }
  })
})

describe('restoreRowProps：恢复行页面的某个版本时写回属性值', () => {
  test('不同才写、快照里没有（或为 null）的键删掉；与当前相同不产生增量', () => {
    const doc = new Y.Doc()
    const map = doc.getMap<unknown>('props')
    map.set('a00001', 1)
    map.set('b00001', 'x')
    map.set('m00001', ['p', 'q'])
    restoreRowProps(doc, { b00001: 'x', c00001: true, d00001: null, m00001: ['p', 'q'] })
    expect(map.toJSON()).toEqual({ b00001: 'x', c00001: true, m00001: ['p', 'q'] })
    let n = 0
    doc.on('update', () => n++)
    restoreRowProps(doc, { b00001: 'x', c00001: true, m00001: ['p', 'q'] })
    expect(n).toBe(0)
    restoreRowProps(doc, {})
    expect(map.toJSON()).toEqual({})
    expect(n).toBe(1)
  })
})
