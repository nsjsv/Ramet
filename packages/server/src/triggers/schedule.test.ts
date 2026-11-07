/* ---------- 定时器时间表（纯函数）：解析 / 拒绝、下次触发、夏令时、人话描述 ---------- */
import { describe, expect, it } from 'vitest'
import { describeSchedule, localStamp, nextAt, parseSchedule, shortStamp, validTimeZone, wallToInstant, type Schedule } from './schedule.js'

const SH = 'Asia/Shanghai'
const NY = 'America/New_York'
const at = (iso: string): Date => new Date(iso)
const ok = (raw: unknown): Schedule => {
  const s = parseSchedule(raw)
  if ('error' in s) throw new Error(s.error)
  return s
}
const err = (raw: unknown): string => {
  const s = parseSchedule(raw)
  return 'error' in s ? s.error : ''
}

describe('parseSchedule', () => {
  it('规整：补零、weekly 去重排序', () => {
    expect(ok({ kind: 'daily', time: '9:05' })).toEqual({ kind: 'daily', time: '09:05' })
    expect(ok({ kind: 'weekly', days: [3, 1, 3], time: '18:00' })).toEqual({ kind: 'weekly', days: [1, 3], time: '18:00' })
    expect(ok({ kind: 'once', at: '2026-11-7 9:00' })).toEqual({ kind: 'once', at: '2026-11-07T09:00' })
    expect(ok({ kind: 'every', minutes: 60 })).toEqual({ kind: 'every', minutes: 60 })
  })

  it('拒绝：间隔太短 / 太长 / 非整数，days 空或越界，HH:MM 越界，once 格式或日期不存在，kind 不认', () => {
    expect(err({ kind: 'every', minutes: 59 })).toContain('最短 60')
    expect(err({ kind: 'every', minutes: 10081 })).toContain('最长 7 天')
    expect(err({ kind: 'every', minutes: 90.5 })).toContain('整数')
    expect(err({ kind: 'weekly', days: [], time: '09:00' })).toContain('days')
    expect(err({ kind: 'weekly', days: [0, 8], time: '09:00' })).toContain('days')
    expect(err({ kind: 'daily', time: '24:00' })).toContain('HH:MM')
    expect(err({ kind: 'daily', time: '09:60' })).toContain('HH:MM')
    expect(err({ kind: 'once', at: '明天 9 点' })).toContain('YYYY-MM-DDTHH:MM')
    expect(err({ kind: 'once', at: '2026-02-30T09:00' })).toContain('YYYY-MM-DDTHH:MM')
    expect(err({ kind: 'cron', expr: '* * * * *' })).toContain('kind')
    expect(err(null)).toContain('kind')
  })
})

