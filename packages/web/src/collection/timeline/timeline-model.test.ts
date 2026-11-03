import { describe, expect, test } from 'vitest'
import { addDays, daysBetween, type CollectionRow } from '@ramet/shared/collection-model'
import { parseRange } from '@ramet/shared/collection-query'
import {
  AXIS_DAYS,
  axisOrigin,
  barOf,
  centerLeft,
  chunkOf,
  chunksFor,
  dayAt,
  defaultLeft,
  dragSpan,
  headerTicks,
  isScale,
  mergeRows,
  SCALE_ORDER,
  SCALES,
  spanValue,
  visibleRange,
  zoomLeft,
} from './timeline-model'

/* 时间线排版：取数块的边界固定（与滚动位置无关）且首尾相接地覆盖视口、左右各多一块；
 * 横条位置 = 离 origin 的天数 × 每天像素；拖两端开始不晚于结束；换刻度后今天仍在视口里 */

const row = (id: string): CollectionRow => ({
  id,
  title: id,
  icon: null,
  props: {},
  position: null,
  created_at: '2026-10-01T00:00:00Z',
  edited_at: '2026-10-01T00:00:00Z',
  has_body: false,
})

describe('取数分块', () => {
  test('日 → 按月、周 → 按季、月 / 季 → 按年；块是合法的日期范围', () => {
    expect(chunkOf('day', '2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28', range: '2026-02-01..2026-02-28' })
    expect(chunkOf('week', '2026-11-02')).toMatchObject({ from: '2026-10-01', to: '2026-12-31' })
    expect(chunkOf('month', '2026-11-02')).toMatchObject({ from: '2026-01-01', to: '2026-12-31' })
    expect(chunkOf('quarter', '2024-07-01')).toMatchObject({ from: '2024-01-01', to: '2024-12-31' })
    for (const scale of SCALE_ORDER) expect(parseRange(chunkOf(scale, '2024-02-29').range)).not.toBeNull()
  })

  test('覆盖视口、左右各多一块、首尾相接；视口挪一点块不变（窗口键复用）', () => {
    const chunks = chunksFor('day', '2026-11-10', '2026-12-05')
    expect(chunks.map((c) => c.from)).toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01'])
    for (let i = 1; i < chunks.length; i++) expect(addDays(chunks[i - 1]!.to, 1)).toBe(chunks[i]!.from)
    expect(chunksFor('day', '2026-11-12', '2026-12-07')).toEqual(chunks)
    expect(chunksFor('week', '2026-11-10', '2026-11-20').map((c) => c.from)).toEqual(['2026-07-01', '2026-10-01', '2027-01-01'])
    expect(chunksFor('quarter', '2025-06-01', '2027-03-01').map((c) => c.from)).toEqual(['2024-01-01', '2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01'])
  })
})

