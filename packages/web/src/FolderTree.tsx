/* ---------- 目录树内容 ----------
 * FolderNode/buildForest、目录 / 条目拖拽单例（folderDrag/itemDrag）、dropBoundaryAt、DirRow/ItemRow、目录树内的 <nav>。
 * 目录树外壳（头部名称 / 折叠 / 菜单 / 创建菜单）在 Boards.tsx。
 * 展开态不在本文件持有：跨刷新记忆的所有者是 tree-state.ts 的 usePersistentSet（key 由
 * Boards 按目录树共用一条给出），这里只读 cb.expanded / 调 cb.onToggle。 */
import { useState } from 'react'
import type { BoardFolder, BoardItem } from './api'
import { COPY } from './copy'
import { PageIcon } from './PageIcon'
import { Icon } from './icons'

export interface FolderNode extends BoardFolder {
  children: FolderNode[]
  items: BoardItem[]
}

/** 平铺目录 → 目录树内组树（孤儿当顶层）；items 按 folder_id 归位到节点上（null = 目录树顶层条目，
 *  单独按 board_id 归位），展开渲染直接取 */
export function buildForest(
  folders: BoardFolder[],
  items: BoardItem[],
): { roots: Map<string, FolderNode[]>; rootItems: Map<string, BoardItem[]> } {
  const nodes = new Map<string, FolderNode>(folders.map((f) => [f.id, { ...f, children: [], items: [] }]))
  const roots = new Map<string, FolderNode[]>()
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined
    if (parent) parent.children.push(node)
    else {
      const list = roots.get(node.board_id) ?? []
      list.push(node)
      roots.set(node.board_id, list)
    }
  }
  const rootItems = new Map<string, BoardItem[]>()
  for (const it of items) {
    if (it.folder_id === null) {
      const list = rootItems.get(it.board_id) ?? []
      list.push(it)
      rootItems.set(it.board_id, list)
    } else nodes.get(it.folder_id)?.items.push(it)
  }
  return { roots, rootItems }
}

// 目录 / 条目拖拽（模块级单例，仅目录树用）
let folderDrag: { id: string; subtree: Set<string> } | null = null
let itemDrag: { id: string } | null = null

/** 与 PageTree 同款收尾：drop 落缝 / 取消时行收不到 dragleave，document 捕获 dragend 统一清 */
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

/** 悬浮菜单锚点：`board` 类型只由目录树头 ⋯ 使用（只剩删除项），目录行只用 folder/folder-plus */
/** page-plus = 页面树 section 头的 ＋（新建页面 / 新建集合），id 是空间 id */
export type MenuTarget = { type: 'board' | 'folder' | 'plus' | 'folder-plus' | 'page-plus'; id: string } | null
export type RenameTarget = { type: 'folder'; id: string } | null
/** 内联创建（自建输入框，替代 window.prompt）：目录树里新建目录的命名输入 */
export type CreatingTarget =
  | { type: 'folder'; boardId: string; parentId: string | null; cancel?: boolean }
  | null

/** 目录树拖拽插入边界（PageTree dropBoundaryAt 的目录版，行集 = 目录树内目录行 + 条目行），返回 null 表示由行自己接管：
 *  目录拖拽：目录行中带（25%~75%）返回 null（行接管，变子目录高亮）；目录行上 / 下边缘返回目录兄弟插入线；
 *  条目行返回 null（目录不落条目行）。条目拖拽：条目行上 / 下半（50% 分界）返回同目录条目兄弟插入线；
 *  目录行返回 null（整行接收拖进目录）。末行下缘 8px 外深空白挪回目录树顶层追加。
 *  非法落点（目录父在拖拽源子树里）也是 null */
