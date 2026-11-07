// ---------- 公开模型目录：按模型名查上下文窗口、输出上限、思考档位 ----------
// 各家模型支持的思考参数、上下文、输出上限都不一样，写死在代码里跟不上新模型。数据取 models.dev 的公开目录
// （开源、按「供应商 → 模型」组织，每个供应商带 API 地址，每个模型带 limit 与 reasoning_options），进程内缓存一天。
// 拉不到就没有目录：调用方按自己原来的规则走（不能因为一个外部站点挂了，Genet 就不能用）。
// 匹配（findModel）：
//   1. 连接地址的 host 对上目录里某个供应商的 API 地址（官方 Anthropic / OpenAI 地址认作这两家），在它下面按模型名找 —— exact，
//      参数就是这个供应商的接口实际收的；
//   2. 找不到再全目录按模型名 / canonical id 找，优先模型自家厂商那一条 —— 不是 exact：网关可能另有上限，调用方只能保守着用。
//   模型名不分大小写、`.` `_` 与 `-` 视为同一个、去掉 `厂商/` 前缀（OpenRouter 式写法）。
// RAMET_MODEL_CATALOG：目录地址；设成 off 就不拉（自托管离线时用）。

import { createSafeFetch, type SafeFetchDeps } from './endpoint-guard.js'
import type { Protocol } from './quick.js'

export const DEFAULT_CATALOG_URL = 'https://models.dev/api.json'
/** 目录多久重拉一次 */
const TTL_MS = 24 * 60 * 60_000
/** 拉失败后多久再试：期间直接当没有目录，不让每一轮都等一次超时 */
const RETRY_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 15_000
/** 从来没拉到过时最多等这么久：目录站点卡住时第一轮不陪着等满超时，先按内置规则，拉到了再通知订阅者 */
const FIRST_WAIT_MS = 3000
/** 目录现在约 6MB，留足余量；超过就当拉失败（防一个异常响应把内存吃掉） */
const MAX_BYTES = 40 * 1024 * 1024
/** 两种协议的原生地址：目录里这两家不写 api（SDK 默认地址），按 host 认不出来 */
const NATIVE_HOSTS: Record<string, string> = { 'api.anthropic.com': 'anthropic', 'api.openai.com': 'openai' }

export type ModelSpec = {
  /** 上下文窗口（token） */
  context?: number
  /** 单次输出上限（token） */
  output?: number
  reasoning: boolean
  /** 思考档位（目录里 type=effort 的 values，按目录给的顺序） */
  efforts?: string[]
  /** 按 token 预算思考（type=budget_tokens），带上下限的话一并给 */
  budget?: { min?: number; max?: number }
}

export type ModelMatch = { spec: ModelSpec; exact: boolean }

