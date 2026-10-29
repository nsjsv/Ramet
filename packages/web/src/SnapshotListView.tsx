// 历史版本列表（时间 / 标题 / 自动|手动徽标 + 加载更多），文档页与集合页的历史面板共用
import type { PageSnapshot } from './api'
import type { SnapshotList } from './snapshot-list'

/** created_at 是 now()::text；解析失败原样展示 */
function formatTime(raw: string): string {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

type Props = {
  list: SnapshotList
  selectedId: string | null
  onPick: (meta: PageSnapshot, prev?: PageSnapshot) => void
}

export default function SnapshotListView({ list, selectedId, onPick }: Props) {
  const { snapshots, tail, prevOf } = list
  return (
    <div className="vh-list">
      {snapshots === null && <div className="vh-empty">加载中…</div>}
      {snapshots?.length === 0 && <div className="vh-empty">还没有版本，编辑页面会自动生成</div>}
      {snapshots?.map((s, i) => (
        <button
          type="button"
          key={s.id}
          className={`vh-item${s.id === selectedId ? ' active' : ''}`}
          onClick={() => onPick(s, prevOf(i))}
        >
          <span className="vh-item-title">{s.title || '无标题'}</span>
          <span className="vh-item-meta">
            <span className={`vh-badge${s.origin === 'manual' ? ' manual' : ''}`}>
              {s.origin === 'manual' ? '手动' : '自动'}
            </span>
            <span className="vh-time">{formatTime(s.created_at)}</span>
          </span>
        </button>
      ))}
      {/* 版本永不删除：再久的历史也在这里，按页往上翻 */}
      {tail && (
        <button type="button" className="vh-more" onClick={() => void list.loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}
