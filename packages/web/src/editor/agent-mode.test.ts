import { expect, test } from 'vitest'
import type { ConfigOption } from '../api'
import { defaultModeValue, modeOptionOf, modeText, nextModeValue, rotatableModes } from './agent-mode'

// 不变量：模式的名称 / 说明 / 顺序都以 agent 上报为准；⇧Tab 按上报顺序轮换，危险档不进轮换，不足两档不动

const option = (values: Array<[string, string?, string?]>, currentValue = values[0]![0]): ConfigOption => ({
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  currentValue,
  options: values.map(([value, name, description]) => ({ value, name: name ?? value, description: description ?? null })),
})

// claude-agent-acp 上报的形状与顺序
const claude = option([
  ['default', 'Manual', 'Always ask before making changes'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan'],
  ['auto', 'Auto'],
  ['bypassPermissions', 'Bypass permissions'],
])
const DANGER = ['bypassPermissions']

test('名称 / 说明用 agent 上报的；只有缺了才退回已核实档位的兜底文案，再缺就显示值', () => {
  expect(modeText({ value: 'default', name: 'Manual', description: 'Always ask' })).toEqual({ t: 'Manual', d: 'Always ask' })
  // agent 没给说明：已核实档位用兜底说明，名称仍是 agent 的
  expect(modeText({ value: 'plan', name: 'Plan', description: null })).toEqual({ t: 'Plan', d: expect.any(String) })
  // 连名称都没给
  expect(modeText({ value: 'plan', name: '' }).t).not.toBe('')
  // 不认识的档位、什么都没给：原样显示值，不编说明
  expect(modeText({ value: 'x-custom', name: '' })).toEqual({ t: 'x-custom', d: null })
})

test('默认档:有叫 default 的就是它,否则取上报的第一个', () => {
  expect(defaultModeValue(claude)).toBe('default')
  expect(defaultModeValue(option([['read-only'], ['auto'], ['agent-full-access']]))).toBe('read-only')
  expect(defaultModeValue(option([['build'], ['plan']]))).toBe('build')
  expect(defaultModeValue({ ...claude, options: [] })).toBe('')
})

test('⇧Tab 轮换:按上报顺序走,跳过危险档,到头回第一个', () => {
  expect(rotatableModes(claude, DANGER).map((v) => v.value)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
  expect(nextModeValue(claude, 'default', DANGER)).toBe('acceptEdits')
  expect(nextModeValue(claude, 'acceptEdits', DANGER)).toBe('plan')
  expect(nextModeValue(claude, 'plan', DANGER)).toBe('auto')
  expect(nextModeValue(claude, 'auto', DANGER)).toBe('default')
})

test('⇧Tab 轮换:当前在危险档 / 不认识的档 → 回到第一个可轮换档;永远不会转进危险档', () => {
  expect(nextModeValue(claude, 'bypassPermissions', DANGER)).toBe('default')
  expect(nextModeValue(claude, 'something-else', DANGER)).toBe('default')
  const seen = new Set<string>()
  let at = 'default'
  for (let i = 0; i < 12; i++) {
    at = nextModeValue(claude, at, DANGER)!
    seen.add(at)
  }
  expect(seen.has('bypassPermissions')).toBe(false)
})

test('⇧Tab 轮换:可轮换档不足两个 = 没得转(null);没有危险档的 agent 全部参与', () => {
  expect(nextModeValue(option([['only']]), 'only', [])).toBeNull()
  expect(nextModeValue(option([['a'], ['danger']]), 'a', ['danger'])).toBeNull()
  const opencode = option([['build'], ['plan']])
  expect(nextModeValue(opencode, 'build', [])).toBe('plan')
  expect(nextModeValue(opencode, 'plan', [])).toBe('build')
})

test('mode 配置项按 category 找,不按 id 猜', () => {
  const model: ConfigOption = { id: 'model', name: 'Model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }
  expect(modeOptionOf([model, claude])).toBe(claude)
  expect(modeOptionOf([model])).toBeUndefined()
})