describe('nextAt', () => {
  it('每天：今天的点没过就是今天，过了就是明天（上海 = UTC+8）', () => {
    const s = ok({ kind: 'daily', time: '09:00' })
    expect(nextAt(s, SH, at('2026-11-06T00:30:00Z'), at('2026-11-06T00:30:00Z'))?.toISOString()).toBe('2026-11-06T01:00:00.000Z')
    expect(nextAt(s, SH, at('2026-11-06T01:00:00Z'), at('2026-11-06T01:00:00Z'))?.toISOString()).toBe('2026-11-07T01:00:00.000Z')
  })

  it('错过多次只给下一次', () => {
    const s = ok({ kind: 'daily', time: '09:00' })
    expect(nextAt(s, SH, at('2026-11-09T02:00:00Z'), at('2026-11-06T01:00:00Z'))?.toISOString()).toBe('2026-11-10T01:00:00.000Z')
  })

  it('每周：工作日跳过周末（2026-11-06 是周五）', () => {
    const s = ok({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })
    expect(nextAt(s, SH, at('2026-11-06T02:00:00Z'), at('2026-11-06T02:00:00Z'))?.toISOString()).toBe('2026-11-09T01:00:00.000Z')
    const sunday = ok({ kind: 'weekly', days: [7], time: '20:00' })
    expect(nextAt(sunday, SH, at('2026-11-06T02:00:00Z'), at('2026-11-06T02:00:00Z'))?.toISOString()).toBe('2026-11-08T12:00:00.000Z')
  })

  it('一次：没到给那一刻，过了给 null', () => {
    const s = ok({ kind: 'once', at: '2026-11-07T09:00' })
    expect(nextAt(s, SH, at('2026-11-06T00:00:00Z'), at('2026-11-06T00:00:00Z'))?.toISOString()).toBe('2026-11-07T01:00:00.000Z')
    expect(nextAt(s, SH, at('2026-11-07T01:00:00Z'), at('2026-11-07T01:00:00Z'))).toBeNull()
  })

  it('每隔：从 anchor 起按步长对齐，错过的跳过', () => {
    const s = ok({ kind: 'every', minutes: 120 })
    const anchor = at('2026-11-06T00:00:00Z')
    expect(nextAt(s, SH, anchor, anchor)?.toISOString()).toBe('2026-11-06T02:00:00.000Z')
    expect(nextAt(s, SH, at('2026-11-06T05:10:00Z'), anchor)?.toISOString()).toBe('2026-11-06T06:00:00.000Z')
    expect(nextAt(s, SH, at('2026-11-06T06:00:00Z'), anchor)?.toISOString()).toBe('2026-11-06T08:00:00.000Z')
  })

  it('纽约夏令时：跳过的 02:30 顺延到跳变后，重复的 01:30 取第一次，跨跳变的每天仍是当地 09:00', () => {
    // 2026-03-08 02:00 EST 往前跳到 03:00 EDT
    expect(new Date(wallToInstant({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, NY)).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // 2026-11-01 02:00 EDT 回拨到 01:00 EST：01:30 出现两次，取 EDT 那次
    expect(new Date(wallToInstant({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, NY)).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    const s = ok({ kind: 'daily', time: '09:00' })
    expect(nextAt(s, NY, at('2026-03-07T15:00:00Z'), at('2026-03-07T15:00:00Z'))?.toISOString()).toBe('2026-03-08T13:00:00.000Z')
    expect(nextAt(s, NY, at('2026-10-31T14:00:00Z'), at('2026-10-31T14:00:00Z'))?.toISOString()).toBe('2026-11-01T14:00:00.000Z')
    const gap = ok({ kind: 'daily', time: '02:30' })
    expect(nextAt(gap, NY, at('2026-03-08T05:00:00Z'), at('2026-03-08T05:00:00Z'))?.toISOString()).toBe('2026-03-08T07:30:00.000Z')
  })
})

describe('描述与时区', () => {
  it('describeSchedule', () => {
    expect(describeSchedule(ok({ kind: 'daily', time: '09:00' }))).toBe('每天 09:00')
    expect(describeSchedule(ok({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }))).toBe('工作日 09:00')
    expect(describeSchedule(ok({ kind: 'weekly', days: [6, 7], time: '10:00' }))).toBe('周末 10:00')
    expect(describeSchedule(ok({ kind: 'weekly', days: [1, 3], time: '09:00' }))).toBe('每周一、三 09:00')
    expect(describeSchedule(ok({ kind: 'every', minutes: 120 }))).toBe('每 2 小时')
    expect(describeSchedule(ok({ kind: 'every', minutes: 90 }))).toBe('每 90 分钟')
    expect(describeSchedule(ok({ kind: 'every', minutes: 2880 }))).toBe('每 2 天')
    expect(describeSchedule(ok({ kind: 'once', at: '2026-11-07T09:00' }))).toBe('11 月 7 日 09:00（一次）')
  })

  it('localStamp / shortStamp', () => {
    expect(localStamp(at('2026-11-06T06:03:00Z'), SH)).toBe('2026-11-06 周五 14:03')
    expect(shortStamp(at('2026-11-06T01:00:00Z'), SH, at('2026-11-06T01:42:00Z'))).toBe('09:00')
    expect(shortStamp(at('2026-11-06T01:00:00Z'), SH, at('2026-11-08T02:00:00Z'))).toBe('11 月 6 日 09:00')
  })

  it('validTimeZone：IANA 名字收（规范写法），偏移 / 乱写 / 非字符串不收', () => {
    expect(validTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(validTimeZone(' UTC ')).toBe('UTC')
    expect(validTimeZone('+08:00')).toBeNull()
    expect(validTimeZone('Mars/Olympus')).toBeNull()
    expect(validTimeZone('')).toBeNull()
    expect(validTimeZone(8)).toBeNull()
  })
})
