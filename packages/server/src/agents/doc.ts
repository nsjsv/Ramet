// ---------- 文档 ⇄ 上下文拼装 ----------
// 序列化：顶层块按 Markdown 口径拼，user_message 输出 '>> ' 行，AI 回复块 agent_reply 与引用块
// 都输出 '> ' 行（嵌套引用 '> > ' 天然出现）。
// 消息约定：行首 '>> ' = 用户消息，其余 '> ' 行 = AI 回复，lastUserMessage 取最后一条用户消息
// （未编辑场景的增量）。
// agent 看到的提示词口径与前端节点无关：消息在前端是独立节点（user_message / agent_reply），
// 喂给 agent 的文本仍是 '>> ' / '> ' 行。

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { decodeStats, encodeStats } from '@ramet/shared/reply-stats'
import { encodePlan, encodeTeam, mentionChainOf, stepVerb, type ChainBlock, type MentionChain, type PlanEntry, type TeamState } from '@ramet/shared/run-model'
import { textOf, type AtomText } from '../updates.js'
import type { PromptEnv } from './prompt-env.js'
import { materialize } from './markdown.js'

// 顶层块级标签间的空行分隔;列表项/标题等同 blocks.ts 的块级口径
function childBlocks(el: Y.XmlElement, atoms?: AtomText): string[] {
  const out: string[] = []
  el.forEach((c) => {
    const t = c instanceof Y.XmlText ? c.toString() : blockMarkdown(c as Y.XmlElement, atoms)
    if (t) out.push(t)
  })
  return out
}

/** 表格 → GFM 管道形态（回喂 agent 的上下文不能把单元格文字粘成一坨；分隔行按 cell 的
 *  alignment 回写）。单元格里的 '|' 转义、换行压成空格：否则再解析时列会错位。 */
function tableText(el: Y.XmlElement, atoms?: AtomText): string {
  const lines: string[] = []
  el.forEach((row) => {
    if (!(row instanceof Y.XmlElement)) return
    if (row.nodeName !== 'table_header_row' && row.nodeName !== 'table_row') return
    const cells: string[] = []
    const align: string[] = []
    row.forEach((cell) => {
      if (!(cell instanceof Y.XmlElement)) return
      cells.push(
        textOf(cell, atoms)
          .replace(/\|/g, '\\|')
          .replace(/\n+/g, ' '),
      )
      const a = cell.getAttribute('alignment')
      align.push(typeof a === 'string' ? a : 'left')
    })
    if (cells.length === 0) return
    lines.push(`| ${cells.join(' | ')} |`)
    if (row.nodeName === 'table_header_row') {
      const marks = align.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'))
      lines.push(`| ${marks.join(' | ')} |`)
    }
  })
  return lines.join('\n')
}

const MAX_LINE_CHARS = 160

