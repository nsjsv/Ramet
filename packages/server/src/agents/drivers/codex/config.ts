// ---------- Codex 线程的配置项：模型 / 推理强度 / 权限预设 ----------
// 当前值以 codex 自己报的为准：thread/start | thread/resume 的应答（用户 config.toml 与项目信任合并后的实际生效值）、
// 之后的 thread/settings/updated。用户在 Ramet 里选过的才记进 overrides，由下一个 turn/start 带上
// （app-server 的语义是回合级覆盖对之后的回合持续生效）；没选过的项不传，codex 按用户自己的配置来。
// 权限只摆三档预设（approvalPolicy + sandbox 的组合）；用户自己的配置对不上任何一档时显示「自定义」，不替他改。

import type { ConfigOption, ConfigOptionValue } from '../../types.js'
import type { AskForApproval, Model, ReasoningEffort, SandboxPolicy, TurnStartParams } from './protocol.js'

export const MODEL_ID = 'model'
export const EFFORT_ID = 'effort'
export const MODE_ID = 'mode'

export const READ_ONLY = 'read-only'
export const AUTO = 'auto'
export const FULL_ACCESS = 'full-access'
/** 用户自己的 approvalPolicy + sandbox 不是三档里的任何一档：只显示，不能选 */
export const CUSTOM = 'custom'

/** 不经确认、不受沙箱限制地执行：等于把机器交给 agent，只有机器主人能进（posture 引用这一份） */
export const UNRESTRICTED_MODES: readonly string[] = [FULL_ACCESS]

type Preset = { name: string; description: string; approvalPolicy: AskForApproval; sandboxPolicy: SandboxPolicy }

