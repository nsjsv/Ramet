// ---------- pi / omp 会话的配置项：模型 / 思考档位（/ omp 的审批档） ----------
// 当前值以 CLI 自己报的为准：get_state 的 model / thinkingLevel，之后的 model_changed（omp）/ thinking_level_changed。
// 用户在 Ramet 里选过的才记进 overrides：模型 / 思考档位经 set_model / set_thinking_level 交给活着的进程（进程重起后补发），
// 没选过的项不碰，CLI 按用户自己的配置来。这两条 RPC 只改当前会话，不写用户的默认模型 / 档位（pi 从 0.84.3 起、omp 的 RPC
// 都不带 persist；更老的 pi 会写，被最低版本挡住），所以不必为了不污染用户配置改用启动参数换进程。
// omp 的审批档没有运行中切换的命令，只有启动参数 --approval-mode：选了就在会话空闲时按新参数重起进程、打开同一份会话记录。
// RPC 读不到 omp 当前生效的审批档，所以没选过时显示「跟随 omp 配置」，不猜。always-ask-cached 不摆：它的授权会写进
// omp 自己的授权缓存（approval-cache.db），比 Ramet 的「本会话总是允许」活得久。

import type { ConfigOption, ConfigOptionValue } from '../../types.js'
import type { Model, PiDialect, ThinkingLevel } from './protocol.js'

export const MODEL_ID = 'model'
export const THINKING_ID = 'thinking'
export const MODE_ID = 'mode'

/** 不传 --approval-mode：沿用 omp 自己的配置（tools.approvalMode，omp 的缺省是 yolo） */
export const FOLLOW_CONFIG = 'config'
export const YOLO = 'yolo'
export type OmpApprovalMode = 'always-ask' | 'write' | 'yolo'

/** 不经确认执行任何工具：只有机器主人能选（posture 引用这一份） */
export const UNRESTRICTED_MODES: readonly string[] = [YOLO]

/** 顺序即菜单与 ⇧Tab 的顺序；第一个是前端眼里的默认档 */
const MODES: Record<string, { name: string; description: string }> = {
  [FOLLOW_CONFIG]: { name: '跟随 omp 配置', description: '按 omp 自己的 tools.approvalMode 来（omp 缺省不确认）' },
  'always-ask': { name: '每一步都确认', description: '每次调用工具之前先问' },
  write: { name: '改动前确认', description: '只读的操作直接执行，会改动东西的操作之前先问' },
  [YOLO]: { name: '跳过全部确认', description: '不经确认执行任何工具；只有机器主人能选' },
}
const MODE_IDS = Object.keys(MODES)

