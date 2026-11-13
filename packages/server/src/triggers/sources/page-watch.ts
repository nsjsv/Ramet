// ---------- 来源：盯页面（source = 'page_watch'） ----------
// 主人盯着一页（可连子页）：别人改了、停手满设定的时长之后汇报一次，带改动摘要（page-watch-format.ts）。
// 只算别人的改动：这一批的编辑者（edit-marks.ts 的 takeFlushedEditors，agent 写的记发起人）去掉主人；主人自己、主人的 agent / 自动化改的不算。
// 「改之前的样子」：Yjs 回不到过去（开着 gc），版本快照 5 分钟去重也不准，所以每个活文档在内存里记「上一次存盘时的样子」——
//   加载时记一次（= 库里最后存的），每次存盘之后换成新的；某条规则这一页的窗口第一次被别人改时，把存盘之前的那份落进窗口（base）。
//   重启 / 文档卸载后下次加载重新记，加载出来的就是最后存盘的样子，不丢。
// 攒改动：page_watch_windows 一条规则 × 一页一行；规则的 next_at = LEAST(最后一次被别人改 + 静默时长, 第一次被改 + 3 小时)。
//   汇报复用定时器的时钟与认领（hub.ts）：到点的规则在认领事务里交给 close()——收走窗口、清 next_at、算摘要，hub 落记录。
//   窗口与认领都先锁规则行，同一条规则上「开窗口」和「收窗口」不会交错。
// 不算：规则暂停期间（不开窗口；暂停 / 恢复 / 改配置都清窗口）、主人不再是那一页所在空间的成员、过程页 / skill 页。
// 存盘是热路径：钩子里同步读文档、算状态，落库交给 hub.background，同一页排成一条链；尽力而为，失败只记日志，绝不往钩子外抛。

import type { Extension } from '@hocuspocus/server'
import type { Pool, PoolClient } from 'pg'
import * as Y from 'yjs'
import { extractTitle, loadDocForRead, PAGE_DOC_NAME } from '../../collab.js'
import { readSchema } from '../../collections/store.js'
import { withTransaction } from '../../db.js'
import { takeFlushedEditors } from '../../edit-marks.js'
import { pageVisibleSql } from '../../page-visibility.js'
import { summaryState, type SummaryState } from '../../updates.js'
import type { TriggerHub } from '../hub.js'
import type { EventPayload } from '../payload.js'
import { shortStamp } from '../schedule.js'
import { clearWatch } from '../store.js'
import { isBlank, parseWatchConfig, watchSummary, WINDOW_MAX_MS, type WatchedPage } from './page-watch-format.js'

const FRESH_SLACK_MS = 60_000

export type PageWatchDeps = {
  pool: Pool
  hub: Pick<TriggerHub, 'causedBy' | 'background' | 'changed' | 'now'>
  getLiveDoc(docName: string): Y.Doc | undefined
}

/** 认领到的一条盯页面规则（hub.ts 的 SELECT_DUE） */
export type WatchDue = { id: string; owner_id: string; config: unknown; time_zone: string; next_at: Date }

/** 收窗口的结果：hub 照它落一条事件记录（外来的） */
export type WatchFiring = { key: string; actorId: string; depth: number; payload: Omit<EventPayload, 'source'> }

type WindowRow = {
  page_id: string
  opened_at: Date
  last_at: Date
  last_editor: string | null
  editors: string[]
  base: SummaryState
  depth: number
}

/** 文档此刻可摘要的样子：有合集定义的才解析定义（与更新流水同口径） */
function stateOf(doc: Y.Doc): SummaryState {
  return summaryState(doc, extractTitle(doc), doc.getMap('collection').size > 0)
}

