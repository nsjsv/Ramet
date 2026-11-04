import { describe, expect, it } from 'vitest'
import type { AskForm } from '../api'
import { companionOf, dateAnswer, firstProblem, numberAnswer, quickPick } from './ask-form'

const form = (fields: AskForm['fields'], required: string[] = []): AskForm => ({ message: '问题', fields, required })
const choice = (key: string, values: string[], multi = false) =>
  ({ key, kind: 'choice', multi, options: values.map((v) => ({ value: v, label: v })) }) as const

describe('提问表单：各家形状的两条规则（与服务端 agents/ask-form.ts 同口径）', () => {
  it('补充文本：紧跟在选择题后面、键名以「题键_」开头（claude _custom / codex _note / omp __other）', () => {
    const f = form([
      choice('question_0', ['a']),
      { key: 'question_0_custom', kind: 'text' },
      choice('env', ['x']),
      { key: 'env_note', kind: 'text' },
      choice('q0', ['y']),
      { key: 'q0__other', kind: 'text' },
      { key: 'q1_custom', kind: 'text' },
    ])
    expect([...companionOf(f)]).toEqual([
      ['question_0_custom', 'question_0'],
      ['env_note', 'env'],
      ['q0__other', 'q0'],
    ])
  })

  it('快选：只有一个单选题或一个是 / 否题；多选、带补充文本、选项太多都不是', () => {
    expect(quickPick(form([choice('value', ['Approve', 'Deny'])]))?.picks.map((p) => p.value)).toEqual(['Approve', 'Deny'])
    expect(quickPick(form([{ key: 'value', kind: 'boolean' }]))?.picks.map((p) => p.value)).toEqual([true, false])
    expect(quickPick(form([choice('m', ['a', 'b'], true)]))).toBeNull()
    expect(quickPick(form([choice('pm', ['bun']), { key: 'pm_custom', kind: 'text' }]))).toBeNull()
    expect(quickPick(form([choice('many', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])]))).toBeNull()
  })
})

describe('提交前的体验校验', () => {
  it('必填为空、多选个数、文字长度 / 格式、数字类型 / 范围给原因；都满足 = null', () => {
    const f = form(
      [
        { ...choice('pick', ['a']), title: '选' },
        { ...choice('many', ['x', 'y'], true), max: 1 },
        { key: 'code', kind: 'text', pattern: '^[0-9]+$' },
        { key: 'n', kind: 'number', integer: true, min: 1 },
      ],
      ['pick'],
    )
    expect(firstProblem(f, {})).toBe('「选」必填')
    expect(firstProblem(f, { pick: 'a', many: ['x', 'y'] })).toBe('「many」最多选 1 项')
    expect(firstProblem(f, { pick: 'a', code: 'abc' })).toBe('「code」格式不对')
    expect(firstProblem(f, { pick: 'a', n: Number.NaN })).toBe('「n」应为数字')
    expect(firstProblem(f, { pick: 'a', n: 0 })).toBe('「n」不能小于 1')
    expect(firstProblem(f, { pick: 'a', many: ['x'], code: '42', n: 3 })).toBeNull()
  })
})

describe('数字字段读值（文本框，不用 type=number）', () => {
  const f = form([{ key: 'n', kind: 'number', integer: true, min: 1, max: 10 }])
  const problem = (text: string): string | null => {
    const v = numberAnswer(text)
    return firstProblem(f, v === undefined ? {} : { n: v })
  }

  it('空 = 没填；能读的照常读（千分位、首尾空白）', () => {
    expect(numberAnswer('')).toBeUndefined()
    expect(numberAnswer('  ')).toBeUndefined()
    expect(numberAnswer(' 1,000 ')).toBe(1000)
    expect(problem('')).toBeNull()
    expect(problem('7')).toBeNull()
  })

  it('填错读成 NaN 报「应为数字」；越界、小数不夹取，交给校验说清楚', () => {
    expect(numberAnswer('abc')).toBeNaN()
    expect(problem('abc')).toBe('「n」应为数字')
    expect(problem('2.5')).toBe('「n」应为整数')
    expect(problem('0')).toBe('「n」不能小于 1')
    expect(problem('11')).toBe('「n」不能大于 10')
  })
})

describe('日期字段读值（文本框 + 日历，不用 type=date / datetime-local）', () => {
  const f = form([
    { key: 'd', kind: 'text', format: 'date' },
    { key: 't', kind: 'text', format: 'date-time' },
  ])

  it('空 = 没填；日期的多种写法读成 YYYY-MM-DD', () => {
    expect(dateAnswer('', false)).toBeUndefined()
    expect(dateAnswer('  ', true)).toBeUndefined()
    expect(dateAnswer('2026/1/2', false)).toBe('2026-01-02')
    expect(dateAnswer('2026年11月3日', false)).toBe('2026-11-03')
  })

  it('日期时间按本地时间换成带偏移的 ISO；只写日期 = 当天 00:00', () => {
    expect(dateAnswer('2026-11-03 14:30', true)).toBe(new Date(2026, 10, 3, 14, 30).toISOString())
    expect(dateAnswer('2026-11-03T09:05', true)).toBe(new Date(2026, 10, 3, 9, 5).toISOString())
    expect(dateAnswer('2026-11-03', true)).toBe(new Date(2026, 10, 3, 0, 0).toISOString())
  })

  it('读不出的原样交出，由校验报格式不对（同服务端口径）', () => {
    expect(dateAnswer('明天', false)).toBe('明天')
    expect(dateAnswer('2026-11-03 25:00', true)).toBe('2026-11-03 25:00')
    expect(firstProblem(f, { d: '明天' })).toBe('「d」日期格式应为 YYYY-MM-DD')
    expect(firstProblem(f, { t: '明天' })).toBe('「t」不是日期时间')
    expect(firstProblem(f, { d: dateAnswer('2026/1/2', false)!, t: dateAnswer('2026-11-03 14:30', true)! })).toBeNull()
  })
})
