import { useEffect, useState } from 'react'
import { api, type Page } from './api'
import { editInfoOf, refreshEditMarks, subscribeEditMarks, type EditInfo } from './edit-marks-store'
import { copyText } from './clipboard'
import { isFavorite, toggleFavorite, useFavorites } from './favorites-store'
import { COPY } from './copy'
import { EditedAgo, EditInfoLines } from './edit-info'
import { Icon } from './icons'
import type { Identity } from './identity'
import { PageIcon } from './PageIcon'
import { EditModeItems } from './editor/edit-mode'
import PreviewToggle from './project/PreviewToggle'
import ProjectToggle from './project/ProjectToggle'

/* ---------- 页面顶栏 ----------
 * 一条 48px，sticky 钉在 .main 滚动口顶部：左面包屑（[data-flip]：侧栏收起 / 展开时 FLIP 跟着滑），
 * 右「X分钟前编辑」（点开版本历史）+ 在场头像 + 文档 / 对话切换（一个图标钮，图标是要去的那个视图）+ 收藏星标
 * + ⋮（版本历史 / 导出 zip / 分享 / 源码模式 / 全宽；分隔线下是字数与上次编辑，菜单打开时现算 / 现取）。
 * 面包屑数据全在 pages 扁平表里沿 parent_id 上溯，零新取数；跨空间 / 缺父 / 环状脏数据即停。导航走 onNavigate。 */

interface Props {
  pages: Page[] | null
  pageId: string | undefined
  /** 同页其他人（awareness，去掉自己）；editor-session 维护 */
  peers: Identity[]
  canPublish: boolean
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
  /** 导出当前页（zip）；返回是否成功（失败的提示由调用方给）。缺省 = 不给导出项 */
  onExport?: () => Promise<boolean>
  /** 全宽（页面属性，editor/full-width.ts）；onFullWidth 缺省 = 只读或不适用，⋮ 菜单不给开关 */
  fullWidth?: boolean
  onFullWidth?: (on: boolean) => void
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
      if (!(e.target as Element | null)?.closest('.topbar-actions')) close()
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
            title={p.chatOn ? COPY.top.toDoc : COPY.top.toChat}
            aria-label={p.chatOn ? COPY.top.toDoc : COPY.top.toChat}
            onClick={() => p.onViewChange?.(!p.chatOn)}
          >
            <Icon name={p.chatOn ? 'file' : 'say'} />
          </button>
        )}
        <PreviewToggle pageId={p.pageId} />
        <ProjectToggle pageId={p.pageId} />
        {p.pageId && <FavoritePageButton pageId={p.pageId} />}
        <button
          type="button"
          className="topbar-btn"
          title={COPY.top.more}
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
            {p.canPublish && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setShareOpen(true)
                }}
              >
                <Icon name="globe" className="menu-icon" />
                {COPY.top.share}
              </button>
            )}
            {/* 编辑方式（源码模式）。过程页是结构化的（步骤是块），源码写回会把步骤压成段落，不提供 */}
            {!isRun && hasBody && <EditModeItems />}
            {p.onFullWidth && (
              <button type="button" aria-pressed={!!p.fullWidth} title={COPY.top.fullWidthHint} onClick={() => p.onFullWidth?.(!p.fullWidth)}>
                <Icon name="full-width" className="menu-icon" />
                {COPY.top.fullWidth}
                {p.fullWidth && <Icon name="check" size={14} className="menu-check" />}
              </button>
            )}
            <EditInfoLines words={words} info={editInfo} />
          </div>
        )}
        {shareOpen && p.canPublish && p.pageId && (
          <SharePopover pageId={p.pageId} published={p.published} includeRuns={p.includeRuns} onChanged={p.onChanged} />
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
    <button type="button" className="topbar-btn" title={label} aria-label={label} aria-pressed={on} onClick={() => void toggleFavorite(pageId)}>
      <Icon name={on ? 'star-fill' : 'star'} />
    </button>
  )
}

/** 根祖先 → … → 父页 → 当前页。根页也渲染（只有当前页一段，位置常驻不跳变）。
 *  集合祖先不列：行页面的面包屑直接从集合所在的页接到行，不显示集合名 */
function Crumbs({ pages, pageId, onNavigate }: { pages: Page[] | null; pageId: string | undefined; onNavigate: (to: string) => void }) {
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
  return (
    <nav className="crumbs" aria-label={COPY.top.crumbs} data-flip>
      {chain.map((pg) => (
        <button key={pg.id} type="button" className="crumb" title={pg.title || COPY.untitled} onClick={() => onNavigate(`/page/${pg.id}`)}>
          <PageIcon icon={pg.icon} placeholder />
          <span>{pg.title || COPY.untitled}</span>
        </button>
      ))}
      {current && (
        <span className="crumb is-current" aria-current="page" title={current.title || COPY.untitled}>
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
    <span className="presence" role="img" aria-label={COPY.top.presence(names)} title={COPY.top.presence(names)}>
      {peers.slice(0, 4).map((x) => (
        <i key={x.name} style={{ backgroundColor: x.color }}>
          {Array.from(x.name)[0]}
        </i>
      ))}
      {peers.length > 4 && <i className="is-more">+{peers.length - 4}</i>}
    </span>
  )
}

/** 「分享」弹层：读当前页 published 决定形态；操作后 onChanged() 刷 pages，弹层状态随之更新。
 *  includeRuns（是否连 agent 过程页一起公开）是这个页面自己的属性，不是过程页上的开关：
 *  发布语义是「祖先公开即子树公开」，子页上的 published 表达不了「我不要公开」 */
function SharePopover({
  pageId,
  published,
  includeRuns,
  onChanged,
}: {
  pageId: string
  published: boolean
  includeRuns: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = `${location.origin}/p/${pageId}`

  /** 发布态与「连过程一起公开」同一条写路径；未发布时也允许先设好过程开关 */
  async function save(nextPublished: boolean, nextRuns?: boolean) {
    setBusy(true)
    setError(null)
    try {
      await api.setPublished(pageId, nextPublished, nextRuns)
      onChanged() // pages 刷新 → EditorPage 重渲染，本弹层按新 published 换形态
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : COPY.retry)
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (await copyText(link)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
    // 失败：不阻断，链接框可手动选中复制
  }

  const runsToggle = (
    <label className="share-option">
      <input type="checkbox" checked={includeRuns} disabled={busy} onChange={(e) => void save(published, e.target.checked)} />
      {COPY.share.includeRuns}
    </label>
  )

  return (
    <div className="share-pop">
      {published ? (
        <>
          <div className="share-link-row">
            <input className="share-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            <button className="admin-btn" onClick={() => void copy()}>
              {copied ? COPY.share.copied : COPY.share.copy}
            </button>
          </div>
          {runsToggle}
          <div className="share-actions">
            <span className="share-state is-on">{COPY.share.on}</span>
            <button className="admin-btn danger" disabled={busy} onClick={() => void save(false)}>
              {COPY.share.unpublish}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="share-hint">{COPY.share.hint}</p>
          {runsToggle}
          <div className="share-actions">
            <span className="share-state">{COPY.share.off}</span>
            <button className="admin-btn primary" disabled={busy} onClick={() => void save(true)}>
              {COPY.share.publish}
            </button>
          </div>
        </>
      )}
      {error && <p className="share-error">{error}</p>}
    </div>
  )
}