/** 压平空白再截断：步骤文字不可能造出新的行首（`>> ` 用户消息标记伪造不了） */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}…` : flat
}

/** 一个步骤块的一行：`{动词} {文字}`，失败加「 · 失败」。过程摘要（prompt-env.ts）与单独读一个步骤块共用 */
export function stepLine(el: Y.XmlElement): string {
  const attr = (name: string): string => {
    const v: unknown = el.getAttribute(name)
    return typeof v === 'string' ? v : ''
  }
  const text = oneLine(textOf(el))
  return `${stepVerb(attr('k'), attr('kind'))}${text ? ` ${text}` : ''}${attr('status') === 'failed' ? ' · 失败' : ''}`
}

/** 一个块 → 提示词口径的文字（markdown 形状）。`atoms` = 原子节点的替代文字（引用解析，见 refs.ts）。
 *  serializeDoc 拼整页、块引用取原块内容、read_page 按块读都用这一个。 */
export function blockMarkdown(el: Y.XmlElement, atoms?: AtomText): string {
  switch (el.nodeName) {
    case 'user_message': {
      // 用户消息在提示词里就是 '>> ' 行（前端独立节点，见 message-blocks.ts）
      const inner = childBlocks(el, atoms).join('\n\n')
      return inner
        .split('\n')
        .map((line) => (line.startsWith('>') ? `>>${line}` : `>> ${line}`))
        .join('\n')
    }
    case 'blockquote':
    // AI 回复块（前端独立节点）与引用块在提示词里同一形状（'> ' 引用行）：
    // agent 读到的历史口径不变，前端怎么存 / 怎么画不影响这里
    case 'agent_reply': {
      const inner = childBlocks(el, atoms).join('\n\n')
      // 引用里嵌引用(用户的真嵌套引用):内层已带 '> ' 前缀,再包一层变成 '> > '
      return inner
        .split('\n')
        .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
        .join('\n')
    }
    case 'table':
      return tableText(el, atoms)
    case 'heading': {
      const level = Number(el.getAttribute('level') ?? 1)
      return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${textOf(el, atoms)}`
    }
    case 'bullet_list':
      return childBlocks(el, atoms)
        .map((t) => `- ${t}`)
        .join('\n')
    case 'ordered_list': {
      let n = Number(el.getAttribute('start') ?? 1)
      return childBlocks(el, atoms)
        .map((t) => `${n++}. ${t}`)
        .join('\n')
    }
    case 'run_step':
      return stepLine(el)
    case 'list_item': {
      // 待办的勾选状态是内容的一部分（「引用一条待办」要拿到它做没做完）：gfm 任务项 checked = true / false，
      // 普通条目没有这个属性
      const checked: unknown = el.getAttribute('checked')
      const mark = checked === true ? '[x] ' : checked === false ? '[ ] ' : ''
      return mark + childBlocks(el, atoms).join('\n')
    }
    case 'code_block': {
      const attrs = el.getAttributes()
      const lang = typeof attrs.language === 'string' ? attrs.language : ''
      return `\`\`\`${lang}\n${textOf(el, atoms)}\n\`\`\``
    }
    case 'math_block':
      return `$$\n${textOf(el, atoms)}\n$$`
    case 'callout': {
      // 提示框：与 markdown 同形（`> [!KIND] 标题` + 引用行），agent 认得 GitHub / Obsidian 的写法
      const kind = String(el.getAttribute('kind') ?? 'note').toUpperCase()
      const title = String(el.getAttribute('title') ?? '')
      const inner = childBlocks(el, atoms).join('\n\n')
      return [`> [!${kind}]${title ? ` ${title}` : ''}`, ...inner.split('\n').map((line) => (line ? `> ${line}` : '>'))].join('\n')
    }
    case 'toggle':
    case 'columns':
    case 'column':
      // 折叠块（首段是摘要）/ 分栏：子块按顺序展开，结构对 agent 没有意义
      return childBlocks(el, atoms).join('\n\n')
    case 'toc':
      return ''
    case 'embed':
      return `[嵌入] ${String(el.getAttribute('src') ?? '')}`
    case 'bookmark':
      return `[书签] ${String(el.getAttribute('url') ?? '')}`
    default:
      return textOf(el, atoms)
  }
}

/** @ 链的进度就是文档本身（规则是 @ramet/shared/run-model 的 mentionChainOf，前端失败条用同一个函数）：
 *  把顶层块摊成 ChainBlock，用户消息里 @ 到的 agent 按出现顺序收集，回复块只数个数。 */
export function mentionChain(fragment: Y.XmlFragment): MentionChain | null {
  const blocks: ChainBlock[] = []
  const collect = (el: Y.XmlFragment | Y.XmlElement, into: string[]): void =>
    el.forEach((child) => {
      if (!(child instanceof Y.XmlElement)) return
      if (child.nodeName === 'agent_mention') {
        const id: unknown = child.getAttribute('agentId')
        if (typeof id === 'string' && id) into.push(id)
      } else collect(child, into)
    })
  fragment.forEach((node) => {
    if (!(node instanceof Y.XmlElement)) return
    if (node.nodeName === 'user_message') {
      const mentions: string[] = []
      collect(node, mentions)
      blocks.push({ kind: 'user_message', mentions })
    } else blocks.push({ kind: node.nodeName === 'agent_reply' ? 'agent_reply' : 'other' })
  })
  return mentionChainOf(blocks)
}