function dropBoundaryAt(
  boardId: string,
  folders: BoardFolder[],
  items: BoardItem[],
  nav: HTMLElement,
  clientY: number,
  drag: { kind: 'folder' | 'item'; id: string; subtree: Set<string> },
) {
  const navRect = nav.getBoundingClientRect()
  const rows = Array.from(nav.querySelectorAll<HTMLElement>('.dir-row[data-dir], .dir-item[data-item]'))
  if (!rows.length) return null
  const byFolderId = new Map(folders.map((f) => [f.id, f]))
  const byItemId = new Map(items.map((it) => [it.id, it]))
  type DirRowInfo = { r: DOMRect; kind: 'folder'; folder: BoardFolder } | { r: DOMRect; kind: 'item'; item: BoardItem }
  const infos = rows.flatMap((el): DirRowInfo[] => {
    const r = el.getBoundingClientRect()
    if (el.dataset.dir) {
      const folder = byFolderId.get(el.dataset.dir)
      return folder ? [{ r, kind: 'folder' as const, folder }] : []
    }
    const item = byItemId.get(el.dataset.item ?? '')
    return item ? [{ r, kind: 'item' as const, item }] : []
  })
  if (!infos.length) return null
  const mk = (parentId: string | null, index: number, x: { r: DOMRect }, y: number, key: string) => ({
    boardId,
    parentId,
    index,
    y: y - navRect.top + nav.scrollTop,
    left: x.r.left - navRect.left + nav.scrollLeft + 6,
    width: Math.max(80, x.r.width - 12),
    key,
  })
  // 父落点在自己子树里非法（防环）
  const illegalFolder = (parent: string | null): boolean =>
    parent !== null && (drag.subtree.has(parent) || parent === drag.id)
  const folderSibIndex = (n: BoardFolder): number => {
    const sibs = folders.filter((f) => (f.parent_id ?? null) === (n.parent_id ?? null))
    return Math.max(0, sibs.findIndex((f) => f.id === n.id))
  }
  // 条目同级列表 = 同 folder_id 的条目（payload 已按展示序排好）；null = 目录树顶层条目
  const itemSibIndex = (it: BoardItem): number => {
    const sibs = items.filter((x) => (x.folder_id ?? null) === (it.folder_id ?? null))
    return Math.max(0, sibs.findIndex((x) => x.id === it.id))
  }
  const first = infos[0]! // infos 非空已保证
  if (clientY <= first.r.top) {
    // 目录 / 条目是两张独立列表（目录先渲染，根级条目垫底）：首行不是同类的行就没有落点
    if (drag.kind === 'folder') {
      if (first.kind !== 'folder') return null
      const parentId = first.folder.parent_id ?? null
      return illegalFolder(parentId)
        ? null
        : mk(parentId, folderSibIndex(first.folder), first, first.r.top, `top:${first.folder.id}`)
    }
    if (first.kind !== 'item') return null
    const parentId = first.item.folder_id ?? null
    return mk(parentId, itemSibIndex(first.item), first, first.r.top, `top:${first.item.id}`)
  }
  const hit = infos.find((x) => clientY >= x.r.top && clientY <= x.r.bottom)
  if (hit) {
    const rel = (clientY - hit.r.top) / Math.max(1, hit.r.height)
    if (drag.kind === 'folder') {
      if (hit.kind !== 'folder') return null // 目录不落条目行
      if (rel >= 0.25 && rel <= 0.75) return null // 中带 = 行自己接管（变子目录高亮）
      const above = rel < 0.5
      const parentId = hit.folder.parent_id ?? null
      const index = folderSibIndex(hit.folder) + (above ? 0 : 1)
      if (illegalFolder(parentId)) return null
      return mk(parentId, index, hit, above ? hit.r.top : hit.r.bottom, `${parentId}:${index}`)
    }
    if (hit.kind !== 'item') return null // 条目拖到目录行 = 行自己接管（拖进目录）
    const above = rel < 0.5
    const parentId = hit.item.folder_id ?? null
    const index = itemSibIndex(hit.item) + (above ? 0 : 1)
    return mk(parentId, index, hit, above ? hit.r.top : hit.r.bottom, `${parentId}:${index}`)
  }
  // 末行下缘窄缝（≤8px）= 该行同列表的下边界
  const aboveLast = infos.filter((x) => x.r.top <= clientY)
  const near = aboveLast[aboveLast.length - 1]
  if (near && clientY <= near.r.bottom + 8) {
    if (drag.kind === 'folder') {
      if (near.kind !== 'folder') return null
      const parentId = near.folder.parent_id ?? null
      if (illegalFolder(parentId)) return null
      return mk(parentId, folderSibIndex(near.folder) + 1, near, near.r.bottom, `${parentId}:gap`)
    }
    if (near.kind !== 'item') return null
    const parentId = near.item.folder_id ?? null
    return mk(parentId, itemSibIndex(near.item) + 1, near, near.r.bottom, `${parentId}:gap`)
  }
  // 深空白 = 挪回目录树顶层追加（目录/条目各回各列表末尾）
  const last = infos[infos.length - 1]
  if (!last) return null
  if (drag.kind === 'folder') {
    return mk(null, folders.filter((f) => !f.parent_id).length, last, last.r.bottom + 4, 'root')
  }
  return mk(null, items.filter((it) => !it.folder_id).length, last, last.r.bottom + 4, 'root')
}

