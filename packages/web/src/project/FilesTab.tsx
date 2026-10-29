import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import FileViewer from './FileViewer'
import { flattenTree, loadedDirs, sizeLabel, type DirState, type TreeRow } from './file-tree'
import { errMessage } from './labels'
import { projectApi, type GitMark, type TreeEntry } from './project-api'

const C = COPY.project.files

/** 改动标记的配色类（颜色在 project.css；标记字母本身也显示，不只靠颜色） */
const markClass = (m: GitMark): string => (m === 'A' || m === '?' ? 'is-add' : m === 'D' ? 'is-del' : m === 'U' ? 'is-conflict' : 'is-mod')

/* ---------- 文件分页：懒加载的文件树 + 查看器（只读；选中几行 ⌘J 随手 AI 改写除外）----------
 * 树按目录懒加载：打开分页拉根目录，点开哪个目录才拉哪个；刷新信号（点刷新 / 本页一轮结束）来了才重拉
 * 根目录和已展开的目录（旧内容先留着，新内容到了再换，不闪）。分页不可见时不请求、不轮询。
 * 点文件进查看器（同一个分页里换一屏，带返回），文件路径由父面板持有（⌘P 找文件也要打开它）。 */
export default function FilesTab({
  pageId,
  agent,
  active,
  enabled,
  tick,
  openPath,
  onOpen,
  canWrite,
  onWritten,
}: {
  pageId: string
  agent: string
  active: boolean
  /** 机器在线且 connector 够新：不满足时不发请求 */
  enabled: boolean
  tick: number
  openPath: string | null
  onOpen: (path: string | null) => void
  /** 页面可写：查看器里的 ⌘J 才能把改写写回文件 */
  canWrite: boolean
  /** 随手 AI 写了文件：改动分页刷新 */
  onWritten: () => void
}) {
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const loadedTick = useRef(-1)
  const listRef = useRef<HTMLDivElement>(null)

  const fetchDir = useCallback(
    (dir: string) => {
      projectApi.tree(pageId, agent, dir).then(
        (r) => setDirs((m) => new Map(m).set(dir, { status: 'ok', entries: r.entries, truncated: r.truncated })),
        (err: unknown) => setDirs((m) => new Map(m).set(dir, { status: 'error', entries: [], truncated: false, error: errMessage(err) })),
      )
    },
    [pageId, agent],
  )

  // 打开分页时、刷新信号变了时拉根目录 + 已展开的目录；其余时候（分页被切走、机器不可用）一个请求都不发
  useEffect(() => {
    if (!active || !enabled || loadedTick.current === tick) return
    loadedTick.current = tick
    for (const dir of loadedDirs(expandedRef.current)) fetchDir(dir)
  }, [active, enabled, tick, fetchDir])

  function toggle(path: string): void {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (dirs.get(path)?.status !== 'ok') fetchDir(path) // 没拉过 / 上次失败：现在拉
    }
    setExpanded(next)
  }

  /** 方向键在树里移动：↑↓ 换行，→ 展开，← 收起 */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && at >= 0) {
      const row = rows[at]!
      const isOpen = row.getAttribute('aria-expanded')
      if (isOpen === null) return
      if ((e.key === 'ArrowRight') !== (isOpen === 'true')) {
        e.preventDefault()
        row.click()
      }
    }
  }

  if (openPath !== null) {
    return (
      <FileViewer
        key={openPath}
        pageId={pageId}
        agent={agent}
        path={openPath}
        active={active}
        tick={tick}
        canWrite={canWrite}
        onWritten={onWritten}
        onBack={() => onOpen(null)}
      />
    )
  }

  const rows = flattenTree(dirs, expanded)
  return (
    <div className="project-tree" ref={listRef} role="tree" aria-label={C.tree} onKeyDown={onKeyDown}>
      {rows.map((row) =>
        row.kind === 'entry' ? (
          <EntryRow key={row.path} row={row} onToggle={toggle} onOpen={onOpen} />
        ) : (
          <p key={`${row.path}|${typeof row.text === 'string' ? row.text : 'error'}`} className={'project-tree-note' + (typeof row.text === 'object' ? ' is-error' : '')} style={{ paddingLeft: 12 + row.depth * 14 }}>
            {noteText(row)}
          </p>
        ),
      )}
    </div>
  )
}

function noteText(row: Extract<TreeRow, { kind: 'note' }>): string {
  if (typeof row.text === 'object') return COPY.project.loadFailed(row.text.error)
  if (row.text === 'loading') return COPY.loading
  if (row.text === 'empty') return C.empty
  return C.truncated
}

function EntryRow({
  row,
  onToggle,
  onOpen,
}: {
  row: Extract<TreeRow, { kind: 'entry' }>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const { entry, path, depth, open } = row
  return (
    <button
      type="button"
      role="treeitem"
      data-row
      aria-expanded={entry.type === 'dir' ? open : undefined}
      disabled={entry.type === 'link'}
      title={entry.type === 'link' ? C.linkOut : entry.size !== undefined ? `${path} · ${sizeLabel(entry.size)}` : path}
      className={'project-tree-row' + (entry.git ? ` ${markClass(entry.git)}` : '')}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => (entry.type === 'dir' ? onToggle(path) : onOpen(path))}
    >
      <span className="project-tree-chev">{entry.type === 'dir' && <Icon name="chevron" size={12} className={open ? 'project-chev is-open' : 'project-chev'} />}</span>
      <Icon name={entry.type === 'dir' ? 'folder' : 'file'} size={14} className="project-tree-ico" />
      <span className="project-tree-name">{entry.name}</span>
      <EntryTail entry={entry} />
    </button>
  )
}

function EntryTail({ entry }: { entry: TreeEntry }) {
  if (entry.git) return <span className="project-mark">{entry.git}</span>
  return null
}
