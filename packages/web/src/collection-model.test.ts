import { describe, expect, test } from 'vitest'
import {
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  FILTER_OPS,
  isCalendarDate,
  isShortId,
  LIST_MAX,
  NAME_MAX,
  newShortId,
  newStatusOptions,
  newView,
  parseCollection,
  pickView,
  PROP_TYPES,
  readValue,
  rowValue,
  STATUS_GROUPS,
  TEXT_MAX,
  timeMs,
  TITLE_PROP,
  validateValue,
  type CollectionProp,
  type CollectionRow,
  type PropType,
} from '@ramet/shared/collection-model'

/* 不变量（@ramet/shared/collection-model 文件头）：parseCollection 对任何输入都不抛，坏条目跳过、缺字段补默认、
 * 视图里引用已删属性的设置自动忽略；readValue 是唯一解读入口，形状对不上 / 选项已删读成 undefined，原值不动；
 * validateValue 是写入前的唯一校验，null = 删键，空值规范化成 null。 */

function prop(type: PropType, extra: Partial<CollectionProp> = {}): CollectionProp {
  return { id: 'p1', name: '属性', type, pos: 0, options: [], ...extra }
}

const OPTIONS = [
  { id: 'oa', name: '甲', color: 'red' as const, pos: 0 },
  { id: 'ob', name: '乙', color: 'blue' as const, pos: 1 },
]
const STATUS_OPTIONS = [
  { id: 'st', name: '未开始', color: 'gray' as const, pos: 0, group: 'todo' as const },
  { id: 'sd', name: '完成', color: 'green' as const, pos: 0, group: 'done' as const },
]

function row(extra: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 'r1',
    title: '一行',
    icon: null,
    props: {},
    position: null,
    created_at: '2026-10-25 08:00:00.123456+00',
    edited_at: '2026-10-25T09:00:00.000Z',
    has_body: false,
    ...extra,
  }
}

describe('parseCollection：容错', () => {
  test('任何输入都不抛，坏的整体得到空集合', () => {
    for (const bad of [null, undefined, 1, 'x', [], [1, 2], { props: 'x', views: 7 }, { props: [], views: [] }, { v: 'x' }]) {
      expect(parseCollection(bad)).toEqual({ v: 1, props: [], views: [] })
    }
  })

  test('坏条目跳过：不认识的类型、非对象、非法 id（大写 / 下划线 / 保留的 title / 空串）', () => {
    const json = JSON.parse(
      JSON.stringify({
        props: {
          good01: { name: '好', type: 'text', pos: 0 },
          weird1: { name: '未来类型', type: 'relation', pos: 1 },
          notobj: 'x',
          BAD001: { name: '大写', type: 'text' },
          bad_01: { name: '下划线', type: 'text' },
          title: { name: '冒充名称', type: 'text' },
          '': { name: '空', type: 'text' },
        },
      }).replace('"notobj"', '"__proto__":{"name":"原型","type":"text"},"notobj"'),
    )
    const schema = parseCollection(json)
    expect(schema.props.map((p) => p.id)).toEqual(['good01'])
  })

  test('缺字段补默认：名字空串、pos 0、颜色 gray、状态选项缺组按未开始、单选选项不带组、layout 缺省 table', () => {
    const schema = parseCollection({
      props: {
        s00001: { type: 'status', options: { o1: {}, o2: { group: 'done', color: 'nope' } } },
        s00002: { type: 'select', pos: 1, options: { o3: { name: 'x', group: 'done' } } },
      },
      views: { v1: {} },
    })
    const [status, select] = schema.props
    expect(status).toMatchObject({ name: '', pos: 0 })
    expect(status!.options).toEqual([
      { id: 'o1', name: '', color: 'gray', pos: 0, group: 'todo' },
      { id: 'o2', name: '', color: 'gray', pos: 0, group: 'done' },
    ])
    expect(select!.options).toEqual([{ id: 'o3', name: 'x', color: 'gray', pos: 0 }])
    expect(schema.views[0]).toEqual({
      id: 'v1',
      name: '',
      layout: 'table',
      pos: 0,
      filter: { all: [] },
      sorts: [],
      groupBy: null,
      shown: null,
      widths: {},
    })
  })

  test('排序：属性 / 视图按 pos、同 pos 按 id；状态选项先按组（未开始 → 进行中 → 已完成）再按 pos', () => {
    const schema = parseCollection({
      props: {
        bbb: { type: 'text', pos: 1 },
        aaa: { type: 'text', pos: 1 },
        ccc: { type: 'number', pos: 0 },
        sss: {
          type: 'status',
          pos: 2,
          options: {
            d1: { name: '完成', group: 'done', pos: 0 },
            g2: { name: '做着B', group: 'doing', pos: 2 },
            g1: { name: '做着A', group: 'doing', pos: 1 },
            t1: { name: '待办', group: 'todo', pos: 9 },
          },
        },
      },
      views: { vb: { pos: 1 }, va: { pos: 1 }, vc: { pos: -1 } },
    })
    expect(schema.props.map((p) => p.id)).toEqual(['ccc', 'aaa', 'bbb', 'sss'])
    expect(schema.props[3]!.options.map((o) => o.name)).toEqual(['待办', '做着A', '做着B', '完成'])
    expect(schema.views.map((v) => v.id)).toEqual(['vc', 'va', 'vb'])
  })

  test('名字按码点截断到 NAME_MAX，不会切出半个 emoji', () => {
    const long = '😀'.repeat(NAME_MAX + 5)
    const schema = parseCollection({ props: { p1: { type: 'text', name: long } } })
    expect([...schema.props[0]!.name]).toHaveLength(NAME_MAX)
    expect(schema.props[0]!.name).toBe('😀'.repeat(NAME_MAX))
  })
})

