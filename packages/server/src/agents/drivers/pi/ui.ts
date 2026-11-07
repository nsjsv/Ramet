// ---------- pi / omp 的扩展 UI 对话框 → 审批卡 / 提问 ----------
// 挂起、应答、取消、撤回的规则都在 DriverBase.hold；这里只把对话框翻成审批卡 / 表单，再把人的选择翻回对话框的答案：
//   omp 的审批（select，标题首行「Allow tool: <工具名>」）→ 允许一次 / 本会话总是允许 / 拒绝（会写进 omp 授权缓存的选项不摆），
//                                                         挂在正在执行的那一步上（主线或子代理里的）
//   confirm（pi 的权限扩展）                              → 确认 / 拒绝
//   其它 select（pi 的 select 一律是这种：pi 没有内置审批） → 单选提问
//   input / editor                                       → 文字提问
//   ask（omp rpc-ui 的提问工具）                          → 每题一个选择字段 + 一个「其他」文本框
// 没人作答就被收掉 → {cancelled: true}（两家都当拒绝 / 跳过处理）。受限会话（⌘J）一律拒绝，不发事件。

import { ASK_OPTIONS } from '../../ask-form.js'
import type { AskContent, AskField, AskForm, PermissionEvent, PermissionOption, StepKind } from '../../types.js'
import { oneLine, TITLE_MAX } from '../tool-text.js'
import type { AskAnswer, AskQuestion, PiDialect, UiAnswer, UiDialogRequest } from './protocol.js'
import type { ToolFace } from './tools.js'
import { ASK_TOOL } from './tools.js'

export const ALLOW_ONCE = 'allow'
export const ALLOW_ALWAYS = 'allow-always'
export const REJECT = 'reject'

export type UiHost = {
  sessionId: string
  dialect: PiDialect
  restricted: boolean
  nextId(): string
  hold(event: PermissionEvent, settle: (optionId: string | null, content?: AskContent) => void, signal: AbortSignal, turnOf?: string): void
  inTurn(): boolean
  /** 这个工具正在执行、还没挂过审批的那一步（审批对话框只带工具名），认领后不再分给同名的下一张卡 */
  claimLive(name: string): string | undefined
  /** 已请求、还没开始执行的这个工具调用（顺手把那一步开出来） */
  claimRequested(name: string): string | undefined
  faceOf(id: string): ToolFace | undefined
}

const CANCELLED: UiAnswer = { cancelled: true }
const APPROVAL_HEAD = /^Allow tool: (\S+)/

/** omp 的审批：宿主没有审批对话框时它退化成一条 select，形状写死在 omp 的 tools/approval.ts。
 *  pi 没有内置审批，它的 select 都是扩展问的问题，标题碰巧长得像也不当审批 */
export function approvalTool(req: UiDialogRequest, dialect: PiDialect = 'omp'): string | null {
  if (dialect !== 'omp' || req.method !== 'select') return null
  const name = APPROVAL_HEAD.exec(req.title.split('\n')[0] ?? '')?.[1]
  if (!name || req.options.at(-1) !== 'Deny') return null
  return req.options.some((o) => o === 'Approve' || o === 'Approve Once') ? name : null
}

/** 审批 select 的选项 → 卡片选项（只摆认得出的三种） */
function approvalOptions(options: string[]): Array<{ card: PermissionOption; value: string }> {
  const out: Array<{ card: PermissionOption; value: string }> = []
  for (const value of options) {
    if (value === 'Approve' || value === 'Approve Once') out.push({ value, card: { optionId: ALLOW_ONCE, name: '允许一次', kind: 'allow_once' } })
    else if (/^Approve .+ for this session$/.test(value)) out.push({ value, card: { optionId: ALLOW_ALWAYS, name: '本会话总是允许', kind: 'allow_always' } })
    else if (value === 'Deny') out.push({ value, card: { optionId: REJECT, name: '拒绝', kind: 'reject_once' } })
  }
  return out
}

const questionKey = (i: number): string => `question_${i}`
/** 「其他」文本框紧跟在题目后面、键名以题目键加下划线开头：ask-form 的 companionOf 据此把它们配成一对 */
const customKey = (i: number): string => `question_${i}_custom`

/** omp ask 的题目 → 表单（omp 说宿主总是提供自由输入，所以每题都跟一个「其他」） */
export function askForm(questions: AskQuestion[], toolCallId?: string): AskForm | null {
  if (questions.length === 0) return null
  const single = questions.length === 1
  const fields: AskField[] = []
  questions.forEach((q, i) => {
    const title = q.header || (single ? undefined : q.question) || undefined
    const description = single || !q.header ? undefined : q.question
    const options = (q.options ?? []).filter((o) => o && typeof o.label === 'string').map((o) => ({ value: o.label, label: o.label, ...(o.description ? { description: o.description } : {}) }))
    if (options.length > 0) {
      const multi = q.multi === true
      // recommended 是 agent 推荐的那一项（下标）：作为默认选中
      const rec = typeof q.recommended === 'number' ? options[q.recommended]?.value : undefined
      const def = rec === undefined ? {} : { default: multi ? [rec] : rec }
      fields.push({ key: questionKey(i), ...(title ? { title } : {}), ...(description ? { description } : {}), kind: 'choice', options, multi, ...def })
      fields.push({ key: customKey(i), title: '其他', description: '选项里没有就写下你的答案（可选）', kind: 'text' })
    } else {
      fields.push({ key: questionKey(i), ...(title ? { title } : {}), ...(description ? { description } : {}), kind: 'text' })
    }
  })
  return { message: single ? questions[0]!.question || questions[0]!.header || '提问' : '请回答下面这些问题', fields, required: [], ...(toolCallId ? { toolCallId } : {}) }
}

