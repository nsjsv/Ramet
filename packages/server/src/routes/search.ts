/* ---------- 全文搜索 ----------
 * GET /api/search?q=&include=agent → 对 title + content_text 做 ILIKE 子串匹配(空白分隔的每个词都要命中,
 * % _ \ 按字面),按相关度排序(标题完全相同 > 前缀 > 包含 > 只在正文;同档按正文命中次数、最近编辑),
 * 返回 [{id, title, snippet}]。可见性与 pages 列表同源:只见自己是成员的空间里的页面(搜索是列举类读路径,
 * 全局 admin 也不例外);限 50 条。snippet 在 JS 里取命中位置前后 ~60 字符(SQL 里做子串还得算偏移,不省事)。
 * 过程页(kind='run')默认不参与 —— 工具调用文本会淹没真实内容;include=agent 显式开启。skill 页(kind='skill')照常参与。 */

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { rowIcon } from '../page-icon.js'

// 每个词都要在标题或正文里出现（$4 = 各词的 ILIKE 模式）；排序：标题档位（完全相同 0 / 前缀 1 / 包含 2 / 只在正文 3）
// → 正文里各词出现次数之和（$5 = 小写的词）→ 正文最近改动（没有就用建页时间）→ id
const SEARCH = `SELECT id, title, content_text, icon_emoji, icon_file_id, parent_id FROM live_pages p
  WHERE space_id IN (SELECT space_id FROM space_members WHERE user_id = $1)
    AND ($2 OR kind <> 'run')
    AND NOT EXISTS (
      SELECT 1 FROM unnest($4::text[]) pat WHERE NOT (p.title ILIKE pat ESCAPE '\\' OR p.content_text ILIKE pat ESCAPE '\\')
    )
  ORDER BY
    CASE WHEN lower(title) = $6 THEN 0 WHEN title ILIKE $7 ESCAPE '\\' THEN 1 WHEN title ILIKE $8 ESCAPE '\\' THEN 2 ELSE 3 END,
    (SELECT coalesce(sum((length(lower(coalesce(p.content_text, ''))) - length(replace(lower(coalesce(p.content_text, '')), w, ''))) / length(w)), 0)
       FROM unnest($5::text[]) w) DESC,
    coalesce(content_updated_at, created_at) DESC,
    id
  LIMIT $3`

/** LIKE 模式里的字面量：\ % _ 都转义（ESCAPE '\'） */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 查询串 → SQL 参数（纯函数，可单测）：空白切词（最多 8 个），整串用来判标题档位 */
export function buildSearch(q: string): { terms: string[]; patterns: string[]; full: string; prefix: string; contains: string } | null {
  const full = q.trim().replace(/\s+/g, ' ')
  if (!full) return null
  const terms = [...new Set(full.toLowerCase().split(' '))].slice(0, 8)
  return {
    terms,
    patterns: terms.map((t) => `%${likeLiteral(t)}%`),
    full: full.toLowerCase(),
    prefix: `${likeLiteral(full)}%`,
    contains: `%${likeLiteral(full)}%`,
  }
}

// 命中前后 ~60 字符;标题命中(content_text 不含 q)时退化为开头一段
function snippet(text: string | null, q: string): string {
  if (!text) return ''
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text.slice(0, 60)
  const start = Math.max(0, i - 60)
  const end = Math.min(text.length, i + q.length + 60)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/** 搜索内核（REST 与 AI 的 search_pages 工具共用）：可见性、过程页开关、片段口径只在这里定义一次 */
export async function searchPages(
  pool: Pool,
  user: { id: string },
  q: string,
  opts: { includeAgent?: boolean; limit?: number } = {},
): Promise<Array<{ id: string; title: string; snippet: string; icon: ReturnType<typeof rowIcon>; parent_id: string | null }>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50)
  const query = buildSearch(q)
  if (!query) return []
  const { rows } = await pool.query<{
    id: string
    title: string
    content_text: string | null
    icon_emoji: string | null
    icon_file_id: string | null
    parent_id: string | null
  }>(SEARCH, [user.id, opts.includeAgent === true, limit, query.patterns, query.terms, query.full, query.prefix, query.contains])
  // 命中带图标(下拉行显示页面身份);派生契约与页面列表同源
  const hitTerm = (text: string | null): string => query.terms.find((t) => text?.toLowerCase().includes(t)) ?? query.terms[0]!
  return rows.map((r) => ({ id: r.id, title: r.title, snippet: snippet(r.content_text, hitTerm(r.content_text)), icon: rowIcon(r), parent_id: r.parent_id }))
}

export function searchRoutes(pool: Pool) {
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))
  app.get('/api/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? ''
    if (!q) return c.json([])
    // 显式开关:include=agent 才把过程页算进结果(默认不搜工具调用文本)
    const hits = await searchPages(pool, c.get('user'), q, { includeAgent: c.req.query('include') === 'agent' })
    return c.json(hits.map(({ parent_id: _parent, ...hit }) => hit))
  })
  return app
}
