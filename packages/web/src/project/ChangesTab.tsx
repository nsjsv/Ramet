import { useEffect, useMemo, useRef, useState } from 'react'
import { COPY } from '../copy'
import { useAgents } from '../default-agent'
import { Icon } from '../icons'
import { diffStat, parseDiff } from './diff-parse'
import { splitPath } from './file-tree'
import { authorLabel, errMessage, QUICK_AUTHOR } from './labels'
import { projectApi, type ChangedFile, type DiffResult, type StatusResult } from './project-api'

const C = COPY.project.changes

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: T }

const markClass = (m: ChangedFile['mark']): string => (m === 'A' || m === '?' ? 'is-add' : m === 'D' ? 'is-del' : m === 'U' ? 'is-conflict' : 'is-mod')

/* ---------- 改动分页：工作区未提交的改动（只预览）----------
 * 列表来自 git status（暂存 + 未暂存 + 未跟踪），点一行看这个文件的 diff。只读：这里没有暂存 / 撤销 / 提交 / 推送。
 * 标明是谁改的：本页各轮 run 记录里 agent 改过的文件标 agent 的名字（服务端算好的 by），其余标「你」。
 * 分页不可见时不请求；打开分页、点刷新、本页一轮结束（刷新信号）才拉。 */
export default function ChangesTab({
  pageId,
  agent,
  active,
  enabled,
  tick,
  diffPath,
  onDiff,
  onOpenFile,
  onStatus,
}: {
  pageId: string
  agent: string
  active: boolean
  enabled: boolean
  tick: number
  diffPath: string | null
  onDiff: (path: string | null) => void
  /** 在「文件」分页里打开它 */
  onOpenFile: (path: string) => void
  /** 状态拉到后把分支信息交给面板头 */
  onStatus: (status: StatusResult) => void
}) {
  const { agents } = useAgents()
  const [state, setState] = useState<Loaded<StatusResult>>({ status: 'loading' })
  const loadedTick = useRef(-1)

  useEffect(() => {
    if (!active || !enabled || loadedTick.current === tick) return
    loadedTick.current = tick
    let cancelled = false
    projectApi.status(pageId, agent).then(
      (data) => {
        if (cancelled) return
        setState({ status: 'ok', data })
        onStatus(data)
      },
      (err: unknown) => !cancelled && setState({ status: 'error', message: errMessage(err) }),
    )
    return () => {
      cancelled = true
    }
    // onStatus 只是把结果交上去，不该成为重拉的理由
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, agent, active, enabled, tick])

  if (state.status === 'loading') return <p className="project-note">{COPY.loading}</p>
  if (state.status === 'error') return <p className="project-note is-error">{COPY.project.loadFailed(state.message)}</p>
  const status = state.data
  const label = (f: ChangedFile): string => authorLabel(f.by, agents, C.you, C.youQuick)

  if (diffPath !== null) {
    const file = status.files.find((f) => f.path === diffPath)
    return (
      <DiffView
        pageId={pageId}
        agent={agent}
        path={diffPath}
        file={file}
        by={file ? label(file) : C.you}
        active={active}
        tick={tick}
        onBack={() => onDiff(null)}
        onOpenFile={onOpenFile}
      />
    )
  }

  if (!status.repo) return <p className="project-note">{COPY.project.notRepo}</p>
  if (status.files.length === 0) return <p className="project-note">{C.none}</p>
  const files = [...status.files].sort((a, b) => a.path.localeCompare(b.path))
  return (
    <div className="project-changes">
      <p className="project-changes-head">{C.count(files.length)}</p>
      <ul className="project-change-list">
        {files.map((f) => {
          const { dir, name } = splitPath(f.path)
          return (
            <li key={f.path}>
              <button type="button" className="project-change-row" onClick={() => onDiff(f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path}>
                <span className={`project-mark ${markClass(f.mark)}`} title={C.mark[f.mark]}>
                  {f.mark}
                </span>
                <span className="project-change-path">
                  <span className="project-change-dir">{dir}</span>
                  <span className="project-change-name">{name}</span>
                </span>
                {f.staged && <span className="project-staged">{C.staged}</span>}
                <span className={'project-by' + (f.by === QUICK_AUTHOR ? ' is-quick' : f.by ? ' is-agent' : '')}>{label(f)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {status.truncated && <p className="project-note is-warn">{C.truncated}</p>}
      <p className="project-fineprint">{C.agentNote}</p>
    </div>
  )
}

function DiffView({
  pageId,
  agent,
  path,
  file,
  by,
  active,
  tick,
  onBack,
  onOpenFile,
}: {
  pageId: string
  agent: string
  path: string
  file: ChangedFile | undefined
  by: string
  active: boolean
  tick: number
  onBack: () => void
  onOpenFile: (path: string) => void
}) {
  const [state, setState] = useState<Loaded<DiffResult>>({ status: 'loading' })
  const loaded = useRef('')

  useEffect(() => {
    const key = `${path}|${tick}`
    if (!active || loaded.current === key) return
    loaded.current = key
    let cancelled = false
    let finished = false
    projectApi.diff(pageId, agent, path).then(
      (data) => {
        finished = true
        if (!cancelled) setState({ status: 'ok', data })
      },
      (err: unknown) => {
        finished = true
        if (!cancelled) setState({ status: 'error', message: errMessage(err) })
      },
    )
    return () => {
      cancelled = true
      if (!finished) loaded.current = ''
    }
  }, [pageId, agent, path, active, tick])

  const diffText = state.status === 'ok' ? state.data.diff : ''
  const lines = useMemo(() => parseDiff(diffText), [diffText])
  const stat = useMemo(() => diffStat(lines), [lines])
  return (
    <div className="project-viewer">
      <div className="project-viewer-head">
        <button type="button" className="project-icon-btn" onClick={onBack} title={C.back} aria-label={C.back}>
          <Icon name="chevron" className="project-back-ico" />
        </button>
        <span className="project-viewer-path" title={path}>
          {path}
        </span>
        <span className={'project-by' + (by === C.youQuick ? ' is-quick' : by !== C.you ? ' is-agent' : '')}>{by}</span>
        {file?.mark !== 'D' && (
          <button type="button" className="project-chip-btn" onClick={() => onOpenFile(path)}>
            {C.openFile}
          </button>
        )}
      </div>
      {state.status === 'loading' && <p className="project-note">{COPY.loading}</p>}
      {state.status === 'error' && <p className="project-note is-error">{COPY.project.loadFailed(state.message)}</p>}
      {state.status === 'ok' && (
        <>
          {lines.length > 0 && (
            <p className="project-diff-stat">
              <span className="is-add">+{stat.add}</span> <span className="is-del">−{stat.del}</span>
            </p>
          )}
          {state.data.truncated && <p className="project-note is-warn">{C.diffTruncated}</p>}
          {lines.length === 0 ? (
            state.data.diff.trim() ? (
              <pre className="project-raw">{state.data.diff}</pre>
            ) : (
              <p className="project-note">{C.noDiff}</p>
            )
          ) : (
            <div className="project-diff" tabIndex={0}>
              {lines.map((l, i) =>
                l.kind === 'hunk' ? (
                  <div key={i} className="project-diff-hunk">
                    <span className="project-diff-no" />
                    <span className="project-diff-no" />
                    <span className="project-diff-text">{l.text || '⋯'}</span>
                  </div>
                ) : l.kind === 'note' ? (
                  <div key={i} className="project-diff-note">
                    {l.text}
                  </div>
                ) : (
                  <div key={i} className={`project-diff-line is-${l.kind}`}>
                    <span className="project-diff-no">{l.old ?? ''}</span>
                    <span className="project-diff-no">{l.new ?? ''}</span>
                    <span className="project-diff-text">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}{l.text}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