const PRESETS: Record<string, Preset> = {
  [AUTO]: {
    name: '自动',
    description: '可以改工作区里的文件；越出工作区或联网之前先问',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  [READ_ONLY]: {
    name: '只读',
    description: '只能读文件；改文件、联网之前先问',
    approvalPolicy: 'on-request',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  },
  [FULL_ACCESS]: {
    name: '完全访问',
    description: '不经确认就执行，可读写任何文件、联网；只有机器主人能选',
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
}
/** 顺序即菜单与 ⇧Tab 的顺序；第一个是前端眼里的默认档，所以 codex 自己的默认（自动）排第一 */
const PRESET_IDS = Object.keys(PRESETS)

const EFFORT_NAMES: Record<string, string> = { none: '不思考', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

/** 回合级覆盖：只放用户在 Ramet 里选过的 */
export type Overrides = Partial<Pick<TurnStartParams, 'model' | 'effort' | 'approvalPolicy' | 'sandboxPolicy'>>

/** codex 报的线程当前设置 */
export type Settings = {
  model: string | null
  effort: ReasoningEffort | null
  approvalPolicy: AskForApproval | null
  sandbox: SandboxPolicy | null
}

/** approvalPolicy + sandbox 对到哪一档预设；网络开关、可写目录这些细节不影响归档（同一档里的变体） */
export function presetOf(approval: AskForApproval | null | undefined, sandbox: SandboxPolicy | null | undefined): string {
  if (typeof approval !== 'string' || !sandbox) return CUSTOM
  if (approval === 'on-request' && sandbox.type === 'readOnly') return READ_ONLY
  if (approval === 'on-request' && sandbox.type === 'workspaceWrite') return AUTO
  if (approval === 'never' && sandbox.type === 'dangerFullAccess') return FULL_ACCESS
  return CUSTOM
}

/** 一个线程的配置：codex 报的当前值 + 用户选过的覆盖 */
export class CodexThreadConfig {
  readonly overrides: Overrides = {}
  private reported: Settings

  constructor(initial: Settings) {
    this.reported = { ...initial }
  }

  /** codex 报了新的设置（resume 应答 / thread/settings/updated）。返回配置项有没有变（变了要发 config 事件） */
  note(models: Model[], settings: Partial<Settings>): boolean {
    const before = JSON.stringify(this.options(models))
    this.reported = { ...this.reported, ...settings }
    return JSON.stringify(this.options(models)) !== before
  }

  private modelValue(models: Model[]): string {
    return this.overrides.model ?? this.reported.model ?? models.find((m) => m.isDefault)?.id ?? models[0]?.id ?? ''
  }

  private currentModel(models: Model[]): Model | undefined {
    const v = this.modelValue(models)
    return models.find((m) => m.id === v) ?? models.find((m) => m.model === v)
  }

  private effortValue(models: Model[]): string {
    return this.overrides.effort ?? this.reported.effort ?? this.currentModel(models)?.defaultReasoningEffort ?? ''
  }

  private modeValue(): string {
    return presetOf(this.overrides.approvalPolicy ?? this.reported.approvalPolicy, this.overrides.sandboxPolicy ?? this.reported.sandbox)
  }

  /** 交给中心的配置项（会话镜像 / 前端的 chip 读它） */
  options(models: Model[]): ConfigOption[] {
    const out: ConfigOption[] = []
    // codex 报的可能是模型的 slug 而不是清单里的 id：对得上就按清单里那一行显示
    const model = this.currentModel(models)?.id ?? this.modelValue(models)
    const listed = models.filter((m) => !m.hidden || m.id === model)
    if (listed.length > 0 || model) {
      const values: ConfigOptionValue[] = listed.map((m) => ({ value: m.id, name: m.displayName || m.id, description: m.description || null }))
      // 当前值不在清单里（codex 报了一个清单外的模型，或清单没取到）也要能显示出来
      if (model && !values.some((v) => v.value === model)) values.push({ value: model, name: model, description: null })
      out.push({ id: MODEL_ID, name: '模型', category: 'model', currentValue: model, options: values })
    }
    const efforts = this.currentModel(models)?.supportedReasoningEfforts ?? []
    if (efforts.length > 0) {
      const effort = this.effortValue(models)
      const values: ConfigOptionValue[] = efforts.map((e) => ({ value: e.reasoningEffort, name: EFFORT_NAMES[e.reasoningEffort] ?? e.reasoningEffort, description: e.description || null }))
      if (effort && !values.some((v) => v.value === effort)) values.push({ value: effort, name: EFFORT_NAMES[effort] ?? effort, description: null })
      out.push({ id: EFFORT_ID, name: '推理强度', category: 'thought_level', currentValue: effort, options: values })
    }
    const mode = this.modeValue()
    out.push({
      id: MODE_ID,
      name: '权限',
      category: 'mode',
      currentValue: mode,
      options: [
        ...PRESET_IDS.map((id) => ({ value: id, name: PRESETS[id]!.name, description: PRESETS[id]!.description })),
        ...(mode === CUSTOM ? [{ value: CUSTOM, name: '自定义', description: '沿用 codex 自己的审批与沙箱配置' }] : []),
      ],
    })
    return out
  }

  /** 校验并记下一项改动（下一个 turn/start 生效）。值与当前相同不记覆盖（没选过的项继续跟着用户自己的配置）；
   *  不认识的项 / 值抛错。返回配置项有没有变 */
  set(models: Model[], configId: string, value: string): boolean {
    const option = this.options(models).find((o) => o.id === configId)
    if (!option) throw new Error(`没有这个配置项：${configId}`)
    if (option.currentValue === value) return false
    if (!option.options.some((o) => o.value === value) || value === CUSTOM) throw new Error(`${option.name}没有这个选项：${value}`)
    if (configId === MODEL_ID) {
      const next = models.find((m) => m.id === value)
      this.overrides.model = value
      // 新模型不支持原来的推理档：换成新模型自己的默认档（回合级覆盖会一直带着，不能留一个新模型不认的值）
      const effort = this.effortValue(models)
      if (next && next.supportedReasoningEfforts.length > 0 && !next.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)) {
        this.overrides.effort = next.defaultReasoningEffort
      }
    } else if (configId === EFFORT_ID) {
      this.overrides.effort = value
    } else {
      const preset = PRESETS[value]!
      this.overrides.approvalPolicy = preset.approvalPolicy
      this.overrides.sandboxPolicy = preset.sandboxPolicy
    }
    return true
  }
}
