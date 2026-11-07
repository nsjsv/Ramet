// Genet 输入框旁的两项（纯函数）：供应商跟谁、思考档按目录 / 内置规则给哪些、发什么参数、max_tokens 放多大，
// 连接被删 / 换了供应商怎么回落。
import { describe, expect, it } from 'vitest'
import type { ConnectionRow } from '../../../ai-connections.js'
import type { ModelMatch, ModelSpec } from '../../../model-catalog.js'
import { EFFORT_ID, PROVIDER_ID, resolveChoice, type ResolvedChoice } from './options.js'

const row = (id: string, protocol: 'anthropic' | 'openai', baseUrl: string | null, model: string): ConnectionRow => ({
  id,
  user_id: 'u',
  name: `名-${id}`,
  protocol,
  base_url: baseUrl,
  model,
  key_ciphertext: '',
  key_last4: '',
})
const official = row('a', 'anthropic', null, 'claude-opus-5-5')
const gateway = row('g', 'anthropic', 'https://gw.example.com/anthropic', 'glm-4.6')
const compat = row('o', 'openai', 'https://x.example.com/v1', 'deepseek-v4-pro')
const rows = [official, gateway, compat]
const none = { provider: null, effort: null }

const current = (r: ResolvedChoice, id: string) => r.options.find((o) => o.id === id)?.currentValue
const values = (r: ResolvedChoice, id: string) => r.options.find((o) => o.id === id)?.options.map((v) => v.value)
/** 目录里只认得这一个连接的模型 */
const only = (target: ConnectionRow, spec: ModelSpec, exact = true) => (r: ConnectionRow): ModelMatch | null => (r === target ? { spec, exact } : null)

describe('resolveChoice：供应商', () => {
  it('一个连接都没有：没有配置项、没有连接', () => {
    expect(resolveChoice([], null, none)).toEqual({ options: [], row: null })
  })

  it('没选过：用设置里的当前连接；选过的优先；它被删了回落到当前连接，在它上面选的思考档作废', () => {
    expect(resolveChoice(rows, 'a', none).row).toBe(official)
    expect(resolveChoice(rows, 'o', { provider: 'a', effort: 'max' }).thinking).toEqual({ effort: 'max' })
    const gone = resolveChoice([official, gateway], 'a', { provider: 'o', effort: 'high' })
    expect(gone.row).toBe(official)
    expect(current(gone, EFFORT_ID)).toBe('low')
  })

  it('供应商列出全部连接：名字 + 模型，目录里有上下文窗口就一并写上', () => {
    const r = resolveChoice(rows, 'a', none, only(compat, { reasoning: true, context: 1_048_576 }))
    expect(r.options[0]).toMatchObject({ id: PROVIDER_ID, category: 'model', currentValue: 'a' })
    expect(r.options[0]!.options).toEqual([
      { value: 'a', name: '名-a', description: 'claude-opus-5-5' },
      { value: 'g', name: '名-g', description: 'glm-4.6' },
      { value: 'o', name: '名-o', description: 'deepseek-v4-pro · 1M 上下文' },
    ])
  })
})

describe('resolveChoice：没有目录时的内置规则', () => {
  it('官方已知模型五档、默认 low（照发）；高档位 max_tokens 放到 64000', () => {
    const r = resolveChoice(rows, 'a', none)
    expect(values(r, EFFORT_ID)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(r.thinking).toEqual({ effort: 'low' })
    expect(r.maxTokens).toBeUndefined()
    expect(resolveChoice(rows, null, { provider: 'a', effort: 'xhigh' })).toMatchObject({ thinking: { effort: 'xhigh' }, maxTokens: 64000 })
  })

  it('openai 兼容：默认（不发）/ 低 / 中 / 高，选了照发、不放大 max_tokens；anthropic 自定义地址没有这一项', () => {
    const plain = resolveChoice(rows, 'o', none)
    expect(values(plain, EFFORT_ID)).toEqual(['default', 'low', 'medium', 'high'])
    expect(plain.thinking).toBeUndefined()
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'high' })).toMatchObject({ thinking: { effort: 'high' } })
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'high' }).maxTokens).toBeUndefined()
    const custom = resolveChoice(rows, null, { provider: 'g', effort: 'max' })
    expect(custom.options.map((o) => o.id)).toEqual([PROVIDER_ID])
    expect(custom.thinking).toBeUndefined()
  })
})

