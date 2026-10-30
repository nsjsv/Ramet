import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { subscribeControl } from './control'
import { startFavoritesSync } from './favorites-store'
import { setSelf } from './people'
import { COPY } from './copy'
import Sidebar from './Sidebar'
import EditorPage from './Editor'
import CollectionPage from './collection/CollectionPage'
import { resetCollectionCache, syncCollectionPages, syncCollectionSpaces } from './collection/collection-store'
import { resetCachedLoads } from './cached-load'
import { spaceReadOnly } from './space-role'
import { Icon } from './icons'
import { flip, motionMs } from './motion'
import Login from './Login'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { api, setUnauthorizedHandler, type Page, type Space, type User } from './api'
import { applyPageSync, bindPageSync, createPageSyncer, loadPagesCache, writePagesCache } from './page-sync'
import { isTouchEditor } from './editor/block-touch'
import ProjectDock, { preloadProjectPanel } from './project/ProjectDock'
import HudLayer from './hud/HudLayer'
import CommandPalette, { preloadPalette } from './palette/CommandPalette'
import { recentRunPages } from './project/agent-commands'
import { markPageSeen, setOpenPage, startInboxSync } from './inbox/inbox-store'

/* 非首屏页面按需加载（新页面默认也走这里），进了对应路由才下载。占位一律 null：这些页面本来就是先空着、取到数据再画，
 * 不另加转圈。chunk 拉取失败（部署后旧标签页）由 main.tsx 的 vite:preloadError 刷新恢复 */
const Setup = lazy(() => import('./Setup'))
const ChangePassword = lazy(() => import('./ChangePassword'))
const Admin = lazy(() => import('./Admin'))
const Join = lazy(() => import('./Join'))
const ConnectMachine = lazy(() => import('./ConnectMachine'))
const SkillLibrary = lazy(() => import('./SkillLibrary'))
const PublicPage = lazy(() => import('./PublicPage'))
const InboxPage = lazy(() => import('./inbox/InboxPage'))
const MemoryPanel = lazy(() => import('./memory/MemoryPanel'))
const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={null}>{children}</Suspense>

/* 未登录打开 /join/:token（邀请）或 /connect/:code（机器接入确认）时，落地页在登录后的 Routes 里不可达，
 * 401 由现有 handler 接管回登录页。登录前先把路径记进 sessionStorage，登录 / 初始化 / 改密完成进入 Shell 前读出并跳回。 */
const PENDING_PATH_KEY = 'ramet_pending_path'
const RESUMABLE_PATH = /^\/(join|connect)\/[^/]+$/

/* 侧边栏折叠态记在 localStorage（刷新保持），样式由 .app.sidebar-collapsed 的 CSS 控制。
 * 折叠后没有常驻展开按钮：指针入左缘热区（.sidebar-zone，折叠态才渲染）侧栏以浮层预览滑出，
 * 点浮层里头部按钮才钉住还原；键盘兜底 Ctrl/Cmd+\（折叠态内容不进 Tab 序列） */
const SIDEBAR_COLLAPSED_KEY = 'ramet.sidebar.collapsed'

/* 侧边栏宽度（桌面专属，拖拽自定义）：存 localStorage，经 --sidebar-w 变量喂给 .sidebar 与 .main 的左内边距；
 * 手机抽屉固定 260px（CSS 手机 media 里钉死），不读这个变量。 */
const SIDEBAR_WIDTH_KEY = 'ramet.sidebar.width'
const SIDEBAR_W_DEFAULT = 248
const SIDEBAR_W_MIN = 180
const SIDEBAR_W_MAX = 480
const clampSidebarW = (w: number) => Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, Math.round(w)))

/* 刷新后恢复上次选中的空间而非个人空间；id 失效（退群 / 被删 / 换账号）沿用现有回落逻辑。 */
const LAST_SPACE_KEY = 'ramet_last_space'

/* 各空间上次打开的页面，切空间时自动回到那一页。单 key 存整个 map（{spaceId: pageId}），
 * 读时校验页面还在且仍属该空间（删页 / 换空间不清理也不出错），无需写时清理。 */
const LAST_PAGE_KEY = 'ramet_last_page_map'

function readLastPageMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/* 列表缓存（pages/spaces，按用户隔离）：刷新先秒出侧栏树（挂载时从 localStorage 播种），
 * 首个 GET 校准后置 hydrated。key 按 uid 分，同浏览器换账号互不可见对方缓存。 */
