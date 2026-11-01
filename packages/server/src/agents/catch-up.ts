// ---------- 原生会话的增量：只发会话没见过的内容 ----------
// 上下文归 agent 自己的会话：同一个 agent 在同一页一直接着它的会话，文档前面的改动、过程页步骤、被引用块的原文、
// 空间记忆变了都不让会话作废。会话记录记着它看到哪一块（SavedSession.seen = 那一轮的回复块 id），下一轮发的是
// 这块之后文档里新增的内容 + 新消息。只多了新消息时（最常见）与原来的增量逐字节一致。
//
// 补发的块（别的 agent / 别的机器上跑的那几轮、别人发的消息、带队轮的回复）不是这个会话自己的历史，必须让它看出来，
// 否则它会当成用户说的话：每块一行署名，整段包进 <ramet-catch-up> 标签。宿主给用户消息填的来源元数据模型看不到
// （它看到的仍是一段普通用户文字），所以各家统一用结构化文字。块的文字与全文重放同一种写法（serializeBlocks）。

import * as Y from 'yjs'
import type { Pool } from 'pg'
import { lastUserMessage, serializeBlocks, stripLastUserMessage } from './doc.js'
import { parseRemoteId, type SavedSession } from './manager-types.js'
import { promptHash, type PromptEnv } from './prompt-env.js'
import type { ConnectorAgentInfo } from './protocol.js'

/** 署名用的名字：用户 id → 用户名，agent catalog id → 显示名（connector 上的带机器名）。查不到返回 undefined */
export type Names = { user: (id: string) => string | undefined; agent: (id: string) => string | undefined }

export const NO_NAMES: Names = { user: () => undefined, agent: () => undefined }

/** 补发内容的字数上限：超了只保留最近的块全文，更早的只留署名 + 定位（agent 需要时自己 read_page） */
export const CATCH_UP_MAX_CHARS = 20_000

const INTRO = '你上次回复之后，对话里新增了下面这些内容（来自共享文档，不是你说的，也不一定是当前用户说的）：'
const AFTER = '这条消息之后，对话里接着有：'
const DOC = '文档内容'

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** 读好这页里出现的作者与 agent 的名字（用户消息的 author 属性、回复块的 agent 属性）。
 *  localLabel = 本机 agent 的显示名；connector 上的 agent 取 connector 上报的清单与机器名 */
export async function resolveNames(pool: Pool, fragment: Y.XmlFragment, localLabel: (id: string) => string | undefined): Promise<Names> {
  const users = new Set<string>()
  const machines = new Set<string>()
  fragment.forEach((c) => {
    if (!(c instanceof Y.XmlElement)) return
    if (c.nodeName === 'user_message' && attr(c, 'author')) users.add(attr(c, 'author'))
    const remote = c.nodeName === 'agent_reply' ? parseRemoteId(attr(c, 'agent')) : null
    if (remote) machines.add(remote.connectorId)
  })
  const [u, m] = await Promise.all([
    users.size
      ? pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...users]])
      : { rows: [] },
    machines.size
      ? pool.query<{ id: string; name: string; agents: ConnectorAgentInfo[] | null }>(
          'SELECT id, name, agents FROM connectors WHERE id = ANY($1::text[])',
          [[...machines]],
        )
      : { rows: [] },
  ])
  const usernames = new Map(u.rows.map((r) => [r.id, r.username]))
  const conns = new Map(m.rows.map((r) => [r.id, r]))
  return {
    user: (id) => usernames.get(id),
    agent: (id) => {
      const remote = parseRemoteId(id)
      if (!remote) return localLabel(id)
      const conn = conns.get(remote.connectorId)
      if (!conn) return undefined
      const label = (Array.isArray(conn.agents) ? conn.agents : []).find((a) => a.id === remote.agentId)?.label ?? remote.agentId
      return `${label}（${conn.name}）`
    },
  }
}

type Item = { label: string; text: string; ref: string }

/** 「alice 的消息」「Codex（laptop）的回复」：西文名后空一格，中文 / 全角结尾直接接 */
const owned = (name: string, what: string): string => `${name}${/[\x21-\x7e]$/.test(name) ? ' ' : ''}的${what}`

