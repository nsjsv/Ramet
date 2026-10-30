/* ---------- 页面树内容 ----------
 * TreeItem/buildTree/pageDrag/armDragEndCleanup、树上改名同步（syncTitleToDoc）。
 * <PageTreeBoard> 只渲染页面树的 <nav>（section 外壳 / 头部归 Boards.tsx）：行 = 空间顶层页
 * （parent_id null）及其子树，没有包装根页，也没有实体行（树由 pages.space_id 派生）。
 * 拖拽 / 展开 / 改名状态按空间 id 各自独立，模块级 pageDrag 单例全模块共享。
 * dropBoundaryAt 不钳根页：parent_id null 就是合法空间顶层，深空白落点即顶层末尾。 */
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { api, type Page } from './api'
import { COPY } from './copy'
import { PageIcon } from './PageIcon'
import { Icon } from './icons'
import { blockDragTarget, moveBlockToPage } from './editor/page-drop'
import { writeTitleFragment } from './editor/title-fragment'
import { usePersistentSet } from './tree-state'
import { peekDirPageDrag, takeDirPageDrag } from './tree-drag'

export interface PageNode extends Page {
  children: PageNode[]
}

/* 树行可拖 = 把该页挂到拖放目标页下（PATCH parent_id，防环 / 同空间校验在服务端）。
 * 与「拖块进页」（编辑器块拖到树行，editor/page-drop.ts）并存：dragover 先判页面拖拽源
 * （本模块单例），再判块拖拽源。dragend 不冒泡但捕获路径必经 document，捕获 once 清源，
 * 不留陈旧源误导下一次 dragover。 */
function subtreeIds(node: PageNode): Set<string> {
  const ids = new Set<string>()
  const walk = (n: PageNode): void => {
    ids.add(n.id)
    n.children.forEach(walk)
  }
  walk(node)
  return ids
}

/** kind：只有文档页能拖进集合成为行（集合 / 过程页 / skill 页不是行），也只有它能拖进目录树 */
export type PageDrag = { id: string; subtree: Set<string>; kind: Page['kind'] }
let pageDrag: PageDrag | null = null

/** 页面树的落点接受的拖拽源：本树的页，或目录树拖来的页面条目（dirItemId；它在页面树里没有子树，
 *  也不能进集合 —— 集合的行要按集合的列来，服务端不收） */
type TreeDrag = PageDrag & { dirItemId?: string }
function activeDrag(): TreeDrag | null {
  if (pageDrag) return pageDrag
  const dir = peekDirPageDrag()
  return dir ? { id: dir.pageId, subtree: new Set([dir.pageId]), kind: 'doc', dirItemId: dir.itemId } : null
}
const intoCollectionOk = (d: TreeDrag): boolean => d.kind === 'doc' && !d.dirItemId

/** 目录树（FolderTree.tsx）也接页面树拖来的页：dragover 现读，drop 取走（清源，免得页面树的 nav 再处理一遍） */
export function peekPageDrag(): PageDrag | null {
  return pageDrag
}
export function takePageDrag(): PageDrag | null {
  const d = pageDrag
  pageDrag = null
  return d
}

/** 树行 dragover 高亮 / 树插入线的收尾：drop 落进缝隙 / 列表末尾 / 拖拽被取消时，行收不到
 * drop/dragleave，高亮或插入线会卡住，所以在高亮首次出现时武装一次 document 捕获 dragend
 * （dragend 不冒泡但捕获路径必经 document）。行高亮与插入线分槽存，dragend 两个都清
 * （拖拽中两者交替出现，最后一次注册的收尾不能顶掉另一种的） */
const dragEndCleanups: { row?: () => void; line?: () => void } = {}
let dragEndArmed = false

function armDragEndCleanup(kind: 'row' | 'line', cleanup: () => void): void {
  dragEndCleanups[kind] = cleanup
  if (dragEndArmed) return
  dragEndArmed = true
  document.addEventListener(
    'dragend',
    () => {
      dragEndArmed = false
      dragEndCleanups.row?.()
      dragEndCleanups.line?.()
      delete dragEndCleanups.row
      delete dragEndCleanups.line
    },
    { capture: true, once: true },
  )
}

