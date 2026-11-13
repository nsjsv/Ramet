import { useEffect, useState } from 'react'
import type { BoardFolder, BoardsPayload, Page } from './api'
import { useBoardsSnapshot } from './boards-store'
import { editInfoOf, refreshEditMarks, subscribeEditMarks, type EditInfo } from './edit-marks-store'
import { isFavorite, toggleFavorite, useFavorites } from './favorites-store'
import { COPY } from './copy'
import { EditedAgo, EditInfoLines } from './edit-info'
import { Icon } from './icons'
import type { Identity } from './identity'
import { PageIcon } from './PageIcon'
import { EditModeItems } from './editor/edit-mode'
import PreviewToggle from './project/PreviewToggle'
import ProjectToggle from './project/ProjectToggle'
import CommentsButton from './comments/CommentsButton'
import CommentSwitches, { type CommentSwitchState } from './comments/CommentSwitches'
import { isPrivatePage } from './page-area'
import { isSharedToMe, nearestShare, useMyShares, useSelfId } from './page-share'
import SharePanel from './share/SharePanel'

/* ---------- 页面顶栏 ----------
 * 一条 48px，sticky 钉在 .main 滚动口顶部：左面包屑（[data-flip]：侧栏收起 / 展开时 FLIP 跟着滑），
 * 右「X分钟前编辑」（点开版本历史）+ 在场头像 + 文档 / 对话切换（一个图标钮，图标是要去的那个视图）+ 收藏星标
 * + ⋮（版本历史 / 导出 zip / 分享 / 源码模式 / 全宽 / 评论（悬浮展开开关子菜单）；分隔线下是字数与上次编辑，菜单打开时现算 / 现取）。
 * 面包屑数据全在 pages 扁平表里沿 parent_id 上溯，零新取数；跨空间 / 缺父 / 环状脏数据即停。导航走 onNavigate。
 * 链顶的页挂在目录树里时，前面再接上它所在的目录链（目录数据共享侧栏已取的那份）。 */

interface Props {
  pages: Page[] | null
  pageId: string | undefined
  /** 同页其他人（awareness，去掉自己）；editor-session 维护 */
  peers: Identity[]
  canPublish: boolean
  /** 能编辑这页：分享弹层里能邀请成员、改档位（share/SharePanel.tsx）；缺省 = 不能 */
  canShare?: boolean
  /** pages 里该页当前 published；分享弹层按它换形态 */
  published: boolean
  /** pages 里该页的 publish_includes_runs：公开时是否连 agent 过程页一起公开（默认否） */
  includeRuns: boolean
  onChanged: () => void
  onNavigate: (to: string) => void
  /** 文档 / 对话切换：onViewChange 缺省 = 不画切换钮（集合页没有对话视图） */
  chatOn?: boolean
  onViewChange?: (chat: boolean) => void
  onOpenHistory: () => void
  /** 开 / 关评论抽屉；缺省 = 这页没有评论（过程页 / skill 页 / 对话视图），不画按钮 */
  onOpenComments?: () => void
  /** 导出当前页（zip）；返回是否成功（失败的提示由调用方给）。缺省 = 不给导出项 */
  onExport?: () => Promise<boolean>
  /** 全宽（页面属性，editor/full-width.ts）；onFullWidth 缺省 = 只读或不适用，⋮ 菜单不给开关 */
  fullWidth?: boolean
  onFullWidth?: (on: boolean) => void
  /** 评论开关（页面属性，⋮ 菜单里「评论」的子菜单）；缺省 = 只读或这页没有评论（过程页 / skill / 集合），⋮ 菜单不给开关 */
  commentSwitches?: CommentSwitchState
  /** 当前页正文字数（⋮ 菜单打开时调用）；编辑器还没建好 = null；缺省 = 没有正文，不显示字数 */
  getWordCount?: () => number | null
}