/** end = 只序列化前 end 个顶层块（缺省整页）。「视图」不变量靠它：每一轮只看它自己的视图。
 *  env = 这一轮实际看到的引用解析与各回复的过程摘要（prompt-env.ts 的 resolvePromptEnv）；不传则引用按默认口径
 *  （快照文字）、回复不带过程摘要。有过程摘要时，摘要行并进回复的引用行（回复正文之前）。 */
export function serializeDoc(fragment: Y.XmlFragment, end: number = fragment.length, env?: PromptEnv): string {
  const out: string[] = []
  fragment.forEach((c, i) => {
    if (i >= end) return
    if (c instanceof Y.XmlText) {
      out.push(c.toString())
      return
    }
    const el = c as Y.XmlElement
    const text = blockMarkdown(el, env?.atoms)
    const process = el.nodeName === 'agent_reply' ? env?.process(el) : undefined
    out.push(process ? `${process.map((line) => `> ${line}`).join('\n')}\n${text}` : text)
  })
  return out.filter((t) => t.trim().length > 0).join('\n\n')
}

/* ---------- 消息级调用配置 ----------
 * 用户消息节点上的 attrs：`agent`（这条消息由谁跑）/ `cwd`（执行端机器上的工作目录）/
 * `opts`（会话配置项编码串 `id=value;…`）。空串 = 没指定 = 回落页面级默认（configs / workspaces）。
 * 前端写入见 web/src/editor/message-blocks.ts 的 MessageConfig；这里只读，不落库。 */

export type MessageConfig = { agent: string; cwd: string; opts: Record<string, string> }

const EMPTY_CONFIG: MessageConfig = { agent: '', cwd: '', opts: {} }

function decodeOpts(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

function messageConfigOf(node: Y.XmlElement): MessageConfig {
  const agent = node.getAttribute('agent')
  const cwd = node.getAttribute('cwd')
  const opts = node.getAttribute('opts')
  return {
    agent: typeof agent === 'string' ? agent : '',
    cwd: typeof cwd === 'string' ? cwd : '',
    opts: typeof opts === 'string' ? decodeOpts(opts) : {},
  }
}

/** 文档里最后一条用户消息的调用配置（哪一轮与 lastUserMessage 同一口径：/continue 的增量取它） */
export function lastUserMessageAttrs(fragment: Y.XmlFragment): MessageConfig {
  let hit: MessageConfig = EMPTY_CONFIG
  fragment.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'user_message') hit = messageConfigOf(c)
  })
  return hit
}

/** 一条用户消息最多带这么多张图给模型（多了只带前几张，其余仍以链接留在文本里） */
export const MAX_PROMPT_IMAGES = 4
const FILE_SRC = /^\/api\/files\/([0-9a-f-]{36})(?:\/display)?$/i

/** 视图（前 end 个顶层块）里最后一条用户消息中的本站图片（文件 id，按出现顺序，至多 MAX_PROMPT_IMAGES 张）。
 *  这一轮发出去的就是它（增量与全文重放都以它收尾），所以只有它的图作为图片块给模型；外链图片不认 */
export function lastUserMessageImages(fragment: Y.XmlFragment, end = fragment.length): string[] {
  let last: Y.XmlElement | null = null
  fragment.forEach((c, i) => {
    if (i < end && c instanceof Y.XmlElement && c.nodeName === 'user_message') last = c
  })
  const ids: string[] = []
  const walk = (el: Y.XmlElement): void => {
    el.forEach((c) => {
      if (ids.length >= MAX_PROMPT_IMAGES || !(c instanceof Y.XmlElement)) return
      if (c.nodeName === 'image') {
        const src: unknown = c.getAttribute('src')
        const id = typeof src === 'string' ? FILE_SRC.exec(src)?.[1] : undefined
        if (id && !ids.includes(id)) ids.push(id)
      } else walk(c)
    })
  }
  if (last) walk(last)
  return ids
}

export type RedoTarget =
  | { ok: true; index: number; agent: string; message: MessageConfig }
  | { ok: false; reason: 'no-reply' | 'no-message' }

/** 重新生成的落点：顶层 agent_reply（按 id）+ 它往前最近的顶层 user_message。
 *  index = 回复在顶层的下标（重做的「视图」= 下标之前的全部内容）；agent = 回复块自己的 agent 属性 */