/** 平铺数组 → 树（孤儿节点当顶层处理） */
function buildTree(pages: Page[]): PageNode[] {
  const nodes = new Map<string, PageNode>(pages.map((p) => [p.id, { ...p, children: [] }]))
  const roots: PageNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** dev 走 vite proxy，prod 同源直连：一律由 location.host 推导 */
function collabUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/collab`
}

/* 树上改名同步到该页 Yjs title fragment：REST 先行，这里补同步，用独立的瞬时 provider，写完即毁。
 * 失败互不阻断（各自 console.error），最终一致：
 * 正打开该页的另一端编辑器由 ySync 即时跟名，其 observeDeep 防抖会把相同值再写一次 DB（幂等无害）；
 * 若 sync 超时没拿到段落结构（旧页未播种的兜底路径），自建单段，形状与服务端播种一致。 */
async function syncTitleToDoc(id: string, draft: string): Promise<void> {
  const provider = new HocuspocusProvider({ url: collabUrl(), name: `page:${id}` })
  try {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 2000) // 超时兜底：即便 sync 未达也尝试写入
      provider.on('synced', () => {
        window.clearTimeout(timer)
        resolve()
      })
    })
    writeTitleFragment(provider.document.getXmlFragment('title'), draft)
  } catch (err) {
    console.error(err)
  } finally {
    provider.destroy()
  }
}

interface TreeCallbacks {
  /** 展开的节点 id 集合：默认空 = 全部收起，点箭头才展开 */
  expanded: Set<string>
  renamingId: string | null
  /** 只读空间（viewer）：隐藏新建 / 删除，禁用双击重命名与拖拽（REST 写会 403） */
  readOnly: boolean
  onToggle: (id: string) => void
  onRenameStart: (id: string | null) => void
  onRenameCommit: (id: string, draft: string) => void
  onCreateChild: (parentId: string | null) => void
  onRemove: (node: PageNode) => void
  /** 树拖拽挪父级 / 排序：源页插到目标父页子列表的 index 位（index 缺省 = 服务端不重排）；
   *  targetParentId=null = 挪回顶层（追加到根末尾）。不自动展开目标行 */
  onMovePage: (sourceId: string, targetParentId: string | null, index?: number) => void
  /** 目录树的页面条目落进页面树：targetParentId null = 空间顶层 */
  onMoveFromDir: (itemId: string, targetParentId: string | null, index?: number) => void
}

/**
 * 页面树的内容区：行 = 空间顶层页森林（页面树是空间的派生视图，无实体行）。
 * 行用现有 listPages 全量（scopedPages）构建，不新增请求；展开态按空间 id 记忆。 */
export function PageTreeBoard({
  spaceId,
  pages,
  readOnly,
  onCreateChild,
  onRemove,
  onChanged,
}: {
  /** 页面树所属空间（无实体 id：树由空间派生） */
  spaceId: string
  /** 当前空间的页面（Sidebar 的 listPages 结果按 space 过滤）；null = 加载中 */
  pages: Page[] | null
  readOnly: boolean
  onCreateChild: (parentId: string | null) => void
  onRemove: (node: PageNode) => void
  onChanged: () => void
}) {
  // 展开态跨刷新保持（localStorage，按空间 id 分：各空间的页面树互不干扰）
  const [expanded, toggle] = usePersistentSet('ramet.tree.pages.' + spaceId)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // 拖页面的插入线：parentId/index = 兄弟插入边界（parentId null = 空间顶层），y/left/width = 线的渲染位置
  const [dropLine, setDropLine] = useState<
    { parentId: string | null; index: number; y: number; left: number; width: number; key: string } | null
  >(null)

  // 行 = 空间顶层页（parent_id null）及其子树；组不成树的孤儿页由 buildTree 当顶层兜底
  const rows = pages === null ? null : buildTree(pages)

  async function commitRename(id: string, draft: string) {
    setRenamingId(null)
    const current = pages?.find((p) => p.id === id)
    if (!current || draft === current.title) return
    try {
      await api.renamePage(id, draft)
      onChanged()
    } catch (err) {
      console.error(err)
    }
    // REST 之后写进该页 Yjs：正打开该页的另一端编辑器标题即时跟随
    void syncTitleToDoc(id, draft)
  }

  // 树拖拽挪父级 / 排序：PATCH parent_id + index（同父重排时只发 index）。换父时父页正文里的入口（子页面块）
  // 由服务端随这次 PATCH 一起改：新父页补、旧父页摘，补不上整个移动不生效。
  // index 缺省 = 服务端不重排（保持原 position）。不自动展开目标行
  async function movePage(sourceId: string, targetParentId: string | null, index?: number) {
    try {
      await api.movePage(sourceId, targetParentId, index)
    } catch (err) {
      console.error(err)
      const cycle = err instanceof Error && err.message === 'parent_id would create a cycle'
      window.alert(cycle ? COPY.tree.moveIntoSelf : COPY.tree.moveFailed)
      return
    }
    onChanged()
  }

  // 目录树的页拖进来：摘挂载、进页面树、挂父页并在父页正文补入口，全在服务端一个请求里（失败整体不生效）
  async function moveFromDir(itemId: string, targetParentId: string | null, index?: number) {
    try {
      await api.moveItemToPageTree(itemId, targetParentId, index)
    } catch (err) {
      console.error(err)
      window.alert(err instanceof Error && err.message ? err.message : COPY.tree.moveFailed)
    }
    onChanged()
  }

  /** 页面拖拽的插入边界：clientY 落在哪一行的上 / 下半，就取该行的上 / 下边界（同父兄弟插入）。
   *  顶带是第一行上边界；深空白（末行下缘 8px 外）是挪到空间顶层末尾（parent_id null）。
   *  非法落点（边界父页在拖拽页自己的子树里）返回 null */
  function dropBoundaryAt(nav: HTMLElement, clientY: number, dragged: { id: string; subtree: Set<string> }) {
    const navRect = nav.getBoundingClientRect()
    const rows = Array.from(nav.querySelectorAll<HTMLElement>('.tree-item'))
    if (!rows.length) return null
    const infos = rows.map((el) => {
      const r = el.getBoundingClientRect()
      const id = el.querySelector('.tree-label')?.getAttribute('href')?.slice('/page/'.length) ?? ''
      const page = pages?.find((p) => p.id === id)
      return { r, id, page }
    })
    if (!infos[0]) return null
    const sibIndexOf = (x: (typeof infos)[number]): number => {
      const siblings = (pages ?? []).filter((p) => (p.parent_id ?? null) === (x.page?.parent_id ?? null))
      return Math.max(0, siblings.findIndex((p) => p.id === x.id))
    }
    // 行的 parent_id 直接当边界父（null = 空间顶层，合法）：空间内可任意重排，
    // 不把顶层边界钳到某个根页（包装根页的模型会把页面踢出可见子树）
    const siblingBoundary = (rowParent: string | null, idx: number): { parentId: string | null; index: number } =>
      ({ parentId: rowParent, index: idx })
    const mk = (x: (typeof infos)[number], y: number, key: string, b: { parentId: string | null; index: number }) => ({
      parentId: b.parentId,
      index: b.index,
      y: y - navRect.top + nav.scrollTop,
      left: x.r.left - navRect.left + nav.scrollLeft + 6,
      width: Math.max(80, x.r.width - 12),
      key,
    })
    // 落点合法性：父页不能在拖拽页自己的子树里（防环）；parent null 合法，只拦自环
    const ok = (b: { parentId: string | null; index: number }): boolean =>
      b.parentId === null || (!dragged.subtree.has(b.parentId) && b.parentId !== dragged.id)
    // 顶带（第一行上缘以上）= 第一行的上边界
    if (clientY <= infos[0].r.top) {
      const x = infos[0]
      if (dragged.subtree.has(x.id)) return null
      const b = siblingBoundary(x.page?.parent_id ?? null, sibIndexOf(x))
      return ok(b) ? mk(x, x.r.top, `top:${x.id}`, b) : null
    }
    // 命中行三区：中带（25%~75%）返回 null（行自己接管，变子页高亮）；上 / 下边缘取上 / 下边界线
    const hit = infos.find((x) => clientY >= x.r.top && clientY <= x.r.bottom)
    if (hit) {
      const rel = (clientY - hit.r.top) / Math.max(1, hit.r.height)
      if (rel >= 0.25 && rel <= 0.75) return null
      const above = rel < 0.5
      const b = siblingBoundary(hit.page?.parent_id ?? null, sibIndexOf(hit) + (above ? 0 : 1))
      if (!ok(b)) return null
      return mk(hit, above ? hit.r.top : hit.r.bottom, `${b.parentId}:${b.index}`, b)
    }
    // 行下缘窄缝（≤8px）= 该行的下边界
    const aboveLast = infos.filter((x) => x.r.top <= clientY)
    const near = aboveLast[aboveLast.length - 1]
    if (near && clientY <= near.r.bottom + 8) {
      const b = siblingBoundary(near.page?.parent_id ?? null, sibIndexOf(near) + 1)
      if (!ok(b)) return null
      return mk(near, near.r.bottom, `${b.parentId}:${b.index}`, b)
    }
    // 深空白 = 挪到空间顶层末尾（顶层是合法状态，直接产出 parent_id null）
    const lastInfo = infos[infos.length - 1]!
    const topCount = (pages ?? []).filter((p) => p.parent_id === null).length
    return mk(lastInfo, lastInfo.r.bottom + 4, 'root', { parentId: null, index: topCount })
  }

  const callbacks: TreeCallbacks = {
    expanded,
    renamingId,
    readOnly,
    onToggle: toggle,
    onRenameStart: setRenamingId,
    onRenameCommit: (id, draft) => void commitRename(id, draft),
    onCreateChild: (parentId) => onCreateChild(parentId),
    onRemove: (node) => onRemove(node),
    onMovePage: (sourceId, targetId, index) => void movePage(sourceId, targetId, index),
    onMoveFromDir: (itemId, targetId, index) => void moveFromDir(itemId, targetId, index),
  }

  return (
    // 树拖放（页面拖拽）= 插入线模型：悬停行的上 / 下半，行上 / 行下显示插入线，松手把页面
    // 插成该边界处的兄弟（同父排序）；列表末行 8px 外的深空白 = 挪到空间顶层。
    // 页面拖拽的 dragover/drop 全部由 nav 统一接管（行命中也冒泡到这里）；块拖拽的高亮 / 接收
    // 仍由行自己处理，nav 对块拖拽直接放行
    <nav
      className="tree"
      onDragOver={(e) => {
        if (readOnly) return
        const pg = activeDrag()
        if (!pg) return // 块拖拽：行自己接管
        const boundary = dropBoundaryAt(e.currentTarget, e.clientY, pg)
        if (!boundary) {
          setDropLine(null) // 中带（行接管变子页）/非法落点：摘掉插入线（框与线互斥）
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropLine((prev) => (prev && prev.key === boundary.key ? prev : boundary))
        armDragEndCleanup('line', () => setDropLine(null))
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropLine(null)
      }}
      onDrop={(e) => {
        if (readOnly) return
        const pg = activeDrag()
        if (!pg) return // 块拖拽：行自己接管
        const boundary = dropBoundaryAt(e.currentTarget, e.clientY, pg)
        if (!boundary) return
        e.preventDefault()
        pageDrag = null
        setDropLine(null)
        if (pg.dirItemId) {
          takeDirPageDrag()
          void moveFromDir(pg.dirItemId, boundary.parentId, boundary.index)
        } else void movePage(pg.id, boundary.parentId, boundary.index)
      }}
    >
      {dropLine && (
        <div
          className="tree-drop-line"
          style={{ top: dropLine.y, left: dropLine.left, width: dropLine.width }}
        />
      )}
      {rows === null && <div className="tree-empty">{COPY.loading}</div>}
      {rows !== null && rows.length === 0 && <div className="tree-empty">{COPY.tree.pageTreeEmpty}</div>}
      {rows?.map((node) => (
        <TreeItem key={node.id} node={node} depth={0} {...callbacks} />
      ))}
    </nav>
  )
}

function TreeItem({ node, depth, ...cb }: TreeCallbacks & { node: PageNode; depth: number }) {
  // 集合在侧栏是叶子：行不进侧栏，从集合视图、搜索、@ 进入
  const isCollection = node.kind === 'collection'
  const hasChildren = !isCollection && node.children.length > 0
  const expanded = hasChildren && cb.expanded.has(node.id)
  // 拖块进页：编辑器手柄拖来的顶层块落到树行 = 整块进该页（editor/page-drop.ts）。
  // 拖树行 = 挪页面：落到别的树行就挂到该页下。拖进自己 / 自己的子树是非法落点（防环，
  // 服务端 400 兜底）。与块拖拽并存：先判页面拖拽源，再判块拖拽源。
  // 两类拖拽源都是模块级可变量（dragstart 才置位、不触发重渲染），必须在事件回调里现读，
  // 不能提成渲染期布尔（stale 闭包会让 dragover 判空 → 落点永远不亮）
  const [dropOver, setDropOver] = useState(false)
  const dropOk = (): boolean => {
    if (cb.readOnly) return false
    const pg = activeDrag()
    if (pg) return !pg.subtree.has(node.id)
    // 拖块进页对集合禁用：集合页没有正文
    return !isCollection && blockDragTarget(node.id) !== null
  }

  return (
    <>
      <div
        className={'tree-item' + (dropOver ? ' droptarget' : '')}
        style={{ '--depth': depth } as React.CSSProperties}
        draggable={!cb.readOnly}
        onDragStart={(e) => {
          // 从按钮/改名输入框起手不算拖页面（输入框有自己的文字拖拽）
          if (cb.readOnly || (e.target as HTMLElement).closest('button, input')) return
          pageDrag = { id: node.id, subtree: subtreeIds(node), kind: node.kind }
          e.dataTransfer.effectAllowed = 'move'
          document.addEventListener(
            'dragend',
            () => {
              pageDrag = null
            },
            { capture: true, once: true },
          )
        }}
        onDragOver={(e) => {
          // 页面拖拽三区：中带(25%~75%) = 变子页高亮（行自己接管）；上下边缘 = nav 画插入线
          const pg = cb.readOnly ? null : activeDrag()
          if (pg) {
            const r = e.currentTarget.getBoundingClientRect()
            const rel = (e.clientY - r.top) / Math.max(1, r.height)
            if (rel < 0.25 || rel > 0.75) {
              setDropOver(false) // 移到边缘：摘掉变子页框（框与线互斥）
              return // 边缘区：nav 接管排序线
            }
            if (pg.id === node.id || pg.subtree.has(node.id) || (isCollection && !intoCollectionOk(pg))) {
              setDropOver(false) // 拖进自己/自己子树、非文档页拖进集合：非法，摘框
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            armDragEndCleanup('row', () => setDropOver(false))
            setDropOver(true)
            return
          }
          if (!dropOk()) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          armDragEndCleanup('row', () => setDropOver(false))
          setDropOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false)
        }}
        onDrop={(e) => {
          setDropOver(false)
          const pg = cb.readOnly ? null : activeDrag()
          if (pg) {
            // 中带落点 = 变子页：挂到该页下（子列表末尾），镜像同步在 movePage 里
            const r = e.currentTarget.getBoundingClientRect()
            const rel = (e.clientY - r.top) / Math.max(1, r.height)
            if (rel < 0.25 || rel > 0.75) return // 边缘区：nav 接管排序线
            if (pg.id === node.id || pg.subtree.has(node.id) || (isCollection && !intoCollectionOk(pg))) return
            e.preventDefault()
            if (pg.dirItemId) {
              takeDirPageDrag()
              cb.onMoveFromDir(pg.dirItemId, node.id, node.children.length)
              return
            }
            const sourceId = pg.id
            pageDrag = null
            // 拖进集合 = 成为行：不带 index（带了服务端会把集合所有行的 position 整列重编号），新行落在手动顺序末尾
            cb.onMovePage(sourceId, node.id, isCollection ? undefined : node.children.length)
            return
          }
          if (!dropOk()) return
          e.preventDefault()
          const src = blockDragTarget(node.id)
          if (!src) return
          void moveBlockToPage(src.pageId, src.blockId, node.id)
        }}
      >
        {/* 图标与折叠箭头融合成同一 18px 槽位（Notion 同款）：平时显图标，行悬停/键盘聚焦箭头时显箭头
            （展开态不参与接管，鼠标移开回到图标）。叶子行不渲染箭头；
            展开/折叠语义全在箭头按钮上，与树行拖拽（button/input 起手不拖页）互不干扰 */}
        <span className={'tree-twisty' + (hasChildren ? ' parent' : '')}>
          {hasChildren && (
            <button
              className="arrow"
              onClick={() => cb.onToggle(node.id)}
              title={expanded ? COPY.tree.collapse : COPY.tree.expand}
              aria-expanded={expanded}
            >
              <Icon name="chevron" size={12} className={'chev' + (expanded ? ' open' : '')} />
            </button>
          )}
          {isCollection && !node.icon ? (
            <Icon name="table" size={16} className="page-icon page-icon-sm" />
          ) : (
            <PageIcon icon={node.icon} placeholder />
          )}
        </span>
        {cb.renamingId === node.id ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={node.title}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') cb.onRenameStart(null)
            }}
            onBlur={(e) => cb.onRenameCommit(node.id, e.currentTarget.value)}
          />
        ) : (
          <NavLink
            to={`/page/${node.id}`}
            className={({ isActive }) => 'tree-label' + (isActive ? ' active' : '')}
            title={node.title || COPY.untitled}
            onDoubleClick={() => !cb.readOnly && cb.onRenameStart(node.id)}
            draggable={false}
          >
            {node.title || COPY.untitled}
          </NavLink>
        )}
        {!cb.readOnly && (
          <span className="tree-actions">
            {/* 集合的行从表格「+ 新建」建，不在侧栏建子页 */}
            {!isCollection && (
              <button className="icon-btn" title={COPY.tree.newChild} onClick={() => cb.onCreateChild(node.id)}>
                <Icon name="plus" size={14} />
              </button>
            )}
            <button className="icon-btn danger" title={COPY.tree.remove} onClick={() => cb.onRemove(node)}>
              <Icon name="x" size={14} />
            </button>
          </span>
        )}
      </div>
      {expanded &&
        node.children.map((child) => <TreeItem key={child.id} node={child} depth={depth + 1} {...cb} />)}
    </>
  )
}
