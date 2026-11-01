// ---------- Claude 会话的配置项：模型 / 权限模式 / 思考强度 ----------
// 模型清单来自 CLI 的 initialize 应答（supportedModels 的同一份），当前值来自每一轮开头的 system/init 与 status 消息。
// 用户自己的 claude 配置（settings 里的默认模型 / 默认模式 / 思考强度）就是起点：Ramet 只在用户明确选过时才把值
// 交给 CLI（prefs），没选过的项不传，CLI 按它自己的配置来。
// 思考强度用 effort（启动参数 --effort，运行中 applyFlagSettings({effortLevel})）：setMaxThinkingTokens 已标废弃，
// 新模型上只当开关用；effort 的可选档按模型给（ModelInfo.supportedEffortLevels），不支持的模型就没有这一项。

import type { EffortLevel, ModelInfo, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ConfigOption } from '../../types.js'
import { UNRESTRICTED_MODES } from './permissions.js'

export const MODEL_ID = 'model'
export const MODE_ID = 'mode'
export const EFFORT_ID = 'effort'
/** 「跟随 claude 自己的配置」 */
const DEFAULT = 'default'

/** root 跑 CLI 时它拒绝 bypassPermissions（沙箱里另说）：这时不传 allowDangerouslySkipPermissions，也不摆这一档 */
export const ALLOW_BYPASS = (process.geteuid?.() ?? 1) !== 0 || Boolean(process.env.IS_SANDBOX)

const MODE_NAMES: Record<PermissionMode, string> = {
  default: '每一步都确认',
  acceptEdits: '自动接受改文件',
  plan: '计划模式',
  dontAsk: '没放行过的一律拒绝',
  auto: '自动审批',
  bypassPermissions: '跳过全部确认',
}
const MODES = Object.keys(MODE_NAMES) as PermissionMode[]
const isMode = (v: string): v is PermissionMode => (MODES as string[]).includes(v)

const EFFORT_NAMES: Record<EffortLevel, string> = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
const isEffort = (v: string): v is EffortLevel => Object.hasOwn(EFFORT_NAMES, v)

/** 用户在 Ramet 里选过的值：CLI 进程重起（resume）时原样带上，运行中改则走控制请求 */
export type ClaudePrefs = { model?: string; mode?: PermissionMode; effort?: EffortLevel }

/** 改一项配置要对活着的 CLI 发的控制请求（进程没起就只记进 prefs，下次起进程时带上） */
export type ConfigChange =
  | { kind: 'model'; model: string | undefined }
  | { kind: 'mode'; mode: PermissionMode }
  | { kind: 'effort'; effort: EffortLevel | null }

export class ClaudeConfig {
  readonly prefs: ClaudePrefs = {}
  private models: ModelInfo[] = []
  /** CLI 报的当前模型 / 模式（system/init、status）；没报过就是 undefined */
  private reportedModel: string | undefined
  private reportedMode: string | undefined

  constructor(private readonly allowBypass = ALLOW_BYPASS) {}

  /** initialize 应答里的模型清单（进程每次起来都给一份，可能随登录 / 版本变） */
  setModels(models: ModelInfo[]): void {
    this.models = models.filter((m) => typeof m.value === 'string' && m.value)
  }

  /** 每一轮开头的 system/init：此刻实际用的模型与模式 */
  noteInit(model: string | undefined, mode: string | undefined): void {
    if (model) this.reportedModel = model
    if (mode) this.noteMode(mode, false)
  }

  /** 模式变了（status 消息）。agent 自己切的（ExitPlanMode 批准后）也记进 prefs：进程重起后还是这一档 */
  noteMode(mode: string, sticky = true): void {
    this.reportedMode = mode
    if (isMode(mode) && (sticky || this.prefs.mode !== undefined)) this.prefs.mode = mode
  }

  /** CLI 报的模型名（完整 id）对到清单里的哪一行：优先「默认」行（用户没指定模型时就是它），再按 value / resolvedModel 找 */
  private matchModel(reported: string): string | undefined {
    const hit = (m: ModelInfo) => m.value === reported || m.resolvedModel === reported
    const def = this.models.find((m) => m.value === DEFAULT)
    if (def && hit(def)) return def.value
    return this.models.find(hit)?.value
  }