describe('resolveChoice：按目录', () => {
  it('档位就是目录里这个模型的（名字译成中文、认不出的原样）；上下文窗口交给上下文圆环', () => {
    const lookup = only(compat, { reasoning: true, efforts: ['none', 'low', 'high', 'turbo'], context: 1_048_576, output: 393_216 })
    const r = resolveChoice(rows, 'o', none, lookup)
    expect(r.options[1]!.options).toEqual([
      { value: 'default', name: '默认', description: '不指定，由服务自己决定' },
      { value: 'none', name: '不思考' },
      { value: 'low', name: '低' },
      { value: 'high', name: '高' },
      { value: 'turbo', name: 'turbo' },
    ])
    expect(r.context).toBe(1_048_576)
    // 在自己的供应商下对上（exact）：高档位放大到 64000（不超过输出上限）
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'high' }, lookup)).toMatchObject({ thinking: { effort: 'high' }, maxTokens: 64000 })
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'medium' }, lookup).thinking).toBeUndefined()
  })

  it('目录说这个模型不按档位思考（不思考 / 只能开关）：openai 兼容没有这一项；官方地址的档位不在目录里也照目录', () => {
    expect(resolveChoice(rows, 'o', none, only(compat, { reasoning: false })).options.map((o) => o.id)).toEqual([PROVIDER_ID])
    expect(resolveChoice(rows, 'o', none, only(compat, { reasoning: true })).options.map((o) => o.id)).toEqual([PROVIDER_ID])
    const r = resolveChoice(rows, 'a', none, only(official, { reasoning: true, efforts: ['medium', 'high'] }))
    expect(values(r, EFFORT_ID)).toEqual(['medium', 'high'])
    expect(r.thinking).toEqual({ effort: 'medium' })
  })

  it('按名字兜底对上的（不是 exact）：只往下收 max_tokens，不往上放', () => {
    const small = only(compat, { reasoning: true, efforts: ['low', 'high'], output: 4096 }, false)
    expect(resolveChoice(rows, 'o', none, small).maxTokens).toBe(4096)
    const big = only(compat, { reasoning: true, efforts: ['low', 'high'], output: 393_216 }, false)
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'high' }, big)).toMatchObject({ thinking: { effort: 'high' } })
    expect(resolveChoice(rows, null, { provider: 'o', effort: 'high' }, big).maxTokens).toBeUndefined()
  })

  it('anthropic 协议按预算思考：默认 / 低 / 中 / 高，预算夹进目录的上下限，max_tokens = 预算 + 正文余量，不超过输出上限', () => {
    const lookup = only(gateway, { reasoning: true, budget: { min: 1024, max: 24_576 }, output: 64_000 })
    const r = resolveChoice(rows, 'g', none, lookup)
    expect(values(r, EFFORT_ID)).toEqual(['default', 'low', 'medium', 'high'])
    expect(r.thinking).toBeUndefined()
    expect(resolveChoice(rows, null, { provider: 'g', effort: 'low' }, lookup)).toMatchObject({ thinking: { budget: 4096 }, maxTokens: 12_096 })
    expect(resolveChoice(rows, null, { provider: 'g', effort: 'high' }, lookup)).toMatchObject({ thinking: { budget: 24_576 }, maxTokens: 32_576 })
    // 输出上限比预算还小：预算让出正文的最小余量
    const tight = only(gateway, { reasoning: true, budget: {}, output: 8192 })
    expect(resolveChoice(rows, null, { provider: 'g', effort: 'medium' }, tight)).toMatchObject({ thinking: { budget: 7168 }, maxTokens: 8192 })
  })

  it('选过的档位不在这个模型的选项里：用默认档', () => {
    const r = resolveChoice(rows, null, { provider: 'o', effort: 'max' }, only(compat, { reasoning: true, efforts: ['low', 'high'] }))
    expect(current(r, EFFORT_ID)).toBe('default')
    expect(r.thinking).toBeUndefined()
  })
})