const THINKING_NAMES: Record<string, string> = { off: '不思考', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

/** ConfigOption 里模型的值：provider/id（不同提供方可能有同名模型） */
export const modelKey = (m: Pick<Model, 'provider' | 'id'>): string => `${m.provider}/${m.id}`

/** 没有可用模型时 CLI 给的占位模型（id / provider 都是 unknown）：不当成当前模型显示 */
function realModel(m: Model | undefined | null): m is Model {
  return !!m && typeof m.id === 'string' && !!m.id && !(m.id === 'unknown' && m.provider === 'unknown')
}

/** provider/id → set_model 的参数（id 本身可能带斜杠，只切第一段） */
export function splitModelKey(key: string): { provider: string; modelId: string } | null {
  const cut = key.indexOf('/')
  return cut > 0 && cut < key.length - 1 ? { provider: key.slice(0, cut), modelId: key.slice(cut + 1) } : null
}

export type Overrides = { model?: string; thinking?: ThinkingLevel; mode?: OmpApprovalMode }

/** 一个会话的配置：CLI 报的当前值 + 可选清单 + 用户选过的覆盖。进程重起不丢（覆盖要补发给新进程） */
export class PiSessionConfig {
  readonly overrides: Overrides = {}
  private models: Model[] = []
  /** 当前模型可选的思考档位（换模型后要重取） */
  private levels: string[] = []
  private model: string | null = null
  private thinking: string | null = null

  constructor(private readonly dialect: PiDialect) {}

  /** CLI 报的模型清单 / 当前值 / 可选档位。返回配置项有没有变（变了要发 config 事件） */
  note(update: { models?: Model[]; model?: Model | null; thinking?: string | null; levels?: string[] }): boolean {
    const before = JSON.stringify(this.options())
    if (update.models) this.models = update.models.filter(realModel)
    if (update.model !== undefined) this.model = realModel(update.model) ? modelKey(update.model) : null
    if (update.thinking !== undefined) this.thinking = update.thinking
    if (update.levels) {
      this.levels = update.levels.filter((l) => typeof l === 'string' && l)
      // 新模型不支持选过的档位：丢掉覆盖，跟着 CLI 夹过之后的值走（不能一直带着一个新模型不认的档位）。
      // 档位清单是按 CLI 此刻的模型给的：选过的模型还没交给它（进程刚重起）时清单对不上，不据此丢
      const settled = this.overrides.model === undefined || this.overrides.model === this.model
      if (settled && this.overrides.thinking && !this.levels.includes(this.overrides.thinking)) delete this.overrides.thinking
    }
    return JSON.stringify(this.options()) !== before
  }

  private modelValue(): string {
    return this.overrides.model ?? this.model ?? ''
  }

  private thinkingValue(): string {
    return this.overrides.thinking ?? this.thinking ?? ''
  }

  private modeValue(): string {
    return this.overrides.mode ?? FOLLOW_CONFIG
  }

  /** 交给中心的配置项（会话镜像 / 前端的 chip 读它） */
  options(): ConfigOption[] {
    const out: ConfigOption[] = []
    const model = this.modelValue()
    if (this.models.length > 0 || model) {
      const values: ConfigOptionValue[] = this.models.map((m) => ({ value: modelKey(m), name: m.name || m.id, description: m.provider }))
      // 当前值不在清单里（清单没取到 / CLI 报了清单外的模型）也要能显示出来
      if (model && !values.some((v) => v.value === model)) values.push({ value: model, name: model, description: null })
      out.push({ id: MODEL_ID, name: '模型', category: 'model', currentValue: model, options: values })
    }
    // 只有一档（不支持推理的模型只有 off）没什么可选的
    if (this.levels.length > 1) {
      const thinking = this.thinkingValue()
      const values: ConfigOptionValue[] = this.levels.map((l) => ({ value: l, name: THINKING_NAMES[l] ?? l }))
      if (thinking && !values.some((v) => v.value === thinking)) values.push({ value: thinking, name: THINKING_NAMES[thinking] ?? thinking })
      out.push({ id: THINKING_ID, name: '思考档位', category: 'thought_level', currentValue: thinking, options: values })
    }
    if (this.dialect === 'omp') {
      out.push({
        id: MODE_ID,
        name: '审批',
        category: 'mode',
        currentValue: this.modeValue(),
        options: MODE_IDS.map((id) => ({ value: id, name: MODES[id]!.name, description: MODES[id]!.description })),
      })
    }
    return out
  }

  /** 校验并记下一项改动。值与当前相同不记覆盖（没选过的项继续跟着用户自己的配置）；不认识的项 / 值抛错。
   *  返回配置项有没有变 */
  set(configId: string, value: string): boolean {
    const option = this.options().find((o) => o.id === configId)
    if (!option) throw new Error(`没有这个配置项：${configId}`)
    if (option.currentValue === value) return false
    if (!option.options.some((o) => o.value === value)) throw new Error(`${option.name}没有这个选项：${value}`)
    if (configId === MODEL_ID) {
      if (!splitModelKey(value)) throw new Error(`${option.name}没有这个选项：${value}`)
      this.overrides.model = value
      // 不支持推理的模型只有 off：选过的档位留着会被 CLI 夹掉，不如现在就丢掉
      const next = this.models.find((m) => modelKey(m) === value)
      if (next && !next.reasoning) delete this.overrides.thinking
    } else if (configId === THINKING_ID) {
      this.overrides.thinking = value as ThinkingLevel
    } else if (value === FOLLOW_CONFIG) {
      delete this.overrides.mode
    } else {
      this.overrides.mode = value as OmpApprovalMode
    }
    return true
  }

  /** 进程的启动参数（审批档变了要换进程，所以它也是进程身份的一部分） */
  launchArgs(): string[] {
    return this.dialect === 'omp' && this.overrides.mode ? ['--approval-mode', this.overrides.mode] : []
  }

  snapshot(): Overrides {
    return { ...this.overrides }
  }

  restore(saved: Overrides): void {
    for (const k of Object.keys(this.overrides) as Array<keyof Overrides>) delete this.overrides[k]
    Object.assign(this.overrides, saved)
  }
}