/** 目录行的回调集：全部由 Boards（目录树外壳）提供，创建 / 改名 / 菜单 / 上传的 state 都在那边 */
export interface FolderTreeCallbacks {
  expanded: Set<string>
  renaming: RenameTarget
  menu: MenuTarget
  /** 内联创建目标（子目录命名输入行显示在对应父目录内并强制展开） */
  creating: CreatingTarget
  onToggle: (id: string) => void
  onRenameStart: (t: RenameTarget) => void
  onRenameCommit: (t: Exclude<RenameTarget, null>, draft: string) => void
  onMenu: (t: MenuTarget, e?: React.MouseEvent) => void
  /** 悬浮菜单锚点样式（fixed 坐标，父组件在打开时计算） */
  menuStyle: React.CSSProperties | undefined
  onCommitCreate: (draft: string) => void
  onCancelCreate: () => void
  /** 行 ＋：开始内联建子目录（父组件记 creating 目标，输入行渲染在该目录内） */
  onCreateChild: (parentId: string) => void
  /** 行 ＋：在该目录下建文档（在目录树所属空间建顶层页并挂进来，与目录树头「创建文档」同一条链路） */
  onCreateDoc: (folderId: string) => void
  onDeleteFolder: (id: string) => void
  /** 目录拖拽中带落点 = 变子目录（挂到该目录子列表末尾） */
  onMoveFolderChild: (sourceId: string, parentId: string) => void
  /** nav 插入线落点 = 挪到指定父级与序号（根级 = parentId null） */
  onMoveFolder: (id: string, parentId: string | null, index: number) => void
  onAttachFile: (folderId: string) => void
  onMoveItem: (itemId: string, folderId: string) => void
  /** nav 插入线落点 = 条目挪到指定父级与序号 */
  onMoveItemTo: (id: string, parentId: string | null, index: number) => void
  onDetachItem: (item: BoardItem) => void
  onNavigate: (pageId: string) => void
  /** 防环子树计算用（目录树全量扁平目录） */
  folders: BoardFolder[]
}

