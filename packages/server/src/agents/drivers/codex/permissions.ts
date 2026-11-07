// ---------- codex 发来的服务端请求：审批 / 提问 / MCP 表单 ----------
// 挂起、应答、取消、撤回的规则都在 DriverBase.hold；这里只把 codex 的请求翻成审批卡 / 表单，再把人的选择翻回 codex 的应答：
//   命令 / 改文件审批 → 允许一次（accept）/ 本会话总是允许（acceptForSession，codex 给了才摆）/ 拒绝（decline）
//   要权限审批       → 允许（scope turn）/ 本会话允许（scope session）/ 拒绝（空的 permissions）
//   提问（requestUserInput）→ 带 form 的审批：每题一个选择字段（isOther 再跟一个「其他」文本框），没选项的题是文本框（isSecret = 密码类）
//   MCP 表单（elicitation）→ 带 form 的审批（requestedSchema 走 ask-form 的同一份归一）；url 模式 = 链接 + 完成
// 没人作答就被收掉（停止本轮、换会话、进程退出）按「拒绝」应答，不用 cancel：codex 的 cancel 是「拒绝并中断整轮」，
// 停止这件事由停止按钮自己发 turn/interrupt，收掉一张卡不能顺带把别的东西停掉。
// codex 给的「以后这类命令都允许」（execpolicy / 网络规则）会写进用户自己的 codex 配置，不摆。
// 受限会话（⌘J）一律拒绝，不发事件。

import type { ToolView } from '@ramet/shared/run-model'
import { ASK_OPTIONS, normalizeAskForm } from '../../ask-form.js'
import type { AskContent, AskForm, PermissionEvent, PermissionOption, StepKind } from '../../types.js'
import { oneLine, rec, str } from '../tool-text.js'
import type { CommandApprovalDecision, JsonValue, PermissionProfile, ServerRequests, ThreadItem, UserInputQuestion } from './protocol.js'
import { RpcError } from './rpc.js'
import { itemFace, type ItemFace } from './tools.js'

export const ALLOW_ONCE = 'allow'
export const ALLOW_ALWAYS = 'allow-always'
export const REJECT = 'reject'

/** codex TUI 自己的写法：isOther 的题多一个「以上都不是」，自由输入的文字以这个前缀附在答案后面 */
export const OTHER_OPTION = 'None of the above'
export const NOTE_PREFIX = 'user_note: '

/** 驱动交给审批层的能力（DriverBase 的 protected 方法经闭包传进来） */
export type PermissionHost = {
  restricted(sessionId: string): boolean
  nextId(): string
  hold(event: PermissionEvent, settle: (optionId: string | null, content?: AskContent) => void, signal: AbortSignal, turnOf?: string): void
  inTurn(sessionId: string): boolean
  /** 这一步开始时算出的样子（审批卡的 diff 预览用；改文件的审批请求里只有条目 id） */
  faceOf(itemId: string): ItemFace | undefined
}

const once: PermissionOption = { optionId: ALLOW_ONCE, name: '允许一次', kind: 'allow_once' }
const always: PermissionOption = { optionId: ALLOW_ALWAYS, name: '本会话总是允许', kind: 'allow_always' }
const reject: PermissionOption = { optionId: REJECT, name: '拒绝', kind: 'reject_once' }

type Simple = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
type CommandParams = ServerRequests['item/commandExecution/requestApproval']['params']
type ElicitParams = ServerRequests['mcpServer/elicitation/request']['params']
type ElicitResult = ServerRequests['mcpServer/elicitation/request']['result']

/** 这次 codex 允许的决定（缺省 = 四个基本决定都可以） */
function offered(list: CommandApprovalDecision[] | null | undefined): Set<Simple> {
  if (!list) return new Set(['accept', 'acceptForSession', 'decline', 'cancel'])
  return new Set(list.filter((d): d is Simple => typeof d === 'string'))
}

/** 卡片上的选项 → codex 的决定值。拒绝优先 decline（只拒这一步），codex 没给 decline 时只能用 cancel */
export function approvalDecision(optionId: string | null, allowed: Set<Simple>): Simple {
  const no: Simple = allowed.has('decline') || !allowed.has('cancel') ? 'decline' : 'cancel'
  if (optionId === ALLOW_ONCE && allowed.has('accept')) return 'accept'
  if (optionId === ALLOW_ALWAYS && allowed.has('acceptForSession')) return 'acceptForSession'
  return no
}

type Card = { title: string; kind: StepKind; view?: ToolView; options: PermissionOption[] }

// ---------- 提问 ----------

const questionKey = (i: number): string => `question_${i}`
/** 「其他」文本框紧跟在它的题目后面、键名以题目键加下划线开头：ask-form 的 companionOf 据此把它们配成一对 */
const customKey = (i: number): string => `question_${i}_custom`
const hasChoices = (q: UserInputQuestion): boolean => (q.options?.length ?? 0) > 0

