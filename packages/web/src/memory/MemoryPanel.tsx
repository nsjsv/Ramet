/* ---------- 空间公共记忆（/memory）----------
 * 当前空间的全部记忆：查看、添加、删除，显示条数与合计字数（每一轮都会全部带上，所以提醒精简）。
 * 写入只有两条路：这里手动添加（或输入框里敲 `/记住 内容`），或 agent 提议、你点「记住」。只读成员只能看。
 * 数据只是 GET /api/spaces/:id/memories 的结果：control:global 的 'memories' 信号（不带内容）去抖重拉。 */

import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Space } from '../api'
import { useCachedLoad } from '../cached-load'
import { COPY } from '../copy'
import { subscribeControl } from '../control'
import { Icon } from '../icons'
import { relativeTime } from '../UpdatesFeed'
import { memoryApi, type MemoryList } from './memory-api'

const C = COPY.memory
const REFRESH_DEBOUNCE_MS = 200

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)
/** 字数按码点数（与服务端同口径：emoji 算一个字） */
const countChars = (text: string): number => Array.from(text).length

export default function MemoryPanel({ space }: { space: Space | null }) {
  const navigate = useNavigate()
  const spaceId = space?.id ?? null
  const canWrite = space !== null && space.my_role !== 'viewer'
  // 上次的列表先画（cached-load.ts），挂载 / 换空间时后台重取；换空间时 hook 直接给新空间的缓存，不串
  const loaded = useCachedLoad<MemoryList>(spaceId ? `memory:${spaceId}` : null, () => memoryApi.list(spaceId!))
  const { data, reload } = loaded
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft('')
    setError(null)
  }, [spaceId])
  // 取数失败 / 恢复：与写操作的提示共用一条（成功后清掉）
  useEffect(() => setError(loaded.error ? message(loaded.error, C.loadFailed) : null), [loaded.error])

  // 别人（或 agent 提议被点「记住」）增删了记忆：'memories' 信号；(重)连上的 'sync' 补拉断线期间错过的。去抖合并
  useEffect(() => {
    let timer: number | undefined
    const off = subscribeControl((ev) => {
      if (ev !== 'memories' && ev !== 'sync') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void reload(), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [reload])

  const limits = data?.limits
  const itemMax = limits?.item ?? 2000
  const spaceMax = limits?.space ?? 30000
  const draftChars = countChars(draft.trim())
  const used = data?.chars ?? 0
  const overItem = draftChars > itemMax
  const wouldOverflow = used + draftChars > spaceMax
  const canAdd = canWrite && !busy && draftChars > 0 && !overItem && !wouldOverflow

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!spaceId || !canAdd) return
    setBusy(true)
    setError(null)
    try {
      await memoryApi.add(spaceId, draft)
      setDraft('')
      await reload()
    } catch (err) {
      setError(message(err, C.addFailed))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, text: string) {
    if (!spaceId || !window.confirm(C.confirmRemove(text))) return
    try {
      await memoryApi.remove(spaceId, id)
      await reload()
    } catch (err) {
      setError(message(err, C.removeFailed))
      void reload() // 404 多半是别人先删了：以服务端为准
    }
  }

  const fill = used / spaceMax
  return (
    <div className="memory-page" data-flip>
      <h1 className="memory-title">{C.title}</h1>
      <p className="memory-sub">{space ? C.sub(space.name) : COPY.loading}</p>
      {space && !canWrite && <p className="memory-sub">{C.readOnly}</p>}

      {data && (
        <div className="memory-stats">
          <span>{C.stats(data.items.length, used, spaceMax)}</span>
          <span className={'memory-bar' + (fill >= 1 ? ' is-full' : fill >= 0.7 ? ' is-near' : '')} aria-hidden="true">
            <i style={{ width: `${Math.min(100, Math.round(fill * 100))}%` }} />
          </span>
          <span className="memory-slim">{fill >= 1 ? C.full : fill >= 0.7 ? C.nearFull : C.slim}</span>
        </div>
      )}

      {error && (
        <div className="memory-error" role="alert">
          <span>{error}</span>
          <button className="memory-error-close" title={COPY.failed} onClick={() => setError(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}

      {canWrite && (
        <form className="memory-add" onSubmit={(e) => void submit(e)}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter 添加；输入法组字中的回车不算
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={C.addPlaceholder}
            rows={3}
            spellCheck={false}
          />
          <div className="memory-add-foot">
            <span className={'memory-counter' + (overItem || wouldOverflow ? ' is-over' : '')}>{C.counter(draftChars, itemMax)}</span>
            <button className="memory-btn is-primary" type="submit" disabled={!canAdd}>
              {busy ? C.adding : C.add}
            </button>
          </div>
        </form>
      )}

      {data !== null && data.items.length === 0 && (
        <div className="memory-empty">
          <b>{C.empty}</b>
          <span>{C.emptyHint}</span>
        </div>
      )}
      <ul className="memory-list">
        {data?.items.map((m) => (
          <li key={m.id} className="memory-row">
            <div className="memory-row-main">
              <div className="memory-text">{m.text}</div>
              <div className="memory-meta">
                {C.by(m.created_by_name ?? C.someone)} · {relativeTime(m.created_at)}
                {m.source_page_id && (
                  <>
                    {' · '}
                    <button className="memory-link" type="button" onClick={() => navigate(`/page/${m.source_page_id}`)}>
                      {C.fromPage}
                    </button>
                  </>
                )}
              </div>
            </div>
            {canWrite && (
              <button className="memory-row-del" title={C.remove} aria-label={C.remove} onClick={() => void remove(m.id, m.text)}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