// 这一页（活的 doc / 合集页）被哪些启用中的盯页面规则盯着：盯的就是它，或者连子页盯、盯的是它的祖先；主人得看得到这一页
const SELECT_WATCHERS = `WITH RECURSIVE up(id, parent_id, n) AS (
    SELECT id, parent_id, 0 FROM live_pages WHERE id = $1 AND kind IN ('doc', 'collection')
    UNION ALL SELECT p.id, p.parent_id, up.n + 1 FROM live_pages p JOIN up ON p.id = up.parent_id WHERE up.n < 100
  )
  SELECT t.id, t.owner_id, t.config FROM agent_triggers t
  WHERE t.source = 'page_watch' AND t.enabled
    AND (t.config->>'page' = $1 OR (t.config->>'subtree' = 'true' AND t.config->>'page' IN (SELECT id FROM up)))
    AND EXISTS (SELECT 1 FROM up JOIN live_pages p ON p.id = up.id
                WHERE up.n = 0 AND ${pageVisibleSql('p', 't.owner_id')})`
// 编辑者按第一次出现的顺序去重
const UPSERT_WINDOW = `INSERT INTO page_watch_windows (trigger_id, page_id, opened_at, last_at, last_editor, editors, base, depth)
  VALUES ($1, $2, $3, $3, $4, $5::text[], $6::jsonb, $7)
  ON CONFLICT (trigger_id, page_id) DO UPDATE SET last_at = GREATEST(page_watch_windows.last_at, EXCLUDED.last_at),
    last_editor = EXCLUDED.last_editor,
    editors = ARRAY(SELECT e FROM unnest(page_watch_windows.editors || EXCLUDED.editors) WITH ORDINALITY AS x(e, n) GROUP BY e ORDER BY min(n)),
    depth = GREATEST(page_watch_windows.depth, EXCLUDED.depth)
  RETURNING (xmax = 0) AS opened`
const SET_NEXT = `UPDATE agent_triggers t SET next_at = LEAST(w.last + $2 * interval '1 millisecond', w.opened + $3 * interval '1 millisecond')
  FROM (SELECT max(last_at) AS last, min(opened_at) AS opened FROM page_watch_windows WHERE trigger_id = $1) w WHERE t.id = $1`
const TAKE_WINDOWS = `DELETE FROM page_watch_windows WHERE trigger_id = $1
  RETURNING page_id, opened_at, last_at, last_editor, editors, base, depth`
const SELECT_PAGES = `SELECT p.id, p.title, p.deleted_at IS NOT NULL AS trashed, par.kind = 'collection' AS row, p.parent_id, p.created_at::timestamptz AS created_at,
    ${pageVisibleSql('p', '$2')} AS member
  FROM pages p LEFT JOIN pages par ON par.id = p.parent_id WHERE p.id = ANY($1::text[])`

/** 建 / 改配置时：主人得看得到那一页，且是普通页或合集页。不行 = 原因 */
export async function checkWatchPage(pool: Pool, ownerId: string, pageId: string): Promise<string | null> {
  const ok = await pool.query(
    `SELECT 1 FROM live_pages p WHERE p.id = $1 AND p.kind IN ('doc', 'collection') AND ${pageVisibleSql('p', '$2')}`,
    [pageId, ownerId],
  )
  return ok.rowCount ? null : '要盯的那一页不在了，或者你看不到它'
}

export class PageWatch {
  /** 每个活文档上一次存盘（或加载）时的样子 */
  private stored = new WeakMap<Y.Doc, SummaryState>()
  /** 同一页的落库排成一条链 */
  private chains = new Map<string, Promise<void>>()

  /** deps 惰性取：触发器在协同实例之后才建好 */
  constructor(private deps: () => PageWatchDeps) {}

