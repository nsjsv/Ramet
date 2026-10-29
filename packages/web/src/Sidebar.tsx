/* ---------- 侧边栏壳 + 数据编排 ----------
 * 页面树渲染 / 拖拽 / 正文镜像在 PageTree.tsx，树列表容器在 Boards.tsx；这里只有
 * 壳（头部 / 搜索 / 空间 footer）、listPages 编排、建页 / 删页 / 空间菜单，然后渲染
 * <Boards>（单一列表：该空间页面树 + 目录树）。 */
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api, type Page, type SearchHit, type Space, type User } from './api'
import { COPY } from './copy'
import { PageIcon } from './PageIcon'
import { Icon } from './icons'
import type { PageNode } from './PageTree'
import RecycleBin from './RecycleBin'
import SettingsModal from './SettingsModal'
import { onOpenSettings, type SettingsTarget } from './settings-bus'
import Boards from './Boards'
import { collectionApi } from './collection/collection-api'
import FavoritesList from './FavoritesList'
import { Avatar } from './Avatar'
import { useInbox } from './inbox/inbox-store'
import { attentionCount } from './inbox/inbox-model'

// 侧栏顶部搜索框：GET /api/search?q= 防抖下拉，命中点击跳页
function SidebarSearch({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [open, setOpen] = useState(false)
  /** 是否连 agent 工具调用过程页一起搜（默认不搜，见 api.search） */
  const [includeAgent, setIncludeAgent] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 点外部收起下拉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  // 防抖 300ms 搜索；失败（404/断网）静默清空结果，不弹错。切换范围立即重搜（勾选是明确意图）
  useEffect(() => {
    const term = q.trim()
    if (!term) {
      setHits(null)
      return
    }
    const timer = window.setTimeout(() => {
      api
        .search(term, includeAgent)
        .then((list) => {
          setHits(list)
          setOpen(true)
        })
        .catch(() => setHits(null))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [q, includeAgent])

  return (
    <div className="sidebar-search" ref={boxRef}>
      <input
        className="sidebar-search-input"
        type="search"
        placeholder={COPY.side.search}
        aria-label={COPY.side.search}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits && setOpen(true)}
      />
      {open && hits !== null && (
        <div className="sidebar-search-results">
          {/* agent 过程页默认不出现在结果里（工具调用文本会淹没真实内容）；要搜就显式勾上 */}
          <label className="sidebar-search-scope">
            <input
              type="checkbox"
              checked={includeAgent}
              onChange={(e) => setIncludeAgent(e.target.checked)}
            />
            {COPY.side.includeRuns}
          </label>
          {hits.length === 0 && <div className="sidebar-search-empty">{COPY.side.noHits}</div>}
          {hits.map((hit) => (
            <button
              key={hit.id}
              className="sidebar-search-hit"
              onClick={() => {
                setOpen(false)
                setQ('')
                onPick(hit.id)
              }}
            >
              <span className="sidebar-search-hit-title">
                <PageIcon icon={hit.icon} placeholder />
                {hit.title || COPY.untitled}
              </span>
              {hit.snippet && <span className="sidebar-search-hit-snippet">{hit.snippet}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({
  pages,
  spaces,
  selectedSpaceId,
  onSelectSpace,
  onChanged,
  onPagesRemoved,
  onPageCreated,
  user,
  onLogout,
  onAvatarChange,
  collapsed = false,
  onToggleCollapse,
}: {
  pages: Page[] | null
  spaces: Space[] | null
  selectedSpaceId: string | null
  onSelectSpace: (id: string) => void
  onChanged: () => void
  /** 删除（软删/物理删）成功后的权威 id 集：Shell 立刻从本地列表摘掉这些行，不等广播刷新 */
  onPagesRemoved: (ids: string[]) => void
  /** 新建成功的页面（建页响应即权威）：Shell 先插进本地列表再跳过去，不等广播刷新 */
  onPageCreated: (page: Page) => void
  user: User
  onLogout: () => void
  /** 设置里换了头像（Shell 更新登录态） */
  onAvatarChange: (avatar: string | null) => void
  /** 折叠态（供 aria；宽度收起由 .app.sidebar-collapsed 的 CSS 负责） */
  collapsed?: boolean
  /** 折叠开关；不传则不渲染折叠按钮（PublicPage 等旁路无侧栏场景不受影响） */
  onToggleCollapse?: () => void
}) {
  const [trashOpen, setTrashOpen] = useState(false)
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 编辑器里随手 AI 的「去设置」：打开设置并落在「随手 AI」页（settings-bus.ts）
  const [settingsTab, setSettingsTab] = useState<SettingsTarget | undefined>(undefined)
  useEffect(
    () =>
      onOpenSettings((tab, spaceId) => {
        // 空间类分页（机器）看的是当前选中的空间：条目在别的空间就先切过去
        if (spaceId && spaceId !== selectedSpaceId) onSelectSpace(spaceId)
        setSettingsTab(tab)
        setSettingsOpen(true)
      }),
    [selectedSpaceId, onSelectSpace],
  )
  const navigate = useNavigate()
  const location = useLocation()

  // 收件箱角标 = 需要你处理的条数（数据由 Shell 常驻的 inbox-store 维护）
  const inboxCount = attentionCount(useInbox().items)
  // 账号处的头像（换头像后 Shell 更新 user，这里随之重渲染）
  const me = { id: user.id, username: user.username, avatar: user.avatar ?? null }
  const selected = spaces?.find((s) => s.id === selectedSpaceId) ?? null
  const isViewer = selected?.my_role === 'viewer'
  // 页面树写入口（新建 / 删除 / 拖拽 / 改名）在 viewer 空间全关（REST 写会 403）
  const readOnly = isViewer
  // ⚙ 主设置入口常驻（footer）：全局分页（默认 Agent / 编辑器 / 账户）任何登录用户都要能进；
  // 空间分页的可见性由 SettingsModal 按 my_role 裁剪，这里不靠条件渲染入口表达

  async function createChild(parentId: string | null) {
    const created = await api.createPage(parentId, selectedSpaceId ?? undefined)
    // 不自动展开父节点：新建页面只 navigate，树的折叠状态由用户手动控制
    onChanged()
    navigate(`/page/${created.id}`)
  }

  // 新建整页集合（空间顶层，默认「状态」属性 + 表格视图由服务端写进初始文档），建好直接打开
  async function createCollection() {
    if (!selectedSpaceId) return
    try {
      const created = await collectionApi.create({ space_id: selectedSpaceId, inline: false })
      // 先进本地列表再跳：PageRoute 按列表里的 kind 分流，列表没到时会先把集合当普通页挂上正文编辑器
      onPageCreated(created)
      onChanged()
      navigate(`/page/${created.id}`)
    } catch (err) {
      console.error(err)
      window.alert(err instanceof Error && err.message ? err.message : COPY.collection.createFailed)
    }
  }

  // 用户删页 = 移入回收站（可恢复）；只有回收站里的「永久删除」才走物理删（api.deletePage）
  async function remove(node: PageNode) {
    if (!window.confirm(COPY.tree.confirmTrash(node.title || COPY.untitled))) return
    try {
      const { trashed } = await api.trashPage(node.id)
      onPagesRemoved(trashed)
      if (trashed.some((id) => location.pathname === `/page/${id}`)) navigate('/')
      onChanged()
    } catch (err) {
      console.error(err)
      window.alert(COPY.side.trashFailed)
    }
  }

  async function createSpace() {
    const name = window.prompt(COPY.side.newSpaceName)
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 50) {
      window.alert(COPY.side.spaceNameInvalid)
      return
    }
    try {
      const created = await api.createSpace(trimmed)
      onChanged()
      onSelectSpace(created.id)
      setSpaceMenuOpen(false)
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <aside className="sidebar" data-flip>
      {/* 头部：收起按钮在最左，不加 logo 方块，名字跟在后面 */}
      <div className="sidebar-header">
        {onToggleCollapse && (
          <button
            className="btn-collapse"
            onClick={onToggleCollapse}
            title={collapsed ? COPY.side.expand : COPY.side.collapse}
            aria-label={collapsed ? COPY.side.expand : COPY.side.collapse}
            aria-expanded={!collapsed}
          >
            {/* 折叠态按钮在浮层预览里，语义为展开 → chevron 反向 */}
            <Icon name={collapsed ? 'panel-expand' : 'panel-collapse'} />
          </button>
        )}
        <b className="sidebar-name">Ramet</b>
      </div>
      <SidebarSearch onPick={(id) => navigate(`/page/${id}`)} />
      {/* 空间功能入口（Skill 库 / 记忆 / 收件箱） */}
      <nav className="side-nav">
        <NavLink to="/skills" className={({ isActive }) => 'side-nav-item' + (isActive ? ' active' : '')}>
          <span className="side-nav-ic">
            <Icon name="skill" size={18} />
          </span>
          <span>{COPY.side.skills}</span>
        </NavLink>
        <NavLink to="/memory" className={({ isActive }) => 'side-nav-item' + (isActive ? ' active' : '')}>
          <span className="side-nav-ic">
            <Icon name="memory" size={18} />
          </span>
          <span>{COPY.memory.nav}</span>
        </NavLink>
        <NavLink to="/inbox" className={({ isActive }) => 'side-nav-item' + (isActive ? ' active' : '')}>
          <span className="side-nav-ic">
            <Icon name="inbox" size={18} />
          </span>
          <span>{COPY.inbox.nav}</span>
          {inboxCount > 0 && (
            <span className="side-nav-badge" title={COPY.inbox.badge(inboxCount)} aria-label={COPY.inbox.badge(inboxCount)}>
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </NavLink>
      </nav>
      {/* 收藏：私人书签（页面 / 块 / AI 回复 / 过程页步骤） */}
      <FavoritesList pages={pages} spaceId={selectedSpaceId} onNavigate={(to) => navigate(to)} />
      {/* 竖树列表：该空间的页面树 + 目录树同区滚动，名字恒定「页面树」「目录树」；
          页面树随空间派生（有页面即渲染），目录树按需落行。外壳 / 折叠 / 删除在 Boards.tsx，
          页面树内容 / 拖拽在 PageTree.tsx。页面拖拽 = 插入线，深空白落点 = 空间顶层末尾 */}
      <Boards
        pages={pages}
        selectedSpaceId={selectedSpaceId}
        spaceIds={spaces?.map((s) => s.id) ?? []}
        readOnly={readOnly}
        onNavigate={(id) => navigate(`/page/${id}`)}
        onCreatePage={(parentId) => void createChild(parentId)}
        onCreateCollection={() => void createCollection()}
        onRemovePage={(node) => void remove(node)}
        onPageChanged={onChanged}
      />
      {/* Notion 式工作区切换器，菜单向上弹 */}
      <div className="sidebar-footer">
        <>
          <button className="ws-trigger" title={COPY.side.switchSpace} onClick={() => setSpaceMenuOpen((v) => !v)}>
            <span className="ws-trigger-name">
              {selected?.name ?? (spaces === null ? COPY.loading : COPY.side.noSpace)}
            </span>
            <span className="ws-trigger-caret">
              <Icon name="caret" size={12} />
            </span>
          </button>
          <button className="ws-cog" title={COPY.side.settings} aria-label={COPY.side.settings} onClick={() => setSettingsOpen(true)}>
            <Icon name="cog" size={16} />
          </button>
          {/* 回收站：写入口，viewer 空间不出现 */}
          {!isViewer && selected && (
            <button className="ws-trash" title={COPY.side.trash} aria-label={COPY.side.trash} onClick={() => setTrashOpen(true)}>
              <Icon name="trash" size={16} />
            </button>
          )}
          {spaceMenuOpen && (
            <>
              {/* 透明遮罩垫在菜单下面：点菜单外任意处关闭 */}
              <div className="space-menu-backdrop" onClick={() => setSpaceMenuOpen(false)} />
              <div className="space-menu">
                <div className="space-menu-list">
                  {spaces === null && <div className="space-item loading">{COPY.loading}</div>}
                  {spaces !== null && spaces.length === 0 && <div className="space-item loading">{COPY.side.noSpace}</div>}
                  {spaces?.map((s) => (
                    <button
                      key={s.id}
                      className={'space-item' + (s.id === selectedSpaceId ? ' active' : '')}
                      onClick={() => {
                        onSelectSpace(s.id)
                        setSpaceMenuOpen(false)
                      }}
                    >
                      <span className="space-item-name" title={s.name}>
                        {s.name}
                      </span>
                      {s.id === selectedSpaceId && <Icon name="check" size={14} />}
                    </button>
                  ))}
                  {!isViewer && (
                    <button className="space-item space-item-add" onClick={() => void createSpace()}>
                      <Icon name="plus" size={14} /> {COPY.side.addSpace}
                    </button>
                  )}
                </div>
                <div className="ws-menu-user">
                  {user.role === 'admin' && (
                    <NavLink
                      to="/admin"
                      className="btn-admin"
                      title={COPY.side.admin}
                      onClick={() => setSpaceMenuOpen(false)}
                    >
                      {COPY.side.admin}
                    </NavLink>
                  )}
                  <Avatar person={me} />
                  <span className="sidebar-user" title={user.username}>
                    {user.username}
                  </span>
                  <button className="btn-logout" onClick={onLogout}>
                    {COPY.side.logout}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      </div>
      {trashOpen && selected && (
        <RecycleBin space={selected} pages={pages} onClose={() => setTrashOpen(false)} onChanged={onChanged} />
      )}
      {settingsOpen && (
        <SettingsModal
          user={user}
          space={selected}
          initialTab={settingsTab}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsTab(undefined)
          }}
          onChanged={onChanged}
          onSpaceGone={(spaceId) => {
            // 正看着被删/已退出的空间的页面时退回首页（页面已随之消失/不可达）
            const currentId = location.pathname.startsWith('/page/')
              ? location.pathname.slice('/page/'.length)
              : null
            if (currentId && pages?.some((p) => p.id === currentId && p.space_id === spaceId)) navigate('/')
            onChanged()
          }}
          onLogout={onLogout}
          onAvatarChange={onAvatarChange}
          pages={pages}
        />
      )}
    </aside>
  )
}