export type CatalogIndex = {
  /** API 地址的 host → 供应商 id（短的在前：zhipuai 先于 zhipuai-coding-plan） */
  hosts: Map<string, string[]>
  /** 供应商 id → 宽松模型名 → 规格 */
  providers: Map<string, Map<string, ModelSpec>>
  /** 宽松模型名（目录里的 id 与 canonical id 的模型部分）→ 规格，模型自家厂商那一条优先 */
  global: Map<string, ModelSpec>
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** 宽松模型名：小写、去掉 `厂商/` 前缀、`.` `_` 换成 `-` */
export function looseModel(id: string): string {
  const last = id.trim().toLowerCase().split('/').pop() ?? ''
  return last.replace(/[._]/g, '-')
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function specOf(raw: Record<string, unknown>): ModelSpec {
  const limit = rec(raw.limit)
  const spec: ModelSpec = { reasoning: raw.reasoning === true }
  const context = num(limit.context)
  const output = num(limit.output)
  if (context) spec.context = context
  if (output) spec.output = output
  for (const o of Array.isArray(raw.reasoning_options) ? raw.reasoning_options.map(rec) : []) {
    if (o.type === 'effort' && Array.isArray(o.values)) {
      const values = o.values.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 20)
      if (values.length > 0) spec.efforts = values
    } else if (o.type === 'budget_tokens') {
      const min = num(o.min)
      const max = num(o.max)
      spec.budget = { ...(min ? { min } : {}), ...(max ? { max } : {}) }
    }
  }
  return spec
}

/** 目录原文 → 索引（纯函数）。形状不对的供应商 / 模型跳过，不整份作废 */
export function indexCatalog(raw: unknown): CatalogIndex {
  const hosts = new Map<string, string[]>()
  const providers = new Map<string, Map<string, ModelSpec>>()
  const global = new Map<string, { spec: ModelSpec; firstParty: boolean }>()
  const offer = (key: string, spec: ModelSpec, firstParty: boolean): void => {
    const had = global.get(key)
    if (!had || (firstParty && !had.firstParty)) global.set(key, { spec, firstParty })
  }
  // 供应商按 id 排序：同名模型多家都有时，结果不随目录里的键序变
  for (const [pid, p] of Object.entries(rec(raw)).sort(([a], [b]) => a.localeCompare(b))) {
    const models = new Map<string, ModelSpec>()
    for (const [key, m] of Object.entries(rec(rec(p).models))) {
      if (!m || typeof m !== 'object') continue
      const model = rec(m)
      const spec = specOf(model)
      const loose = looseModel(key)
      if (!models.has(loose)) models.set(loose, spec)
      const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : ''
      const owner = canonical.split('/')[0] ?? ''
      // 自家厂商：canonical id 的厂商段就是这个供应商（deepseek 下的 deepseek-v4-pro → deepseek/deepseek-v4-pro-0813）
      const firstParty = owner !== '' && owner === pid
      offer(loose, spec, firstParty)
      if (canonical) offer(looseModel(canonical), spec, firstParty)
    }
    if (models.size === 0) continue
    providers.set(pid, models)
    const api = rec(p).api
    const host = typeof api === 'string' ? hostOf(api) : null
    if (host) hosts.set(host, [...(hosts.get(host) ?? []), pid].sort((a, b) => a.length - b.length || a.localeCompare(b)))
  }
  for (const [host, pid] of Object.entries(NATIVE_HOSTS)) if (providers.has(pid) && !hosts.has(host)) hosts.set(host, [pid])
  return { hosts, providers, global: new Map([...global].map(([k, v]) => [k, v.spec])) }
}

/** 这套连接的模型在目录里的规格；对不上 null（纯函数） */
export function findModel(index: CatalogIndex, conn: { protocol: Protocol; baseUrl: string | null; model: string }): ModelMatch | null {
  const key = looseModel(conn.model)
  if (!key) return null
  const own = conn.baseUrl ? (hostOf(conn.baseUrl) ?? '') : conn.protocol === 'anthropic' ? 'anthropic' : ''
  const pids = conn.baseUrl ? (index.hosts.get(own) ?? []) : own ? [own] : []
  for (const pid of pids) {
    const spec = index.providers.get(pid)?.get(key)
    if (spec) return { spec, exact: true }
  }
  const spec = index.global.get(key)
  return spec ? { spec, exact: false } : null
}

/** 拉目录原文（可注入）。抛错 = 这一次没拉到 */
export type CatalogLoader = () => Promise<unknown>

/** 目录缓存：过期了先给旧的、后台重拉；从来没拉到过就等这一次（最多 FIRST_WAIT_MS，同时只拉一次）；拉失败隔一段时间再试。
 *  重拉成功通知订阅者（Genet 据此刷新开着的输入框里的档位） */
export class ModelCatalog {
  private index: CatalogIndex | null = null
  private loadedAt = 0
  private failedAt = -Infinity
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly load: CatalogLoader,
    private readonly now: () => number = Date.now,
  ) {}

  /** 现有的索引（可能过期 / 没有），不触发拉取 */
  current(): CatalogIndex | null {
    return this.index
  }

  async get(): Promise<CatalogIndex | null> {
    const t = this.now()
    if (this.index && t - this.loadedAt < TTL_MS) return this.index
    if (t - this.failedAt < RETRY_MS) return this.index
    const pending = this.refresh()
    if (!this.index) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([pending, new Promise((r) => (timer = setTimeout(r, FIRST_WAIT_MS)))])
      clearTimeout(timer)
    }
    return this.index
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private refresh(): Promise<void> {
    this.loading ??= this.load()
      .then((raw) => {
        this.index = indexCatalog(raw)
        this.loadedAt = this.now()
        for (const fn of this.listeners) fn()
      })
      .catch((err: unknown) => {
        this.failedAt = this.now()
        console.warn(`[model-catalog] 模型目录没拉到，先按内置规则：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}

/** 默认的拉取：经防护版 fetch（目录地址可配，同样不许指向内网），超时、限大小 */
export function fetchCatalog(url: string, deps: SafeFetchDeps = {}): CatalogLoader {
  const safeFetch = createSafeFetch(deps)
  return async () => {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!res.ok || !res.body) throw new Error(`目录地址返回 ${res.status}`)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('目录太大')
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
}

let shared: ModelCatalog | null | undefined

/** 进程共用的目录；RAMET_MODEL_CATALOG=off 时没有（null） */
export function defaultModelCatalog(): ModelCatalog | null {
  if (shared !== undefined) return shared
  const url = process.env.RAMET_MODEL_CATALOG?.trim() || DEFAULT_CATALOG_URL
  shared = url === 'off' ? null : new ModelCatalog(fetchCatalog(url))
  return shared
}