  private modelValue(): string {
    if (this.prefs.model) return this.prefs.model
    const reported = this.reportedModel && (this.matchModel(this.reportedModel) ?? this.reportedModel)
    return reported ?? this.models.find((m) => m.value === DEFAULT)?.value ?? this.models[0]?.value ?? ''
  }

  private modeValue(): string {
    return this.prefs.mode ?? this.reportedMode ?? 'default'
  }

  /** 当前模型这一行（「默认」行或认不出的模型按第一个有 effort 档的算不准，就当没有） */
  private currentModel(): ModelInfo | undefined {
    const v = this.modelValue()
    return this.models.find((m) => m.value === v)
  }

  private efforts(): EffortLevel[] {
    const m = this.currentModel()
    return m?.supportsEffort ? (m.supportedEffortLevels ?? []).filter(isEffort) : []
  }

  private modes(): PermissionMode[] {
    const current = this.modeValue()
    const auto = this.models.some((m) => m.supportsAutoMode === true)
    return MODES.filter((m) => {
      if (m === current) return true
      if (m === 'auto') return auto
      if (m === 'bypassPermissions') return this.allowBypass
      return true
    })
  }

  /** 交给中心的配置项（会话镜像 / 前端的 chip 读它）。模型清单还没拿到时没有模型项 */
  options(): ConfigOption[] {
    const out: ConfigOption[] = []
    const model = this.modelValue()
    if (this.models.length > 0 || model) {
      const values = this.models.map((m) => ({ value: m.value, name: m.displayName || m.value, description: m.description || null }))
      // 当前值不在清单里（CLI 报了一个清单外的模型）也要能显示出来
      if (model && !values.some((v) => v.value === model)) values.push({ value: model, name: model, description: null })
      out.push({ id: MODEL_ID, name: '模型', category: 'model', currentValue: model, options: values })
    }
    out.push({
      id: MODE_ID,
      name: '权限模式',
      category: 'mode',
      currentValue: this.modeValue(),
      options: this.modes().map((m) => ({ value: m, name: MODE_NAMES[m], description: UNRESTRICTED_MODES.includes(m) ? '不经确认就执行，只有机器主人能选' : null })),
    })
    const efforts = this.efforts()
    if (efforts.length > 0) {
      const effort = this.prefs.effort && efforts.includes(this.prefs.effort) ? this.prefs.effort : DEFAULT
      out.push({
        id: EFFORT_ID,
        name: '思考强度',
        category: 'thought_level',
        currentValue: effort,
        options: [{ value: DEFAULT, name: '默认' }, ...efforts.map((e) => ({ value: e, name: EFFORT_NAMES[e] }))],
      })
    }
    return out
  }

  /** 校验并记下一项改动，返回要对活进程发的控制请求与撤销（控制请求被 CLI 拒绝时回到改之前）。
   *  值不在可选项里抛错 */
  set(configId: string, value: string): { change: ConfigChange; undo: () => void } {
    const prefs = { ...this.prefs }
    const reportedMode = this.reportedMode
    const undo = (): void => {
      for (const k of Object.keys(this.prefs) as (keyof ClaudePrefs)[]) delete this.prefs[k]
      Object.assign(this.prefs, prefs)
      this.reportedMode = reportedMode
    }
    return { change: this.apply(configId, value), undo }
  }

  private apply(configId: string, value: string): ConfigChange {
    const option = this.options().find((o) => o.id === configId)
    if (!option) throw new Error(`没有这个配置项：${configId}`)
    if (!option.options.some((o) => o.value === value)) throw new Error(`${option.name}没有这个选项：${value}`)
    if (configId === MODEL_ID) {
      this.prefs.model = value
      // 换了模型，原来的思考档新模型不一定有：不支持就回到默认（CLI 自己会按新模型降档，这里只管显示一致）
      if (this.prefs.effort && !this.efforts().includes(this.prefs.effort)) delete this.prefs.effort
      return { kind: 'model', model: value === DEFAULT ? undefined : value }
    }
    if (configId === MODE_ID && isMode(value)) {
      this.prefs.mode = value
      this.reportedMode = value
      return { kind: 'mode', mode: value }
    }
    if (configId === EFFORT_ID && (value === DEFAULT || isEffort(value))) {
      if (value === DEFAULT) delete this.prefs.effort
      else this.prefs.effort = value
      return { kind: 'effort', effort: value === DEFAULT ? null : value }
    }
    throw new Error(`${option.name}没有这个选项：${value}`)
  }
}