export function redoTarget(fragment: Y.XmlFragment, replyId: string): RedoTarget {
  let message = null as MessageConfig | null
  let hit = null as { index: number; agent: string } | null
  fragment.forEach((c, index) => {
    if (hit || !(c instanceof Y.XmlElement)) return
    if (c.nodeName === 'user_message') message = messageConfigOf(c)
    else if (c.nodeName === 'agent_reply' && c.getAttribute('id') === replyId) {
      const agent = c.getAttribute('agent')
      hit = { index, agent: typeof agent === 'string' ? agent : '' }
    }
  })
  if (!hit) return { ok: false, reason: 'no-reply' }
  if (!message) return { ok: false, reason: 'no-message' }
  return { ok: true, ...hit, message }
}

// 取最后一个用户消息块的文本：与 stripLastUserMessage 同一个边界（最后一个以 '>>' 开头的顶层块），
// 块内每一行（含段间空行 '>> '）都带前缀，连续的 '>>' 行都算这条消息；每行只剥 blockMarkdown 加的那一层
export function lastUserMessage(doc: string): string | null {
  const at = doc.lastIndexOf('\n\n>>')
  const start = at >= 0 ? at + 2 : doc.startsWith('>>') ? 0 : -1
  if (start < 0) return null
  const lines: string[] = []
  for (const line of doc.slice(start).split('\n')) {
    if (!line.startsWith('>>')) break
    lines.push(line.startsWith('>> ') ? line.slice(3) : line.slice(2))
  }
  return lines.join('\n')
}

// 去掉末尾的用户消息块(本轮要发的新输入):其余部分与 lastSyncedHash 比对,
// 相等 → 走增量(只有新消息是新增);不等 → 编辑过,全文重放。
// 顶层块以 '\n\n' 分隔,用户消息块以 '>> ' 开头(内层续行也以 '>>' 打头但块内只有 '\n')
export function stripLastUserMessage(doc: string): string {
  const idx = doc.lastIndexOf('\n\n>>')
  return idx < 0 ? (doc.startsWith('>>') ? '' : doc) : doc.slice(0, idx)
}

// ---------- AI 回复块(agent_reply,前端独立节点):占位 + 一次性收尾 ----------
// 运行中的正文不进文档（归 RunRecord，经 SSE 推给前端实时渲染）；文档里只有一个占位块，
// 一轮结束（正常 / 停止 / 出错 / 关停四个出口同一段收尾）时在一个事务里换成最后一段话的块结构。
// 所以文档历史、协同增量、版本快照里都没有过渡文字。

/** 认领前先看这块还在不在、是不是仍开着。finished = 已经收过尾，不能再写一遍盖掉。 */
export function agentReplyPhase(doc: Y.Doc, replyId: string): 'missing' | 'open' | 'finished' {
  const reply = findAgentReply(doc, replyId)
  if (!reply) return 'missing'
  const outcome = decodeStats(reply.getAttribute('stats')).o
  if (outcome && outcome !== 'run') return 'finished'
  return 'open'
}

function findAgentReply(doc: Y.Doc, replyId: string): Y.XmlElement | null {
  const frag = doc.getXmlFragment('prosemirror')
  let found: Y.XmlElement | null = null
  frag.forEach((node) => {
    if (found || !(node instanceof Y.XmlElement) || node.nodeName !== 'agent_reply') return
    if (node.getAttribute('id') === replyId) found = node
  })
  return found
}

export class ReplyWriter {
  /** 块 id：新建时在这里生成；认领时是文档里那一块已有的 id（前端 ensureBlockIds 不会改它） */
  readonly id: string
  private reply: Y.XmlElement

  /** agentId = 产出这个 AI 块的 agent catalog id：写进节点属性做归属，前端按它渲染 icon/名字。
   *  stats = `o:run`:回复的生命周期状态在块自己身上(没收尾就断了的块,前端据此显示「已中断」)
   *  existing 只给 bind 用：绑上已有节点，不再往文档末尾插第二块。 */
  constructor(private doc: Y.Doc, agentId: string, existing?: Y.XmlElement) {
    if (existing) {
      this.reply = existing
      const id = existing.getAttribute('id')
      this.id = typeof id === 'string' && id ? id : agentId
      return
    }
    this.id = randomUUID()
    this.reply = new Y.XmlElement('agent_reply')
    this.reply.setAttribute('id', this.id)
    this.reply.setAttribute('agent', agentId)
    this.reply.setAttribute('stats', encodeStats({ o: 'run' }))
    this.reply.insert(0, [new Y.XmlElement('paragraph')])
    doc.getXmlFragment('prosemirror').insert(fragmentLength(doc), [this.reply])
  }