export default function TopBar(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const pageKind = p.pages?.find((pg) => pg.id === p.pageId)?.kind
  const isRun = pageKind === 'run'
  const isDoc = pageKind === 'doc'
  // 集合页没有正文：源码模式无从谈起
  const hasBody = pageKind !== 'collection'
  // ⋮ 菜单底部：字数打开时现算；上次编辑读缓存当场画（进页面已预取），后台再刷一次，到了原地更新
  const [words, setWords] = useState<number | null>(null)
  const [editInfo, setEditInfo] = useState<EditInfo | null>(null)
  const { getWordCount, pageId } = p
  useEffect(() => {
    if (!menuOpen || !pageId) return
    setWords(getWordCount?.() ?? null)
    const sync = () => setEditInfo(editInfoOf(pageId))
    sync()
    const off = subscribeEditMarks(sync)
    void refreshEditMarks(pageId)
    return off
  }, [menuOpen, pageId, getWordCount])

  // 换页收起弹层
  useEffect(() => {
    setMenuOpen(false)
    setShareOpen(false)
  }, [p.pageId])

  // 外点 / Esc 收菜单与分享弹层（顶栏常驻，不能靠换页自然消失）
  useEffect(() => {
    if (!menuOpen && !shareOpen) return
    const close = () => {
      setMenuOpen(false)
      setShareOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      // 弹层里的下拉列表挂在 body 上（ui/popover.tsx 的 .pop-card），点它不算外点
      if (!(e.target as Element | null)?.closest('.topbar-actions, .pop-card')) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, shareOpen])

  return (
    <header className="topbar">
      <Crumbs pages={p.pages} pageId={p.pageId} onNavigate={p.onNavigate} />
      <div className="topbar-actions">
        {p.pageId && <EditedAgo pageId={p.pageId} onOpen={p.onOpenHistory} />}
        <Presence peers={p.peers} />
        {p.onViewChange && (
          <button
            type="button"
            className="topbar-btn"
            data-tip={p.chatOn ? COPY.top.toDoc : COPY.top.toChat}
            aria-label={p.chatOn ? COPY.top.toDoc : COPY.top.toChat}
            onClick={() => p.onViewChange?.(!p.chatOn)}
          >
            <Icon name={p.chatOn ? 'file' : 'say'} />
          </button>
        )}
        <PreviewToggle pageId={p.pageId} />
        <ProjectToggle pageId={p.pageId} />
        {p.pageId && p.onOpenComments && <CommentsButton pageId={p.pageId} onClick={p.onOpenComments} />}
        {p.pageId && <FavoritePageButton pageId={p.pageId} />}
        <button
          type="button"
          className="topbar-btn"
          data-tip={COPY.top.more}
          aria-label={COPY.top.more}
          aria-expanded={menuOpen}
          onClick={() => {
            setShareOpen(false)
            setMenuOpen((v) => !v)
          }}
        >
          <Icon name="more-vertical" />
        </button>
        {menuOpen && (
          <div className="page-menu">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                p.onOpenHistory()
              }}
            >
              <Icon name="clock" className="menu-icon" />
              {COPY.top.history}
            </button>
            {/* 打包只给普通文档页（过程页 / skill 页不导出） */}
            {isDoc && p.onExport && <ExportItem onExport={p.onExport} onDone={() => setMenuOpen(false)} />}
            {(p.canPublish || p.canShare) && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setShareOpen(true)
                }}
              >
                <Icon name="users" className="menu-icon" />
                {COPY.top.share}
              </button>
            )}
            {/* 编辑方式（源码模式）。过程页是结构化的（步骤是块），源码写回会把步骤压成段落，不提供 */}
            {!isRun && hasBody && <EditModeItems />}
            {p.onFullWidth && (
              <button type="button" aria-pressed={!!p.fullWidth} data-tip={COPY.top.fullWidthHint} onClick={() => p.onFullWidth?.(!p.fullWidth)}>
                <Icon name="full-width" className="menu-icon" />
                {COPY.top.fullWidth}
                {p.fullWidth && <Icon name="check" size={14} className="menu-check" />}
              </button>
            )}
            {p.pageId && p.commentSwitches && <CommentSwitches pageId={p.pageId} state={p.commentSwitches} onChanged={p.onChanged} />}
            <EditInfoLines words={words} info={editInfo} />
          </div>
        )}
        {shareOpen && (p.canPublish || p.canShare) && p.pageId && (
          <SharePanel
            pageId={p.pageId}
            spaceId={p.pages?.find((pg) => pg.id === p.pageId)?.space_id ?? null}
            canShare={!!p.canShare}
            canPublish={p.canPublish}
            published={p.published}
            includeRuns={p.includeRuns}
            onChanged={p.onChanged}
          />
        )}
      </div>
    </header>
  )
}

