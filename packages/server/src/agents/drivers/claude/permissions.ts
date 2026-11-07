// ---------- Claude 的审批与提问：can_use_tool / MCP elicitation → permission 事件 ----------
// 挂起、应答、取消、撤回的规则都在 DriverBase.hold；这里只把 Claude 的请求翻成审批卡 / 表单，再把人的选择翻回 SDK 的应答：
//   AskUserQuestion → 带 form 的 permission（每题一个选择字段 + 一个「其他」文本框），答案组装成工具自己读的 updatedInput
//   ExitPlanMode    → 审批卡，选项 = 批准并切到哪个模式（来自 permission_suggestions 的 setMode），id 前缀固定，posture 据此认提权
//   其余工具        → 允许一次 / 总是允许（有建议规则、且 CLI 没说不许给「总是」时）/ 拒绝
//   MCP elicitation → 带 form 的 permission（requestedSchema 走 ask-form 的同一份归一）；url 模式 = 链接 + 完成
// 受限会话（⌘J）一律拒绝，不发事件。

import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  OnElicitation,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import { ASK_OPTIONS, normalizeAskForm } from '../../ask-form.js'
import type { AskContent, AskForm, PermissionEvent, PermissionOption } from '../../types.js'
import { rec, str } from '../tool-text.js'
import { toolUseFace } from './tools.js'

/** 受限会话（⌘J）里 claude 要用工具时回给它的话 */
export const RESTRICTED_MESSAGE = '这是 ⌘J 的单次改写，不允许读写文件或运行命令'

/** 不经人确认就执行的模式：bypassPermissions 全部放行，auto 由分类器代批。两者都等于把机器交给 agent，只有机器主人能进 */
export const UNRESTRICTED_MODES: readonly PermissionMode[] = ['bypassPermissions', 'auto']

/** ExitPlanMode 的「批准并切到某个模式」：选项 id = 前缀 + 模式名。posture 按同一个函数认哪些选项会提权，两边不许各写一份 */
export const EXIT_PLAN_PREFIX = 'exit-plan:'
export const exitPlanOptionId = (mode: string): string => EXIT_PLAN_PREFIX + mode

export const ALLOW_ONCE = 'allow'
export const ALLOW_ALWAYS = 'allow-always'
export const REJECT = 'reject'

/** 驱动交给审批层的能力（DriverBase 的 protected 方法经闭包传进来） */
export type PermissionHost = {
  restricted(sessionId: string): boolean
  nextId(): string
  hold(event: PermissionEvent, settle: (optionId: string | null, content?: AskContent) => void, signal: AbortSignal, turnOf?: string): void
  inTurn(sessionId: string): boolean
}

type ToolOpts = Parameters<CanUseTool>[2]
export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }

const deny = (message: string): PermissionResult => ({ behavior: 'deny', message })
const CANCELLED = '这一步被取消了'

/** 审批事件的 toolCall 只放 id 与标题：审批折进同一步时，步骤的详情来自视图（toolCall 里有 rawInput / content 等老 ACP 键会让改动统计按老口径算） */
function toolCallOf(toolName: string, input: Record<string, unknown>, toolUseID: string): Pick<PermissionEvent, 'toolCall' | 'view'> {
  const face = toolUseFace(toolName, input)
  return { toolCall: { toolCallId: toolUseID, title: face.title, kind: face.kind }, view: face.view }
}

// ---------- AskUserQuestion ----------

/** 输入里合格的题目（缺题干或选项的丢掉）；一道都没有 = null */
function questionsOf(input: Record<string, unknown>): Question[] | null {
  const raw = Array.isArray(input.questions) ? input.questions.map(rec) : []
  const out: Question[] = []
  for (const q of raw) {
    const options = Array.isArray(q.options) ? q.options.map(rec).filter((o) => str(o.label)) : []
    if (!str(q.question) || options.length === 0) continue
    out.push({
      question: str(q.question),
      header: str(q.header),
      multiSelect: q.multiSelect === true,
      options: options.map((o) => ({ label: str(o.label), description: str(o.description) })),
    })
  }
  return out.length > 0 ? out : null
}

const questionKey = (i: number): string => `question_${i}`
/** 「其他」文本框紧跟在它的题目后面、键名以题目键加下划线开头：ask-form 的 companionOf 据此把它们配成一对 */
const customKey = (i: number): string => `question_${i}_custom`

/** 题目 → 表单：先拼成 MCP 的 requestedSchema，再走 ask-form 的同一份归一（限长、去重与其它提问一致） */
function questionForm(questions: Question[], toolUseID: string): AskForm | null {
  const single = questions.length === 1
  const properties: Record<string, unknown> = {}
  questions.forEach((q, i) => {
    const options = q.options.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) }))
    const title = q.header || undefined
    const description = single ? undefined : q.question
    properties[questionKey(i)] = q.multiSelect
      ? { type: 'array', title, description, items: { anyOf: options } }
      : { type: 'string', title, description, oneOf: options }
    properties[customKey(i)] = {
      type: 'string',
      title: '其他',
      description: q.multiSelect ? '写下你自己的答案，会和上面勾选的一起交给 agent（可选）' : '选项里没有就写下你的答案，也可以给上面的选择补一句（可选）',
    }
  })
  return normalizeAskForm({
    message: single ? questions[0]!.question : '请回答下面这些问题',
    requestedSchema: { type: 'object', properties },
    toolCallId: toolUseID,
  })
}

