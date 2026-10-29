// ---------- 「链接视图」的集合选择器：在光标处弹出，筛选本空间的集合，选中即插块 ----------
// 从斜杠菜单（非 React 环境）打开：临时挂一个 React 根，关掉即卸载。弹层复用 popover.tsx。
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { PageIcon } from '../PageIcon'
import { Popover } from './popover'

const C = COPY.collection.embed

type Props = {
  anchor: HTMLElement
  collections: readonly Page[]
  onPick: (page: Page) => void
  onClose: () => void
  /** 标题与空列表的说法：缺省是「链接视图」的（批量「移到…」另给） */
  title?: string
  empty?: string
}

/** 集合选择弹层：React 里直接用（批量操作栏的「移到…」）；斜杠菜单经 openCollectionPicker 临时挂根 */
export function CollectionChooser({ anchor, collections, onPick, onClose, title = C.pick, empty = C.pickEmpty }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const q = query.trim().toLowerCase()
  const shown = collections.filter((p) => !q || (p.title || COPY.untitled).toLowerCase().includes(q))
  useEffect(() => setActive(0), [query])
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div className="cl-picker">
        <div className="pop-section">{title}</div>
        <input
          ref={input}
          className="cl-picker-q"
          value={query}
          placeholder={C.search}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              if (shown.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = shown[active]
              if (hit) onPick(hit)
            }
          }}
        />
        <div className="cl-picker-list">
          {shown.map((page, i) => (
            <button
              key={page.id}
              type="button"
              className={'pop-row cl-picker-row' + (i === active ? ' is-active' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(page)}
            >
              {page.icon ? <PageIcon icon={page.icon} /> : <Icon name="table" size={16} />}
              <span>{page.title || COPY.untitled}</span>
            </button>
          ))}
          {shown.length === 0 && <div className="cl-picker-empty">{collections.length === 0 ? empty : C.pickNone}</div>}
        </div>
      </div>
    </Popover>
  )
}

/** 在屏幕坐标 at 处弹出选择器；选中调 onPick，关掉（外点 / Esc）调 onCancel */
export function openCollectionPicker(o: {
  at: { left: number; top: number; bottom: number }
  collections: readonly Page[]
  onPick: (page: Page) => void
  onCancel: () => void
}): void {
  // 弹层要贴着一个元素定位：在光标处放一个看不见的锚
  const anchor = document.createElement('div')
  anchor.className = 'cl-caret-anchor'
  Object.assign(anchor.style, { position: 'fixed', left: `${o.at.left}px`, top: `${o.at.top}px`, height: `${o.at.bottom - o.at.top}px`, width: '1px' })
  document.body.appendChild(anchor)
  const host = document.createElement('div')
  const root = createRoot(host)
  let done = false
  const close = (picked: Page | null): void => {
    if (done) return
    done = true
    queueMicrotask(() => {
      root.unmount()
      anchor.remove()
    })
    if (picked) o.onPick(picked)
    else o.onCancel()
  }
  root.render(<CollectionChooser anchor={anchor} collections={o.collections} onPick={(p) => close(p)} onClose={() => close(null)} />)
}
