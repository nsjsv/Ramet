import { describe, expect, test } from 'vitest'
import { newStatusOptions, parseCollection, pickView, type CollectionRow } from '@ramet/shared/collection-model'
import { queryWindow } from '@ramet/shared/collection-query'
import { sectionsOf } from '../table/table-model'
import { listDrop, newRowSet, visibleRows } from './list-model'

/* 不变量：分段直接用表格的 sectionsOf（这里不重测）；看得见的行不含折叠的段；段底新建带上这一段的分组值
 * （无值段、不分组不带）；拖行只在同一段里，落回原处不发请求。 */

const OPTS = newStatusOptions()
const [TODO, DOING, DONE] = Object.keys(OPTS) as [string, string, string]

const schema = parseCollection({
  props: {
    sel001: { name: '优先级', type: 'select', pos: 0, options: { hi: { name: '高', pos: 0 }, lo: { name: '低', pos: 1 } } },
    sts001: { name: '状态', type: 'status', pos: 1, options: OPTS },
  },
  views: {
    grouped: { name: '列表', layout: 'list', pos: 0, groupBy: 'sel001' },
    status: { name: '按状态', layout: 'list', pos: 1, groupBy: 'sts001' },
    flat: { name: '平铺', layout: 'list', pos: 2 },
  },
})

const row = (id: string, props: Record<string, unknown>, position: number): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props,
  position,
  created_at: '2026-10-25 00:00:00+00',
  edited_at: '2026-10-25 00:00:00+00',
  has_body: false,
})

const rows = [row('a', { sel001: 'hi' }, 0), row('b', {}, 1), row('c', { sel001: 'lo' }, 2), row('d', { sel001: 'hi' }, 3)]
const sectionsFor = (viewId: string) => {
  const view = pickView(schema, viewId)
  return { view, sections: sectionsOf(queryWindow(rows, view, schema), schema, view) }
}

describe('看得见的行', () => {
  test('按段的顺序连起来，折叠的段不算；不分组时就是整个窗口', () => {
    const { sections } = sectionsFor('grouped')
    expect(sections.map((s) => s.key)).toEqual(['', 'hi', 'lo'])
    expect(visibleRows(sections, new Set()).map((r) => r.id)).toEqual(['b', 'a', 'd', 'c'])
    expect(visibleRows(sections, new Set(['hi'])).map((r) => r.id)).toEqual(['b', 'c'])
    const flat = sectionsFor('flat').sections
    expect(visibleRows(flat, new Set(['hi'])).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('段底新建带的分组值', () => {
  test('有值段带上选项 id；无值段、不分组都不带', () => {
    const { view, sections } = sectionsFor('grouped')
    expect(sections.map((s) => newRowSet(view, s))).toEqual([undefined, { sel001: 'hi' }, { sel001: 'lo' }])
    const flat = sectionsFor('flat')
    expect(newRowSet(flat.view, flat.sections[0]!)).toBeUndefined()
  })

  test('状态分组：每段都是一个选项（空值读成缺省选项，没有无值段）', () => {
    const { view, sections } = sectionsFor('status')
    expect(sections.map((s) => newRowSet(view, s))).toEqual([{ sts001: TODO }, { sts001: DOING }, { sts001: DONE }])
  })
})

describe('拖行', () => {
  test('同段里挪：给出落下后的前后邻居；落回原处 = null', () => {
    const { sections } = sectionsFor('grouped')
    const hi = sections[1]!
    expect(listDrop({ id: 'a', section: 'hi' }, hi, 'd', true)).toEqual({ after: 'd', before: null })
    expect(listDrop({ id: 'd', section: 'hi' }, hi, 'a', false)).toEqual({ after: null, before: 'a' })
    expect(listDrop({ id: 'a', section: 'hi' }, hi, 'd', false)).toBeNull()
    expect(listDrop({ id: 'a', section: 'hi' }, hi, 'a', true)).toBeNull()
  })

  test('跨段不能拖（改分组值走属性编辑，不靠拖）', () => {
    const { sections } = sectionsFor('grouped')
    expect(listDrop({ id: 'b', section: '' }, sections[1]!, 'a', false)).toBeNull()
  })

  test('不分组：整个窗口一段', () => {
    const { sections } = sectionsFor('flat')
    expect(listDrop({ id: 'a', section: null }, sections[0]!, 'c', true)).toEqual({ after: 'c', before: 'd' })
  })
})