describe('parseCollection：视图设置', () => {
  const props = {
    txt: { type: 'text', pos: 0 },
    num: { type: 'number', pos: 1 },
    sel: { type: 'select', pos: 2, options: { oa: { name: '甲' } } },
    sts: { type: 'status', pos: 3, options: { st: { name: '未开始', group: 'todo' } } },
  }

  test('引用了已删属性的筛选、排序、分组、显示列、列宽一律忽略', () => {
    const schema = parseCollection({
      props,
      views: {
        v1: {
          filter: { all: [{ prop: 'gone', op: 'contains', value: 'x' }, { prop: 'txt', op: 'contains', value: 'x' }] },
          sorts: [{ prop: 'gone', dir: 'asc' }, { prop: 'num', dir: 'desc' }],
          groupBy: 'gone',
          shown: ['gone', 'num', 'txt'],
          widths: { gone: 200, txt: 180 },
        },
      },
    })
    const view = schema.views[0]!
    expect(view.filter.all).toEqual([{ prop: 'txt', op: 'contains', value: 'x' }])
    expect(view.sorts).toEqual([{ prop: 'num', dir: 'desc' }])
    expect(view.groupBy).toBeNull()
    expect(view.shown).toEqual(['num', 'txt'])
    expect(view.widths).toEqual({ txt: 180 })
  })

  test('条件：运算不适用于当前类型的丢掉；值不合用的留下但不带值（没填完，界面要能接着编辑）', () => {
    const schema = parseCollection({
      props,
      views: {
        v1: {
          filter: {
            all: [
              { prop: 'num', op: 'contains', value: 'x' }, // 数字没有「包含」（比如改类型之前留下的）
              { prop: 'num', op: 'gt', value: '3' }, // 值形状不对
              { prop: 'sel', op: 'is', value: 'deleted' }, // 选项已删
              { prop: 'sts', op: 'in_group', value: 'doing' },
              { prop: 'title', op: 'eq', value: '名字' }, // 「名称」可以被筛
              { prop: 'txt', op: 'empty', value: 'ignored' }, // 不带值的运算丢掉多余的值
              'garbage',
            ],
          },
        },
      },
    })
    expect(schema.views[0]!.filter.all).toEqual([
      { prop: 'num', op: 'gt' },
      { prop: 'sel', op: 'is' },
      { prop: 'sts', op: 'in_group', value: 'doing' },
      { prop: 'title', op: 'eq', value: '名字' },
      { prop: 'txt', op: 'empty' },
    ])
  })

  test('排序同一属性只留第一级、dir 缺省 asc；分组只认状态 / 单选；shown 去重并去掉 title；不是数组 = null', () => {
    const view = (raw: Record<string, unknown>) => parseCollection({ props, views: { v1: raw } }).views[0]!
    expect(view({ sorts: [{ prop: 'num' }, { prop: 'num', dir: 'desc' }, { prop: 'title', dir: 'desc' }] }).sorts).toEqual([
      { prop: 'num', dir: 'asc' },
      { prop: 'title', dir: 'desc' },
    ])
    expect(view({ groupBy: 'sel' }).groupBy).toBe('sel')
    expect(view({ groupBy: 'sts' }).groupBy).toBe('sts')
    expect(view({ groupBy: 'txt' }).groupBy).toBeNull()
    expect(view({ groupBy: 'title' }).groupBy).toBeNull()
    expect(view({ shown: ['num', 'title', 'num', 3, 'txt'] }).shown).toEqual(['num', 'txt'])
    expect(view({ shown: 'num' }).shown).toBeNull()
    expect(view({ shown: [] }).shown).toEqual([])
    expect(view({ layout: 'board' }).layout).toBe('board')
    expect(view({ layout: 'calendar' }).layout).toBe('table')
  })

  test('列宽夹进区间并取整，「名称」列的宽度保留，非数字丢掉', () => {
    const widths = parseCollection({ props, views: { v1: { widths: { title: 260.4, txt: 1, num: 99999, sel: 'wide' } } } })
      .views[0]!.widths
    expect(widths).toEqual({ title: 260, txt: COLUMN_WIDTH_MIN, num: COLUMN_WIDTH_MAX })
  })
})

