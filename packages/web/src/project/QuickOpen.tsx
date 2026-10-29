import { useEffect, useMemo, useRef, useState } from 'react'
import { COPY } from '../copy'
import { fuzzyFilter } from './fuzzy'
import { errMessage } from './labels'
import { projectApi, type FilesResult } from './project-api'
import { splitPath } from './file-tree'

const C = COPY.project.quick

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: FilesResult }

/* ---------- ⌘P 找文件：模糊匹配工作区的文件清单 ----------
 * 清单在打开时拉一次（git 仓库 = 已跟踪 + 未跟踪但没被忽略的；非 git 目录 = 有上限的遍历，跳过 node_modules 等），
 * 过滤全在浏览器里做，打字不产生请求。↑↓ 选，↵ 打开，Esc 关。 */
export default function QuickOpen({
  pageId,
  agent,
  onPick,
  onClose,
}: {
  pageId: string
  agent: string
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [state, setState] = useState<Loaded>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let cancelled = false
    projectApi.files(pageId, agent).then(
      (data) => !cancelled && setState({ status: 'ok', data }),
      (err: unknown) => !cancelled && setState({ status: 'error', message: errMessage(err) }),
    )
    return () => {
      cancelled = true
    }
  }, [pageId, agent])

  const hits = useMemo(() => (state.status === 'ok' ? fuzzyFilter(state.data.files, query, 50) : []), [state, query])
  useEffect(() => setAt(0), [query])
  useEffect(() => {
    listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  return (
    <div className="project-quick" role="dialog" aria-label={C.title}>
      <input
        className="project-quick-input"
        autoFocus
        value={query}
        placeholder={C.placeholder}
        aria-label={C.title}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setAt((i) => Math.min(hits.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setAt((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const hit = hits[at]
            if (hit) onPick(hit.path)
          }
        }}
      />
      {state.status === 'loading' && <p className="project-note">{C.loading}</p>}
      {state.status === 'error' && <p className="project-note is-error">{`${C.failed}：${state.message}`}</p>}
      {state.status === 'ok' && (
        <>
          {hits.length === 0 ? (
            <p className="project-note">{C.none}</p>
          ) : (
            <ul className="project-quick-list" ref={listRef} role="listbox">
              {hits.map((hit, i) => {
                const { dir, name } = splitPath(hit.path)
                return (
                  <li key={hit.path} role="option" aria-selected={i === at}>
                    <button type="button" className={'project-quick-row' + (i === at ? ' is-on' : '')} onMouseMove={() => setAt(i)} onClick={() => onPick(hit.path)}>
                      <span className="project-quick-name">{name}</span>
                      <span className="project-quick-dir">{dir}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {state.data.truncated && <p className="project-fineprint">{C.truncated}</p>}
        </>
      )}
    </div>
  )
}