/** 表单答案 → ask 的应答：每题一条、按题序；单选不能同时有选项和自由输入，写了「其他」就以它为准 */
export function askAnswers(questions: AskQuestion[], content: AskContent | undefined): AskAnswer[] {
  return questions.map((q, i) => {
    const value = content?.[questionKey(i)]
    const picked = Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : typeof value === 'string' && value.trim() ? [value.trim()] : []
    const customRaw = content?.[customKey(i)]
    const custom = typeof customRaw === 'string' ? customRaw.trim() : ''
    if (!(q.options?.length ?? 0)) return { id: q.id, selectedOptions: [], ...(picked[0] ? { customInput: picked[0] } : {}) }
    if (custom && !q.multi) return { id: q.id, selectedOptions: [], customInput: custom }
    return { id: q.id, selectedOptions: picked, ...(custom ? { customInput: custom } : {}) }
  })
}

const titleOf = (text: string): string => oneLine(text, TITLE_MAX) || '提问'

export class PiUi {
  constructor(private readonly host: UiHost) {}

  handle(req: UiDialogRequest, signal: AbortSignal): UiAnswer | Promise<UiAnswer> {
    const tool = approvalTool(req, this.host.dialect)
    if (tool && req.method === 'select') return this.approval(req.title, tool, req.options, signal)
    switch (req.method) {
      case 'confirm':
        return this.confirm(req.title, req.message, signal)
      case 'select': {
        const options = req.options.map((o, i) => {
          const description = req.optionDetails?.[i]?.description
          return { value: o, label: o, ...(description ? { description } : {}) }
        })
        return this.question({ message: req.title, fields: [{ key: 'value', kind: 'choice', options, multi: false }], required: ['value'] }, signal, (c) => {
          const v = c?.value
          return typeof v === 'string' && req.options.includes(v) ? { value: v } : CANCELLED
        })
      }
      case 'input':
      case 'editor': {
        const field: AskField = {
          key: 'value',
          kind: 'text',
          ...(req.method === 'editor' && req.prefill ? { default: req.prefill } : {}),
          ...(req.method === 'input' && req.secret ? { secret: true } : {}),
        }
        return this.question({ message: req.title, fields: [field], required: [] }, signal, (c) => (typeof c?.value === 'string' ? { value: c.value } : CANCELLED))
      }
      case 'ask': {
        if (this.host.restricted) return CANCELLED
        const questions = Array.isArray(req.questions) ? req.questions.filter((q) => q && typeof q.id === 'string' && q.id) : []
        const form = askForm(questions, this.host.claimRequested(ASK_TOOL))
        if (!form) return CANCELLED
        return this.question(form, signal, (c) => ({ answers: askAnswers(questions, c) }), { tool: 'ask' })
      }
      default:
        return CANCELLED
    }
  }

  private approval(title: string, tool: string, raw: string[], signal: AbortSignal): UiAnswer | Promise<UiAnswer> {
    const options = approvalOptions(raw)
    const deny = options.find((o) => o.card.optionId === REJECT)
    if (this.host.restricted) return deny ? { value: deny.value } : CANCELLED
    const toolCallId = this.host.claimLive(tool)
    const face = toolCallId ? this.host.faceOf(toolCallId) : undefined
    const kind: StepKind = face?.kind ?? 'other'
    const cardTitle = face?.title ?? titleOf(title.split('\n').slice(1).join('\n') || tool)
    const event = this.event(cardTitle, options.map((o) => o.card), {
      ...(toolCallId ? { toolCall: { toolCallId, title: cardTitle, kind } } : {}),
      ...(face ? { view: face.view } : {}),
    })
    return this.wait(event, signal, (optionId) => {
      const picked = options.find((o) => o.card.optionId === optionId)
      return picked ? { value: picked.value } : CANCELLED
    })
  }

  private confirm(title: string, message: string, signal: AbortSignal): UiAnswer | Promise<UiAnswer> {
    if (this.host.restricted) return { confirmed: false }
    const options: PermissionOption[] = [
      { optionId: ALLOW_ONCE, name: '确认', kind: 'allow_once' },
      { optionId: REJECT, name: '拒绝', kind: 'reject_once' },
    ]
    const event = this.event(titleOf(title), options, message ? { view: { description: message } } : {})
    return this.wait(event, signal, (optionId) => ({ confirmed: optionId === ALLOW_ONCE }))
  }

  private question(form: AskForm, signal: AbortSignal, answer: (content: AskContent | undefined) => UiAnswer, view?: { tool: string }): UiAnswer | Promise<UiAnswer> {
    if (this.host.restricted) return CANCELLED
    const title = titleOf(form.message)
    const event = this.event(title, ASK_OPTIONS, {
      form,
      ...(form.toolCallId ? { toolCall: { toolCallId: form.toolCallId, title, kind: 'other' } } : {}),
      ...(view ? { view } : {}),
    })
    // 提问不比所在的一轮活得久
    const turnOf = this.host.inTurn() ? this.host.sessionId : undefined
    return this.wait(event, signal, (optionId, content) => (optionId === 'accept' ? answer(content) : CANCELLED), turnOf)
  }

  private event(title: string, options: PermissionOption[], extra: Partial<PermissionEvent>): PermissionEvent {
    return { type: 'permission', requestId: this.host.nextId(), title, options, ...extra, sessionId: this.host.sessionId }
  }

  private wait(event: PermissionEvent, signal: AbortSignal, answer: (optionId: string | null, content?: AskContent) => UiAnswer, turnOf?: string): Promise<UiAnswer> {
    const { promise, resolve } = Promise.withResolvers<UiAnswer>()
    this.host.hold(event, (optionId, content) => resolve(answer(optionId, content)), signal, turnOf)
    return promise
  }
}
