import { useEffect, useRef, useState } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import PreviewRow from './PreviewRow'
import { usePagePreviews } from './preview-state'
import { useProjectTarget } from './project-state'

const C = COPY.project.preview

/** 顶栏上的「预览」：本页有共享中的预览、而我没有 machine 授权（项目面板里没有预览分页）时出现。
 *  点开列出本页共享的预览，点哪个就在新标签里打开（走一次性票据，预览在独立的预览源里）。
 *  有 machine 授权的人用项目面板里的预览分页，这里不重复出现，也就不发这次请求。 */
export default function PreviewToggle({ pageId }: { pageId: string | undefined }) {
  const target = useProjectTarget(pageId)
  const { data } = usePagePreviews(pageId, target === null)
  const [open, setOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  // 换页收起；外点 / Esc 收起
  useEffect(() => {
    setOpen(false)
    setProblem(null)
  }, [pageId])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!pageId || target !== null || !data || !data.enabled || data.previews.length === 0) return null
  return (
    <div className="preview-toggle" ref={root}>
      <button
        type="button"
        className="topbar-btn"
        title={C.toggle}
        aria-label={C.toggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="globe" />
      </button>
      {open && (
        <div className="preview-pop" role="dialog" aria-label={C.listTitle}>
          <h4 className="project-round-title">{C.listTitle}</h4>
          <ul className="preview-list">
            {data.previews.map((p) => (
              <PreviewRow key={p.id} item={p} pageId={pageId} onError={setProblem} />
            ))}
          </ul>
          {problem && <p className="project-note is-error">{problem}</p>}
          <p className="project-fineprint">{C.sameBrowser}</p>
        </div>
      )}
    </div>
  )
}
