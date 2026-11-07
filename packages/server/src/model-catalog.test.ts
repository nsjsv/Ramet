// 公开模型目录：原文 → 索引（形状坏的跳过）、按连接找模型（host 对上供应商 → 名字兜底，自家厂商优先）、
// 缓存（第一次等、同时只拉一次、过期先给旧的后台重拉、失败隔一段再试）、拉取（经防护版 fetch，非 200 当失败）。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCatalog, findModel, indexCatalog, looseModel, ModelCatalog } from './model-catalog.js'

const effort = (...values: string[]) => [{ type: 'effort', values }]
const raw = {
  anthropic: {
    models: {
      'claude-opus-5-5': { reasoning: true, reasoning_options: effort('low', 'medium', 'high', 'xhigh', 'max'), limit: { context: 1_000_000, output: 128_000 }, canonical_model_id: 'anthropic/claude-opus-5-5' },
    },
  },
  deepseek: {
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-v4-pro': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, ...effort('low', 'high', 'max')],
        limit: { context: 1_048_576, output: 393_216 },
        canonical_model_id: 'deepseek/deepseek-v4-pro-0813',
      },
    },
  },
  zenmux: {
    api: 'https://zenmux.ai/api/v1',
    models: {
      'deepseek/deepseek-v4-pro': { reasoning: true, reasoning_options: effort('low', 'high'), limit: { context: 1_000_000, output: 64_000 }, canonical_model_id: 'deepseek/deepseek-v4-pro' },
      'anthropic/claude-haiku-4.5': { reasoning: true, reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 'x' }], limit: { context: 200_000, output: 64_000 } },
    },
  },
  zhipuai: { api: 'https://open.bigmodel.cn/api/paas/v4', models: { 'glm-4.6': { reasoning: true, reasoning_options: effort('none', 'high'), limit: { context: 200_000 } } } },
  'zhipuai-coding-plan': { api: 'https://open.bigmodel.cn/api/coding/paas/v4', models: { 'glm-4.6': { reasoning: true, reasoning_options: effort('high') } } },
  broken: 'not an object',
  junk: { api: 42, models: { bad: null, also: { limit: { context: -1 }, reasoning_options: 'x' } } },
}
const index = indexCatalog(raw)

