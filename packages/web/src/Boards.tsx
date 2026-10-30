/* ---------- 侧边栏树列表：目录树注册行 + 空间派生的页面树 ----------
 * 单一滚动区，两个 section，名字恒定不随空间改名：
 *   1) 页面树：该空间里 in_page_tree 不为 false 的页（及其同样在树里的祖先）按 parent_id
 *      组成的森林。目录树自建文档不在这里。有这种页才渲染；只有折叠与 ＋，没有 ⋯ 菜单。
 *   2) 目录树：目录 + 挂载条目（folders/folder_items）。该空间有目录树行时才渲染，
 *      保留 ＋ 菜单（创建目录/创建文档/上传文件）与 ⋯ 菜单（删除目录树）。
 * 两者都没有就显示空态和两个入口（新建页面 / 新建目录树）。内容区分派：页面树走 <PageTreeBoard>
 * （PageTree.tsx），目录树走 <FolderTreeBoard>（FolderTree.tsx）。
 * 空间动作（改名/删除空间）只在底部空间切换器，不在这里。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { api, type Board, type BoardItem, type BoardsPayload, type Page } from './api'
import { useCachedLoad } from './cached-load'
import { subscribeControl } from './control'
import { COPY } from './copy'
import { uploadFile } from './editor/media'
import { PageTreeBoard, unlinkFromParentDoc, type PageDrag, type PageNode } from './PageTree'
import { publishBoards } from './boards-store'
import { Icon } from './icons'
import { usePersistentSet } from './tree-state'
import {
  buildForest,
  FolderTreeBoard,
  type CreatingTarget,
  type MenuTarget,
  type RenameTarget,
} from './FolderTree'

/** 悬浮菜单锚点：触发按钮 rect 换算成 fixed 坐标（right 距视口右缘；近下缘则上翻） */
type MenuPos = { top?: number; bottom?: number; right: number }

