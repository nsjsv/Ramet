import { useEffect, useState } from 'react'
import type { CollectionSchema } from '@ramet/shared/collection-model'
import { api, HISTORY_PAGE, type UpdateEntry, type UpdateSummaryItem } from './api'
import { useCachedLoad } from './cached-load'
import { agentList } from './default-agent'
import { Icon } from './icons'
import { COPY } from './copy'
import { useCollection, useCollectionSchema } from './collection/collection-store'
import { usePeopleTick } from './collection/cells/CellView'
import { orderSummary, propItemText } from './collection/value-text'

/** AI 写的署名：目录里的名字，对不上就写「AI」，不借用当前默认 agent（更新流水与菜单里的「上次编辑」共用） */
export function agentLabel(id: string | null): string {
  const label = id ? agentList().find((a) => a.id === id)?.label?.trim() : ''
  return label || 'AI'
}

/** 这条编辑记录署名谁 */
export function editAuthorName(entry: Pick<UpdateEntry, 'actor' | 'actor_agent' | 'author_username'>, username: string): string {
  if (entry.actor === 'agent') return agentLabel(entry.actor_agent)
  if (entry.author_username === username) return '你'
  return entry.author_username ?? '有人'
}

interface Props {
  pageId: string
  /** 当前登录用户名：条目作者与它相同则显示「你」 */
  username: string
  /** 点条目时钟：跳到历史版本 Tab 并选中该快照；缺省 = 没有历史版本 Tab，不画时钟 */
  onJump?: (snapshotId: string) => void
  /** 集合的行页面：所属集合 id（属性项按它的当前定义显示名字与值；与属性区共用同一条集合连接） */
  collectionId?: string | null
  /** 人员属性的显示名按这个空间的成员取 */
  spaceId?: string | null
}

/** 相对时间：刚刚 / X分钟前 / X小时前 / 今年 M月D日 / 跨年 YYYY年M月D日；解析失败原样展示（各处共用） */
export function relativeTime(raw: string): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}小时前`
  const md = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}年${md}`
}

/** 行属性的显示上下文：当前属性定义（没到 = null）与人员所在空间 */
type PropContext = { schema: CollectionSchema | null; spaceId: string | null }

/** 摘要项一行：del 删除线灰字、edit/add 蓝色高亮、title 前缀 + 新标题；prop / schema 是集合的属性与定义；create 不渲染 */
function SummaryLine({ item, ctx }: { item: UpdateSummaryItem; ctx: PropContext }) {
  if (item.kind === 'prop') return <div className="uf-sum">{propItemText(item, ctx.schema, ctx.spaceId)}</div>
  if (item.kind === 'schema') {
    return <div className="uf-sum">{COPY.collection.history.schema[item.op](item.text || COPY.collection.history.unnamed)}</div>
  }
  const { kind, text } = item
  if (kind === 'del') {
    return (
      <div className="uf-sum">
        已删除 <span className="uf-del-text">{text}</span>
      </div>
    )
  }
  if (kind === 'title') {
    return (
      <div className="uf-sum">
        改了标题 <span className="uf-hl">{text}</span>
      </div>
    )
  }
  // edit / add：蓝色高亮
  return (
    <div className="uf-sum">
      <span className="uf-hl">{text}</span>
    </div>
  )
}

/** 读得见的摘要项（create 不进摘要区，动作行已表达「创建了」） */
function summaryItems(entry: UpdateEntry): UpdateEntry['summary'] {
  return entry.summary.filter((s) => s.kind !== 'create')
}

/** 流水里只列读得见的更新：「创建了」，或至少有一项摘要。只加减了空行、只改了节点属性、改了又撤销留下的
 *  老版本等没有可读摘要的条目不列，它们仍在「历史版本」里，可以查看 / 恢复 */
function isVisibleUpdate(entry: UpdateEntry): boolean {
  return entry.summary[0]?.kind === 'create' || summaryItems(entry).length > 0
}

