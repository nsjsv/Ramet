// ---------- 反向链接：哪些页面 / 块引用了本页 ----------
// 不另维护手写关系，从正文里已有的引用派生：
//   page_mention（@ 页面 / [[）→ mention；block_ref（块提及）→ quote；block_sync（同步块）→ sync；
//   带站内页面地址的链接（/page/<id>）→ link。page_ref（子页面块）是父子结构关系，不算反链。
// 派生结果存 page_links 索引表：collab 存储钩子在每次存页面时重算该页的出链（syncPageLinks），
// 启动时补没建过索引的页（backfillPageLinks）；表里的一切都能由正文重建。
// 查询时尊重可见性：来源页必须是活页面、不是过程页、此人是其空间成员（visiblePages），不可见的整条不出现。
// 块文字（snippet）是建索引时存下的，反链查询纯 SQL、不加载任何文档。
// 本模块不依赖 collab.ts（collab 在存储钩子里调它），文档由调用方给。

import type { Pool } from 'pg'
import * as Y from 'yjs'
import { isAddressable } from '@ramet/shared/block-address'
import { withTransaction } from './db.js'
import { visiblePages } from './page-visibility.js'
import { textOf } from './updates.js'

export type LinkKind = 'mention' | 'quote' | 'sync' | 'link'
export type Link = { sourceBlock: string; targetPage: string; targetBlock: string; kind: LinkKind; snippet: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SITE_HREF = new RegExp(`/page/(${UUID})(?:[/?#]|$)`, 'i')
const MENTION_HREF = new RegExp(`^page:(${UUID})(?:#(.+))?$`, 'i')

const str = (el: Y.XmlElement, name: string): string => {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** link mark 的地址 → 目标（站内 /page/<id>，或降级的 page:<id>[#块]） */
function hrefTarget(link: unknown): { page: string; block: string; kind: LinkKind } | null {
  const href = link && typeof link === 'object' ? (link as { href?: unknown }).href : undefined
  if (typeof href !== 'string') return null
  const mention = MENTION_HREF.exec(href)
  if (mention) return { page: mention[1]!, block: mention[2] ?? '', kind: mention[2] ? 'quote' : 'mention' }
  const site = SITE_HREF.exec(href)
  return site ? { page: site[1]!, block: '', kind: 'link' } : null
}

const SNIPPET = 160

/** 正文 → 出链。引用记在它所在的可寻址块（顶层块 / 列表项 / AI 回复子块的 id），没有 id 的记 ''；每条带上那个块当前的文字（snippet）。
 *  纯函数，同一目标同一块同一种只记一条 */
export function collectLinks(body: Y.XmlFragment): Link[] {
  const out = new Map<string, Link>()
  const add = (link: Link): void => {
    out.set(`${link.sourceBlock}|${link.targetPage}|${link.targetBlock}|${link.kind}`, link)
  }
  /** 块文字：同一个块里有多条引用也只算一次 */
  const snippets = new Map<string, string>()
  const snippetOf = (owner: string, el: Y.XmlElement | null): string => {
    if (!owner || !el) return ''
    let text = snippets.get(owner)
    if (text === undefined) {
      text = textOf(el).replace(/\s+/g, ' ').trim().slice(0, SNIPPET)
      snippets.set(owner, text)
    }
    return text
  }
  // parent 是父块类型名（null 为正文顶层）；行内原子挂在文字里，父亲记成 '#text'（永不可寻址）
  const visit = (node: Y.XmlElement | Y.XmlText, owner: string, ownerEl: Y.XmlElement | null, parent: string | null): void => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
        if (op.insert instanceof Y.XmlElement) visit(op.insert, owner, ownerEl, '#text')
        else if (typeof op.insert === 'string') {
          const t = hrefTarget(op.attributes?.link)
          if (t) add({ sourceBlock: owner, targetPage: t.page, targetBlock: t.block, kind: t.kind, snippet: snippetOf(owner, ownerEl) })
        }
      }
      return
    }
    const name = node.nodeName
    if (name === 'page_ref') return // 子页面块是父子结构，不是引用
    const id = str(node, 'id')
    const addressable = Boolean(id) && isAddressable(name, parent)
    const here = addressable ? id : owner
    const hereEl = addressable ? node : ownerEl
    if (name === 'page_mention') {
      const page = str(node, 'pageId')
      if (page) add({ sourceBlock: here, targetPage: page, targetBlock: '', kind: 'mention', snippet: snippetOf(here, hereEl) })
    } else if (name === 'block_ref' || name === 'block_sync') {
      const page = str(node, 'pageId')
      const block = str(node, 'blockId')
      if (page && block) {
        add({ sourceBlock: here, targetPage: page, targetBlock: block, kind: name === 'block_ref' ? 'quote' : 'sync', snippet: snippetOf(here, hereEl) })
      }
    }
    node.forEach((child) => visit(child as Y.XmlElement | Y.XmlText, here, hereEl, name))
  }
  body.forEach((child) => visit(child as Y.XmlElement | Y.XmlText, '', null, null))
  return [...out.values()]
}