/** 目录树的内容区：<nav> 承载全部行 + 拖拽插入线 + 顶层内联创建输入 */
export function FolderTreeBoard({
  board,
  roots,
  rootItems,
  folders,
  items,
  cb,
}: {
  board: { id: string }
  roots: FolderNode[]
  rootItems: BoardItem[]
  folders: BoardFolder[]
  items: BoardItem[]
  cb: FolderTreeCallbacks
}) {
  /** 插入线（目录拖拽排序）：y/left/width 相对本 nav；boardId 只用于渲染守卫 */
  const [dropLine, setDropLine] = useState<
    { boardId: string; parentId: string | null; index: number; y: number; left: number; width: number; key: string } | null
  >(null)

  return (
    <nav
      className="tree"
      onDragOver={(e) => {
        // 拖拽源：目录拖拽带子树防环；条目拖拽叶子无子树。行自己接管的落点（目录行中带/
        // 条目拖到目录行）由 dropBoundaryAt 返回 null，行高亮接管
        const d = folderDrag
          ? { kind: 'folder' as const, id: folderDrag.id, subtree: folderDrag.subtree }
          : itemDrag
            ? { kind: 'item' as const, id: itemDrag.id, subtree: new Set<string>() }
            : null
        if (!d) return
        const boundary = dropBoundaryAt(board.id, folders, items, e.currentTarget, e.clientY, d)
        if (!boundary) {
          setDropLine(null)
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
        const d = folderDrag
          ? { kind: 'folder' as const, id: folderDrag.id, subtree: folderDrag.subtree }
          : itemDrag
            ? { kind: 'item' as const, id: itemDrag.id, subtree: new Set<string>() }
            : null
        if (!d) return
        const boundary = dropBoundaryAt(board.id, folders, items, e.currentTarget, e.clientY, d)
        if (!boundary) return
        e.preventDefault()
        folderDrag = null
        itemDrag = null
        setDropLine(null)
        if (d.kind === 'folder') cb.onMoveFolder(d.id, boundary.parentId, boundary.index)
        else cb.onMoveItemTo(d.id, boundary.parentId, boundary.index)
      }}
    >
      {dropLine?.boardId === board.id && (
        <div
          className="tree-drop-line"
          style={{ top: dropLine.y, left: dropLine.left, width: dropLine.width }}
        />
      )}
      {cb.creating?.type === 'folder' && cb.creating.boardId === board.id && cb.creating.parentId === null && !cb.creating.cancel && (
        <div className="tree-item dir-row">
          <input
            className="rename-input dir-create-input"
            autoFocus
            placeholder={COPY.tree.folderName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') {
                e.currentTarget.dataset.cancel = '1'
                cb.onCancelCreate()
              }
            }}
            onBlur={(e) => {
              if (e.currentTarget.dataset.cancel) return
              cb.onCommitCreate(e.currentTarget.value)
            }}
          />
        </div>
      )}
      {roots.length === 0 && rootItems.length === 0 && !cb.creating && (
        <div className="tree-empty">{COPY.tree.dirTreeEmpty}</div>
      )}
      {roots.map((node) => (
        <DirRow key={node.id} node={node} depth={0} cb={cb} />
      ))}
      {rootItems.map((it) => (
        <ItemRow key={it.id} item={it} depth={0} cb={cb} />
      ))}
    </nav>
  )
}