/** ⋮ 菜单里的导出项：进行中显示「导出中…」，成功后图标变对勾 0.9 秒再收菜单（反馈由操作本身给出，不弹提示条） */
function ExportItem({ onExport, onDone }: { onExport: () => Promise<boolean>; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  return (
    <button
      type="button"
      disabled={state === 'busy'}
      onClick={() => {
        setState('busy')
        void onExport().then((ok) => {
          setState(ok ? 'done' : 'idle')
          if (ok) window.setTimeout(onDone, 900)
        })
      }}
    >
      <Icon name="download" className="menu-icon" />
      {state === 'busy' ? COPY.export.busy : COPY.export.zip}
      {state === 'done' && <Icon name="check" size={14} className="menu-check" />}
    </button>
  )
}

/** 顶栏星标：一点收藏 / 取消收藏本页。收藏是私人书签，只读成员也有 */
function FavoritePageButton({ pageId }: { pageId: string }) {
  useFavorites() // 订阅：别处改了收藏，这里的星标跟着变
  const on = isFavorite(pageId)
  const label = on ? COPY.fav.removePage : COPY.fav.addPage
  return (
    <button type="button" className="topbar-btn" data-tip={label} aria-label={label} aria-pressed={on} onClick={() => void toggleFavorite(pageId)}>
      <Icon name={on ? 'star-fill' : 'star'} />
    </button>
  )
}

/** 挂着该页的目录，从目录树顶层往下排；不在目录树里 / 挂在目录树顶层 = 空 */
function folderPathOf(boards: BoardsPayload | null, pageId: string | undefined): BoardFolder[] {
  const item = pageId ? boards?.items.find((it) => it.kind === 'page' && it.item_id === pageId) : undefined
  if (!boards || !item) return []
  const byId = new Map(boards.folders.map((f) => [f.id, f]))
  const path: BoardFolder[] = []
  for (let f = item.folder_id ? byId.get(item.folder_id) : undefined; f && !path.includes(f); f = f.parent_id ? byId.get(f.parent_id) : undefined) {
    path.unshift(f)
  }
  return path
}

/** 目录 → … → 根祖先 → … → 父页 → 当前页。根页也渲染（只有当前页一段，位置常驻不跳变）。
 *  集合祖先不列：行页面的面包屑直接从集合所在的页接到行，不显示集合名。目录段只是位置提示，不可点。
 *  私人页最前面一段锁形的「私人」：只有我看得到；别人分享给我的私人页是「分享给你的」（文档页与集合页共用这一条面包屑） */
function Crumbs({ pages, pageId, onNavigate }: { pages: Page[] | null; pageId: string | undefined; onNavigate: (to: string) => void }) {
  const boards = useBoardsSnapshot()
  const byId = new Map((pages ?? []).map((pg) => [pg.id, pg]))
  const chain: Page[] = []
  const seen = new Set<string>(pageId ? [pageId] : [])
  let cur = pageId ? byId.get(pageId) : undefined
  const current = cur
  while (cur?.parent_id) {
    const parent = byId.get(cur.parent_id)
    if (!parent || seen.has(parent.id)) break
    if (parent.kind !== 'collection') chain.unshift(parent)
    seen.add(parent.id)
    cur = parent
  }
  const folders = folderPathOf(boards, cur?.id)
  // 别人私人区里分享给我的页、我作为访客看到的页：最前面一段写「分享给你的」，悬停写是谁分享的（最近的那条分享）
  const me = useSelfId()
  const shares = useMyShares(me)
  const sharedBy = current ? (nearestShare(current.id, (id) => byId.get(id), shares.byPage)?.by ?? null) : null
  const sharedToMe = !!current && (isSharedToMe(current, me) || shares.guestSpaces.some((g) => g.id === current.space_id))
  return (
    <nav className="crumbs" aria-label={COPY.top.crumbs} data-flip>
      {sharedToMe ? (
        <span className="crumb crumb-private" data-tip={COPY.area.sharedBy(sharedBy)} aria-label={COPY.area.sharedBy(sharedBy)}>
          <Icon name="users" size={14} />
          <span>{COPY.area.sharedCrumb}</span>
        </span>
      ) : (
        isPrivatePage(current) && (
          <span className="crumb crumb-private" data-tip={COPY.area.privateBadge} aria-label={COPY.area.privateBadge}>
            <Icon name="lock" size={14} />
            <span>{COPY.area.privateTree}</span>
          </span>
        )
      )}
      {folders.map((f) => (
        <span key={f.id} className="crumb" data-tip={f.name}>
          <Icon name="folder" size={16} />
          <span>{f.name}</span>
        </span>
      ))}
      {chain.map((pg) => (
        <button key={pg.id} type="button" className="crumb" data-tip={pg.title || COPY.untitled} onClick={() => onNavigate(`/page/${pg.id}`)}>
          <PageIcon icon={pg.icon} placeholder />
          <span>{pg.title || COPY.untitled}</span>
        </button>
      ))}
      {current && (
        <span className="crumb is-current" aria-current="page" data-tip={current.title || COPY.untitled}>
          <PageIcon icon={current.icon} placeholder />
          <span>{current.title || COPY.untitled}</span>
        </span>
      )}
    </nav>
  )
}

/** 在场头像：同页其他人（最多 4 个，余下 +N）。名字给读屏与悬停 */
function Presence({ peers }: { peers: Identity[] }) {
  if (peers.length === 0) return null
  const names = peers.map((x) => x.name)
  return (
    <span className="presence" role="img" aria-label={COPY.top.presence(names)} data-tip={COPY.top.presence(names)}>
      {peers.slice(0, 4).map((x) => (
        <i key={x.name} style={{ backgroundColor: x.color }}>
          {Array.from(x.name)[0]}
        </i>
      ))}
      {peers.length > 4 && <i className="is-more">+{peers.length - 4}</i>}
    </span>
  )
}
