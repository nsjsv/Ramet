// ---------- 提示词里的引用：定位 + 当前内容 ----------
// 引用契约（agent 侧的说明写在 mcp/tools/pages.mjs 的 read_page、mcp/tools/skills.mjs 的 use_skill 描述里，两边说的必须是同一件事）：
//   page_mention（@ 页面）           → page:<页面id>            （默认口径，updates.textOf 就是这样）
//   page_mention 指向 skill 页       → skill:<skill 名>         （斜杠菜单点名的 skill，agent 用 use_skill 加载，不是 read_page）
//   page_ref（子页面块）             → page:<页面id>「标题」
//   block_ref（块提及）/ block_sync → page:<页面id>#<块id>「原块当前内容」
// 原块读不到（页面删了 / 进回收站 / 发起人没权限 / 块删了）不区分原因、不泄露存在性：
// 提及给插入时的快照并注明，同步块没有快照只注明。
// 只解一层：原块里面再有的引用只给定位（提及另带快照），不递归，防环，也控提示词长度。
//
// 解析是异步的（跨页读文档、按发起人判权限），文字抽取是同步的：resolveRefs 先把要用的原块内容
// 全部读好，返回一个同步的 AtomText，serializeDoc 拿它渲染。基线 hash 就是对这份结果算的，
// 原块一改，「文档没变」的判定即失效，原生续聊也会全文重放看到新内容。

import * as Y from 'yjs'
import type { Pool } from 'pg'
import { loadDocForRead, pageAccess } from '../collab.js'
import { findBlockElement } from '../block-ids.js'
import type { AtomText } from '../updates.js'
import { blockMarkdown } from './doc.js'

type Ref = { pageId: string; blockId: string }

const UNREADABLE_MENTION = '（原块已不可读，这是引用时的快照）'
const UNREADABLE_SYNC = '（原块已不可读）'
const NESTED_MENTION = '（引用时的快照）'
const NESTED_SYNC = '（同步块）'

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** 块引用（提及 / 同步块）的目标；不是块引用或缺字段 → null */
function refOf(el: Y.XmlElement): Ref | null {
  if (el.nodeName !== 'block_ref' && el.nodeName !== 'block_sync') return null
  const pageId = attr(el, 'pageId')
  const blockId = attr(el, 'blockId')
  return pageId && blockId ? { pageId, blockId } : null
}

const keyOf = (r: Ref) => `${r.pageId}#${r.blockId}`
const locator = (r: Ref) => `page:${r.pageId}#${r.blockId}`

/** 子页面块：页面定位 + 标题（标题空就只给定位） */
function pageRefText(el: Y.XmlElement): string {
  const pageId = attr(el, 'pageId')
  const title = attr(el, 'title')
  return title ? `page:${pageId}「${title}」` : `page:${pageId}`
}

/** 不解析的渲染：原块里面的引用（只解一层），以及 read_page 按块读时块里的引用 */
export const nestedAtoms: AtomText = (el) => {
  if (el.nodeName === 'page_ref') return pageRefText(el)
  const ref = refOf(el)
  if (!ref) return undefined
  return el.nodeName === 'block_ref' ? `${locator(ref)}「${attr(el, 'text')}」${NESTED_MENTION}` : `${locator(ref)}${NESTED_SYNC}`
}

/** 一个块单独拿出来时的提示词口径：列表项补上列表标记（单独的条目没有父列表给它加 `- `） */
export function standaloneMarkdown(el: Y.XmlElement, atoms: AtomText = nestedAtoms): string {
  const md = blockMarkdown(el, atoms)
  return el.nodeName === 'list_item' ? `- ${md}` : md
}

/** 正文里要在提示词里解析的东西：块引用（读原块当前内容）与 @ 提及的页面（看是不是 skill） */
type Collected = { blocks: Map<string, Ref>; mentions: Set<string> }

/** 收集节点树里的块引用与页面提及（含嵌在文本里的行内元素） */
function collect(node: Y.XmlElement | Y.XmlText, into: Collected): void {
  if (node instanceof Y.XmlText) {
    for (const op of node.toDelta() as Array<{ insert?: unknown }>) {
      if (op.insert instanceof Y.XmlElement) collect(op.insert, into)
    }
    return
  }
  if (node.nodeName === 'page_mention') {
    const pageId = attr(node, 'pageId')
    if (pageId) into.mentions.add(pageId)
    return
  }
  const ref = refOf(node)
  if (ref) {
    into.blocks.set(keyOf(ref), ref)
    return
  }
  node.forEach((child) => collect(child as Y.XmlElement | Y.XmlText, into))
}

/** 提及里指向 skill 页的：页面 id → skill 名（发起人看不到的页面不解析，仍给 page: 定位，同块引用的不泄露口径） */
async function skillNames(pool: Pool, user: { id: string; role: string }, pageIds: Set<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (pageIds.size === 0) return names
  const { rows } = await pool.query<{ page_id: string; name: string }>(
    'SELECT s.page_id, s.name FROM skills s JOIN live_pages p ON p.id = s.page_id WHERE s.page_id = ANY($1::text[])',
    [[...pageIds]],
  )
  for (const row of rows) if (await pageAccess(pool, row.page_id, user)) names.set(row.page_id, row.name)
  return names
}

/** 读好正文里全部块引用的原块当前内容，返回提示词口径的原子渲染。
 *  收集整页而不只是视图：解析要 await，视图的边界（重新生成的目标下标）得在 await 之后同步算，
 *  否则中途到达的编辑会让下标漂移。可读性按发起这一轮的用户判（pageAccess，与提及快照同一口径）。 */
export async function resolveRefs(
  pool: Pool,
  user: { id: string; role: string },
  fragment: Y.XmlFragment,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
): Promise<AtomText> {
  const found: Collected = { blocks: new Map(), mentions: new Set() }
  fragment.forEach((child) => collect(child as Y.XmlElement | Y.XmlText, found))
  const byPage = new Map<string, Ref[]>()
  for (const ref of found.blocks.values()) byPage.set(ref.pageId, [...(byPage.get(ref.pageId) ?? []), ref])
  const skills = await skillNames(pool, user, found.mentions)

  const current = new Map<string, string>()
  for (const [pageId, list] of byPage) {
    if (!(await pageAccess(pool, pageId, user))) continue
    const body = (await loadDocForRead(pool, `page:${pageId}`, getLiveDoc)).getXmlFragment('prosemirror')
    for (const ref of list) {
      const el = findBlockElement(body, ref.blockId)
      if (el) current.set(keyOf(ref), standaloneMarkdown(el))
    }
  }

  return (el) => {
    if (el.nodeName === 'page_ref') return pageRefText(el)
    if (el.nodeName === 'page_mention') {
      const skill = skills.get(attr(el, 'pageId'))
      return skill ? `skill:${skill}` : undefined
    }
    const ref = refOf(el)
    if (!ref) return undefined
    const text = current.get(keyOf(ref))
    if (text !== undefined) return `${locator(ref)}「${text}」`
    return el.nodeName === 'block_ref' ? `${locator(ref)}「${attr(el, 'text')}」${UNREADABLE_MENTION}` : `${locator(ref)}${UNREADABLE_SYNC}`
  }
}