/** 单条更新：作者行动作 + 相对时间 + 时钟，次行页面标题，再下摘要（默认 4 项，可展开） */
function UpdateItem({
  entry,
  username,
  onJump,
  ctx,
}: {
  entry: UpdateEntry
  username: string
  onJump?: (snapshotId: string) => void
  ctx: PropContext
}) {
  const [expanded, setExpanded] = useState(false)
  const items = orderSummary(summaryItems(entry), ctx.schema)
  const shown = expanded ? items : items.slice(0, 4)
  // 展开后能看到多少项就用多少报数：服务端截 20 时 summary_total 会虚高，按实有项数算
  const rest = Math.max(0, Math.min(entry.summary_total, entry.summary.length) - 4)
  return (
    <div className="uf-entry">
      <div className="uf-entry-top">
        <span className="uf-author">{editAuthorName(entry, username)}</span>
        <span className="uf-action">{entry.summary[0]?.kind === 'create' ? '创建了' : '编辑了'}</span>
        <span className="uf-time">{relativeTime(entry.created_at)}</span>
        {onJump && (
          <button
            type="button"
            className="uf-jump"
            title="在历史版本中查看"
            aria-label="在历史版本中查看"
            onClick={() => onJump(entry.id)}
          >
            <Icon name="clock" size={14} />
          </button>
        )}
      </div>
      <div className="uf-entry-title">{entry.title || '无标题'}</div>
      {shown.length > 0 && (
        <div className="uf-sums">
          {shown.map((s, i) => (
            <SummaryLine key={i} item={s} ctx={ctx} />
          ))}
        </div>
      )}
      {!expanded && rest > 0 && (
        <button type="button" className="uf-more" onClick={() => setExpanded(true)}>
          查看其余 {rest} 项
        </button>
      )}
    </div>
  )
}

/** 更新流水面板：拉 /updates 渲染倒序条目；分页续拉（版本永不删除，历史可以很长）。
 *  第一页按页面 id 缓存（cached-load.ts）：Drawer 切回本 Tab 重挂载时先画上次的、后台重拉；续拉的更早几页不缓存 */
export default function UpdatesFeed({ pageId, username, onJump, collectionId = null, spaceId = null }: Props) {
  // 行页面：当前属性定义（store 按集合引用计数，与属性区同一条连接）；人员名单到了重画
  const schema = useCollectionSchema(useCollection(collectionId))
  usePeopleTick()
  const ctx: PropContext = { schema, spaceId }
  const first = useCachedLoad<UpdateEntry[]>(`updates:${pageId}`, () => api.listUpdates(pageId, { limit: HISTORY_PAGE }))
  /** 续拉到的更早几页（不缓存）；页面换了就清掉 */
  const [older, setOlder] = useState<{ pageId: string; rows: UpdateEntry[]; full: boolean } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const extra = older?.pageId === pageId ? older : null
  // 第一页重拉后可能与续拉的那几页有重叠（期间又有了新版本）：按 id 去重
  const entries = first.data
    ? extra
      ? first.data.concat(extra.rows.filter((r) => !first.data!.some((f) => f.id === r.id)))
      : first.data
    : null
  /** 上一页整页返回 = 还有更早的（服务端窗口有上限，一页最多 HISTORY_PAGE 条） */
  const hasMore = extra ? extra.full : first.data?.length === HISTORY_PAGE

  useEffect(() => setError(null), [pageId])
  useEffect(() => {
    if (first.error) setError(first.error instanceof Error ? first.error.message : String(first.error))
  }, [first.error])

  // 续拉更早一页：游标 = 已加载里最旧一条的 created_at（含不列出的条目；服务端按窗口回放，摘要仍带基线）
  async function loadMore() {
    if (!entries || entries.length === 0) return
    setLoadingMore(true)
    try {
      const rows = await api.listUpdates(pageId, {
        limit: HISTORY_PAGE,
        before: entries[entries.length - 1]!.created_at,
      })
      setOlder({ pageId, rows: [...(extra?.rows ?? []), ...rows], full: rows.length === HISTORY_PAGE })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
    }
  }

  // 分页 / 游标按服务端原始条目算（hasMore 看整页是否返回满），只在渲染时滤掉没有可读摘要的
  const visible = entries?.filter(isVisibleUpdate) ?? null
  return (
    <div className="uf-feed">
      {error && <div className="vh-error">{error}</div>}
      {entries === null && !error && <div className="vh-empty">加载中…</div>}
      {visible?.length === 0 && !hasMore && <div className="vh-empty">还没有动态，编辑页面会自动生成</div>}
      {visible?.map((entry) => (
        <UpdateItem key={entry.id} entry={entry} username={username} onJump={onJump} ctx={ctx} />
      ))}
      {hasMore && (
        <button type="button" className="vh-more" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}