describe('索引与匹配', () => {
  it('宽松模型名：小写、去厂商前缀、. _ 换成 -', () => {
    expect(looseModel(' DeepSeek/DeepSeek-V4.Pro ')).toBe('deepseek-v4-pro')
    expect(looseModel('glm_4.6')).toBe('glm-4-6')
  })

  it('官方 Anthropic（没填地址）在 anthropic 下找：exact，带档位、上下文与输出上限', () => {
    expect(findModel(index, { protocol: 'anthropic', baseUrl: null, model: 'claude-opus-5-5' })).toEqual({
      spec: { reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], context: 1_000_000, output: 128_000 },
      exact: true,
    })
  })

  it('连接地址的 host 对上供应商：在它下面找（只看 host，路径不同的 anthropic 兼容地址也认）；网关的写法 厂商/模型 也认', () => {
    expect(findModel(index, { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-pro' })).toMatchObject({
      spec: { efforts: ['low', 'high', 'max'], output: 393_216 },
      exact: true,
    })
    expect(findModel(index, { protocol: 'openai', baseUrl: 'https://zenmux.ai/api/v1', model: 'deepseek/deepseek-v4-pro' })).toMatchObject({
      spec: { efforts: ['low', 'high'], output: 64_000 },
      exact: true,
    })
    // 按预算思考：上下限里不是数的丢掉；只能开关（toggle）不记
    expect(findModel(index, { protocol: 'anthropic', baseUrl: 'https://zenmux.ai/api/anthropic', model: 'anthropic/claude-haiku-4.5' })?.spec).toEqual({
      reasoning: true,
      budget: { min: 1024 },
      context: 200_000,
      output: 64_000,
    })
  })

  it('OpenAI 官方地址：目录里 openai 不写 api，也认作 openai', () => {
    const withOpenai = indexCatalog({ openai: { models: { 'gpt-5.5': { reasoning: true, reasoning_options: effort('none', 'xhigh') } } } })
    expect(findModel(withOpenai, { protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' })).toMatchObject({ spec: { efforts: ['none', 'xhigh'] }, exact: true })
  })

  it('一个 host 几个供应商：id 短的先（套餐版排后）；模型名不分大小写、点与下划线', () => {
    expect(findModel(index, { protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'GLM_4.6' })).toMatchObject({
      spec: { efforts: ['none', 'high'] },
      exact: true,
    })
  })

  it('host 对不上：全目录按名字 / canonical id 兜底，模型自家厂商那一条优先，不是 exact', () => {
    const proxy = 'https://my-proxy.example.com/v1'
    expect(findModel(index, { protocol: 'openai', baseUrl: proxy, model: 'deepseek-v4-pro' })).toMatchObject({ spec: { output: 393_216 }, exact: false })
    expect(findModel(index, { protocol: 'openai', baseUrl: proxy, model: 'deepseek-v4-pro-0813' })).toMatchObject({ spec: { output: 393_216 }, exact: false })
    expect(findModel(index, { protocol: 'openai', baseUrl: proxy, model: 'no-such-model' })).toBeNull()
    expect(findModel(index, { protocol: 'openai', baseUrl: proxy, model: '  ' })).toBeNull()
  })

  it('形状坏的供应商 / 模型跳过，不整份作废；整份不是对象就是空索引', () => {
    expect(index.providers.has('broken')).toBe(false)
    expect(index.providers.get('junk')?.get('also')).toEqual({ reasoning: false })
    expect(indexCatalog(null).providers.size).toBe(0)
  })
})

describe('缓存', () => {
  const HOUR = 3_600_000

  it('第一次等拉取、同时只拉一次；过期了先给旧的、后台重拉、重拉到了通知订阅者', async () => {
    let t = 0
    let loads = 0
    let model = 'm1'
    const catalog = new ModelCatalog(async () => {
      loads++
      return { p: { models: { [model]: { reasoning: false } } } }
    }, () => t)
    const [a, b] = await Promise.all([catalog.get(), catalog.get()])
    expect(loads).toBe(1)
    expect(a).toBe(b)
    expect(a?.global.has('m1')).toBe(true)
    let notified = 0
    catalog.onUpdate(() => notified++)
    t = 23 * HOUR
    expect(await catalog.get()).toBe(a)
    expect(loads).toBe(1)

    model = 'm2'
    t = 25 * HOUR
    expect(await catalog.get()).toBe(a)
    await new Promise((r) => setTimeout(r, 0))
    expect(loads).toBe(2)
    expect(notified).toBe(1)
    expect(catalog.current()?.global.has('m2')).toBe(true)
  })

  it('第一次拉得慢：最多等一会儿就先给 null（调用方按内置规则），拉到了通知订阅者', async () => {
    vi.useFakeTimers()
    try {
      let finish: (raw: unknown) => void = () => {}
      const catalog = new ModelCatalog(() => new Promise((r) => (finish = r)))
      let notified = 0
      catalog.onUpdate(() => notified++)
      const first = catalog.get()
      await vi.advanceTimersByTimeAsync(3000)
      expect(await first).toBeNull()
      finish({ p: { models: { m: {} } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(notified).toBe(1)
      expect(await catalog.get()).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('拉失败：当没有目录；十分钟内不再拉，之后再试', async () => {
    let t = 0
    let fail = true
    let loads = 0
    const catalog = new ModelCatalog(async () => {
      loads++
      if (fail) throw new Error('网络不通')
      return {}
    }, () => t)
    expect(await catalog.get()).toBeNull()
    t = 5 * 60_000
    expect(await catalog.get()).toBeNull()
    expect(loads).toBe(1)
    fail = false
    t = 11 * 60_000
    expect(await catalog.get()).not.toBeNull()
    expect(loads).toBe(2)
  })
})

describe('拉取', () => {
  let server: http.Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  async function serve(status: number, body: string): Promise<string> {
    server = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    return `http://catalog.example.com:${(server.address() as AddressInfo).port}/api.json`
  }
  const deps = { allowHttp: true, resolve: async () => [{ address: '127.0.0.1', family: 4 as const }], forbidden: () => false }

  it('经防护版 fetch 拉到 JSON；非 200 当失败', async () => {
    expect(await fetchCatalog(await serve(200, JSON.stringify(raw)), deps)()).toEqual(raw)
    server!.close()
    await expect(fetchCatalog(await serve(503, '{}'), deps)()).rejects.toThrow(/503/)
  })

  it('不放宽禁止地址：解析到本机的目录地址在连接之前就被拦下', async () => {
    const url = await serve(200, '{}')
    await expect(fetchCatalog(url, { allowHttp: true, resolve: deps.resolve })()).rejects.toThrow()
  })
})