/** 多选的答案按 CLI 自己的写法逗号拼接；本身带「, 」或引号的项用 JSON 引起来，工具拆回去时不会被拆成两项 */
function joinPicks(items: string[]): string {
  return items.map((item) => (item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item)).join(', ')
}

/** 表单答案 → AskUserQuestion 的 updatedInput（answers 以题干为键，工具的 call() 读它）。
 *  多选：勾选项与「其他」一起算答案；单选：没选时「其他」就是答案，选了时「其他」作为这道题的 notes 附上，两者都不丢 */
export function questionAnswers(questions: Question[], content: AskContent | undefined): { answers: Record<string, string>; annotations: Record<string, { notes: string }> } {
  const answers: Record<string, string> = {}
  const annotations: Record<string, { notes: string }> = {}
  questions.forEach((q, i) => {
    const custom = content?.[customKey(i)]
    const text = typeof custom === 'string' ? custom.trim() : ''
    const value = content?.[questionKey(i)]
    const picks = value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String).filter(Boolean)
    if (q.multiSelect) {
      const joined = joinPicks(text ? [...picks, text] : picks)
      if (joined) answers[q.question] = joined
      return
    }
    const picked = picks.join(', ')
    if (!picked) {
      if (text) answers[q.question] = text
      return
    }
    answers[q.question] = picked
    if (text) annotations[q.question] = { notes: text }
  })
  return { answers, annotations }
}

// ---------- ExitPlanMode ----------

/** 选项顺序：不提权的在前（第一个选项是各处的主按钮，不能是「跳过全部确认」） */
const MODE_ORDER: readonly string[] = ['acceptEdits', 'default', 'dontAsk', 'plan', 'auto', 'bypassPermissions']
const EXIT_PLAN_NAMES: Record<string, string> = {
  acceptEdits: '批准，自动接受改文件',
  default: '批准，每一步都确认',
  dontAsk: '批准，没放行过的一律拒绝',
  plan: '批准，留在计划模式',
  auto: '批准，交给自动审批',
  bypassPermissions: '批准，跳过全部确认',
}

/** CLI 建议的「批准后切到哪个模式」；没给建议时只给不提权的两档（提权必须是 CLI 自己提出来的） */
function exitPlanModes(suggestions: PermissionUpdate[]): string[] {
  const modes = suggestions.flatMap((s) => (s.type === 'setMode' ? [s.mode] : []))
  const unique = [...new Set(modes.length > 0 ? modes : ['acceptEdits', 'default'])]
  const rank = (m: string): number => (MODE_ORDER.includes(m) ? MODE_ORDER.indexOf(m) : MODE_ORDER.length)
  return unique.sort((a, b) => rank(a) - rank(b))
}

// ---------- 入口 ----------

export class ClaudePermissions {
  constructor(private readonly host: PermissionHost) {}

  canUseTool(sessionId: string): CanUseTool {
    return (toolName, input, opts) => {
      if (this.host.restricted(sessionId)) return Promise.resolve(deny(RESTRICTED_MESSAGE))
      if (toolName === 'AskUserQuestion') return this.ask(sessionId, input, opts)
      if (toolName === 'ExitPlanMode') return this.exitPlan(sessionId, toolName, input, opts)
      return this.approve(sessionId, toolName, input, opts)
    }
  }

  onElicitation(sessionId: string): OnElicitation {
    return (request, { signal }) => this.elicit(sessionId, request, signal)
  }

  private wait<T>(event: PermissionEvent, signal: AbortSignal, answer: (optionId: string | null, content?: AskContent) => T, turnOf?: string): Promise<T> {
    const { promise, resolve } = Promise.withResolvers<T>()
    this.host.hold(event, (optionId, content) => resolve(answer(optionId, content)), signal, turnOf)
    return promise
  }

  /** 提问不比所在的一轮活得久：到达时这个会话有在飞的 prompt 就打上标记 */
  private turnOf(sessionId: string): string | undefined {
    return this.host.inTurn(sessionId) ? sessionId : undefined
  }