  /** 挂在协同实例上的扩展（index.ts） */
  extension(): Extension {
    return {
      afterLoadDocument: async ({ documentName, document }) => {
        if (!PAGE_DOC_NAME.test(documentName)) return
        try {
          this.stored.set(document, stateOf(document))
        } catch (err) {
          console.error(`[page-watch] 记加载时的样子失败(${documentName}):`, err)
        }
      },
      afterStoreDocument: async ({ documentName, document }) => {
        const pageId = PAGE_DOC_NAME.exec(documentName)?.[1]
        if (!pageId) return
        let base: SummaryState | undefined
        let editors: Map<string, Date>
        let d: PageWatchDeps
        try {
          editors = takeFlushedEditors(document)
          base = this.stored.get(document)
          this.stored.set(document, stateOf(document))
          if (editors.size === 0 || !base) return
          d = this.deps()
        } catch (err) {
          console.error(`[page-watch] 读存盘前后的样子失败(${documentName}):`, err)
          return
        }
        const before = base
        d.hub.background(() => {
          const next = (this.chains.get(pageId) ?? Promise.resolve())
            .then(() => this.edited(d, pageId, before, editors))
            .catch((err: unknown) => console.error(`[page-watch] 攒改动失败(${documentName}):`, err))
          this.chains.set(pageId, next)
          void next.finally(() => {
            if (this.chains.get(pageId) === next) this.chains.delete(pageId)
          })
          return next
        })
      },
    }
  }

  /** 一次存盘里有人动过手：盯着这一页的规则，主人以外有人动手的，开窗口（base = 存盘之前的样子）或往后推 */
  private async edited(d: PageWatchDeps, pageId: string, base: SummaryState, editors: Map<string, Date>): Promise<void> {
    const { rows } = await d.pool.query<{ id: string; owner_id: string; config: unknown }>(SELECT_WATCHERS, [pageId])
    if (rows.length === 0) return
    const depth = d.hub.causedBy(pageId)
    const now = d.hub.now()
    let opened = false
    for (const r of rows) {
      const others = [...editors].filter(([id]) => id !== r.owner_id).sort((a, b) => a[1].getTime() - b[1].getTime())
      const last = others[others.length - 1]
      const config = parseWatchConfig(r.config)
      if (!last || 'error' in config) continue
      await withTransaction(d.pool, async (db) => {
        const rule = (await db.query<{ enabled: boolean; config: unknown }>('SELECT enabled, config FROM agent_triggers WHERE id = $1 FOR UPDATE', [r.id])).rows[0]
        // 查到之后、锁上之前被暂停了或换了盯的页：这次不算（换了配置时窗口已清，不能按旧范围再开）
        if (!rule?.enabled || JSON.stringify(rule.config) !== JSON.stringify(r.config)) return
        const up = await db.query<{ opened: boolean }>(UPSERT_WINDOW, [r.id, pageId, now, last[0], others.map(([id]) => id), JSON.stringify(base), depth])
        if (up.rows[0]?.opened) opened = true
        await db.query(SET_NEXT, [r.id, config.quiet * 60_000, WINDOW_MAX_MS])
      })
    }
    // AI 页上「攒着改动 · 约几点汇报」：新开了窗口才刷新（往后推不刷，别人一直在打字时不至于一直发信号）
    if (opened) d.hub.changed()
  }

  /** 到点：收走窗口、算摘要。在 hub 的认领事务里调（规则行已锁）；读不到、算不出不往外抛（不能拖住同一批里的定时器），
   *  这一阵作废、记日志。读得见的都没变 / 主人都看不到了 = null（不落记录） */
  async close(db: PoolClient, rule: WatchDue, now: Date): Promise<WatchFiring | null> {
    await db.query('SAVEPOINT page_watch')
    try {
      const out = await this.summarize(db, rule)
      await db.query('RELEASE SAVEPOINT page_watch')
      return out
    } catch (err) {
      console.error(`[page-watch] 规则 ${rule.id} 汇报失败（${now.toISOString()}）:`, err)
      await db.query('ROLLBACK TO SAVEPOINT page_watch')
      await clearWatch(db, rule.id)
      return null
    }
  }