const pagesCacheKey = (uid: string) => `ramet_cache_pages_${uid}`
const spacesCacheKey = (uid: string) => `ramet_cache_spaces_${uid}`

/** 读列表缓存：解析失败 / 结构不对按无缓存（null），不抛错（脏数据不能白屏） */
function readListCache<T>(key: string): T[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

interface Auth {
  user: User | null
  setUser: (user: User | null) => void
  logout: () => void
  /** 启动探测链得出：users 空表需初始化，无会话时展示初始化页而非登录页（单次会话内不再变） */
  setupNeeded: boolean
  /** 初始化页发现已被抢先完成（403）时翻回登录页，避免卡在永远打不通的初始化页 */
  setSetupNeeded: (needed: boolean) => void
}

const AuthContext = createContext<Auth | null>(null)

/** 登录态与登出 */
export function useAuth(): Auth {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [probing, setProbing] = useState(true) // me 探测期：渲染加载态，防闪登录页

  useEffect(() => {
    let cancelled = false
    // 任意请求 401 都清会话，Root 随即渲染登录页
    setUnauthorizedHandler(() => {
      if (!cancelled) setUser(null)
    })
    api
      .me()
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        // 401 说明未登录，探测是否首启（users 空表）；失败按「不需要初始化」处理，走登录页
        return api
          .setupStatus()
          .then((s) => {
            if (!cancelled && s.needed) setSetupNeeded(true)
          })
          .catch(() => {})
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => {
      cancelled = true
      setUnauthorizedHandler(null)
    }
  }, [])

  // 身份变了（登出、会话失效、换账号）：清掉内存里的集合保活 / 冷缓存与列表页缓存，别让下一个人看到上一个人的数据。
  // 用 layout effect：同一次提交里它先于子树的 useEffect 跑。登录那一刻 Shell 刚挂上，子组件的首次取数必须发在
  // reset 之后（否则按旧代数算、回来时被当成上一个身份的丢掉，页面一直「加载中」）。之后才释放的旧连接靠代数直接拆、不留
  const uid = user?.id ?? null
  useLayoutEffect(() => {
    resetCollectionCache()
    resetCachedLoads()
  }, [uid])

  const logout = useCallback(() => {
    void api.logout().catch(() => {}) // 接口失败（会话已死/断网）也要清本地态
    sessionStorage.removeItem(PENDING_PATH_KEY) // 别把上个会话的邀请 / 接入确认带到下次登录
    setUser(null)
  }, [])

  if (probing) return <div className="loading auth-loading">{COPY.loading}</div>

  return <AuthContext.Provider value={{ user, setUser, logout, setupNeeded, setSetupNeeded }}>{children}</AuthContext.Provider>
}

export default function App() {
  const location = useLocation()
  // 公开预览页在登录壳之外：不进 AuthProvider（无 me 探测闪烁），无侧边栏无顶部导航；
  // 登录态由 PublicPage 自行探测（仅克隆按钮需要）。/p/ 前缀整段接管（含 /p/xxx 之外的奇异路径，统一 404 提示）
  if (location.pathname.startsWith('/p/')) {
    return (
      <Lazy>
        <PublicPage />
      </Lazy>
    )
  }
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  )
}

/** 守卫分叉：无会话按需走初始化页或登录页；强制改密拦在主应用前；都过了才进主应用 */
function Root() {
  const { user, setUser, logout, setupNeeded, setSetupNeeded } = useAuth()
  const location = useLocation()

  // 未登录状态下停留在 /join/:token、/connect/:code（登录页/初始化页/改密页期间 URL 不变）：记下路径，回头再跳
  useEffect(() => {
    if (user) return
    if (RESUMABLE_PATH.test(location.pathname)) sessionStorage.setItem(PENDING_PATH_KEY, location.pathname)
  }, [user, location.pathname])

  if (!user) {
    return setupNeeded ? (
      <Lazy>
        <Setup onSuccess={setUser} onUnavailable={() => setSetupNeeded(false)} />
      </Lazy>
    ) : (
      <Login onSuccess={setUser} />
    )
  }
  // 临时密码账号首登：flag 来自服务端（me/login），刷新也拿不到旧值，主应用不可达
  if (user.must_change_password) {
    return (
      <Lazy>
        <ChangePassword onDone={() => setUser({ ...user, must_change_password: false })} onLogout={logout} />
      </Lazy>
    )
  }
  // 进入 Shell 前消费待跳回的路径（登录/setup/改密三条路都会经过这里）
  const pending = sessionStorage.getItem(PENDING_PATH_KEY)
  if (pending) {
    sessionStorage.removeItem(PENDING_PATH_KEY)
    if (RESUMABLE_PATH.test(pending)) return <Navigate to={pending} replace />
  }
  // key：换账号必须是新 Shell 实例（页面缓存 key、增量同步的游标与确认列表都按账号，挂载时取一次）
  return <Shell key={user.id} user={user} />
}