function DirRow({ node, depth, cb }: { node: FolderNode; depth: number; cb: FolderTreeCallbacks }) {
  const hasChildren = node.children.length > 0 || node.items.length > 0
  const creatingChildHere = cb.creating?.type === 'folder' && cb.creating.parentId === node.id && !cb.creating.cancel
  // 建子目录的输入行放在父目录内：强制展开
  const isOpen = creatingChildHere || (hasChildren && cb.expanded.has(node.id))
  const [dropOver, setDropOver] = useState(false)
  const renaming = cb.renaming?.type === 'folder' && cb.renaming.id === node.id
  const menuOpen = cb.menu?.type === 'folder' && cb.menu.id === node.id

  return (
    <>
      <div
        className={'tree-item dir-row' + (dropOver ? ' droptarget' : '')}
        data-dir={node.id}
        style={{ '--depth': depth } as React.CSSProperties}
        draggable
        /* 整行可点 = 展开 / 折叠（叶子行无子节点则无动作）；
           行内的 ＋/⋯/菜单/改名输入各自处理，点击不吃这一发（箭头按钮不单独绑 onClick，
           它落在行上、由这里统一 toggle，键盘 Enter/Space 触发的 click 同样走这条路） */
        onClick={(e) => {
          if (!hasChildren) return
          // 双击 = 改名（label 的 onDoubleClick）：detail=2 的这一发不 toggle，否则折叠态
          // 会被双击的第一发展开、第二发又收回，看着闪一下
          if (e.detail > 1) return
          if ((e.target as HTMLElement).closest('.tree-actions, .dir-menu, input')) return
          cb.onToggle(node.id)
        }}
        onDragStart={(e) => {
          // 从按钮 / 改名输入框起手不算拖目录
          if ((e.target as HTMLElement).closest('button, input')) return
          e.stopPropagation()
          folderDrag = { id: node.id, subtree: subtreeIdsOf(node, cb.folders) }
          itemDrag = null
          e.dataTransfer.effectAllowed = 'move'
          document.addEventListener('dragend', () => { folderDrag = null }, { capture: true, once: true })
        }}
        onDragOver={(e) => {
          if (itemDrag) {
            // 条目拖到目录行 = 移动（无插入线，整行接收）
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            armDragEndCleanup('row', () => setDropOver(false))
            setDropOver(true)
            return
          }
          if (!folderDrag) return
          const r = e.currentTarget.getBoundingClientRect()
          const rel = (e.clientY - r.top) / Math.max(1, r.height)
          // 中带 = 变子目录高亮（拖进自己子树非法）；边缘 = nav 画插入线
          if (rel >= 0.25 && rel <= 0.75) {
            if (folderDrag.id === node.id || folderDrag.subtree.has(node.id)) {
              setDropOver(false)
              return
            }
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            armDragEndCleanup('row', () => setDropOver(false))
            setDropOver(true)
            return
          }
          setDropOver(false)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false)
        }}
        onDrop={(e) => {
          setDropOver(false)
          if (itemDrag) {
            e.preventDefault()
            const itemId = itemDrag.id
            itemDrag = null
            cb.onMoveItem(itemId, node.id)
            return
          }
          if (!folderDrag) return
          const r = e.currentTarget.getBoundingClientRect()
          const rel = (e.clientY - r.top) / Math.max(1, r.height)
          if (rel < 0.25 || rel > 0.75) return // 边缘区：nav 接管排序线
          if (folderDrag.id === node.id || folderDrag.subtree.has(node.id)) return
          e.preventDefault()
          const sourceId = folderDrag.id
          folderDrag = null
          cb.onMoveFolderChild(sourceId, node.id)
        }}
      >
        {/* 同页面树：展开态不参与箭头接管，悬停 / 键盘聚焦才显箭头（见 sidebar.css 块首注释） */}
        <span className={'tree-twisty' + (hasChildren ? ' parent' : '')}>
          {hasChildren && (
            <button className="arrow" title={isOpen ? COPY.tree.collapse : COPY.tree.expand} aria-expanded={isOpen}>
              <Icon name="chevron" size={12} className={'chev' + (isOpen ? ' open' : '')} />
            </button>
          )}
          {/* 目录 glyph：18px 槽位内绝对定位，与 PageIcon 同框（tree-twisty 已是 relative） */}
          <Icon name="folder" size={18} className="dir-glyph" />
        </span>
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            defaultValue={node.name}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else if (e.key === 'Escape') cb.onRenameStart(null)
            }}
            onBlur={(e) => cb.onRenameCommit({ type: 'folder', id: node.id }, e.currentTarget.value)}
          />
        ) : (
          <span className="tree-label" title={node.name} onDoubleClick={() => cb.onRenameStart({ type: 'folder', id: node.id })}>
            {node.name}
          </span>
        )}
        <span className="tree-actions">
          {/* ＋ 打开行内菜单（同目录树头 ＋ 模式）：建子目录 / 建文档 / 传文件进该目录 */}
          <button className="icon-btn" title={COPY.tree.addMenu} onClick={(e) => cb.onMenu({ type: 'folder-plus', id: node.id }, e)}><Icon name="plus" size={14} /></button>
          <button className="icon-btn" title={COPY.tree.folderMenu} onClick={(e) => cb.onMenu({ type: 'folder', id: node.id }, e)}><Icon name="more" size={14} /></button>
        </span>
        {menuOpen && (
          <div className="dir-menu" style={cb.menuStyle}>
            <button onClick={() => { cb.onMenu(null); cb.onRenameStart({ type: 'folder', id: node.id }) }}>{COPY.tree.rename}</button>
            <button onClick={() => { cb.onMenu(null); cb.onAttachFile(node.id) }}>{COPY.tree.upload}</button>
            <button
              className="danger"
              onClick={() => {
                cb.onMenu(null)
                if (!window.confirm(COPY.tree.confirmDeleteFolder(node.name))) return
                cb.onDeleteFolder(node.id)
              }}
            >
              {COPY.tree.remove}
            </button>
          </div>
        )}
        {cb.menu?.type === 'folder-plus' && cb.menu.id === node.id && (
          <div className="dir-menu" style={cb.menuStyle}>
            <button onClick={() => { cb.onMenu(null); cb.onCreateChild(node.id) }}>{COPY.tree.newFolder}</button>
            <button onClick={() => { cb.onMenu(null); cb.onCreateDoc(node.id) }}>{COPY.tree.newDoc}</button>
            <button onClick={() => { cb.onMenu(null); cb.onAttachFile(node.id) }}>{COPY.tree.upload}</button>
          </div>
        )}
      </div>
      {isOpen && (
        <>
          {creatingChildHere && (
            <div className="tree-item dir-row" style={{ '--depth': depth + 1 } as React.CSSProperties}>
              <input
                className="rename-input dir-create-input"
                autoFocus
                placeholder={COPY.tree.folderName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') {
                    e.currentTarget.dataset.cancel = '1'
                    cb.onCancelCreate()
                  }
                }}
                onBlur={(e) => {
                  if (e.currentTarget.dataset.cancel) return
                  cb.onCommitCreate(e.currentTarget.value)
                }}
              />
            </div>
          )}
          {node.children.map((child) => (
            <DirRow key={child.id} node={child} depth={depth + 1} cb={cb} />
          ))}
          {node.items.map((it) => (
            <ItemRow key={it.id} item={it} depth={depth + 1} cb={cb} />
          ))}
        </>
      )}
    </>
  )
}

