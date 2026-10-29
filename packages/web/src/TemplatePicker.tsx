import { useState } from 'react'
import { api, type Page } from './api'
import { Icon } from './icons'
import Modal from './Modal'
import { PageIcon } from './PageIcon'
import { builtinTemplates } from './templates-builtin'

/* ---------- 从模板新建 ----------
 * 两组：本空间的模板（页面 ⋮「设为模板」的那些，is_template）与内置模板（templates-builtin.ts）。
 * 空间模板 = 复制整页（连子页，server routes/import.ts 的 instantiate）；内置模板 = 一份 markdown 走导入端点建页。
 * 落在空间顶层或当前页下面。建好跳到新页。
 *
 * 入口暂时隐藏：侧栏「导入」「从模板新建」与顶栏 ⋮「设为模板」都已撤掉，
 * 本组件、服务端接口（routes/import.ts）与 api 函数保留，重新上线时只需把入口接回 Sidebar / TopBar。 */

export default function TemplatePicker({
  spaceId,
  pages,
  currentPage,
  onClose,
  onDone,
}: {
  spaceId: string
  pages: Page[] | null
  currentPage: Page | null
  onClose: () => void
  onDone: (pageId: string | null) => void
}) {
  const [underCurrent, setUnderCurrent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const templates = (pages ?? []).filter((p) => p.is_template && p.space_id === spaceId && p.kind === 'doc')
  const parentId = underCurrent && currentPage ? currentPage.id : null

  async function create(key: string, make: () => Promise<string | null>): Promise<void> {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      const id = await make()
      onDone(id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal onClose={onClose} className="create-modal" label="从模板新建">
      <header className="create-head">
        <span className="create-head-ic">
          <Icon name="plus" size={18} />
        </span>
        <div className="create-head-text">
          <h2 className="modal-title">从模板新建</h2>
          <p className="create-sub">页面 ⋮ 菜单里「设为模板」的页面会出现在这里</p>
        </div>
        <button className="modal-close" onClick={onClose} title="关闭">
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="template-section">本空间的模板</div>
      {templates.length === 0 ? (
        <div className="template-empty">还没有。打开一个页面，在 ⋮ 菜单里选「设为模板」。</div>
      ) : (
        <div className="template-list">
          {templates.map((t) => (
            <button key={t.id} className="template-row" disabled={busy !== null} onClick={() => void create(t.id, async () => (await api.instantiateTemplate(t.id, spaceId, parentId)).id)}>
              <PageIcon icon={t.icon} size="sm" placeholder />
              <span className="template-title">{t.title || '无标题'}</span>
              {busy === t.id && <span className="template-busy">正在新建…</span>}
            </button>
          ))}
        </div>
      )}

      <div className="template-section">内置模板</div>
      <div className="template-list">
        {builtinTemplates().map((t) => (
          <button
            key={t.id}
            className="template-row"
            disabled={busy !== null}
            onClick={() =>
              void create(t.id, async () => {
                const file = new Blob([t.markdown], { type: 'text/markdown' })
                const result = await api.importMarkdown(spaceId, file, `${t.title}.md`, parentId)
                return result.roots[0] ?? null
              })
            }
          >
            <Icon name="file" size={16} />
            <span className="template-title">{t.title}</span>
            <span className="template-desc">{busy === t.id ? '正在新建…' : t.desc}</span>
          </button>
        ))}
      </div>

      {currentPage && (
        <label className="create-where">
          <input type="checkbox" checked={underCurrent} onChange={(e) => setUnderCurrent(e.target.checked)} />
          放在「{currentPage.title || '无标题'}」下面（不勾 = 空间顶层）
        </label>
      )}
      {error && <div className="modal-error">{error}</div>}
    </Modal>
  )
}