  /** 跨重启认领：finalize 必须写回原来那块 agent_reply。节点没了返回 null，调用方删绑定、不许再插一块。 */
  static bind(doc: Y.Doc, replyId: string): ReplyWriter | null {
    const existing = findAgentReply(doc, replyId)
    if (!existing) return null
    return new ReplyWriter(doc, replyId, existing)
  }

  /** 收尾:内容换成 markdown 的块结构,同时写 stats(与过程页 id)、agent 最后一份计划清单(`plan` 属性,
   *  JSON 串;没有计划 = 不留这个属性)和带队的团队计划(`team` 属性,同样 JSON 串)。一个事务:
   *  前端看到 stats 变成终态时,真内容必然已经就位。调用点在 turn.ts runTurn 的统一 finally,
   *  且在算 lastSyncedHash 之前(hash 要落在这份最终结构上;plan 属性不进提示词,hash 不受它影响) */
  finalize(markdown: string, stats: string, runPageId: string | null, plan?: readonly PlanEntry[], team?: TeamState): void {
    const { blocks } = parseBlocks(markdown)
    const encodedPlan = encodePlan(plan)
    const encodedTeam = encodeTeam(team)
    this.doc.transact(() => {
      this.reply.delete(0, this.reply.length)
      if (blocks.length > 0) materialize(this.reply, blocks)
      else this.reply.insert(0, [new Y.XmlElement('paragraph')])
      this.reply.setAttribute('stats', stats)
      if (runPageId) this.reply.setAttribute('run', runPageId)
      if (encodedPlan) this.reply.setAttribute('plan', encodedPlan)
      else this.reply.removeAttribute('plan')
      // 带队的一轮：计划卡 / 甘特的快照（`team` 属性，JSON 串；也不进提示词）。草稿计划之后的改动以 GET /team/:planId 为准
      if (encodedTeam) this.reply.setAttribute('team', encodedTeam)
      else this.reply.removeAttribute('team')
    })
  }

  /** 原地复位（重新生成）：清空子块、stats 回到 `o:run`、去掉 `run` / `plan` / `team` 属性；块 id / agent 不变 ——
   *  引用、收藏跟着新回答走。之后照常流式与收尾（finalize）。一个事务：协作者看到的是一步切换 */
  reset(): void {
    this.doc.transact(() => {
      this.reply.delete(0, this.reply.length)
      this.reply.insert(0, [new Y.XmlElement('paragraph')])
      this.reply.setAttribute('stats', encodeStats({ o: 'run' }))
      this.reply.removeAttribute('run')
      this.reply.removeAttribute('plan')
      this.reply.removeAttribute('team')
    })
  }

  /** 这一块的「视图」：页首到它自己（含），即本轮收尾时 agent 看过的全部内容，收尾 hash 按它算（env = 本轮开头解析的环境，新回复的过程摘要已补进）。
   *  它之后别人追加的内容不属于这一轮，留给下一轮增量（起始 hash 与收尾 hash 必须同一视图） */
  viewText(env: PromptEnv, newProcess?: string[]): string {
    const frag = this.doc.getXmlFragment('prosemirror')
    let end = frag.length
    frag.forEach((node, i) => {
      if (node === this.reply) end = i + 1
    })
    // 本轮新回复的过程页是刚归档的，开头的环境里没有它：摘要由调用方（收尾）从刚建好的文档算出，在这里补给它。
    // 无档（tool-profile.ts）不带过程摘要，新回复也不补，与下一轮开头的口径一致
    const fresh = env.tools === 'none' ? undefined : newProcess
    const seen: PromptEnv = { ...env, process: (el) => (el === this.reply ? fresh : env.process(el)) }
    return serializeDoc(frag, end, seen)
  }
}

function fragmentLength(doc: Y.Doc): number {
  return doc.getXmlFragment('prosemirror').length
}
