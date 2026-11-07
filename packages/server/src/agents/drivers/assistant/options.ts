// ---------- Genet 的会话配置项：供应商 + 思考程度 ----------
// 输入框旁的「模型 · 思考」chip 读的就是这两项（与别的 agent 同一条会话配置通道，页面级落库、重开会话按 applyConfigs 收敛）。
//   供应商 = 用户在「设置 → Genet」里存的模型连接（一套 = 协议 + 地址 + 模型 + key），category=model。
//     会话建立时取设置里的当前连接，之后只听 chip 的：设置里改「当前」只影响 ⌘J，Genet 看得见自己用的是哪个，在这里换。
//     选中的连接被删了才回落到设置里的当前连接。
//   思考程度跟着选中的供应商走，category=thought_level。档位按公开模型目录（model-catalog.ts）里这个模型的 reasoning_options 给，
//     只映射到所用协议的标准参数：
//       anthropic：effort → output_config.effort；budget_tokens → thinking.budget_tokens（低 / 中 / 高 三档预算）；
//       openai 兼容：effort → reasoning_effort。只能开关（toggle）或按预算思考的模型在这个协议下没有标准参数，不给。
//     「默认」= 不发思考参数；官方地址 + 已知模型的请求本来就带 effort（协议矩阵里是 low），没有「默认」这一档。
//     目录拉不到 / 对不上时退回内置规则：官方已知模型五档、openai 兼容低中高、anthropic 自定义地址不给。
//   max_tokens 也按目录：思考算在 max_tokens 里，高档位要放大；但只有在连接自己的供应商下对上（exact）才往上放，
//     按名字兜底对上的只往下收（网关可能另有上限，放大了会被 400）。

import type { ConnectionRow } from '../../../ai-connections.js'
import type { ModelMatch } from '../../../model-catalog.js'
import { isKnownAnthropic, MAX_TOKENS_CUSTOM, MAX_TOKENS_OFFICIAL } from '../../../quick.js'
import type { ConfigOption, ConfigOptionValue } from '../../types.js'

export const PROVIDER_ID = 'provider'
export const EFFORT_ID = 'effort'

/** 会话里记着的选择。provider 在会话建立时就定下来（见 resolveChoice 的调用方）；
 *  effort 是在 provider 上选的档，null = 这个供应商的默认档。换供应商就清掉：各家档位不同，
 *  从官方地址的「高」换到 openai 兼容，带过去就成了悄悄发 reasoning_effort，「默认 = 不发」的保护落空 */
export type AssistantChoice = { provider: string | null; effort: string | null }

/** 发给模型的思考参数 */
export type AssistantThinking = { effort: string } | { budget: number }

/** 连接 → 它的模型在目录里的规格；没有目录 / 对不上 null */
export type SpecLookup = (row: ConnectionRow) => ModelMatch | null

type Levels = { kind: 'effort' | 'budget'; values: ConfigOptionValue[]; fallback: string }
/** 定档位只看这三项（设置页还没保存的表单也能问） */
type ConnShape = Pick<ConnectionRow, 'protocol' | 'base_url' | 'model'>

const DEFAULT = 'default'
const DEFAULT_VALUE: ConfigOptionValue = { value: DEFAULT, name: '默认', description: '不指定，由服务自己决定' }
const EFFORT_NAMES: Record<string, string> = { none: '不思考', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }
// 内置规则：目录不可用时用（官方已知模型的档位与目录一致）
const BUILTIN_ANTHROPIC = ['low', 'medium', 'high', 'xhigh', 'max']
const BUILTIN_OPENAI = ['low', 'medium', 'high']
/** 按预算思考的三档（会再夹进目录给的上下限、并给正文留出余量） */
const BUDGETS: Record<string, number> = { low: 4096, medium: 16384, high: 32768 }
/** Anthropic 接口要求的最小思考预算 */
const BUDGET_FLOOR = 1024
/** 高档位思考的 max_tokens（流式请求，放大不怕超时） */
const MAX_TOKENS_DEEP = 64000
const DEEP_EFFORTS = ['high', 'xhigh', 'max']

function effortValues(efforts: string[]): ConfigOptionValue[] {
  return efforts.map((v) => ({ value: v, name: EFFORT_NAMES[v] ?? v }))
}