function ItemRow({ item, depth, cb }: { item: BoardItem; depth: number; cb: FolderTreeCallbacks }) {
  return (
    <div
      className={'tree-item dir-item' + (item.kind === 'page' ? ' dir-item-page' : '')}
      data-item={item.id}
      style={{ '--depth': depth } as React.CSSProperties}
      draggable
      onDragStart={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return
        itemDrag = { id: item.id }
        folderDrag = null
        e.dataTransfer.effectAllowed = 'move'
        document.addEventListener('dragend', () => { itemDrag = null }, { capture: true, once: true })
      }}
    >
      <span className="tree-twisty">
        {item.kind === 'page' ? <PageIcon icon={item.icon} placeholder /> : (
          /* 通用文件 glyph：18px 槽位内绝对定位 */
          <Icon name="file" size={18} className="dir-glyph" />
        )}
      </span>
      <button
        className="tree-label"
        title={item.kind === 'page' ? item.title || COPY.untitled : item.name || ''}
        onClick={() => {
          if (item.kind === 'page') cb.onNavigate(item.item_id)
          else window.open(`/api/files/${item.item_id}/display`, '_blank')
        }}
      >
        {item.kind === 'page' ? item.title || COPY.untitled : item.name || COPY.tree.unnamedFile}
      </button>
      <span className="tree-actions">
        <button
          className="icon-btn danger"
          title={item.kind === 'page' ? COPY.tree.removePage : COPY.tree.detachFile}
          onClick={() => cb.onDetachItem(item)}
        >
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  )
}

function subtreeIdsOf(node: FolderNode, all: BoardFolder[]): Set<string> {
  const ids = new Set<string>()
  const walk = (id: string): void => {
    ids.add(id)
    for (const f of all) if (f.parent_id === id) walk(f.id)
  }
  walk(node.id)
  return ids
}