function labelOf(el: Y.XmlElement | null, names: Names): string {
  if (el?.nodeName === 'user_message') {
    const author = attr(el, 'author')
    return owned((author && names.user(author)) || '用户', '消息')
  }
  if (el?.nodeName === 'agent_reply') {
    const agent = attr(el, 'agent')
    return owned((agent && names.agent(agent)) || agent || 'agent', '回复')
  }
  return DOC
}

/** 超过上限时从最早的块开始只留署名 + 定位；最近的块尽量完整 */
function elide(items: Item[], env: PromptEnv): void {
  let budget = CATCH_UP_MAX_CHARS
  let over = false
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (!over && item.text.length <= budget) {
      budget -= item.text.length
      continue
    }
    over = true
    // 无档（tool-profile.ts）没有 read_page，不提它
    item.text = env.tools === 'none' ? '（较早的内容略）' : `（较早的内容略，需要时用 read_page 读 ${item.ref}）`
    item.ref = ''
  }
}

function render(head: string, items: Item[]): string {
  const out: string[] = []
  let prev = ''
  for (const it of items) {
    // 被省略的块（ref 已清空）署名与说明写在同一行；连续的普通文档块共用一行署名
    if (!it.ref) out.push(`[${it.label}]${it.text}`)
    else out.push(it.label === DOC && prev === DOC ? it.text : `[${it.label}]\n${it.text}`)
    prev = it.ref ? it.label : ''
  }
  return ['<ramet-catch-up>', head, '', out.join('\n\n'), '</ramet-catch-up>'].join('\n')
}

/** 有 seen 的会话这一轮的提示词。seen 这块不在视图里（被删了）→ 只发新消息。
 *  新增的块按「最后一条用户消息之前 / 之后」分两段，新消息本身不包标签（之后那段出现在 @ 链：前一家的回复跟在消息后面） */
export function catchUpPrompt(o: {
  fragment: Y.XmlFragment
  seen: string
  end: number
  env: PromptEnv
  names: Names
  pageId: string
  /** 这一轮的新消息（lastUserMessage 的口径） */
  message: string
}): string {
  let at = -1
  let last = -1
  o.fragment.forEach((c, i) => {
    if (i >= o.end || !(c instanceof Y.XmlElement)) return
    if (at < 0) {
      if (attr(c, 'id') === o.seen) at = i
    } else if (c.nodeName === 'user_message') last = i
  })
  if (at < 0) return o.message
  const items = (from: number, to: number): Item[] =>
    serializeBlocks(o.fragment, from, to, o.env)
      .filter((b) => b.text.trim().length > 0)
      .map((b) => {
        const id = b.el ? attr(b.el, 'id') : ''
        return { label: labelOf(b.el, o.names), text: b.text, ref: id ? `page:${o.pageId}#${id}` : `page:${o.pageId}` }
      })
  const before = items(at + 1, last < 0 ? o.end : last)
  const after = last < 0 ? [] : items(last + 1, o.end)
  if (before.length === 0 && after.length === 0) return o.message
  elide([...before, ...after], o.env)
  return [before.length ? render(INTRO, before) : '', o.message, after.length ? render(AFTER, after) : ''].filter(Boolean).join('\n\n')
}

/** 接着用已有会话时这一轮发的提示词；null = 不能接着用（老记录的 hash 对不上），新建会话 + 全文重放。
 *  老记录（没有 seen、只有 lastSyncedHash）hash 相等 = 只追加了新消息，只发新消息；发出前补记 seen（turn.ts） */
export function deltaPrompt(
  saved: SavedSession,
  view: { fragment: Y.XmlFragment; end: number; docText: string; env: PromptEnv; names: Names; pageId: string },
): string | null {
  const message = lastUserMessage(view.docText) ?? view.docText
  if (saved.seen) return catchUpPrompt({ ...view, seen: saved.seen, message })
  return saved.lastSyncedHash === promptHash(view.env.memory, stripLastUserMessage(view.docText)) ? message : null
}