describe('readValue：唯一解读入口', () => {
  test('文本 / 链接：非空字符串；别的形状读成空', () => {
    for (const type of ['text', 'url'] as const) {
      expect(readValue(prop(type), 'abc')).toBe('abc')
      expect(readValue(prop(type), '')).toBeUndefined()
      expect(readValue(prop(type), 3)).toBeUndefined()
      expect(readValue(prop(type), ['abc'])).toBeUndefined()
    }
  })

  test('数字：有限数', () => {
    expect(readValue(prop('number'), 0)).toBe(0)
    expect(readValue(prop('number'), -2.5)).toBe(-2.5)
    expect(readValue(prop('number'), Number.NaN)).toBeUndefined()
    expect(readValue(prop('number'), Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(readValue(prop('number'), '3')).toBeUndefined()
  })

  test('单选 / 状态：选项还在才读得出；选项删了读成空', () => {
    expect(readValue(prop('select', { options: OPTIONS }), 'oa')).toBe('oa')
    expect(readValue(prop('select', { options: OPTIONS }), 'gone')).toBeUndefined()
    expect(readValue(prop('select', { options: OPTIONS }), ['oa'])).toBeUndefined()
    expect(readValue(prop('status', { options: STATUS_OPTIONS }), 'sd')).toBe('sd')
  })

  test('多选：只滤掉已删的项并去重，剩下为空才是空；单个字符串不是多选的形状', () => {
    const multi = prop('multi_select', { options: OPTIONS })
    expect(readValue(multi, ['ob', 'gone', 'oa', 'ob', 7])).toEqual(['ob', 'oa'])
    expect(readValue(multi, ['gone'])).toBeUndefined()
    expect(readValue(multi, [])).toBeUndefined()
    expect(readValue(multi, 'oa')).toBeUndefined()
  })

  test('人员：去重的用户 id 列表（成员资格不在这里判，界面再按成员表显示）', () => {
    expect(readValue(prop('person'), ['u1', 'u2', 'u1', ''])).toEqual(['u1', 'u2'])
    expect(readValue(prop('person'), [])).toBeUndefined()
    expect(readValue(prop('person'), 'u1')).toBeUndefined()
  })

  test('日期：真实日历日的 YYYY-MM-DD；复选框：布尔', () => {
    expect(readValue(prop('date'), '2024-02-29')).toBe('2024-02-29')
    expect(readValue(prop('date'), '2026-02-29')).toBeUndefined()
    expect(readValue(prop('date'), '2026-1-1')).toBeUndefined()
    expect(readValue(prop('date'), '2026-10-25T00:00:00Z')).toBeUndefined()
    expect(readValue(prop('checkbox'), true)).toBe(true)
    expect(readValue(prop('checkbox'), false)).toBe(false)
    expect(readValue(prop('checkbox'), 'true')).toBeUndefined()
  })

  test('创建 / 编辑时间不存储：props 里有同名键也读不出', () => {
    expect(readValue(prop('created_time'), '2026-10-25')).toBeUndefined()
    expect(readValue(prop('edited_time'), '2026-10-25')).toBeUndefined()
  })

  test('改类型：对不上的读成空，原值不动，改回原类型就回来；单选与状态的编码相同，值照样读得出', () => {
    const raw = 42
    expect(readValue(prop('number'), raw)).toBe(42)
    expect(readValue(prop('text'), raw)).toBeUndefined()
    expect(readValue(prop('select', { options: OPTIONS }), raw)).toBeUndefined()
    expect(readValue(prop('number'), raw)).toBe(42) // 纯函数：改回来什么都没丢
    expect(readValue(prop('status', { options: [{ ...OPTIONS[0]!, group: 'todo' }] }), 'oa')).toBe('oa')
  })
})

describe('rowValue', () => {
  test('名称取标题、创建 / 编辑时间取行元数据，其余读 props', () => {
    const r = row({ props: { p1: 'x' } })
    expect(rowValue(r, TITLE_PROP)).toBe('一行')
    expect(rowValue(row({ title: '' }), TITLE_PROP)).toBeUndefined()
    expect(rowValue(r, prop('created_time'))).toBe(r.created_at)
    expect(rowValue(r, prop('edited_time'))).toBe(r.edited_at)
    expect(rowValue(r, prop('text'))).toBe('x')
  })

  test('只读自有属性：继承来的 constructor 不是值，JSON 里自有的 __proto__ 键照常读', () => {
    expect(rowValue(row(), prop('text', { id: 'constructor' }))).toBeUndefined()
    const fromJson = row({ props: JSON.parse('{"__proto__":"x","p1":"y"}') as Record<string, unknown> })
    expect(rowValue(fromJson, prop('text', { id: '__proto__' }))).toBe('x')
    expect(rowValue(fromJson, prop('text'))).toBe('y')
  })
})

describe('validateValue：写入前的唯一校验', () => {
  const members = new Set(['u1', 'u2'])

  test('null 恒合法（删键）；空文本 / 空列表 / 未勾选规范化成 null', () => {
    for (const type of PROP_TYPES.filter((t) => t !== 'created_time' && t !== 'edited_time')) {
      expect(validateValue(prop(type), null)).toEqual({ ok: true, value: null })
    }
    expect(validateValue(prop('text'), '')).toEqual({ ok: true, value: null })
    expect(validateValue(prop('url'), '   ')).toEqual({ ok: true, value: null })
    expect(validateValue(prop('multi_select', { options: OPTIONS }), [])).toEqual({ ok: true, value: null })
    expect(validateValue(prop('person'), [], { members })).toEqual({ ok: true, value: null })
    expect(validateValue(prop('checkbox'), false)).toEqual({ ok: true, value: null })
    expect(validateValue(prop('checkbox'), true)).toEqual({ ok: true, value: true })
  })

  test('文本：长度按码点、保留换行与制表，拒绝其它控制字符与半个代理项（JSONB 存不了）', () => {
    expect(validateValue(prop('text'), '第一行\n\t第二行')).toEqual({ ok: true, value: '第一行\n\t第二行' })
    expect(validateValue(prop('text'), '😀'.repeat(TEXT_MAX)).ok).toBe(true)
    expect(validateValue(prop('text'), 'a'.repeat(TEXT_MAX + 1)).ok).toBe(false)
    expect(validateValue(prop('text'), 'a\u0000b').ok).toBe(false)
    expect(validateValue(prop('text'), 'a\ud83d').ok).toBe(false)
    expect(validateValue(prop('text'), '\ude00a').ok).toBe(false)
    expect(validateValue(prop('text'), 3).ok).toBe(false)
  })

  test('链接：去首尾空白，拒绝控制字符、超长与会执行脚本的协议', () => {
    expect(validateValue(prop('url'), '  https://example.com/a  ')).toEqual({ ok: true, value: 'https://example.com/a' })
    expect(validateValue(prop('url'), 'example.com').ok).toBe(true)
    expect(validateValue(prop('url'), 'JavaScript:alert(1)').ok).toBe(false)
    expect(validateValue(prop('url'), 'data:text/html,x').ok).toBe(false)
    expect(validateValue(prop('url'), 'https://a\n.com').ok).toBe(false)
    expect(validateValue(prop('url'), 'https://' + 'a'.repeat(TEXT_MAX)).ok).toBe(false)
  })

  test('数字：有限数；-0 归一成 0', () => {
    expect(validateValue(prop('number'), 3.5)).toEqual({ ok: true, value: 3.5 })
    const zero = validateValue(prop('number'), -0)
    expect(zero.ok && Object.is(zero.value, 0)).toBe(true)
    expect(validateValue(prop('number'), Number.NaN).ok).toBe(false)
    expect(validateValue(prop('number'), Number.POSITIVE_INFINITY).ok).toBe(false)
    expect(validateValue(prop('number'), '3').ok).toBe(false)
  })

  test('单选 / 状态 / 多选：选项必须存在；多选去重、有上限', () => {
    expect(validateValue(prop('select', { options: OPTIONS }), 'oa')).toEqual({ ok: true, value: 'oa' })
    expect(validateValue(prop('select', { options: OPTIONS }), 'gone').ok).toBe(false)
    expect(validateValue(prop('status', { options: STATUS_OPTIONS }), 'sd')).toEqual({ ok: true, value: 'sd' })
    const multi = prop('multi_select', { options: OPTIONS })
    expect(validateValue(multi, ['ob', 'oa', 'ob'])).toEqual({ ok: true, value: ['ob', 'oa'] })
    expect(validateValue(multi, ['oa', 'gone']).ok).toBe(false)
    expect(validateValue(multi, ['oa', 3]).ok).toBe(false)
    expect(validateValue(multi, 'oa').ok).toBe(false)
    const many = prop('multi_select', { options: Array.from({ length: LIST_MAX + 1 }, (_, i) => ({ ...OPTIONS[0]!, id: `o${i}` })) })
    expect(validateValue(many, many.options.map((o) => o.id)).ok).toBe(false)
    expect(validateValue(many, many.options.slice(0, LIST_MAX).map((o) => o.id)).ok).toBe(true)
  })

  test('人员：只能选空间成员；没给成员表一律不合法', () => {
    expect(validateValue(prop('person'), ['u2', 'u1', 'u2'], { members })).toEqual({ ok: true, value: ['u2', 'u1'] })
    expect(validateValue(prop('person'), ['u1', 'agent'], { members }).ok).toBe(false)
    expect(validateValue(prop('person'), ['u1']).ok).toBe(false)
  })

  test('日期：必须是真实日历日', () => {
    expect(validateValue(prop('date'), '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' })
    for (const bad of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-1', 20261025]) {
      expect(validateValue(prop('date'), bad).ok).toBe(false)
    }
    expect(validateValue(prop('date'), '2000-02-29').ok).toBe(true)
  })

  test('复选框只收布尔；创建 / 编辑时间不能写', () => {
    expect(validateValue(prop('checkbox'), 'true').ok).toBe(false)
    expect(validateValue(prop('created_time'), '2026-10-25').ok).toBe(false)
    expect(validateValue(prop('edited_time'), '2026-10-25').ok).toBe(false)
  })

  test('非法时带原因', () => {
    const result = validateValue(prop('select', { options: OPTIONS }), 'gone')
    expect(result).toEqual({ ok: false, error: '没有这个选项' })
  })
})

describe('id、模板与小工具', () => {
  test('newShortId：6 位 base36，避开已有的 id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newShortId()))
    expect(ids.size).toBe(200)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-z]{6}$/)
      expect(isShortId(id)).toBe(true)
    }
    let asked = 0
    const id = newShortId({ has: () => ++asked <= 3 })
    expect(asked).toBe(4)
    expect(id).toHaveLength(6)
  })

  test('newStatusOptions：三组各一个，名字同组名；解析后能当状态的值', () => {
    const options = newStatusOptions()
    expect(Object.keys(options)).toHaveLength(3)
    const schema = parseCollection({ props: { st0001: { name: '状态', type: 'status', pos: 0, options } } })
    expect(schema.props[0]!.options.map((o) => [o.name, o.group])).toEqual(STATUS_GROUPS.map((g) => [g.name, g.id]))
  })

  test('newView 与 pickView：给的 id 不在就用第一个视图，一个都没有就是空白表格视图', () => {
    expect(newView('看板', 'board', 2, 'st0001')).toEqual({
      name: '看板',
      layout: 'board',
      pos: 2,
      filter: { all: [] },
      sorts: [],
      groupBy: 'st0001',
      shown: null,
      widths: {},
    })
    const schema = parseCollection({ views: { vb: { pos: 1, name: 'B' }, va: { pos: 0, name: 'A' } } })
    expect(pickView(schema, 'vb').name).toBe('B')
    expect(pickView(schema, 'gone').name).toBe('A')
    expect(pickView(schema).name).toBe('A')
    expect(pickView(parseCollection(null))).toMatchObject({ id: '', layout: 'table', filter: { all: [] } })
  })

  test('FILTER_OPS：每种类型都有运算，名称按文本', () => {
    for (const type of PROP_TYPES) expect(FILTER_OPS[type].length).toBeGreaterThan(0)
    expect(FILTER_OPS[TITLE_PROP.type]).toContain('contains')
  })

  test('timeMs：Postgres 的 now()::text 与 ISO 8601 同一时刻；没写时区按 UTC；认不出 = NaN', () => {
    const iso = Date.parse('2026-10-25T08:12:33.123Z')
    expect(timeMs('2026-10-25 08:12:33.123456+00')).toBe(iso)
    expect(timeMs('2026-10-25T08:12:33.123Z')).toBe(iso)
    expect(timeMs('2026-10-25 16:12:33.123+08')).toBe(iso)
    expect(timeMs('2026-10-25 13:42:33.123+05:30')).toBe(iso)
    expect(timeMs('2026-10-25 05:12:33.123-03')).toBe(iso)
    expect(timeMs('2026-10-25 08:12:33.123')).toBe(iso)
    expect(Number.isNaN(timeMs('昨天'))).toBe(true)
  })

  test('isCalendarDate：闰年规则', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true)
    expect(isCalendarDate('2000-02-29')).toBe(true)
    expect(isCalendarDate('2100-02-29')).toBe(false)
    expect(isCalendarDate('2026-12-31')).toBe(true)
    expect(isCalendarDate('2026-12-32')).toBe(false)
  })
})