export default function Boards({
  pages,
  selectedSpaceId,
  spaceIds,
  readOnly,
  onNavigate,
  onCreatePage,
  onCreateCollection,
  onRemovePage,
  onPagesTrashed,
  onPageCreated,
  onPageChanged,
}: {
  /** listPages 全量（页面树行在此组装，按空间过滤）；null = 加载中 */
  pages: Page[] | null
  selectedSpaceId: string | null
  /** 我参与的空间 id 集（新建/克隆空间后触发重拉目录树列表） */
  spaceIds: string[]
  /** viewer 空间：写入口整体关闭（服务端另有 403 一道闸） */
  readOnly: boolean
  onNavigate: (pageId: string) => void
  /** 页面树行「新建子页」（parentId = 空间内父页；null = 新建顶层页） */
  onCreatePage: (parentId: string | null) => void
  /** 页面树 ＋ 菜单「新建集合」（整页集合，空间顶层） */
  onCreateCollection: () => void
  /** 页面树行删除（移入回收站） */
  onRemovePage: (node: PageNode) => void
  /** 目录树操作把页面移入回收站后（删条目 / 删目录 / 删目录树）：带服务端返回的权威 id 集，
   *  由 Shell 摘本地列表，正开着其中一页时离开 */
  onPagesTrashed: (ids: string[]) => void
  /** 目录树「创建文档」建好的页先进本地列表：条目只画活列表里有的页，晚一步就会闪没 */
  onPageCreated: (page: Page) => void
  /** 树结构变化（拖拽/改名）后通知 Shell 刷新 */
  onPageChanged: () => void
}) {
  /** 整块折叠态（key=section 标识：页面树用空间 id，目录树用 boardId） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 本次挂载里用户亲手开合过的 section：只有它们展开时播入场 */
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  /** 目录行展开态（key=folderId；与 section 折叠 Set 分开存）；跨刷新保持 */
  const [expandedFolders, toggleFolder, expandFolders] = usePersistentSet('ramet.tree.folders')
  const [renaming, setRenaming] = useState<RenameTarget>(null)
  const [menu, setMenu] = useState<MenuTarget>(null)
  /** 当前打开菜单的锚点坐标（打开时随触发按钮一并记录） */
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  /** 内联创建：目录树里新建目录的命名输入 */
  const [creating, setCreating] = useState<CreatingTarget>(null)
  /** 上传文件的目标（null folderId = 目录树顶层；菜单点「上传文件」后等 input onChange） */
  const [uploadTarget, setUploadTarget] = useState<{ boardId: string; folderId: string | null } | null>(null)

  /** 空间集合变化(新建 / 加入 / 退出)后重拉目录树列表（首次挂载也走这里）。
   *  上次的列表先画（cached-load.ts），后台重取 */
  const spaceIdsKey = spaceIds.join(',')
  const loaded = useCachedLoad<BoardsPayload>('boards:', () => api.listBoards(), [spaceIdsKey])
  const data = loaded.data
  useEffect(() => {
    if (loaded.error) console.error(loaded.error)
  }, [loaded.error])
  // 顶栏面包屑要目录结构：共享这份列表，不另取
  useEffect(() => publishBoards(data), [data])

  // 别的标签页 / 别的成员改了目录树：只认 'boards'（页面写的 'changed' 很频繁，不连带重拉）；'sync' 补断线期间漏掉的
  useEffect(
    () =>
      subscribeControl((ev) => {
        if (ev === 'boards' || ev === 'sync') void loaded.reload()
      }),
    [loaded.reload],
  )

  // 页面条目的标题 / 图标以活页面列表为准：payload 里的是拉取那一刻的快照，改名 / 换图标后当次就跟，
  // 不为此重拉目录树。活列表里没有的页（移入回收站，含别处删的）不画，不然再点删除就是对已回收页
  // 再 trash（404）；恢复时服务端广播 'boards'，重拉后条目回来
  const items = useMemo((): BoardItem[] => {
    const raw = data?.items ?? []
    if (pages === null) return raw
    const byId = new Map(pages.map((p) => [p.id, p]))
    return raw.flatMap((it) => {
      if (it.kind !== 'page') return [it]
      const page = byId.get(it.item_id)
      return page ? [{ ...it, title: page.title, icon: page.icon }] : []
    })
  }, [data, pages])

  /** 目录及其全部祖先目录的 id（展开它们，这个目录里的东西才看得见） */
  function folderChain(folderId: string): string[] {
    const byId = new Map((data?.folders ?? []).map((f) => [f.id, f]))
    const chain: string[] = []
    for (let id: string | null = folderId; id && !chain.includes(id); id = byId.get(id)?.parent_id ?? null) chain.push(id)
    return chain
  }

  // 打开的页挂在折叠的目录里（搜索 / 链接跳进来、刷新恢复）：展开到它，高亮行才看得见。
  // 每个页只定位一次，之后用户自己收起不会被列表重拉又撑开
  const location = useLocation()
  const activePageId = location.pathname.match(/^\/page\/([\w-]+)$/)?.[1] ?? null
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!activePageId || revealed.current === activePageId) return
    const hit = items.find((it) => it.kind === 'page' && it.item_id === activePageId)
    if (!hit) return // 列表还没到 / 不在目录树里：等下一次
    revealed.current = activePageId
    if (hit.folder_id) expandFolders(folderChain(hit.folder_id))
  }, [activePageId, items])

  function refresh(): void {
    void loaded.reload()
  }

  function toggleCollapsed(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setToggled((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }

  /** 按钮 rect → 菜单 fixed 坐标（往下放会出视口时改上翻） */
  function menuPosFrom(e: React.MouseEvent): MenuPos {
    const r = e.currentTarget.getBoundingClientRect()
    return r.bottom + 190 > window.innerHeight
      ? { bottom: window.innerHeight - r.top + 2, right: window.innerWidth - r.right }
      : { top: r.bottom + 2, right: window.innerWidth - r.right }
  }
  /** 打开菜单：同时记锚点 */
  function openMenu(t: MenuTarget, e: React.MouseEvent): void {
    setMenuPos(menuPosFrom(e))
    setMenu(t)
  }
  const menuStyle: React.CSSProperties | undefined = menuPos
    ? {
        right: menuPos.right,
        ...(menuPos.top !== undefined ? { top: menuPos.top } : { bottom: menuPos.bottom }),
      }
    : undefined

  const run = (fn: () => Promise<unknown>, fail = COPY.failed): void => {
    fn().then(refresh).catch((err: unknown) => {
      console.error(err)
      window.alert(err instanceof Error && err.message ? err.message : fail)
    })
  }

  /** 内联创建提交：只余目录树目录 */
  function commitCreate(draft: string): void {
    const cur = creating
    setCreating(null)
    const name = draft.trim()
    if (!cur || !name || cur.type !== 'folder') return
    // 输入行在父目录里时是强制展开的，提交后父目录得真展开，不然新目录一出现就被收起来
    if (cur.parentId) expandFolders(folderChain(cur.parentId))
    run(() => api.createFolder(cur.boardId, cur.parentId, name))
  }

  function cancelCreate(): void {
    // 标记取消：Escape 卸载输入框后其 blur 仍会触发一次，靠标记短路
    setCreating((cur) => (cur ? { ...cur, cancel: true } : null))
  }

  /** 目录树「创建文档」（顶层或某目录下）：在目录树所属空间建页再挂到目标位置。
   *  in_page_tree false：页属于该空间（可见/搜索/回收站），但不进页面树。 */
  function createDoc(boardId: string, folderId: string | null): void {
    const spaceId = (data?.boards ?? []).find((b) => b.id === boardId)?.space_id
    if (!spaceId) return
    api.createPage(null, spaceId, { in_page_tree: false })
      .then((page) => {
        onPageCreated(page)
        if (folderId) expandFolders(folderChain(folderId))
        const attach = folderId
          ? api.attachItem(folderId, 'page', page.id)
          : api.attachItemRoot(boardId, 'page', page.id)
        return attach.then(() => {
          refresh()
          onPageChanged()
          onNavigate(page.id)
        })
      })
      .catch((err: unknown) => {
        console.error(err)
        window.alert(err instanceof Error && err.message ? err.message : COPY.tree.createFailed)
      })
  }

  /** 页面树的页拖进目录树（folderId null = 顶层；index 缺省 = 末尾）。目录树条目是叶子、画不出子页，
   *  带子页的页拖进来子页会从两棵树里一起消失，所以拒收；服务端同一道闸，这里先拦是为了给出说得清的提示。
   *  挂上后页离开页面树（服务端同事务清掉父页并标记不进页面树），旧父页正文里的子页引用随后摘掉 */
  function dropPage(drag: PageDrag, folderId: string | null, index?: number): void {
    if (drag.kind !== 'doc') {
      window.alert(COPY.tree.dropNotDoc)
      return
    }
    if (drag.subtree.size > 1) {
      window.alert(COPY.tree.dropHasChildren)
      return
    }
    const board = dirBoard
    if (!board) return
    const page = pages?.find((p) => p.id === drag.id)
    const oldParent = page?.parent_id ? pages?.find((p) => p.id === page.parent_id) : undefined
    if (folderId) expandFolders(folderChain(folderId))
    const attach = folderId ? api.attachItem(folderId, 'page', drag.id) : api.attachItemRoot(board.id, 'page', drag.id)
    attach
      .then(async (item) => {
        if (index !== undefined) await api.moveItem(item.id, folderId, index)
        // 集合页没有正文，不存在子页引用
        if (oldParent && oldParent.kind !== 'collection') await unlinkFromParentDoc(drag.id, oldParent.id)
      })
      .then(() => {
        refresh()
        onPageChanged()
      })
      .catch((err: unknown) => {
        console.error(err)
        window.alert(err instanceof Error && err.message ? err.message : COPY.tree.moveFailed)
        refresh()
        onPageChanged()
      })
  }

  /** 删目录树：树里挂的页面移入回收站（可恢复），文件条目只脱挂 */
  function deleteBoardWithConfirm(board: Board): void {
    if (!window.confirm(COPY.tree.confirmDeleteTree)) return
    api
      .deleteBoard(board.id)
      .then(({ trashed }) => {
        onPagesTrashed(trashed)
        refresh()
        onPageChanged()
      })
      .catch((err: unknown) => {
        console.error(err)
        window.alert(err instanceof Error && err.message ? err.message : COPY.tree.deleteFailed)
      })
  }

  /** 目录改名 */
  function commitRename(target: Exclude<RenameTarget, null>, draft: string): void {
    setRenaming(null)
    if (target.type !== 'folder') return
    const current = data?.folders.find((f) => f.id === target.id)?.name
    if (!draft.trim() || draft === current) return
    run(() => api.renameFolder(target.id, draft))
  }

  // 派生：该空间有无页面（页面树随空间派生）、有无目录树行
  const scopedPages = pages && selectedSpaceId ? pages.filter((p) => p.space_id === selectedSpaceId) : pages
  // 页面树只画成员。目录树自建文档（in_page_tree false）及其子孙留在 pages 里供打开/改名，但不进这棵树
  const pageTreePages = scopedPages === null ? null : pagesInPageTree(scopedPages)
  const dirBoard = (data?.boards ?? []).find((b) => b.space_id === selectedSpaceId) ?? null
  // section 折叠 key：页面树无实体 id，用空间 id；目录树用行 id
  const pageKey = `page_tree:${selectedSpaceId ?? ''}`
  const forest = buildForest(data?.folders ?? [], items)
  const showPageTree = data !== null && pageTreePages !== null && pageTreePages.length > 0
  const showDirTree = dirBoard !== null && data !== null

  /** 页面树 section 头：名字恒定「页面树」，无 ⋯ 菜单（空间派生视图，不可删） */
  function pageTreeHeader(): React.ReactNode {
    const isCollapsed = collapsed.has(pageKey)
    return (
      <div className="dir-board-header" onClick={() => toggleCollapsed(pageKey)}>
        <span className="dir-board-name" title={COPY.tree.pageTree}>
          {COPY.tree.pageTree}
        </span>
        <button
          className="icon-btn dir-board-chev"
          title={isCollapsed ? COPY.tree.expand : COPY.tree.collapse}
          aria-expanded={!isCollapsed}
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapsed(pageKey)
          }}
        >
          <Icon name="chevron" size={12} className={'chev' + (isCollapsed ? '' : ' open')} />
        </button>
        {!readOnly && selectedSpaceId && (
          <span className="tree-actions dir-board-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="icon-btn"
              title={COPY.collection.addMenu}
              onClick={(e) => {
                if (menu?.type === 'page-plus' && menu.id === selectedSpaceId) setMenu(null)
                else openMenu({ type: 'page-plus', id: selectedSpaceId }, e)
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            {menu?.type === 'page-plus' && menu.id === selectedSpaceId && (
              <div className="dir-menu" style={menuStyle}>
                <button
                  onClick={() => {
                    setMenu(null)
                    onCreatePage(null)
                  }}
                >
                  {COPY.tree.newPage}
                </button>
                <button
                  onClick={() => {
                    setMenu(null)
                    onCreateCollection()
                  }}
                >
                  {COPY.collection.newCollection}
                </button>
              </div>
            )}
          </span>
        )}
      </div>
    )
  }

  /** 目录树 section 头：名字恒定「目录树」，保留 ＋ 菜单与 ⋯ 删除 */
  function dirTreeHeader(board: Board): React.ReactNode {
    const isCollapsed = collapsed.has(board.id)
    return (
      <div className="dir-board-header" onClick={() => toggleCollapsed(board.id)}>
        <span className="dir-board-name" title={COPY.tree.dirTree}>
          {COPY.tree.dirTree}
        </span>
        <button
          className="icon-btn dir-board-chev"
          title={isCollapsed ? COPY.tree.expand : COPY.tree.collapse}
          aria-expanded={!isCollapsed}
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapsed(board.id)
          }}
        >
          <Icon name="chevron" size={12} className={'chev' + (isCollapsed ? '' : ' open')} />
        </button>
        {!readOnly && (
          <span className="tree-actions dir-board-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="icon-btn"
              title={COPY.tree.addMenu}
              onClick={(e) => {
                if (menu?.type === 'plus' && menu.id === board.id) setMenu(null)
                else openMenu({ type: 'plus', id: board.id }, e)
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button className="icon-btn" title={COPY.tree.dirTreeMenu} onClick={(e) => openMenu({ type: 'board', id: board.id }, e)}>
              <Icon name="more" size={14} />
            </button>
            {menu?.type === 'board' && menu.id === board.id && (
              <div className="dir-menu" style={menuStyle}>
                <button
                  className="danger"
                  onClick={() => {
                    setMenu(null)
                    deleteBoardWithConfirm(board)
                  }}
                >
                  {COPY.tree.deleteTree}
                </button>
              </div>
            )}
            {menu?.type === 'plus' && menu.id === board.id && (
              <div className="dir-menu" style={menuStyle}>
                <button
                  onClick={() => {
                    setMenu(null)
                    setCreating({ type: 'folder', boardId: board.id, parentId: null })
                  }}
                >
                  {COPY.tree.newFolder}
                </button>
                <button
                  onClick={() => {
                    setMenu(null)
                    createDoc(board.id, null)
                  }}
                >
                  {COPY.tree.newDoc}
                </button>
                <button
                  onClick={() => {
                    setMenu(null)
                    setUploadTarget({ boardId: board.id, folderId: null })
                  }}
                >
                  {COPY.tree.upload}
                </button>
              </div>
            )}
          </span>
        )}
      </div>
    )
  }

  function sectionBody(key: string, body: React.ReactNode): React.ReactNode {
    const state = collapsed.has(key) ? ' closed' : toggled.has(key) ? ' is-toggled' : ''
    return <div className={'dir-board-body' + state}>{body}</div>
  }

  return (
    <div className="dirboards">
      {menu && <div className="space-menu-backdrop" onClick={() => setMenu(null)} />}
      {showPageTree && selectedSpaceId && (
        <section key={pageKey} className={'dir-board' + (collapsed.has(pageKey) ? ' closed' : '')}>
          {pageTreeHeader()}
          {sectionBody(
            pageKey,
            <PageTreeBoard
              spaceId={selectedSpaceId}
              pages={pageTreePages}
              readOnly={readOnly}
              onCreateChild={onCreatePage}
              onRemove={onRemovePage}
              onChanged={onPageChanged}
            />,
          )}
        </section>
      )}
      {showDirTree && dirBoard && (
        <section key={dirBoard.id} className={'dir-board' + (collapsed.has(dirBoard.id) ? ' closed' : '')}>
          {dirTreeHeader(dirBoard)}
          {sectionBody(
            dirBoard.id,
            <FolderTreeBoard
              board={dirBoard}
              roots={forest.roots.get(dirBoard.id) ?? []}
              rootItems={forest.rootItems.get(dirBoard.id) ?? []}
              folders={data?.folders ?? []}
              items={items}
              cb={{
                readOnly,
                expanded: expandedFolders,
                renaming,
                menu,
                creating,
                onToggle: toggleFolder,
                onRenameStart: setRenaming,
                onRenameCommit: commitRename,
                onMenu: (t, e) => {
                  if (e) setMenuPos(menuPosFrom(e))
                  setMenu(t)
                },
                menuStyle,
                onCommitCreate: commitCreate,
                onCancelCreate: cancelCreate,
                onCreateChild: (parentId) =>
                  setCreating({ type: 'folder', boardId: dirBoard.id, parentId }),
                onCreateDoc: (folderId) => createDoc(dirBoard.id, folderId),
                onDeleteFolder: (id) => {
                  // 删目录会把子树里挂的页面移入回收站（可恢复），页面树与回收站都要跟着刷
                  api
                    .deleteFolder(id)
                    .then(({ trashed }) => {
                      onPagesTrashed(trashed)
                      refresh()
                      onPageChanged()
                    })
                    .catch((err: unknown) => {
                      console.error(err)
                      window.alert(err instanceof Error && err.message ? err.message : COPY.tree.deleteFolderFailed)
                    })
                },
                onMoveFolderChild: (sourceId, parentId) =>
                  run(() => api.moveFolder(sourceId, parentId), COPY.tree.moveFailed),
                onMoveFolder: (id, parentId, index) =>
                  run(() => api.moveFolder(id, parentId, index), COPY.tree.moveFailed),
                onAttachFile: (folderId) => setUploadTarget({ boardId: dirBoard.id, folderId }),
                onMoveItem: (itemId, folderId) => run(() => api.moveItem(itemId, folderId), COPY.tree.moveFailed),
                onMoveItemTo: (id, parentId, index) =>
                  run(() => api.moveItem(id, parentId, index), COPY.tree.moveFailed),
                onDropPage: dropPage,
                onDetachItem: (it) => {
                  // 页面恒属一个空间：页面条目移入回收站（可恢复）；
                  // 文件条目只脱挂（文件永不删除）
                  if (it.kind === 'file') {
                    run(() => api.detachItem(it.id), COPY.tree.detachFailed)
                    return
                  }
                  if (!window.confirm(COPY.tree.confirmTrash(it.title || COPY.untitled))) return
                  api
                    .trashPage(it.item_id)
                    .then(({ trashed }) => {
                      onPagesTrashed(trashed)
                      refresh()
                      onPageChanged()
                    })
                    .catch((err: unknown) => {
                      if (err instanceof Error && err.message === 'page not found') {
                        onPagesTrashed([it.item_id])
                        refresh()
                        onPageChanged()
                        return
                      }
                      console.error(err)
                      window.alert(err instanceof Error && err.message ? err.message : COPY.tree.deleteFailed)
                    })
                },
                folders: data?.folders ?? [],
              }}
            />,
          )}
        </section>
      )}
      {/* 空态/缺树入口：两棵树各自按有没有给入口，点掉一个不会把另一个的入口带走
          （新空间没有页面也没有目录树行，两棵树都靠用户显式建） */}
      {selectedSpaceId && pages !== null && data !== null && (!showPageTree || !showDirTree) && (
        <div className="tree-empty">
          {!showPageTree && !showDirTree && <div>{COPY.tree.spaceEmpty}</div>}
          {!readOnly && (
            <div className="tree-empty-actions">
              {!showPageTree && <button onClick={() => onCreatePage(null)}>{COPY.tree.newPage}</button>}
              {!showPageTree && <button onClick={onCreateCollection}>{COPY.collection.newCollection}</button>}
              {!showDirTree && (
                <button onClick={() => run(() => api.createDirTree(selectedSpaceId))}>{COPY.tree.newDirTree}</button>
              )}
            </div>
          )}
        </div>
      )}
      {/* 上传文件：目录菜单点「上传文件」后挂载即弹选择器，复用 editor 的 POST /api/files
          上传（uploadFile，FormData 不走 api.request），再挂到该目录；folderId null 是目录树顶层 */}
      {uploadTarget && (
        <input
          type="file"
          hidden
          ref={(el) => el?.click()}
          onChange={(e) => {
            const file = e.target.files?.[0]
            const target = uploadTarget
            setUploadTarget(null)
            e.target.value = ''
            if (!file) return
            if (target.folderId) expandFolders(folderChain(target.folderId))
            uploadFile(file)
              .then((meta) =>
                target.folderId
                  ? api.attachItem(target.folderId, 'file', meta.id)
                  : api.attachItemRoot(target.boardId, 'file', meta.id),
              )
              .then(refresh)
              .catch((err: unknown) => {
                console.error(err)
                window.alert(err instanceof Error ? err.message : COPY.tree.uploadFailed)
              })
          }}
        />
      )}
    </div>
  )
}
