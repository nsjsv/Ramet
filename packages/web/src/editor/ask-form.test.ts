import { describe, expect, it } from 'vitest'
import type { AskForm } from '../api'
import { companionOf, firstProblem, quickPick } from './ask-form'

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
