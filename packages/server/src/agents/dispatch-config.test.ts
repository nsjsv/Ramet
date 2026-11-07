// 派活时把 Genet 说的模型 / 思考程度对到 agent 的配置项上（pickOption，纯函数，不碰数据库）
import { describe, expect, it } from 'vitest'
import { pickOption } from './dispatch-config.js'
import type { ConfigOption } from './types.js'

const MODEL: ConfigOption = {
  id: 'model',
  name: '模型',
  category: 'model',
  currentValue: 'default',
  options: [
    { value: 'default', name: '默认' },
    { value: 'claude-opus-5-5', name: 'Opus 5.5' },
    { value: 'claude-sonnet-5', name: 'Sonnet 5' },
    { value: 'Haiku', name: 'haiku' },
  ],
}
const EFFORT: ConfigOption = {
  id: 'effort',
  name: '推理强度',
  category: 'thought_level',
  currentValue: 'low',
  options: [
    { value: 'low', name: '低' },
    { value: 'high', name: '高' },
    { value: 'xhigh', name: '很高' },
  ],
}
const MODE: ConfigOption = {
  id: 'mode',
  name: '权限',
  category: 'mode',
  currentValue: 'auto',
  options: [
    { value: 'auto', name: '自动' },
    { value: 'full-access', name: '完全访问' },
  ],
}
const ALL = [MODEL, MODE, EFFORT]

describe('pickOption', () => {
  it('精确的 value 先认', () => {
    expect(pickOption(ALL, 'model', 'claude-opus-5-5')).toEqual({ id: 'model', value: 'claude-opus-5-5', name: 'Opus 5.5' })
    // 精确的 value 优先于不分大小写的 name：value 是 Haiku、name 是 haiku 的那一项
    expect(pickOption(ALL, 'model', 'Haiku')).toEqual({ id: 'model', value: 'Haiku', name: 'haiku' })
  })

  it('不分大小写的 value 或 name', () => {
    expect(pickOption(ALL, 'model', 'opus 5.5')).toEqual({ id: 'model', value: 'claude-opus-5-5', name: 'Opus 5.5' })
    expect(pickOption(ALL, 'model', 'HAIKU')).toEqual({ id: 'model', value: 'Haiku', name: 'haiku' })
    expect(pickOption(ALL, 'thought_level', '高')).toEqual({ id: 'effort', value: 'high', name: '高' })
    // 「高」同时是「很高」的一部分：完全相等的那一档优先，不算含糊
    expect(pickOption(ALL, 'thought_level', 'HIGH')).toEqual({ id: 'effort', value: 'high', name: '高' })
  })

  it('唯一一个包含它的 value / name', () => {
    expect(pickOption(ALL, 'model', 'opus')).toEqual({ id: 'model', value: 'claude-opus-5-5', name: 'Opus 5.5' })
    expect(pickOption(ALL, 'model', 'Sonnet')).toEqual({ id: 'model', value: 'claude-sonnet-5', name: 'Sonnet 5' })
    expect(pickOption(ALL, 'thought_level', 'xh')).toEqual({ id: 'effort', value: 'xhigh', name: '很高' })
  })

  it('含糊：只列对上的那几个', () => {
    const r = pickOption(ALL, 'model', 'claude')
    expect('error' in r && r.error).toBe('「claude」对得上好几个模型：claude-opus-5-5（Opus 5.5）、claude-sonnet-5（Sonnet 5），要说具体是哪一个')
  })

  it('对不上：列出全部可选值 value（name）', () => {
    const r = pickOption(ALL, 'thought_level', 'medium')
    expect('error' in r && r.error).toBe('没有叫「medium」的推理强度，可选：low（低）、high（高）、xhigh（很高）')
  })

  it('没有这一项：模型 / 当前模型没有思考档 / 根本没有模型', () => {
    expect(pickOption([MODE], 'model', 'opus')).toEqual({ error: '这个 agent 不能选模型' })
    expect(pickOption([MODEL, MODE], 'thought_level', 'high')).toEqual({ error: '当前模型不能调思考程度' })
    expect(pickOption([MODE], 'thought_level', 'high')).toEqual({ error: '这个 agent 不能调思考程度' })
    expect(pickOption([{ ...MODEL, options: [] }], 'model', 'opus')).toEqual({ error: '这个 agent 不能选模型' })
  })

  it('只看指定的 category：权限模式的值对不上模型 / 思考程度', () => {
    expect('error' in pickOption(ALL, 'model', 'full-access')).toBe(true)
    expect('error' in pickOption(ALL, 'thought_level', 'auto')).toBe(true)
  })
})
