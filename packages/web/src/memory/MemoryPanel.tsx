/* ---------- 记忆：个人记忆（Genet 页的记忆分页 /ai/memory）与空间记忆（空间 AI 页的记忆分页 /spaces/:id/ai/memory）----------
 * 同一个列表组件（MemorySection）：PersonalMemory =「你的个人记忆」（只有你看得到、只给 Genet，GET /api/me/memories），
 * SpaceMemory = 一个空间的公共记忆（这个空间里所有 agent 共享，GET /api/spaces/:id/memories）。都是查看、添加、删除，显示条数与合计字数（会全部带上，所以提醒精简）。
 * 写入只有两条路：这里手动添加（或输入框里敲 `/记住 内容`：Genet 页上进个人记忆，别的页进那个空间），或 agent 提议、你点「记住」。只读成员只能看空间记忆。
 * control:global 的 'memories' 信号（不带内容）去抖重拉。 */

import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Space } from '../api'
import { useCachedLoad } from '../cached-load'
import { COPY } from '../copy'
import { subscribeControl } from '../control'
import { Icon } from '../icons'
import { relativeTime } from '../UpdatesFeed'
import { memoryApi, personalMemoryApi, type MemoryList } from './memory-api'
import { confirmDialog } from '../ui/dialog'

const C = COPY.memory
const REFRESH_DEBOUNCE_MS = 200

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)
/** 字数按码点数（与服务端同口径：emoji 算一个字） */
const countChars = (text: string): number => Array.from(text).length

/** 一节记忆的数据源：个人的、某个空间的 */
type MemorySource = {
  /** 缓存键（null = 还不知道是哪个空间） */
  key: string | null
  title: string
  sub: string
  canWrite: boolean
  /** 只读时的说明 */
  readOnly?: string
  /** 列出谁记的（个人记忆都是自己记的，不列） */
  showAuthor: boolean
  list: () => Promise<MemoryList>
  add: (text: string) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
}

/** 个人记忆（Genet 页的「记忆」分页） */
export function PersonalMemory() {
  const personal: MemorySource = {
    key: 'memory:me',
    title: C.personal.title,
    sub: C.personal.sub,
    canWrite: true,
    showAuthor: false,
    list: personalMemoryApi.list,
    add: personalMemoryApi.add,
    remove: personalMemoryApi.remove,
  }
  return (
    <div className="memory-page" data-flip>
      <MemorySection source={personal} />
    </div>
  )
}

/** 一个空间的公共记忆（空间 AI 页的「记忆」分页） */
export function SpaceMemory({ space }: { space: Space | null }) {
  const spaceId = space?.id ?? null
  const shared: MemorySource = {
    key: spaceId ? `memory:${spaceId}` : null,
    title: space ? C.spaceTitle(space.name) : C.loading,
    sub: space ? C.sub(space.name) : '',
    canWrite: space !== null && space.my_role !== 'viewer',
    readOnly: C.readOnly,
    showAuthor: true,
    list: () => memoryApi.list(spaceId!),
    add: (text) => memoryApi.add(spaceId!, text),
    remove: (id) => memoryApi.remove(spaceId!, id),
  }
  return (
    <div className="memory-page" data-flip>
      <MemorySection source={shared} />
    </div>
  )
}

function MemorySection({ source }: { source: MemorySource }) {
  const navigate = useNavigate()
  const { key, canWrite } = source
  // 上次的列表先画（cached-load.ts），挂载 / 换空间时后台重取；换空间时 hook 直接给新空间的缓存，不串
  const loaded = useCachedLoad<MemoryList>(key, source.list)
  const { data, reload } = loaded
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft('')
    setError(null)
  }, [key])
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
    if (!key || !canAdd) return
    setBusy(true)
    setError(null)
    try {
      await source.add(draft)
      setDraft('')
      await reload()
    } catch (err) {
      setError(message(err, C.addFailed))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string, text: string) {
    if (!key || !(await confirmDialog({ message: C.confirmRemove(text), danger: true }))) return
    try {
      await source.remove(id)
      await reload()
    } catch (err) {
      setError(message(err, C.removeFailed))
      void reload() // 404 多半是别人先删了：以服务端为准
    }
  }

  const fill = used / spaceMax
  return (
    <section className="memory-section">
      <h3 className="memory-section-title">{source.title}</h3>
      <p className="memory-sub">{key ? source.sub : COPY.loading}</p>
      {key && !canWrite && source.readOnly && <p className="memory-sub">{source.readOnly}</p>}

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
          <button className="memory-error-close" data-tip={COPY.failed} aria-label={COPY.failed} onClick={() => setError(null)}>
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
                {source.showAuthor && `${C.by(m.created_by_name ?? C.someone)} · `}
                {relativeTime(m.created_at)}
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
              <button className="memory-row-del" data-tip={C.remove} aria-label={C.remove} onClick={() => void remove(m.id, m.text)}>
                <Icon name="trash" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