describe('表头', () => {
  test('日刻度：上层月、下层日，截到 [from, to] 里；周刻度的下层从周一起', () => {
    const day = headerTicks('day', '2026-10-30', '2026-11-02')
    expect(day.top).toEqual([
      { start: '2026-10-30', days: 2 },
      { start: '2026-11-01', days: 2 },
    ])
    expect(day.bottom.map((t) => t.start)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    const week = headerTicks('week', '2026-11-04', '2026-11-20')
    expect(week.bottom).toEqual([
      { start: '2026-11-04', days: 5 },
      { start: '2026-11-09', days: 7 },
      { start: '2026-11-16', days: 5 },
    ])
  })

  test('月 / 季刻度：上层年；格子天数加起来就是整段', () => {
    const q = headerTicks('quarter', '2025-11-15', '2026-04-10')
    expect(q.top.map((t) => t.start)).toEqual(['2025-11-15', '2026-01-01'])
    expect(q.bottom.map((t) => t.start)).toEqual(['2025-11-15', '2026-01-01', '2026-04-01'])
    const m = headerTicks('month', '2026-01-01', '2026-12-31')
    expect(m.bottom).toHaveLength(12)
    expect(m.bottom.reduce((n, t) => n + t.days, 0)).toBe(365)
  })
})

describe('横条与拖动', () => {
  test('位置 = 离 origin 的天数 × 每天像素，单日也占一整天；像素换回日子', () => {
    expect(barOf({ start: '2026-11-03', end: '2026-11-03' }, '2026-11-01', 'day')).toEqual({ left: 96, width: 48 })
    expect(barOf({ start: '2026-10-30', end: '2026-11-02' }, '2026-11-01', 'week')).toEqual({ left: -48, width: 96 })
    expect(dayAt(0, '2026-11-01', 'day')).toBe('2026-11-01')
    expect(dayAt(47, '2026-11-01', 'day')).toBe('2026-11-01')
    expect(dayAt(48, '2026-11-01', 'day')).toBe('2026-11-02')
    expect(dayAt(-1, '2026-11-01', 'month')).toBe('2026-10-31')
  })

  test('整条平移；拖开始 / 结束改一端，开始不晚于结束；单日拖一端成区间', () => {
    const span = { start: '2026-11-03', end: '2026-11-06' }
    expect(dragSpan(span, 'move', 2)).toEqual({ start: '2026-11-05', end: '2026-11-08' })
    expect(dragSpan(span, 'start', -3)).toEqual({ start: '2026-10-31', end: '2026-11-06' })
    expect(dragSpan(span, 'start', 9)).toEqual({ start: '2026-11-06', end: '2026-11-06' })
    expect(dragSpan(span, 'end', -9)).toEqual({ start: '2026-11-03', end: '2026-11-03' })
    const single = { start: '2026-11-03', end: '2026-11-03' }
    expect(spanValue(dragSpan(single, 'end', 2))).toBe('2026-11-03/2026-11-05')
    expect(spanValue(dragSpan(single, 'start', -1))).toBe('2026-11-02/2026-11-03')
    expect(spanValue(dragSpan(single, 'end', -1))).toBe('2026-11-03')
    expect(spanValue(dragSpan(single, 'move', 0))).toBe('2026-11-03')
  })
})

describe('视口', () => {
  const today = '2026-11-02'
  const inView = (scale: (typeof SCALE_ORDER)[number], left: string, px: number): boolean => {
    const offset = daysBetween(left, today)
    return offset >= 0 && offset < px / SCALES[scale]
  }

  test('换刻度：今天在视口里就还在（各刻度两两切换、今天在左右边缘）', () => {
    for (const vp of [400, 900, 1600]) {
      for (const from of SCALE_ORDER) {
        const days = Math.floor(vp / SCALES[from])
        for (const offset of [0, Math.floor(days / 2), days - 1]) {
          const left = addDays(today, -offset)
          for (const to of SCALE_ORDER) expect(inView(to, zoomLeft(from, to, left, vp, today), vp), `${vp} ${from}→${to} ${offset}`).toBe(true)
        }
      }
    }
  })

  test('今天不在视口里：以视口中间那天为锚，换完它还在视口中间附近', () => {
    const left = '2025-01-01'
    const next = zoomLeft('day', 'month', left, 960, today)
    const center = addDays(left, 10)
    expect(Math.abs(daysBetween(next, center) - 60)).toBeLessThanOrEqual(1)
  })

  test('缺省左缘让今天落在三分之一处；居中；轴的 origin 左边留三分之一', () => {
    expect(defaultLeft('day', today, 900)).toBe(addDays(today, -6))
    expect(inView('quarter', defaultLeft('quarter', today, 900), 900)).toBe(true)
    expect(centerLeft('week', today, 960)).toBe(addDays(today, -20))
    expect(daysBetween(axisOrigin('day', today), today)).toBe(AXIS_DAYS.day / 3)
  })

  test('竖向只画看得见的行（上下多画几行）', () => {
    expect(visibleRange(0, 340, 34, 1000)).toEqual([0, 16])
    expect(visibleRange(3400, 340, 34, 1000)).toEqual([94, 116])
    expect(visibleRange(3400, 340, 34, 105)).toEqual([94, 105])
    expect(visibleRange(0, 340, 34, 0)).toEqual([0, 0])
  })

  test('刻度写法校验；几块的行按 id 去重', () => {
    expect(isScale('week')).toBe(true)
    expect(isScale('year')).toBe(false)
    expect(mergeRows([[row('a'), row('b')], [row('b'), row('c')], []]).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})