  private async summarize(db: PoolClient, rule: WatchDue): Promise<WatchFiring | null> {
    const { pool, getLiveDoc } = this.deps()
    await db.query('UPDATE agent_triggers SET next_at = NULL WHERE id = $1', [rule.id])
    const config = parseWatchConfig(rule.config)
    const windows = (await db.query<WindowRow>(TAKE_WINDOWS, [rule.id])).rows.sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime())
    if ('error' in config || windows.length === 0) return null
    const info = new Map(
      (
        await db.query<{ id: string; title: string; trashed: boolean; row: boolean | null; parent_id: string | null; created_at: Date; member: boolean }>(SELECT_PAGES, [
          [...windows.map((w) => w.page_id), config.page],
          rule.owner_id,
        ])
      ).rows.map((r) => [r.id, r]),
    )
    const kept = windows.filter((w) => info.get(w.page_id)?.member)
    if (kept.length === 0) return null
    const names = new Map(
      (await db.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...new Set(kept.flatMap((w) => w.editors))]])).rows.map(
        (r) => [r.id, r.username],
      ),
    )
    // 这阵改动从哪一刻算起：在它之后（差不到一分钟也算：建页与第一次存盘之间隔着存盘的去抖）建的、改之前还是空的页 = 新页
    const since = Math.min(...kept.map((w) => w.opened_at.getTime())) - FRESH_SLACK_MS
    const schemas = new Map<string, Map<string, string>>()
    const pages: WatchedPage[] = []
    for (const w of kept) {
      const p = info.get(w.page_id)!
      let props = new Map<string, string>()
      if (p.row && p.parent_id) {
        props = schemas.get(p.parent_id) ?? new Map((await readSchema(pool, p.parent_id, getLiveDoc)).props.map((x) => [x.id, x.name]))
        schemas.set(p.parent_id, props)
      }
      const live = getLiveDoc(`page:${w.page_id}`)
      const now = p.trashed ? null : live ? (this.stored.get(live) ?? stateOf(live)) : stateOf(await loadDocForRead(pool, `page:${w.page_id}`))
      const fixed = props
      pages.push({
        title: p.title,
        trashed: p.trashed,
        fresh: p.created_at.getTime() >= since && isBlank(w.base),
        base: w.base,
        now,
        editors: w.editors.map((id) => names.get(id) ?? '已注销用户'),
        propName: (id) => fixed.get(id),
      })
    }
    const summary = watchSummary(pages)
    if (!summary) return null
    const changed = summary.changed.map((i) => kept[i]!)
    const latest = changed.reduce((a, b) => (b.last_at > a.last_at ? b : a))
    const actorId = latest.last_editor ?? latest.editors[latest.editors.length - 1] ?? ''
    if (!actorId) return null
    const root = info.get(config.page)
    const single = changed.length === 1 ? changed[0]!.page_id : null
    const where = single ?? config.page
    const whereTitle = (single ? info.get(single)?.title : root?.title) ?? ''
    const who = [...new Set(changed.flatMap((w) => w.editors))].map((id) => names.get(id) ?? '已注销用户')
    const from = changed.reduce((a, b) => (b.opened_at < a ? b.opened_at : a), changed[0]!.opened_at)
    const to = latest.last_at
    return {
      key: `page_watch:${rule.id}:${rule.next_at.toISOString()}`,
      actorId,
      depth: Math.max(...changed.map((w) => w.depth)),
      payload: {
        actor: { id: actorId, name: names.get(actorId) ?? '已注销用户' },
        page: { id: where, title: whereTitle },
        text: summary.text,
        extra: [
          ['盯着', `《${(root?.member ? root.title : '') || '无标题'}》${config.subtree ? '及子页' : ''}`],
          ['改的人', who.join('、')],
          ['时段', `${shortStamp(from, rule.time_zone, to)}–${shortStamp(to, rule.time_zone, from)}`],
          ['改了几页', String(changed.length)],
          ['链接', `/page/${where}`],
        ],
      },
    }
  }
}
