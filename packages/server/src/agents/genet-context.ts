// ---------- Genet 每一轮带的跨空间上下文（空间清单、个人记忆、眼前的空间的约定） ----------
// Genet 一页一直聊、会话几乎不重建，「只在新建会话时带记忆」对它等于不带：这里每一轮看一遍，同一个会话里带过、没变的不再带，
// 变了就带变化后的全部。带过什么记在会话记录里（SavedSession.context：键 list / personal / space:<id>，值是指纹，turn.ts 落库），
// 新建会话（全文重放）时从空的开始。
// 眼前的空间：这一轮新消息（用户消息、通知块）里记着的当前页（ctx 属性）和提到的页（page_mention）所在、且用户是成员的空间；
// Genet 页和它下面的任务页不算（它们只是放在那个空间里）。按在文档里最后出现的顺序取最近的 MAX_SPACES 个，总字数封顶，
// 放不下的写一行「这轮没带上」、不记为已带，下一轮再提到时再试。别的空间只在清单里，Genet 要用时自己 read_space。
// 渲染全在 space-context.ts。

import * as Y from 'yjs'
import type { Pool } from 'pg'
import { genetOwnerOf } from './assistant-agent.js'
import { listHash, mySpaces, personalMemory, renderPersonalMemory, renderSpaceBlock, renderSpaceList, spaceContext } from './space-context.js'

/** 一轮最多带几个眼前的空间 */
export const MAX_SPACES = 3
/** 这一轮所有块合计的字数上限（一个空间的约定最多约 38000 字：记忆 30000 + skill 清单 8000，第一个总放得下） */
export const GENET_CONTEXT_MAX = 40_000

export type GenetContextInput = {
  user: { id: string }
  fragment: Y.XmlFragment
  /** 视图的尾（不含） */
  viewEnd: number
  /** 增量：会话看到的最后一块；全文重放 = null（只看最后一条用户消息） */
  seen: string | null
  /** 这个会话带过的（全文重放 = {}） */
  prior: Readonly<Record<string, string>>
}

const attr = (el: Y.XmlElement, name: string): string => {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** 这一轮的新消息：seen 之后的用户消息（含通知块）；seen 不在视图里或全文重放 → 最后一条 */
function newMessages(fragment: Y.XmlFragment, viewEnd: number, seen: string | null): Y.XmlElement[] {
  const top = fragment.toArray().slice(0, viewEnd).filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
  const messages = (from: number) => top.slice(from).filter((el) => el.nodeName === 'user_message')
  const at = seen ? top.findIndex((el) => attr(el, 'id') === seen) : -1
  if (at >= 0) return messages(at + 1)
  const all = messages(0)
  return all.slice(-1)
}

/** 一条消息里的页：ctx（发消息时正在看的页）+ 提到的页，按出现顺序 */
function pagesOf(el: Y.XmlElement): string[] {
  const out: string[] = []
  const walk = (node: Y.XmlElement): void => {
    if (node.nodeName === 'page_mention' && attr(node, 'pageId')) out.push(attr(node, 'pageId'))
    node.toArray().forEach((c) => c instanceof Y.XmlElement && walk(c))
  }
  walk(el)
  if (attr(el, 'ctx')) out.push(attr(el, 'ctx'))
  return out
}

const SELECT_PAGE_SPACES = `SELECT p.id, s.id AS space_id, s.name, m.role FROM live_pages p
  JOIN spaces s ON s.id = p.space_id JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
  WHERE p.id = ANY($1::text[])`

type Here = { id: string; name: string }

/** 眼前的空间，最近的在前（见文件头） */
export async function spacesHere(pool: Pool, userId: string, fragment: Y.XmlFragment, viewEnd: number, seen: string | null): Promise<Here[]> {
  const pages = newMessages(fragment, viewEnd, seen).flatMap(pagesOf)
  if (pages.length === 0) return []
  const rows = (await pool.query<{ id: string; space_id: string; name: string }>(SELECT_PAGE_SPACES, [[...new Set(pages)], userId])).rows
  const spaceOf = new Map(rows.map((r) => [r.id, r]))
  const out: Here[] = []
  const seenSpaces = new Set<string>()
  for (const pageId of [...pages].reverse()) {
    const hit = spaceOf.get(pageId)
    if (!hit || seenSpaces.has(hit.space_id) || (await genetOwnerOf(pool, pageId)) !== null) continue
    seenSpaces.add(hit.space_id)
    out.push({ id: hit.space_id, name: hit.name })
  }
  return out
}

const skipLine = (s: Here, why: string): string => `[Ramet 空间上下文：「${s.name}」space:${s.id} 的约定这轮没带上（${why}），需要时用 read_space 取]`

/** 这一轮要带的块（text 为空 = 什么都不用带）与带完之后的记录 */
export async function genetContext(pool: Pool, input: GenetContextInput): Promise<{ text: string; record: Record<string, string> }> {
  const { user, prior } = input
  const record: Record<string, string> = { ...prior }
  const parts: string[] = []
  const [list, personal, here] = await Promise.all([
    mySpaces(pool, user.id),
    personalMemory(pool, user.id),
    spacesHere(pool, user.id, input.fragment, input.viewEnd, input.seen),
  ])
  const lh = listHash(list)
  if (prior.list !== lh) {
    parts.push(renderSpaceList(list))
    record.list = lh
  }
  if (prior.personal !== personal.hash) {
    // 一开始就没有个人记忆：不带空块，只记下指纹（之后加了第一条按「有更新」带）
    if (personal.items.length || prior.personal !== undefined) parts.push(renderPersonalMemory(personal.items, prior.personal === undefined ? 'start' : 'updated'))
    record.personal = personal.hash
  }
  let used = parts.reduce((n, p) => n + p.length, 0)
  for (const [i, space] of here.entries()) {
    const ctx = await spaceContext(pool, space.id)
    const key = `space:${space.id}`
    if (prior[key] === ctx.hash) continue
    if (i >= MAX_SPACES) {
      parts.push(skipLine(space, '这轮提到的空间太多'))
      continue
    }
    const block = renderSpaceBlock(space, ctx, 'here')
    if (used + block.length > GENET_CONTEXT_MAX) {
      parts.push(skipLine(space, '太长'))
      continue
    }
    parts.push(block)
    used += block.length
    record[key] = ctx.hash
  }
  return { text: parts.join('\n\n'), record }
}

/** 块在前、这一轮的正文在后 */
export function withGenetContext(context: string, body: string): string {
  return context ? `${context}\n\n${body}` : body
}