  private ask(sessionId: string, input: Record<string, unknown>, opts: ToolOpts): Promise<PermissionResult> {
    const questions = questionsOf(input)
    const form = questions && questionForm(questions, opts.toolUseID)
    if (!questions || !form) return Promise.resolve(deny('AskUserQuestion 里没有能展示的问题'))
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: form.message.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '提问',
      options: ASK_OPTIONS,
      form,
      ...toolCallOf('AskUserQuestion', input, opts.toolUseID),
      sessionId,
    }
    return this.wait(
      event,
      opts.signal,
      (optionId, content): PermissionResult => {
        if (optionId === null) return deny(CANCELLED)
        if (optionId !== 'accept') return deny('用户跳过了这些问题')
        const { answers, annotations } = questionAnswers(questions, content)
        return { behavior: 'allow', updatedInput: { ...input, answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) } }
      },
      this.turnOf(sessionId),
    )
  }

  private exitPlan(sessionId: string, toolName: string, input: Record<string, unknown>, opts: ToolOpts): Promise<PermissionResult> {
    const suggestions = opts.suggestions ?? []
    const modes = exitPlanModes(suggestions)
    const options: PermissionOption[] = [
      ...modes.map((m) => ({ optionId: exitPlanOptionId(m), name: EXIT_PLAN_NAMES[m] ?? `批准，切到 ${m}`, kind: m === 'default' ? 'allow_once' : 'allow_always' })),
      { optionId: REJECT, name: '继续规划', kind: 'reject_once' },
    ]
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: opts.title ?? '计划好了，开始执行？',
      options,
      ...toolCallOf(toolName, input, opts.toolUseID),
      sessionId,
    }
    return this.wait(event, opts.signal, (optionId): PermissionResult => {
      if (optionId === null) return deny(CANCELLED)
      if (!optionId.startsWith(EXIT_PLAN_PREFIX)) return deny('用户要继续规划')
      const mode = optionId.slice(EXIT_PLAN_PREFIX.length)
      // 优先原样带回 CLI 的建议（目标位置等以它为准），没有建议时自己拼一条只作用于本会话的
      const update = suggestions.find((s) => s.type === 'setMode' && s.mode === mode) ?? { type: 'setMode', mode: mode as PermissionMode, destination: 'session' }
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [update] }
    })
  }

  private approve(sessionId: string, toolName: string, input: Record<string, unknown>, opts: ToolOpts): Promise<PermissionResult> {
    // 「总是允许」不许顺带把会话切进免确认模式：那条路只有 ExitPlanMode 的提权选项（posture 认得出、拦得住）
    const updates = (opts.suggestions ?? []).filter((s) => !(s.type === 'setMode' && UNRESTRICTED_MODES.includes(s.mode)))
    const always = updates.length > 0 && opts.suppressAlwaysAllowRule !== true
    const allow: PermissionOption[] = [
      { optionId: ALLOW_ONCE, name: '允许', kind: 'allow_once' },
      ...(always ? [{ optionId: ALLOW_ALWAYS, name: '总是允许', kind: 'allow_always' }] : []),
    ]
    const reject: PermissionOption = { optionId: REJECT, name: '拒绝', kind: 'reject_once' }
    // defaultToNo：CLI 要求这条审批不能一键批准。第一个选项是各处的主按钮，所以把拒绝排到最前
    const defaultToNo = opts.defaultToNo === true
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: opts.title ?? opts.displayName ?? toolName,
      options: defaultToNo ? [reject, ...allow] : [...allow, reject],
      ...toolCallOf(toolName, input, opts.toolUseID),
      ...(defaultToNo ? { defaultToNo: true } : {}),
      sessionId,
    }
    return this.wait(event, opts.signal, (optionId): PermissionResult => {
      if (optionId === ALLOW_ONCE) return { behavior: 'allow', updatedInput: input }
      if (optionId === ALLOW_ALWAYS && always) return { behavior: 'allow', updatedInput: input, updatedPermissions: updates }
      return deny(optionId === null ? CANCELLED : '用户拒绝了这一步')
    })
  }

  private elicit(sessionId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    if (this.host.restricted(sessionId)) return Promise.resolve({ action: 'decline' })
    const message = request.message ?? ''
    let form: AskForm | null
    let options = ASK_OPTIONS
    if (request.mode === 'url') {
      // 网页授权类：在浏览器里打开链接完成，回来点「完成」。链接放在说明里，没有要填的字段
      if (!request.url) return Promise.resolve({ action: 'cancel' })
      form = { message: `${message}\n${request.url}`.trim(), fields: [], required: [] }
      options = [
        { optionId: 'accept', name: '完成' },
        { optionId: 'decline', name: '跳过' },
      ]
    } else {
      form = normalizeAskForm({ message, requestedSchema: request.requestedSchema })
    }
    // 必填字段认不出：没法让人答，直接取消
    if (!form) return Promise.resolve({ action: 'cancel' })
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: (request.title ?? form.message.split('\n').find((l) => l.trim())?.trim() ?? '').slice(0, 200) || '提问',
      options,
      form,
      sessionId,
    }
    return this.wait(
      event,
      signal,
      (optionId, content): ElicitationResult =>
        optionId === 'accept' ? { action: 'accept', ...(request.mode === 'url' ? {} : { content: content ?? {} }) } : { action: optionId === 'decline' ? 'decline' : 'cancel' },
      this.turnOf(sessionId),
    )
  }
}
