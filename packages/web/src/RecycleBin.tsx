import { useEffect, useState } from 'react'
import { api, type Page, type Space, type TrashEntry } from './api'
import { useCachedLoad } from './cached-load'
import { COPY } from './copy'
import { ConfirmButton } from './form-kit'
import { Icon } from './icons'
import Modal from './Modal'
import { PageIcon } from './PageIcon'
import { relativeTime } from './UpdatesFeed'
import { pagePath } from './editor/mention-rows'

/** 回收站弹窗：列出当前空间的条目（服务端按可见性给全量，这里按 space_id 过滤，与侧栏树一样）。
 *  条目 = 一次删除搬进来的整棵子树的根：恢复把它连同子孙放回原位，父子关系与标题照旧；
 *  「永久删除 / 清空回收站」是物理删除，页面正文与版本历史一并清掉（唯一允许清历史的用户动作），用行内两步确认。
 *  每行次行：原位置（父页标题链，用侧栏已有的页面树现算；条目的父必是活页面或空间顶层）+ 含几个子页面。 */
export default function RecycleBin({
  space,
  pages,
  onClose,
  onChanged,
}: {
  space: Space
  /** 侧栏的页面树（算原位置路径）；没到就不显示路径 */
  pages: readonly Page[] | null
  onClose: () => void
  /** 恢复 / 永久删除 / 清空成功后刷新侧栏树（服务端同时广播，其它端自动跟） */
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // 上次的列表先画（cached-load.ts），打开时后台重取
  const loaded = useCachedLoad<TrashEntry[]>(`trash:${space.id}`, () =>
    api.listTrash().then((rows) => rows.filter((e) => e.space_id === space.id)),
  )
  const { data: entries, reload: load } = loaded
  useEffect(() => {
    if (!loaded.error) return
    console.error(loaded.error)
    setError('回收站加载失败')
  }, [loaded.error])

  /** 一次写操作：忙态 + 报错 + 成功后重拉列表并刷新侧栏 */
  async function run(action: () => Promise<unknown>, failed: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      void load()
      onChanged()
    } catch (err) {
      console.error(err)
      setError(failed)
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const shown = entries?.filter((e) => !needle || (e.title || '无标题').toLowerCase().includes(needle)) ?? null

  return (
    <Modal onClose={onClose} className="trash-modal" label="回收站">
      <header className="trash-head">
        <span className="trash-head-ic">
          <Icon name="trash" size={18} />
        </span>
        <div className="trash-head-text">
          <h2 className="modal-title">回收站</h2>
          <p className="trash-sub">
            {space.name}
            {entries && entries.length > 0 && ` · ${entries.length} 项`}
          </p>
        </div>
        <button className="modal-close" onClick={onClose} title="关闭">
          <Icon name="x" size={16} />
        </button>
      </header>

      {entries !== null && entries.length > 0 && (
        <label className="trash-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索已删除的页面" aria-label="搜索已删除的页面" />
        </label>
      )}
      {error && <div className="modal-error trash-error">{error}</div>}

      <div className="trash-list">
        {entries === null && !error && <div className="trash-empty">加载中…</div>}
        {entries !== null && entries.length === 0 && (
          <div className="trash-empty">
            <span className="trash-empty-ic">
              <Icon name="trash" size={22} />
            </span>
            <b>回收站是空的</b>
            <span>删除的页面会先放在这里，可以随时恢复到原来的位置。</span>
          </div>
        )}
        {entries !== null && entries.length > 0 && shown?.length === 0 && <div className="trash-empty">没有匹配「{query.trim()}」的页面</div>}
        {shown?.map((entry) => (
          <TrashRow
            key={entry.id}
            entry={entry}
            pages={pages}
            busy={busy}
            onRestore={() => void run(() => api.restorePage(entry.id), '恢复失败')}
            onPurge={() => void run(() => api.deletePage(entry.id), '删除失败')}
          />
        ))}
      </div>

      {entries !== null && entries.length > 0 && (
        <footer className="trash-foot">
          <span>永久删除会一并清除正文和全部版本历史，无法撤销。</span>
          <ConfirmButton
            disabled={busy}
            confirmLabel={`确认清空 ${entries.length} 项`}
            onConfirm={() => void run(() => api.emptyTrash(space.id), '清空失败')}
          >
            清空回收站
          </ConfirmButton>
        </footer>
      )}
    </Modal>
  )
}

/** 原位置：顶层 = 「空间顶层」；父页不在页面树里（树还没到）就不说 */
function originOf(entry: TrashEntry, pages: readonly Page[] | null): string | null {
  if (entry.parent_id === undefined) return null // 旧服务端没有这一列
  if (entry.parent_id === null) return '空间顶层'
  const parent = pages?.find((p) => p.id === entry.parent_id)
  if (!parent || !pages) return null
  const path = pagePath(parent, pages)
  const name = parent.title.trim() || '新页面'
  return path ? `${path} / ${name}` : name
}

function TrashRow({
  entry,
  pages,
  busy,
  onRestore,
  onPurge,
}: {
  entry: TrashEntry
  pages: readonly Page[] | null
  busy: boolean
  onRestore: () => void
  onPurge: () => void
}) {
  const title = entry.title || '无标题'
  const origin = originOf(entry, pages)
  const meta = [
    entry.kind === 'skill' ? 'Skill' : entry.kind === 'collection' ? COPY.collection.label : null,
    origin ? `原位置：${origin}` : null,
    entry.descendants ? `含 ${entry.descendants} 个子页面` : null,
  ].filter(Boolean)
  return (
    <div className="trash-row">
      <span className="trash-ic">
        {entry.kind === 'skill' ? <Icon name="skill" size={18} /> : <PageIcon icon={entry.icon} placeholder />}
      </span>
      <div className="trash-main">
        <span className="trash-title" title={title}>
          {title}
        </span>
        {meta.length > 0 && <span className="trash-meta">{meta.join(' · ')}</span>}
      </div>
      <span className="trash-when">{relativeTime(entry.deleted_at)}</span>
      <div className="trash-acts">
        <button type="button" className="trash-act" disabled={busy} onClick={onRestore} title="恢复到原位置（连同子页面）">
          <Icon name="undo" size={14} />
          恢复
        </button>
        <ConfirmButton
          className="trash-act danger"
          disabled={busy}
          title="永久删除（正文与版本历史一并删除）"
          confirmLabel="确认删除"
          onConfirm={onPurge}
        >
          <Icon name="trash" size={14} />
        </ConfirmButton>
      </div>
    </div>
  )
}