/** 题目 → 表单：先拼成 MCP 的 requestedSchema，再走 ask-form 的同一份归一（限长、去重、密码类与其它提问一致） */
export function questionForm(questions: UserInputQuestion[], itemId: string): AskForm | null {
  if (questions.length === 0) return null
  const single = questions.length === 1
  const properties: Record<string, unknown> = {}
  questions.forEach((q, i) => {
    const title = q.header || (single ? undefined : q.question) || undefined
    const description = single || !q.header ? undefined : q.question
    const secret = q.isSecret ? { _meta: { codex: { isSecret: true } } } : {}
    if (hasChoices(q)) {
      const options = q.options!.map((o) => ({ const: o.label, title: o.label, ...(o.description ? { description: o.description } : {}) }))
      properties[questionKey(i)] = { type: 'string', title, description, oneOf: options }
      if (q.isOther) {
        properties[customKey(i)] = { type: 'string', title: '其他', description: '选项里没有就写下你的答案，也可以给上面的选择补一句（可选）', ...secret }
      }
    } else {
      properties[questionKey(i)] = { type: 'string', title, description, ...secret }
    }
  })
  return normalizeAskForm({
    message: single ? questions[0]!.question || questions[0]!.header : '请回答下面这些问题',
    requestedSchema: { type: 'object', properties },
    toolCallId: itemId,
  })
}

/** 表单答案 → requestUserInput 的应答（以题目 id 为键，每题一个字符串数组）。照 codex TUI 的写法：
 *  选了的选项在前，「其他」里写的字以 `user_note: ` 前缀附在后面；只写了「其他」没选时，选项记成「以上都不是」。
 *  没答的题不出现；全都没答 = 空的 answers（codex 当作跳过） */
export function questionAnswers(questions: UserInputQuestion[], content: AskContent | undefined): ServerRequests['item/tool/requestUserInput']['result'] {
  const answers: Record<string, { answers: string[] }> = {}
  questions.forEach((q, i) => {
    const value = content?.[questionKey(i)]
    const picked = typeof value === 'string' ? value.trim() : ''
    if (!hasChoices(q)) {
      if (picked) answers[q.id] = { answers: [picked] }
      return
    }
    const custom = content?.[customKey(i)]
    const note = q.isOther && typeof custom === 'string' ? custom.trim() : ''
    const list = picked ? [picked] : note ? [OTHER_OPTION] : []
    if (note) list.push(NOTE_PREFIX + note)
    if (list.length > 0) answers[q.id] = { answers: list }
  })
  return { answers }
}

// ---------- 入口 ----------

export class CodexPermissions {
  constructor(private readonly host: PermissionHost) {}