const keyOf = (l: Link): string => `${l.sourceBlock}|${l.targetPage}|${l.targetBlock}|${l.kind}|${l.snippet}`

/** 重算一页的出链并落索引：没变（含块文字）一个写都不做；目标页必须存在（外键），指向不存在页面的引用不进索引。
 *  过程页（kind='run'）不建（工具调用文本里的引用是噪声，也不出现在任何反链里） */
export async function syncPageLinks(pool: Pool, pageId: string, body: Y.XmlFragment): Promise<void> {
  const kind = (await pool.query<{ kind: string }>('SELECT kind FROM pages WHERE id = $1', [pageId])).rows[0]?.kind
  if (!kind || kind === 'run') return
  const found = collectLinks(body).filter((l) => l.targetPage !== pageId)
  const targets = [...new Set(found.map((l) => l.targetPage))]
  const [alive, existing, state] = await Promise.all([
    targets.length
      ? pool.query<{ id: string }>('SELECT id FROM pages WHERE id = ANY($1::text[])', [targets])
      : Promise.resolve({ rows: [] as Array<{ id: string }> }),
    pool.query<{ source_block_id: string; target_page_id: string; target_block_id: string; kind: LinkKind; snippet: string }>(
      'SELECT source_block_id, target_page_id, target_block_id, kind, snippet FROM page_links WHERE source_page_id = $1',
      [pageId],
    ),
    pool.query('SELECT 1 FROM page_links_state WHERE page_id = $1', [pageId]),
  ])
  const exists = new Set(alive.rows.map((r) => r.id))
  const want = found.filter((l) => exists.has(l.targetPage))
  const have = existing.rows.map((r) =>
    keyOf({ sourceBlock: r.source_block_id, targetPage: r.target_page_id, targetBlock: r.target_block_id, kind: r.kind, snippet: r.snippet }),
  )
  const same = have.length === want.length && want.every((l) => have.includes(keyOf(l)))
  if (same && state.rows.length > 0) return
  await withTransaction(pool, async (client) => {
    if (!same) {
      await client.query('DELETE FROM page_links WHERE source_page_id = $1', [pageId])
      for (const l of want) {
        await client.query(
          `INSERT INTO page_links (source_page_id, source_block_id, target_page_id, target_block_id, kind, snippet)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [pageId, l.sourceBlock, l.targetPage, l.targetBlock, l.kind, l.snippet],
        )
      }
    }
    await client.query('INSERT INTO page_links_state (page_id) VALUES ($1) ON CONFLICT DO NOTHING', [pageId])
  })
}

/** 启动时给没建过索引的页补索引（后台跑，逐页，失败只记日志）。返回补了几页 */
export async function backfillPageLinks(pool: Pool, loadBody: (pageId: string) => Promise<Y.XmlFragment>): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT p.id FROM pages p LEFT JOIN page_links_state s ON s.page_id = p.id
     WHERE s.page_id IS NULL AND p.kind <> 'run' ORDER BY p.created_at, p.id`,
  )
  let done = 0
  for (const { id } of rows) {
    try {
      await syncPageLinks(pool, id, await loadBody(id))
      done++
    } catch (err) {
      console.error(`[links] 补反链索引失败(${id}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return done
}

export type BacklinkBlock = { blockId: string; text: string; kind: LinkKind; targetBlockId: string }
export type Backlink = { pageId: string; title: string; blocks: BacklinkBlock[] }

const SELECT_BACKLINKS = `SELECT l.source_page_id, l.source_block_id, l.target_block_id, l.kind, l.snippet
  FROM page_links l JOIN live_pages p ON p.id = l.source_page_id
  WHERE l.target_page_id = $1 AND p.kind <> 'run'
  ORDER BY p.title, l.source_page_id, l.source_block_id`

const MAX_PAGES = 50
const MAX_BLOCKS = 5

/** 引用了 targetPageId 的页面与块（此人看得见的）。块文字是建索引时存下的（随每次存页面刷新），这里纯 SQL、不加载任何文档 */
export async function backlinksOf(
  pool: Pool,
  user: { id: string; role: string },
  targetPageId: string,
): Promise<{ backlinks: Backlink[]; total: number }> {
  const { rows } = await pool.query<{ source_page_id: string; source_block_id: string; target_block_id: string; kind: LinkKind; snippet: string }>(
    SELECT_BACKLINKS,
    [targetPageId],
  )
  const visible = await visiblePages(pool, user, [...new Set(rows.map((r) => r.source_page_id))])
  const grouped = new Map<string, BacklinkBlock[]>()
  for (const r of rows) {
    if (!visible.has(r.source_page_id)) continue
    const list = grouped.get(r.source_page_id) ?? []
    list.push({ blockId: r.source_block_id, targetBlockId: r.target_block_id, kind: r.kind, text: r.snippet })
    grouped.set(r.source_page_id, list)
  }
  const backlinks = [...grouped].slice(0, MAX_PAGES).map(([pageId, blocks]) => ({ pageId, title: visible.get(pageId)!.title, blocks: blocks.slice(0, MAX_BLOCKS) }))
  return { backlinks, total: grouped.size }
}
