// 设置页模型框下面那一行：GET /api/me/model-spec 按协议 / 地址 / 模型名查公开模型目录，给出规格与 Genet 会给的思考档
// （与输入框旁 chip 同一份判定：按名字兜底也认、官方已知模型没有「默认」、对不上按内置规则、目录拉不到照样回答）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertUser, pool } from './agents/test-kit.js'
import { startServer } from './index.js'
import { ModelCatalog } from './model-catalog.js'

const effort = (...values: string[]) => [{ type: 'effort', values }]
const catalog = new ModelCatalog(async () => ({
  anthropic: { models: { 'claude-opus-5-5': { reasoning: true, reasoning_options: effort('low', 'medium', 'high', 'xhigh', 'max'), limit: { context: 1_000_000, output: 128_000 } } } },
  deepseek: { api: 'https://api.deepseek.com', models: { 'deepseek-v4-flash': { reasoning: true, reasoning_options: effort('low', 'high', 'max') } } },
  above: {
    api: 'https://api.above.example',
    models: {
      'deepseek-v4.1-flash': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, ...effort('low', 'high', 'max')],
        limit: { context: 1_000_000, output: 384_000 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
    },
  },
}))
const offline = new ModelCatalog(async () => {
  throw new Error('网络不通')
})

let site: Awaited<ReturnType<typeof startServer>>
let dark: Awaited<ReturnType<typeof startServer>>
beforeAll(async () => {
  site = await startServer(pool, 0, { preview: null, quick: { catalog, secretKey: null } })
  dark = await startServer(pool, 0, { preview: null, quick: { catalog: offline, secretKey: null } })
})
afterAll(async () => {
  await site.close()
  await dark.close()
})

/** carol 登录这一份服务（每个用例开头库都被清空，用户已在就跳过） */
async function cookieFor(port: number): Promise<string> {
  await insertUser('carol').catch(() => undefined)
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'carol', password: 'pw-123456' }),
  })
  return res.headers.get('set-cookie')!.split(';')[0]!
}

async function spec(port: number, cookie: string, q: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/me/model-spec?${new URLSearchParams(q)}`, { headers: { cookie } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const names = (body: Record<string, unknown>) => (body.thinking as Array<{ name: string }>).map((v) => v.name)

describe('GET /api/me/model-spec', () => {
  it('要登录；地址不合法 400', async () => {
    expect((await fetch(`http://127.0.0.1:${site.port}/api/me/model-spec?protocol=openai&model=x`)).status).toBe(401)
    const cookie = await cookieFor(site.port)
    expect((await spec(site.port, cookie, { protocol: 'openai', baseUrl: '', model: 'x' })).status).toBe(400)
  })

  it('DeepSeek 官方地址上的新模型：目录的 deepseek 下还没有，按名字兜底对上（不是 exact），给上下文、输出上限与档位', async () => {
    const cookie = await cookieFor(site.port)
    const { status, body } = await spec(site.port, cookie, { protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'DeepSeek-V4.1-Flash' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ catalog: true, match: { exact: false, context: 1_000_000, output: 384_000 } })
    expect(names(body)).toEqual(['默认', '低', '高', '最高'])
  })

  it('官方 Anthropic（地址留空）：exact，五档、没有「默认」', async () => {
    const cookie = await cookieFor(site.port)
    const { body } = await spec(site.port, cookie, { protocol: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' })
    expect(body).toMatchObject({ catalog: true, match: { exact: true, context: 1_000_000, output: 128_000 } })
    expect(names(body)).toEqual(['低', '中', '高', '超高', '最高'])
  })

  it('目录里没有这个模型：match 为空，档位按内置规则；目录拉不到也照样回答（catalog=false）', async () => {
    const cookie = await cookieFor(site.port)
    const { body } = await spec(site.port, cookie, { protocol: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'my-own-model' })
    expect(body).toMatchObject({ catalog: true, match: null })
    expect(names(body)).toEqual(['默认', '低', '中', '高'])
    const off = await spec(dark.port, await cookieFor(dark.port), { protocol: 'anthropic', baseUrl: 'https://gw.example.com/anthropic', model: 'glm-4.6' })
    expect(off.body).toEqual({ catalog: false, match: null, thinking: [] })
  })
})