  /** 一条服务端请求的应答。sessionId 是它所属的会话（子代理线程的请求归到主会话） */
  handle(sessionId: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> | unknown {
    const restricted = this.host.restricted(sessionId)
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandParams
        const allowed = offered(p.availableDecisions)
        if (restricted) return { decision: approvalDecision(null, allowed) }
        const face = this.host.faceOf(p.itemId) ?? (p.command ? commandFace(p) : undefined)
        const options = [
          ...(allowed.has('accept') ? [once] : []),
          ...(allowed.has('acceptForSession') ? [always] : []),
          reject,
        ]
        const card = { title: face?.title ?? (oneLine(p.reason ?? '') || '运行命令'), kind: face?.kind ?? 'execute', ...(face ? { view: face.view } : {}), options }
        return this.approve(sessionId, p.itemId, card, signal, (optionId) => ({ decision: approvalDecision(optionId, allowed) }))
      }
      case 'item/fileChange/requestApproval': {
        const allowed = offered(null)
        if (restricted) return { decision: 'decline' }
        const p = params as ServerRequests[typeof method]['params']
        const face = this.host.faceOf(p.itemId)
        const card = { title: face?.title ?? (oneLine(p.reason ?? '') || '修改文件'), kind: face?.kind ?? 'edit', ...(face ? { view: face.view } : {}), options: [once, always, reject] }
        return this.approve(sessionId, p.itemId, card, signal, (optionId) => ({ decision: approvalDecision(optionId, allowed) }))
      }
      case 'item/permissions/requestApproval': {
        const none: ServerRequests[typeof method]['result'] = { permissions: {}, scope: 'turn' }
        if (restricted) return none
        const p = params as ServerRequests[typeof method]['params']
        const card = { title: permissionTitle(p.permissions, p.reason), kind: 'other' as const, options: [once, always, reject] }
        return this.approve(sessionId, p.itemId, card, signal, (optionId) =>
          optionId === ALLOW_ONCE ? { permissions: p.permissions, scope: 'turn' } : optionId === ALLOW_ALWAYS ? { permissions: p.permissions, scope: 'session' } : none,
        )
      }
      case 'item/tool/requestUserInput':
        return this.ask(sessionId, params as ServerRequests[typeof method]['params'], signal)
      case 'mcpServer/elicitation/request':
        return this.elicit(sessionId, params as ElicitParams, signal)
      default:
        throw new RpcError(-32601, `Ramet 不支持 ${method}`)
    }
  }

  private wait<R>(event: PermissionEvent, signal: AbortSignal, answer: (optionId: string | null, content?: AskContent) => R, turnOf?: string): Promise<R> {
    const { promise, resolve } = Promise.withResolvers<R>()
    this.host.hold(event, (optionId, content) => resolve(answer(optionId, content)), signal, turnOf)
    return promise
  }

  /** 提问不比所在的一轮活得久：到达时这个会话有在飞的 prompt 就打上标记 */
  private turnOf(sessionId: string): string | undefined {
    return this.host.inTurn(sessionId) ? sessionId : undefined
  }

  private approve<R>(sessionId: string, itemId: string, card: Card, signal: AbortSignal, answer: (optionId: string | null) => R): Promise<R> {
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: card.title,
      options: card.options,
      // toolCall 只放 id / 标题 / 种类：审批折进同一步时，详情来自视图（toolCall 里有 rawInput / content 等老 ACP 键会让改动统计按老口径算）
      toolCall: { toolCallId: itemId, title: card.title, kind: card.kind },
      ...(card.view ? { view: card.view } : {}),
      sessionId,
    }
    return this.wait(event, signal, (optionId) => answer(optionId))
  }

  private ask(sessionId: string, p: ServerRequests['item/tool/requestUserInput']['params'], signal: AbortSignal): Promise<unknown> | unknown {
    const skip: ServerRequests['item/tool/requestUserInput']['result'] = { answers: {} }
    if (this.host.restricted(sessionId)) return skip
    const questions = Array.isArray(p.questions) ? p.questions.filter((q) => q && typeof q.id === 'string' && q.id) : []
    const form = questionForm(questions, p.itemId)
    // 认不出能展示的题：协议里没有「拒绝」，空答案就是跳过
    if (!form) return skip
    const title = form.message.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '提问'
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title,
      options: ASK_OPTIONS,
      form,
      // 让提问在过程里是一步：答完时中心把「问题 → 答：…」写进这一步
      toolCall: { toolCallId: p.itemId, title, kind: 'other' },
      view: { tool: 'requestUserInput' },
      sessionId,
    }
    // isBlocking 为假的提问 codex 自己不等它，不跟着一轮收掉
    return this.wait(event, signal, (optionId, content) => (optionId === 'accept' ? questionAnswers(questions, content) : skip), p.isBlocking ? this.turnOf(sessionId) : undefined)
  }

  private elicit(sessionId: string, p: ElicitParams, signal: AbortSignal): Promise<ElicitResult> | ElicitResult {
    const done = (action: ElicitResult['action'], content: JsonValue | null = null): ElicitResult => ({ action, content, _meta: null })
    if (this.host.restricted(sessionId)) return done('decline')
    const message = typeof p.message === 'string' ? p.message : ''
    let form: AskForm | null = null
    let options = ASK_OPTIONS
    if (p.mode === 'url') {
      // 网页授权类：在浏览器里打开链接完成，回来点「完成」。链接放在说明里，没有要填的字段
      const url = str(rec(p).url)
      if (!url) return done('cancel')
      form = { message: `${message}\n${url}`.trim(), fields: [], required: [] }
      options = [
        { optionId: 'accept', name: '完成' },
        { optionId: 'decline', name: '跳过' },
      ]
    } else if (p.mode === 'form') {
      form = normalizeAskForm({ message, requestedSchema: rec(rec(p).requestedSchema) })
    } else {
      // openai 自己的表单变体没有公开的形状：不猜，按拒绝
      return done('decline')
    }
    // 必填字段认不出：没法让人答，直接取消（同其它提问）
    if (!form) return done('cancel')
    const event: PermissionEvent = {
      type: 'permission',
      requestId: this.host.nextId(),
      title: form.message.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '提问',
      options,
      form,
      sessionId,
    }
    const url = p.mode === 'url'
    return this.wait(
      event,
      signal,
      (optionId, content): ElicitResult =>
        optionId === 'accept' ? done('accept', url ? null : ((content ?? {}) as JsonValue)) : done(optionId === 'decline' ? 'decline' : 'cancel'),
      this.turnOf(sessionId),
    )
  }
}

/** 审批请求自带的命令（条目还没开始时用它算审批卡） */
function commandFace(p: CommandParams): ItemFace {
  const item = {
    type: 'commandExecution', id: p.itemId, command: p.command ?? '', cwd: p.cwd ?? '', processId: null, source: 'agent',
    status: 'inProgress', commandActions: p.commandActions ?? [], aggregatedOutput: null, exitCode: null, durationMs: null,
  } satisfies ThreadItem
  return itemFace(item)
}

function permissionTitle(perms: PermissionProfile, reason: string | null): string {
  const parts: string[] = []
  if (rec(perms.network).enabled) parts.push('访问网络')
  const fs = rec(perms.fileSystem)
  const write = Array.isArray(fs.write) ? fs.write.map(str).filter(Boolean) : []
  const read = Array.isArray(fs.read) ? fs.read.map(str).filter(Boolean) : []
  if (write.length > 0) parts.push(`写入 ${write.join('、')}`)
  if (read.length > 0) parts.push(`读取 ${read.join('、')}`)
  return oneLine(parts.join('，') || reason || '额外权限')
}