/** 已登录主应用（spaces + pages 并行拉取，任何变更两者都刷） */
function Shell({ user }: { user: User }) {
  const { logout, setUser } = useAuth()
  // 登录态镜像给非 React 消费方（新消息记发言人、对话气泡画自己的头像，见 people.ts）
  useEffect(() => {
    setSelf({ id: user.id, username: user.username, avatar: user.avatar ?? null })
  }, [user.id, user.username, user.avatar])
  // 设置里换了头像：登录态是唯一事实源，改它（people 镜像随上面的 effect 跟上）
  const changeAvatar = useCallback((avatar: string | null) => setUser({ ...user, avatar }), [user, setUser])
  const navigate = useNavigate()
  const location = useLocation()
  // 播种：挂载即从 localStorage 同步恢复上次的 pages/spaces，侧栏树先渲染（首个 GET 校准）。
  // 播种数据只喂展示（Sidebar 树、PageRoute 角色计算）；路由决策必须等 hydrated（见 Home effect），
  // 否则陈旧缓存会误判空空间或跳进已删页
  // 页面缓存带着上次同步的游标（page-sync.ts）：刷新网页先用缓存画，再带游标只拉变过的页
  const [pagesCache] = useState(() => loadPagesCache(pagesCacheKey(user.id)))
  const [pages, setPages] = useState<Page[] | null>(() => pagesCache?.pages ?? null)
  const [spaces, setSpaces] = useState<Space[] | null>(() => readListCache<Space>(spacesCacheKey(user.id)))
  // hydrated：首次 refresh() 两个 GET 都成功后置 true（之后重复置位无害）。置位前 Home 不跳页
  const [hydrated, setHydrated] = useState(false)
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  // 收藏：外壳挂载拉一次，窗口回到前台再拉（星标状态、侧栏列表、块菜单都读这一份）
  useEffect(() => startFavoritesSync(), [])
  // 收件箱：外壳挂载拉一次，之后跟着 control:global 的 'inbox' 信号重拉（不另开连接）；退出 / 换账号时拆掉并清空
  useEffect(() => startInboxSync(), [user.id])
  // 登录几秒后、浏览器空闲时预取命令面板与项目面板的本体（平时按需加载）：第一次 ⌘K / 打开项目面板不用等下载
  useEffect(() => {
    let idle = 0
    const go = (): void => {
      preloadPalette()
      preloadProjectPanel()
    }
    const t = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(go, { timeout: 5000 })
      else go() // Safari 没有 requestIdleCallback
    }, 3000)
    return () => {
      clearTimeout(t)
      if (idle) cancelIdleCallback(idle)
    }
  }, [])
  // 折叠状态：桌面从 localStorage 播种（刷新保持）；手机端默认收起（侧栏是覆盖抽屉）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => isTouchEditor() || localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  )
  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])
  // 侧边栏宽度：桌面拖右缘手柄调整（localStorage 记忆）。拖动期间直接写 :root 变量、不走
  // React 渲染（拖拽每帧 setState 会重渲整棵树）；松手才提交 state 并落盘。变量放 :root
  // 而非 .app 内联样式：避免拖拽中的直接写被下一次任意 re-render 的样式协调冲回旧值。
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return raw >= SIDEBAR_W_MIN && raw <= SIDEBAR_W_MAX ? clampSidebarW(raw) : SIDEBAR_W_DEFAULT
  })
  const [sidebarResizing, setSidebarResizing] = useState(false)
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidth}px`)
  }, [sidebarWidth])
  const startSidebarResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    setSidebarResizing(true)
    // 显式捕获让指针拖出窗口仍能收 move/up；合成指针（自动化测试）无活动 pointerId 会抛，忽略即可
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 合成指针无捕获能力，window 监听兜底 */
    }
    const onMove = (ev: PointerEvent) => {
      document.documentElement.style.setProperty('--sidebar-w', `${clampSidebarW(startW + ev.clientX - startX)}px`)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const w = clampSidebarW(startW + ev.clientX - startX)
      setSidebarResizing(false)
      setSidebarWidth(w)
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  // 悬停预览（折叠态专属）：左缘热区/面板进入即开；指针离开后面板保持卡片形体滑出淡出（--d-2）再摘类。
  // 不做纯 CSS :hover：收起按钮就落在浮层面板的覆盖范围内，点完收起后浏览器仍按旧布局
  // 保留悬停态，面板会立刻自己弹回来（等于收起没生效）；显式状态只在真实指针事件上变。
  const [sidebarPeek, setSidebarPeek] = useState<'off' | 'on' | 'out'>('off')
  // 显式折叠/展开后先「解除武装」：指针还停在左缘（收起按钮就在热区里）时，一动鼠标不该又把预览弹出来；
  // 等指针离开预览区再进才重新允许展开
  const peekArmed = useRef(true)
  const peekTimer = useRef<number | null>(null)
  const cancelPeekOut = useCallback(() => {
    if (peekTimer.current !== null) {
      window.clearTimeout(peekTimer.current)
      peekTimer.current = null
    }
  }, [])
  const openPeek = useCallback(() => {
    cancelPeekOut()
    setSidebarPeek('on')
  }, [cancelPeekOut])
  const closePeek = useCallback(() => {
    cancelPeekOut()
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null
      setSidebarPeek('off')
    }, motionMs('--d-2'))
    setSidebarPeek('out')
  }, [cancelPeekOut])
  // 折叠态唯一切换入口：折叠/展开都清预览（残留会让下次折叠瞬间又弹出来，动画定时器同清）。
  // 侧栏自己的滑入滑出是 CSS 过渡；正文列 / 面包屑 / 钉住时的浮层卡片（[data-flip]）走 FLIP 从旧位置滑过去
  const toggleSidebar = useCallback(() => {
    cancelPeekOut()
    peekArmed.current = false
    flip(document.querySelectorAll('[data-flip]'), () =>
      flushSync(() => {
        setSidebarPeek('off')
        setSidebarCollapsed((v) => !v)
      }),
    )
  }, [cancelPeekOut])
  // 折叠态只剩鼠标悬停（热区/浮层）：Ctrl/Cmd+\ 给键盘用户留同一条路
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])
  // 悬停预览的命中判定：交给浏览器自己的 :hover，每次 mousemove 复核（只认变化沿，不轮询式重复起停动画）。
  // 不用 mouseenter/leave：面板浮出/隐去会在指针静止时改掉命中目标，而 enter/leave 只随指针位置变化补发，
  // 状态就会与实际位置脱节（收起后静止悬停态让面板弹回，或指针停在热区里却不再展开）。
  useEffect(() => {
    if (!sidebarCollapsed) return
    const zone = document.querySelector('.sidebar-zone')
    const panel = document.querySelector('.sidebar')
    let hot = false
    const onMove = () => {
      const inside = !!zone?.matches(':hover') || !!panel?.matches(':hover')
      if (!inside) {
        peekArmed.current = true // 指针离开预览区：重新武装，下次进入即可展开
        if (hot) {
          hot = false
          closePeek()
        }
        return
      }
      if (!hot && peekArmed.current) {
        hot = true
        openPeek()
      }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [sidebarCollapsed, openPeek, closePeek])
  const [searchParams, setSearchParams] = useSearchParams()
  // ?space= 首见时的 spaces 列表快照：同一份列表里没有不算无效，换过一份还没有才判定参数作废
  const paramSeenAt = useRef<Space[] | null>(null)

  // 集合 store 从页面列表感知行的进出与改名（服务端不为它们推集合增量）
  useEffect(() => {
    if (pages) syncCollectionPages(pages)
  }, [pages])
  // 正文里的集合块按集合所在空间的角色决定给不给编辑入口（不按宿主页）：空间列表也喂一份给 store
  useEffect(() => syncCollectionSpaces(spaces), [spaces])

  // 页面列表走增量同步（page-sync.ts）：changed 信号来了只拉变过的页并进当前列表；游标过旧 / 成员关系变了服务端回整表。
  // 单飞：在途时再来的 refresh 记一笔，完成后再同步一次。每次同步成功把服务端确认过的列表连同游标回写 localStorage；
  // 两路（页面、空间）都至少成功过一次才置 hydrated。Shell 实例内 user.id 不变，换账号 = 新 Shell 实例（新 syncer）
  const loaded = useRef({ pages: false, spaces: false })
  const settle = useCallback(() => {
    if (loaded.current.pages && loaded.current.spaces) setHydrated(true)
  }, [])
  // 写失败只记录：隐私模式/quota 满时 setItem 会抛，不能让它中断 settle，否则 hydrated 永远 false，Home 永不跳页
  const writeCache = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch (err: unknown) {
      console.error('list cache write failed:', err)
    }
  }, [])
  const [syncer] = useState(() =>
    createPageSyncer({
      cache: pagesCache,
      fetch: (since) => api.syncPages(since),
      onResult: (res, mark, confirmed) => {
        // 并进当前列表（本地乐观改动没被这次增量碰到的保留）；缓存只存服务端确认过的那份
        setPages((cur) => applyPageSync(cur, res))
        writeCache(pagesCacheKey(user.id), writePagesCache(mark, confirmed))
        loaded.current.pages = true
        settle()
      },
      onError: console.error,
    }),
  )
  // 编辑器（link-watcher）删子页前要拿服务端现状确认结构：经它发一次增量同步
  useEffect(() => bindPageSync(syncer.run), [syncer])
  const refresh = useCallback(() => {
    void syncer.run()
    api
      .listSpaces()
      .then((list) => {
        setSpaces(list)
        writeCache(spacesCacheKey(user.id), JSON.stringify(list))
        loaded.current.spaces = true
        settle()
      })
      .catch(console.error)
  }, [user.id, syncer, settle, writeCache])

  // 标题即时上树：编辑器标题 fragment 一变就乐观改 pages，侧栏当次输入即变。
  // 库写回仍由编辑器内 500ms 防抖 REST + 广播 refresh 校准，这里纯本地。同值不产生新数组（少一次全树重渲染）
  const patchPageTitle = useCallback((pageId: string, title: string) => {
    setPages((cur) => {
      if (cur === null) return cur
      const hit = cur.find((p) => p.id === pageId)
      if (!hit || hit.title === title) return cur
      return cur.map((p) => (p.id === pageId ? { ...p, title } : p))
    })
  }, [])
  // 页面被删/移入回收站后，用删除响应（权威 id 集）立刻把行从本地列表摘掉：
  // 树当次即变，且紧跟着的 navigate('/') 里 Home 拿到的不是刷新前的旧表，
  // 否则 Home 会挑中刚被删的那页，把人送回死页并卡在加载中
  const dropPages = useCallback((ids: string[]) => {
    const gone = new Set(ids)
    setPages((cur) => (cur === null ? cur : cur.filter((p) => !gone.has(p.id))))
  }, [])
  // 新建页面的响应先插进本地列表（同 dropPages：mutation 响应即权威，广播 refresh 只做校准）
  const addPage = useCallback((page: Page) => {
    setPages((cur) => (cur === null || cur.some((p) => p.id === page.id) ? cur : [...cur, page]))
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])

  // 常连 control:global 信令文档（无内容，连接由 control.ts 持有）：
  // 服务端页面/空间写库成功后 broadcastStateless，实时刷新侧栏树；'sync' 是（重）连上补刷一次。
  // agent 目录（'agents'）不归这里管，default-agent 自己订同一条连接失效缓存。
  useEffect(
    () =>
      subscribeControl((ev) => {
        // 'agents'（目录）、'inbox'（收件箱）、'memories'（记忆面板）、'boards'（目录树）各有各的订阅方；
        // 树与空间只跟页面 / 空间写库和重连补拉
        if (ev === 'changed' || ev === 'sync') refresh()
      }),
    [refresh],
  )

  // 选中空间：?space= 优先（Join 接受邀请后带进来；等 spaces 列表带上该空间再选中并清掉参数），
  // 否则保持当前选中；仅当选中空间已消失（退群/被删/首次进入）时回落个人空间，不干扰手动切换。
  useEffect(() => {
    if (!spaces) return
    const fromQuery = searchParams.get('space')
    if (fromQuery) {
      const hit = spaces.find((s) => s.id === fromQuery)
      if (hit) {
        paramSeenAt.current = null
        setSelectedSpaceId(hit.id)
        const next = new URLSearchParams(searchParams)
        next.delete('space')
        setSearchParams(next, { replace: true })
        return
      }
      // 接受邀请后 onChanged 的刷新在途：同一份列表里先等；换过一份还没有就让参数作废，走默认
      if (paramSeenAt.current === null || paramSeenAt.current === spaces) {
        paramSeenAt.current = spaces
        return
      }
      paramSeenAt.current = null
      const next = new URLSearchParams(searchParams)
      next.delete('space')
      setSearchParams(next, { replace: true })
      return
    }
    paramSeenAt.current = null
    // 恢复优先级：当前选中 > localStorage 上次空间 > 个人空间
    // last 在 effect 里取一次，updater 保持纯函数；写 effect 只在选中真正变化时写，二者不打架
    const last = localStorage.getItem(LAST_SPACE_KEY)
    setSelectedSpaceId((cur) => {
      if (cur && spaces.some((s) => s.id === cur)) return cur
      if (last && spaces.some((s) => s.id === last)) return last
      return (spaces.find((s) => s.is_personal) ?? spaces[0])?.id ?? null
    })
  }, [spaces, searchParams, setSearchParams])

  // 记住上次选中空间，刷新后恢复
  useEffect(() => {
    if (selectedSpaceId) localStorage.setItem(LAST_SPACE_KEY, selectedSpaceId)
  }, [selectedSpaceId])

  // 浏览器标签页标题：页面标题 | Ramet；非页面路由只显 Ramet。pages 变化即重算：
  // 标题输入时 patchPageTitle 乐观更新 pages，标签页当次输入即跟。
  // /p/ 公开页在 Shell 之外（PublicPage 自管），这里不用管。
  // 图标：emoji 直接当前缀（标签页只能文本）；图片图标不加（favicon 不是文本槽）
  useEffect(() => {
    const m = location.pathname.match(/^\/page\/([\w-]+)$/)
    const page = m ? pages?.find((p) => p.id === m[1]) : undefined
    const emoji = page?.icon?.kind === 'emoji' ? `${page.icon.value} ` : ''
    document.title = page ? `${emoji}${page.title.trim() || COPY.blankPage} | Ramet` : 'Ramet'
  }, [location.pathname, pages])

  // 打开页面时记进各空间上次页面的 map。map 同值不重写，省一次 setItem
  useEffect(() => {
    const m = location.pathname.match(/^\/page\/([\w-]+)$/)
    if (!m || !pages) return
    const page = pages.find((p) => p.id === m[1])
    if (!page?.space_id) return
    const map = readLastPageMap()
    if (map[page.space_id] === page.id) return
    map[page.space_id] = page.id
    try {
      localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map))
    } catch {
      // quota 满/隐私模式：丢的只是「切空间回跳」记忆，不中断
    }
  }, [location.pathname, pages])

  // 打开了某个对话页 = 它在收件箱里「做完待你看」的回合看过了
  useEffect(() => {
    const m = location.pathname.match(/^\/page\/([\w-]+)$/)
    const id = m ? m[1]! : null
    setOpenPage(id)
    if (id) markPageSeen(id)
    return () => setOpenPage(null)
  }, [location.pathname])

  // 切空间（仅用户手动切换：prev 非 null 且变化）时自动打开目标空间上次打开的页；
  // 没有就跳 /，Home 落到第一页/空提示（空空间不自动建页）。初始恢复（prev=null）、
  // 重复点击都不导航，不打断当前页面
  const prevSpaceRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSpaceRef.current
    prevSpaceRef.current = selectedSpaceId
    if (!selectedSpaceId || prev === null || prev === selectedSpaceId) return
    const last = readLastPageMap()[selectedSpaceId]
    const hit = last ? pages?.find((p) => p.id === last && p.space_id === selectedSpaceId) : undefined
    navigate(hit ? `/page/${hit.id}` : '/')
  }, [selectedSpaceId, pages, navigate])

  // 页面可写（项目面板改文件、工作台停止这一轮）：只读成员（viewer）不行（服务端也拦：viewer 403）
  const canWritePage = (pageId: string): boolean => {
    const spaceId = pages?.find((p) => p.id === pageId)?.space_id
    return spaces?.find((s) => s.id === spaceId)?.my_role !== 'viewer'
  }

  return (
    <div
      className={
        'app' +
        (sidebarCollapsed ? ' sidebar-collapsed' : '') +
        (sidebarCollapsed && sidebarPeek !== 'off' ? ' sidebar-peek' : '') +
        (sidebarCollapsed && sidebarPeek === 'out' ? ' sidebar-peek-out' : '') +
        (sidebarResizing ? ' sidebar-resizing' : '')
      }
    >
      {/* 左缘热区：只在折叠态渲染。纯几何元素，悬停判定统一由 Shell 的 mousemove + :hover 复核（见上） */}
      {sidebarCollapsed && <div className="sidebar-zone" aria-hidden="true" />}
      <Sidebar
        pages={pages}
        spaces={spaces}
        selectedSpaceId={selectedSpaceId}
        onSelectSpace={setSelectedSpaceId}
        onChanged={refresh}
        onPagesRemoved={dropPages}
        onPageCreated={addPage}
        user={user}
        onLogout={logout}
        onAvatarChange={changeAvatar}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
      />
      {/* 桌面专属的宽度拖拽手柄：贴侧栏右缘的 6px 热区，拖动实时写 --sidebar-w（见 startSidebarResize）。
          CSS 只在 ≥769px 渲染它（手机抽屉固定 260px）；折叠态无宽度可言，不渲染 */}
      {!sidebarCollapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={COPY.side.resize}
          onPointerDown={startSidebarResize}
        />
      )}
      {/* 手机端抽屉没有悬停预览：折叠态保留左上角浮动展开按钮作唯一入口（桌面由 CSS 隐藏） */}
      {sidebarCollapsed && (
        <button className="btn-expand" title={COPY.side.expand} onClick={toggleSidebar}>
          <Icon name="panel-expand" />
        </button>
      )}
      {/* 手机端抽屉遮罩：点外侧任意位置收回（桌面 display:none 不渲染影响）。
          遮罩只在展开态出现，切换走 toggleSidebar（收起并清悬停预览，与桌面折叠同一入口） */}
      {!sidebarCollapsed && <div className="sidebar-scrim" onClick={toggleSidebar} />}
      <main className="main">
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/admin" element={<Lazy><Admin /></Lazy>} />
          <Route path="/join/:token" element={<Lazy><Join onChanged={refresh} /></Lazy>} />
          <Route path="/connect/:code" element={<Lazy><ConnectMachine spaces={spaces} selectedSpaceId={selectedSpaceId} /></Lazy>} />
          <Route
            path="/"
            element={
              <Home
                pages={pages}
                spaces={spaces}
                selectedSpaceId={selectedSpaceId}
                onChanged={refresh}
                hydrated={hydrated}
              />
            }
          />
          <Route path="/inbox" element={<Lazy><InboxPage /></Lazy>} />
          <Route path="/memory" element={<Lazy><MemoryPanel space={spaces?.find((s) => s.id === selectedSpaceId) ?? null} /></Lazy>} />
          <Route
            path="/skills"
            element={<Lazy><SkillLibrary space={spaces?.find((s) => s.id === selectedSpaceId) ?? null} pages={pages} onChanged={refresh} /></Lazy>}
          />
          <Route
            path="/page/:id"
            element={
              <PageRoute
                pages={pages}
                spaces={spaces}
                onChanged={refresh}
                user={user}
                onTitleLive={patchPageTitle}
              />
            }
          />
        </Routes>
      </main>
      {/* 右上角工作台：当前页在飞的一轮浮一条岛，点开是总览 / 步骤 / 任务 / 改动 / 协作（hud/） */}
      <HudLayer canStop={canWritePage} />
      {/* 命令面板（⌘K）：页面、这一轮、常用命令（palette/） */}
      <CommandPalette pages={pages ?? []} spaceId={selectedSpaceId} canWritePage={canWritePage} onCreated={refresh} />
      {/* 项目面板（⌘E）：agent 所在机器的工作区（文件 / 改动），只在页面的 agent 是自己能用的机器时出现 */}
      <ProjectDock canWrite={canWritePage} runsOf={(pageId) => recentRunPages(pages, pageId)} />
    </div>
  )
}

/** /page/:id：按页面所属空间的 my_role 算 readOnly/canPublish 传给编辑器（viewer 只读，只有 owner 能发布，
 *  全局 admin 也不例外） */
function PageRoute({
  pages,
  spaces,
  onChanged,
  user,
  onTitleLive,
}: {
  pages: Page[] | null
  spaces: Space[] | null
  onChanged: () => void
  user: User
  onTitleLive: (id: string, title: string) => void
}) {
  const { id } = useParams<{ id: string }>()
  const page = pages?.find((p) => p.id === id) ?? null
  const space = page?.space_id ? spaces?.find((s) => s.id === page.space_id) : undefined
  const readOnly = spaceReadOnly(spaces, page?.space_id)
  // 公开态只有 doc 页承载（过程页跟着父文档走，skill 页是空间内部的做事方法）：源头不给入口，不靠各处特判
  const canPublish = page?.kind === 'doc' && space?.my_role === 'owner'
  // 列表还没到时先不挂：viewer 只读要等空间角色，避免先按可写建编辑器再拆掉。
  // 过程页与普通页走同一个编辑器（正文是协同文档）；集合页没有正文，走自己的页面（collection/CollectionPage.tsx）
  if (pages === null) return null
  if (page?.kind === 'collection') {
    return <CollectionPage pages={pages} onChanged={onChanged} onTitleLive={onTitleLive} username={user.username} readOnly={readOnly} />
  }
  return (
    <EditorPage
      pages={pages}
      onChanged={onChanged}
      onTitleLive={onTitleLive}
      username={user.username}
      readOnly={readOnly}
      canPublish={canPublish}
    />
  )
}

/** 根路径：跳到所选空间的第一个页面；该空间没有页面就显示空提示，不自动建页
 *  （新空间默认没有页面和目录树，由用户显式建：侧栏空态「新建页面」或页面树 ＋）。 */
function Home({
  pages,
  spaces,
  selectedSpaceId,
  onChanged,
  hydrated,
}: {
  pages: Page[] | null
  spaces: Space[] | null
  selectedSpaceId: string | null
  onChanged: () => void
  /** 列表缓存已被首个 GET 校准。置位前播种数据只喂展示：不跳页、不自动建页，
   *  避免陈旧缓存触发建页或跳进已删页 */
  hydrated: boolean
}) {
  const navigate = useNavigate()
  const navigating = useRef(false)
  const [searchParams] = useSearchParams()
  // 有待消费的 ?space= 时先不动：等 Shell 选好目标空间再跳/建页，避免落进旧空间
  const waitingSpaceQuery = searchParams.get('space') !== null

  const targetSpaceId = selectedSpaceId
  const space = spaces?.find((s) => s.id === targetSpaceId) ?? null
  const scoped =
    pages === null
      ? null
      : targetSpaceId
        ? pages.filter((p) => p.space_id === targetSpaceId)
        : pages
  // 空空间只提示，不写库
  const emptyForViewer = scoped !== null && scoped.length === 0 && space !== null

  useEffect(() => {
    // 等就绪再动作：spaces 未到时目标空间还是 null，会跳错空间；hydrated 前播种列表
    // 未经服务端校准，跳页/建页决策不能吃陈旧缓存（跳进已删页、陈旧空空间误建页）
    if (
      !hydrated ||
      !pages ||
      !spaces ||
      !targetSpaceId ||
      waitingSpaceQuery ||
      navigating.current ||
      emptyForViewer
    )
      return
    navigating.current = true
    // 空空间不建页：保持空提示，跳页由用户在侧栏空态/页面树 ＋ 显式发起。
    // 优先打开页面树里的页；只有目录树文档时才落到那些页（它们不在页面树里，但仍然是这个空间的页）
    const inSpace = pages.filter((p) => p.space_id === targetSpaceId)
    const first = pagesInPageTree(inSpace)[0] ?? inSpace[0]
    if (!first) return
    navigate(`/page/${first.id}`, { replace: true })
  }, [
    hydrated,
    pages,
    spaces,
    targetSpaceId,
    waitingSpaceQuery,
    emptyForViewer,
    navigate,
    onChanged,
  ])

  if (emptyForViewer) return <div className="loading">{COPY.side.noPages}</div>
  return <div className="loading">{COPY.loading}</div>
}