function levelsOf(row: ConnShape, match: ModelMatch | null): Levels | null {
  const spec = match?.spec
  if (row.protocol === 'anthropic') {
    const official = isKnownAnthropic({ baseUrl: row.base_url, model: row.model })
    const efforts = spec ? spec.efforts : official ? BUILTIN_ANTHROPIC : undefined
    if (efforts) {
      if (official) return { kind: 'effort', values: effortValues(efforts), fallback: efforts.includes('low') ? 'low' : efforts[0]! }
      return { kind: 'effort', values: [DEFAULT_VALUE, ...effortValues(efforts)], fallback: DEFAULT }
    }
    return spec?.budget ? { kind: 'budget', values: [DEFAULT_VALUE, ...effortValues(Object.keys(BUDGETS))], fallback: DEFAULT } : null
  }
  const efforts = spec ? spec.efforts : BUILTIN_OPENAI
  return efforts ? { kind: 'effort', values: [DEFAULT_VALUE, ...effortValues(efforts)], fallback: DEFAULT } : null
}

/** 选中的档位 → 思考参数 + max_tokens（undefined = 协议矩阵的默认） */
function planOf(row: ConnShape, match: ModelMatch | null, levels: Levels | null, value: string): { thinking?: AssistantThinking; maxTokens?: number } {
  const official = isKnownAnthropic({ baseUrl: row.base_url, model: row.model })
  const base = row.protocol === 'anthropic' && official ? MAX_TOKENS_OFFICIAL : MAX_TOKENS_CUSTOM
  const limit = match?.spec.output ?? Infinity
  // 能不能往上放：目录里就是这个供应商的数字，或者没有目录时内置规则认得的官方模型
  const raise = match ? match.exact : official
  const capped = (n: number): number | undefined => (Math.min(n, limit) === base ? undefined : Math.min(n, limit))
  if (!levels || value === DEFAULT) return { maxTokens: capped(base) }
  if (levels.kind === 'effort') return { thinking: { effort: value }, maxTokens: capped(raise && DEEP_EFFORTS.includes(value) ? MAX_TOKENS_DEEP : base) }
  const range = match?.spec.budget ?? {}
  const want = Math.min(Math.max(BUDGETS[value] ?? BUDGETS.low!, range.min ?? BUDGET_FLOOR), range.max ?? Infinity)
  // max_tokens 必须大于预算：预算之外再留一份正文的量，整体不超过模型的输出上限
  const total = Math.min(want + base, limit)
  const budget = Math.min(want, total - BUDGET_FLOOR)
  if (budget < Math.max(range.min ?? 0, BUDGET_FLOOR)) return { maxTokens: capped(base) }
  return { thinking: { budget }, maxTokens: total }
}

/** 这套连接在 chip 上会有哪些思考档（含「默认」）；空 = 没有这一项。设置页模型框下面那一行用，与 chip 同一份判定 */
export function thinkingLevels(conn: ConnShape, match: ModelMatch | null): ConfigOptionValue[] {
  return levelsOf(conn, match)?.values ?? []
}

/** 1000000 → 1M，400000 → 400K */
function tokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`
}

export type ResolvedChoice = {
  options: ConfigOption[]
  /** 用哪套连接；null = 一套都没有（或设置里没选当前连接、会话也没选过） */
  row: ConnectionRow | null
  thinking?: AssistantThinking
  maxTokens?: number
  /** 上下文窗口（目录里有才有）：上下文圆环用 */
  context?: number
}

/** 连接表 + 设置里的当前连接 + 会话的选择 + 目录 → chip 上的两项与这一轮实际怎么问模型（纯函数）。
 *  选中的连接没了就回落到设置里的当前连接，选过的思考档跟着作废；档位不在这个供应商的选项里也用默认档 */
export function resolveChoice(rows: ConnectionRow[], activeId: string | null, choice: AssistantChoice, lookup: SpecLookup = () => null): ResolvedChoice {
  const chosen = rows.find((r) => r.id === choice.provider)
  const row = chosen ?? rows.find((r) => r.id === activeId) ?? null
  if (!row) return { options: [], row: null }
  const describe = (r: ConnectionRow): string => {
    const context = lookup(r)?.spec.context
    return context ? `${r.model} · ${tokens(context)} 上下文` : r.model
  }
  const options: ConfigOption[] = [
    {
      id: PROVIDER_ID,
      name: '供应商',
      category: 'model',
      currentValue: row.id,
      options: rows.map((r) => ({ value: r.id, name: r.name, description: describe(r) })),
    },
  ]
  const match = lookup(row)
  const levels = levelsOf(row, match)
  const current = (levels && ((chosen && levels.values.find((v) => v.value === choice.effort)?.value) || levels.fallback)) || DEFAULT
  if (levels) options.push({ id: EFFORT_ID, name: '思考程度', category: 'thought_level', currentValue: current, options: levels.values })
  const context = match?.spec.context
  return { options, row, ...planOf(row, match, levels, current), ...(context ? { context } : {}) }
}
