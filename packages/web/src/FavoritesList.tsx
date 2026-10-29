/* ---------- 侧栏收藏列表 ----------
 * 私人书签（页面或块），只列当前空间的（收藏跟着所在页的空间走），只有自己可见，没有收藏时整栏不渲染。
 * 块的文字是服务端现读的当前内容；原块 / 原页看不到了就显示存档并标「原块已删」
 * （不区分是删了、进回收站还是被移出空间）。点一行跳到页面（有块则定位到块），悬停出现取消收藏。
 * 分区头与行的视觉复用页面树 / 目录树（sidebar.css 的 .dir-board-* / .tree-item），结构照 Boards.tsx 的分区头和 PageTree.tsx 的树行。 */

import { useState } from 'react'
import type { FavoriteView, Page } from './api'
import { COPY } from './copy'
import { toggleFavorite, useFavorites } from './favorites-store'
import { Icon, type IconName } from './icons'
import { PageIcon } from './PageIcon'

const OPEN_KEY = 'ramet.favorites.open'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

/** 块的小图标：按块类型给个意会的形状 */
function blockIcon(type: string): IconName {
  return type === 'agent_reply' ? 'say' : type === 'run_step' ? 'step' : type === 'user_message' ? 'quote' : 'read'
}

function Row({ fav, page, onNavigate }: { fav: FavoriteView; page: Page | undefined; onNavigate: (to: string) => void }) {
  const isPage = fav.blockId === null
  // 能进的页面：列表里有它（回收站里的 / 没权限的不在列表里）。原块没了但页面还在，照样能进页面
  const target = page ? `/page/${fav.pageId}${fav.blockId && !fav.gone ? `?block=${fav.blockId}` : ''}` : null
  const primary = isPage ? fav.title || COPY.untitled : fav.text || COPY.untitled
  // 单行放不下所在页标题：块收藏把它放进悬停提示
  const hint = isPage || !fav.title ? primary : `${primary}\n${fav.title}`
  return (
    <div className={'tree-item' + (fav.gone ? ' is-gone' : '')}>
      <span className="tree-twisty">
        {isPage ? (
          <PageIcon icon={page?.icon ?? null} placeholder />
        ) : (
          <Icon name={blockIcon(fav.blockType)} size={18} className="dir-glyph" />
        )}
      </span>
      <button type="button" className="tree-label" disabled={!target} title={hint} onClick={() => target && onNavigate(target)}>
        {primary}
      </button>
      {fav.gone && <em className="fav-gone">{isPage ? COPY.fav.gonePage : COPY.fav.goneBlock}</em>}
      <span className="tree-actions">
        <button
          type="button"
          className="icon-btn danger"
          title={COPY.fav.remove}
          aria-label={COPY.fav.remove}
          onClick={() => void toggleFavorite(fav.pageId, fav.blockId ?? '')}
        >
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  )
}

export default function FavoritesList({
  pages,
  spaceId,
  onNavigate,
}: {
  pages: Page[] | null
  /** 当前选中的空间：只列这个空间的收藏 */
  spaceId: string | null
  onNavigate: (to: string) => void
}) {
  const { list } = useFavorites()
  const [open, setOpen] = useState(readOpen)
  // 本次挂载里开合过：展开时内容淡入上浮（同 Boards 的 .is-toggled）；首屏不播
  const [toggled, setToggled] = useState(false)
  // 只列当前空间的；占位（刚点收藏、服务端还没回，spaceId 未知）不进列表
  const shown = list.filter((f) => !f.id.startsWith('pending:') && f.spaceId === spaceId)
  // 没有收藏就整栏不显示（还没加载完也一样）。隐藏条件只看内容、不掺折叠态：有收藏时标题行恒在，
  // 折叠只收起内容，否则折叠态存在 localStorage 里，整块卸载会让人再也展开不了
  if (shown.length === 0) return null
  const toggle = (): void => {
    setOpen(!open)
    setToggled(true)
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1')
    } catch {
      /* 记不住展开状态不碍事 */
    }
  }
  return (
    <section className="fav-board">
      <div className="dir-board-header" onClick={toggle}>
        <span className="dir-board-name" title={COPY.fav.section}>
          {COPY.fav.section}
        </span>
        <button
          type="button"
          className="icon-btn dir-board-chev"
          title={open ? COPY.tree.collapse : COPY.tree.expand}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          <Icon name="chevron" size={12} className={'chev' + (open ? ' open' : '')} />
        </button>
      </div>
      <div className={'dir-board-body' + (!open ? ' closed' : toggled ? ' is-toggled' : '')}>
        <div className="fav-list">
          {shown.map((fav) => (
            <Row key={fav.id} fav={fav} page={pages?.find((p) => p.id === fav.pageId)} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    </section>
  )
}
