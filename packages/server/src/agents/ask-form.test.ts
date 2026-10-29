/* ---------- 提问表单：归一 / 校验 / 摘要（纯函数）----------
 * 形状取自各家真实表单（claude-agent-acp / codex-acp / opencode v2 / omp），见 ask-form.ts 文件头 */
import { expect, test } from 'vitest'
import { askSummary, checkAskAnswer, companionOf, normalizeAskForm } from './ask-form.js'
import type { AskForm } from './types.js'

const form = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): AskForm => {
  const out = normalizeAskForm({ mode: 'form', sessionId: 's', message: '问题', requestedSchema: { type: 'object', properties, ...extra } })
  if (!out) throw new Error('应能归一')
  return out
}

test('归一：有标题 / 无标题的单选、多选、文本、数字、布尔；默认值只留合法的', () => {
  const f = form({
    a: { type: 'string', title: 'A', oneOf: [{ const: 'x', title: 'X', description: '说明' }, { const: 'y', title: 'Y' }], default: 'y' },
    b: { type: 'string', enum: ['Approve', 'Deny'], default: 'nope' },
    c: { type: 'array', items: { anyOf: [{ const: 'p', title: 'P' }] }, minItems: 1, default: ['p', 'zz'] },
    d: { type: 'string', format: 'email', maxLength: 50, default: 'a@b.c' },
    e: { type: 'integer', minimum: 1, maximum: 9 },
    g: { type: 'boolean', default: true },
  })
  expect(f.fields).toEqual([
    { key: 'a', title: 'A', kind: 'choice', multi: false, default: 'y', options: [{ value: 'x', label: 'X', description: '说明' }, { value: 'y', label: 'Y' }] },
    { key: 'b', kind: 'choice', multi: false, options: [{ value: 'Approve', label: 'Approve' }, { value: 'Deny', label: 'Deny' }] },
    { key: 'c', kind: 'choice', multi: true, min: 1, default: ['p'], options: [{ value: 'p', label: 'P' }] },
    { key: 'd', kind: 'text', format: 'email', maxLength: 50, default: 'a@b.c' },
    { key: 'e', kind: 'number', integer: true, min: 1, max: 9 },
    { key: 'g', kind: 'boolean', default: true },
  ])
})

test('认不出的字段：可选的丢掉，必填的整张不认；toolCallId 保留', () => {
  const ok = normalizeAskForm({ mode: 'form', sessionId: 's', message: 'm', toolCallId: 't1', requestedSchema: { properties: { x: { type: 'object' }, y: { type: 'boolean' } } } })
  expect(ok?.fields.map((f) => f.key)).toEqual(['y'])
  expect(ok?.toolCallId).toBe('t1')
  expect(normalizeAskForm({ mode: 'form', message: 'm', requestedSchema: { properties: { x: { type: 'object' } }, required: ['x'] } })).toBeNull()
})

test('codex 的密码类字段；补充文本配对（_custom / _note / __other，必须紧跟在选择题后面）', () => {
  const f = form({
    q: { type: 'string', oneOf: [{ const: 'a', title: 'a' }] },
    q_note: { type: 'string', _meta: { codex: { role: 'user_note' } } },
    secret: { type: 'string', _meta: { codex: { isSecret: true } } },
    q0: { type: 'string', enum: ['x'] },
    q0__other: { type: 'string' },
    q1_custom: { type: 'string' },
  })
  expect(f.fields.find((x) => x.key === 'secret')).toMatchObject({ kind: 'text', secret: true })
  expect([...companionOf(f)]).toEqual([['q_note', 'q'], ['q0__other', 'q0']])
})

test('校验：多余的键 / 类型不对 / 不在候选里 / 越界 / 必填为空都给原因；空值当没填', () => {
  const f = form(
    {
      pick: { type: 'string', title: '选', oneOf: [{ const: 'a', title: 'A' }] },
      many: { type: 'array', items: { enum: ['x', 'y'] }, maxItems: 1 },
      n: { type: 'integer', minimum: 1 },
      code: { type: 'string', pattern: '^[0-9]+$' },
    },
    { required: ['pick'] },
  )
  expect(checkAskAnswer(f, { pick: 'a', many: [], code: '' })).toEqual({ ok: true, content: { pick: 'a' } })
  expect(checkAskAnswer(f, { pick: 'a', extra: 1 })).toEqual({ ok: false, error: '表单里没有「extra」' })
  expect(checkAskAnswer(f, { pick: 'b' })).toEqual({ ok: false, error: '「选」不在可选项里' })
  expect(checkAskAnswer(f, { pick: 'a', many: ['x', 'y'] })).toEqual({ ok: false, error: '「many」最多选 1 项' })
  expect(checkAskAnswer(f, { pick: 'a', n: 1.5 })).toEqual({ ok: false, error: '「n」应为整数' })
  expect(checkAskAnswer(f, { pick: 'a', code: 'abc' })).toEqual({ ok: false, error: '「code」格式不对' })
  expect(checkAskAnswer(f, {})).toEqual({ ok: false, error: '「选」必填' })
  expect(checkAskAnswer(f, 'x')).toEqual({ ok: false, error: '答案应为对象' })
})

test('摘要：单题不带题名、补充文本写成「补充」、多题带题名、密码打码、跳过', () => {
  const one = form({ q: { type: 'string', title: '包管理器', oneOf: [{ const: 'npm', title: 'npm' }, { const: 'pnpm', title: 'pnpm' }] }, q_custom: { type: 'string' } })
  expect(askSummary(one, 'accept', { q: 'pnpm', q_custom: '要 v9' })).toBe('问题 → 答：pnpm；补充：要 v9')
  expect(askSummary(one, 'decline', undefined)).toBe('问题 → 跳过')

  const two = form({
    env: { type: 'string', title: '环境', enum: ['prod'] },
    token: { type: 'string', title: 'Token', _meta: { codex: { isSecret: true } } },
    ok: { type: 'boolean', title: '确认' },
  })
  expect(askSummary(two, 'accept', { env: 'prod', token: 'hunter2', ok: true })).toBe('问题 → 答：环境：prod；Token：••••；确认：是')
})
