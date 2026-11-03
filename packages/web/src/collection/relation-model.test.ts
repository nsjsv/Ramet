import { describe, expect, test } from 'vitest'
import { parseCollection, type CollectionProp, type PropRef } from '@ramet/shared/collection-model'
import type { Page } from '../api'
import {
  itemValue,
  linkedPages,
  relatableCollections,
  relationCandidates,
  relationText,
  rollupDate,
  rollupNumber,
  rollupTarget,
  toggleLink,
  withoutForward,
} from './relation-model'

/* 关联格 / 选择器的口径：候选只有对方集合的活 doc 子页、按标题搜、已选在前、有上限；能关联的集合只在同一个空间；
 * 汇总的数字 / 日期按输出类型写成文字。 */

const T = 'c-target'
const page = (id: string, parent: string | null, title = id, kind: Page['kind'] = 'doc', space = 's1'): Page => ({
  id,
  parent_id: parent,
  title,
  kind,
  created_at: '',
  space_id: space,
  published: false,
  publish_includes_runs: false,
  icon: null,
})

const PAGES: Page[] = [
  page(T, null, '项目', 'collection'),
  page('r1', T, '阿尔法'),
  page('r2', T, '贝塔'),
  page('r3', T, '阿尔法二期'),
  page('run', T, '过程', 'run'),
  page('other', 'c-else', '阿尔法别处'),
  page('c-else', null, '别的集合', 'collection'),
  page('c-far', null, '别的空间', 'collection', 's2'),
]

describe('关联格与选择器', () => {
  test('画得出来的行：只认对方集合的 doc 子页，保持值的顺序', () => {
    expect(linkedPages(['r2', 'gone', 'other', 'r1', 'run'], T, PAGES).map((p) => p.id)).toEqual(['r2', 'r1'])
    expect(linkedPages(['r1'], undefined, PAGES)).toEqual([])
    expect(linkedPages(['r1'], T, null)).toEqual([])
  })

  test('候选：对方集合的行，按标题搜（不分大小写），已选的在前，超出上限给剩余数', () => {
    const all = relationCandidates(PAGES, T, ['r3'], '', 10)
    expect(all.items.map((c) => [c.page.id, c.on])).toEqual([
      ['r3', true],
      ['r1', false],
      ['r2', false],
    ])
    expect(relationCandidates(PAGES, T, [], '阿尔法', 10).items.map((c) => c.page.id)).toEqual(['r1', 'r3'])
    expect(relationCandidates(PAGES, T, [], 'ALPHA', 10).items).toEqual([])
    expect(relationCandidates([...PAGES, page('r4', T, 'Alpha')], T, [], 'alpha', 10).items.map((c) => c.page.id)).toEqual(['r4'])
    const capped = relationCandidates(PAGES, T, [], '', 2)
    expect(capped.items).toHaveLength(2)
    expect(capped.more).toBe(1)
    // 已选但不在对方集合里的（进了回收站）不出现
    expect(relationCandidates(PAGES, T, ['gone'], '', 10).items.map((c) => c.page.id)).toEqual(['r1', 'r2', 'r3'])
  })

  test('点一行：多选切换，只能关联一行时换成它、再点一次清空', () => {
    expect(toggleLink(['a'], 'b', false)).toEqual(['a', 'b'])
    expect(toggleLink(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggleLink(['a'], 'b', true)).toEqual(['b'])
    expect(toggleLink(['b'], 'b', true)).toEqual([])
  })

  test('能关联的集合：同一个空间的集合（含本集合），按标题排', () => {
    expect(relatableCollections(PAGES, 's1').map((p) => p.id)).toEqual(['c-else', T])
    expect(relatableCollections(PAGES, null)).toEqual([])
  })

  test('文字：标题用「、」连，不在列表里的写占位', () => {
    expect(relationText(['r1', 'gone', 'r2'], PAGES, '已不在的行', '未命名')).toBe('阿尔法、已不在的行、贝塔')
    expect(relationText(['x'], [page('x', T, '')], '已不在的行', '未命名')).toBe('未命名')
  })
})

describe('汇总的样子', () => {
  const days = (n: string) => `${n} 天`
  test('数字：占比 1 位小数的百分数、日期范围带天、其余最多 2 位小数、编号的最小最大带前缀', () => {
    expect(rollupNumber('percent_checked', 1 / 3, null, days)).toBe('33.3%')
    expect(rollupNumber('percent_empty', 1, null, days)).toBe('100.0%')
    expect(rollupNumber('percent_not_empty', 0, null, days)).toBe('0.0%')
    expect(rollupNumber('date_range', 3, null, days)).toBe('3 天')
    expect(rollupNumber('average', 10 / 3, null, days)).toBe('3.33')
    expect(rollupNumber('count', 4, null, days)).toBe('4')
    const id: CollectionProp = { id: 'title', name: '', type: 'unique_id', pos: 0, options: [], cfg: { prefix: 'T' } }
    expect(rollupNumber('max', 7, id, days)).toBe('T-7')
    expect(rollupNumber('sum', 7, id, days)).toBe('7')
  })

  test('日期：日历日原样（区间写箭头），时间戳按本地时区', () => {
    expect(rollupDate('2026-10-02')).toBe('2026-10-02')
    expect(rollupDate('2026-10-02T03:04:00Z')).toMatch(/^2026-10-0\d \d\d:\d\d$/)
  })

  test('目标属性定义：refs 里没有就是 null', () => {
    const ref: PropRef = { state: 'ok', prop: { type: 'select', options: [], cfg: {} } }
    expect(rollupTarget(ref)?.type).toBe('select')
    expect(rollupTarget({ state: 'broken' })).toBeNull()
    expect(rollupTarget(undefined)).toBeNull()
    const multi = rollupTarget({ state: 'ok', prop: { type: 'multi_select', options: [], cfg: {} } })!
    expect(itemValue(multi, 'o1')).toEqual(['o1'])
    expect(itemValue(multi, 3)).toBe(3)
    const file = { id: 'f', name: 'a.png', mime: 'image/png', size: 1 }
    expect(itemValue(multi, file)).toEqual([file])
  })
})

test('行页面属性区：去掉正向关联的计算值（它们直接读行文档），反向关联与汇总留着', () => {
  const schema = parseCollection({
    props: {
      fwd001: { name: 'F', type: 'relation', pos: 0, cfg: { target: '0b0c3c1e-6f7a-4b2c-9d8e-112233445566', reverse: null } },
      rev001: { name: 'R', type: 'relation', pos: 1, cfg: { target: '0b0c3c1e-6f7a-4b2c-9d8e-112233445566', mirror: 'x00001' } },
      sum001: { name: 'S', type: 'rollup', pos: 2, cfg: { relation: 'fwd001', prop: 'title', fn: 'count' } },
    },
  })
  expect(withoutForward({ fwd001: ['a'], rev001: ['b'], sum001: 1 }, schema)).toEqual({ rev001: ['b'], sum001: 1 })
  expect(withoutForward(undefined, schema)).toEqual({})
})
