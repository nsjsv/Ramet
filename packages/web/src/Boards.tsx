/* ---------- 侧边栏树列表：目录树注册行 + 空间派生的页面树 ----------
 * 单一滚动区，两个 section，名字恒定不随空间改名：
 *   1) 页面树：该空间里 in_page_tree 不为 false 的页（及其同样在树里的祖先）按 parent_id
 *      组成的森林。目录树自建文档不在这里。有这种页才渲染；只有折叠与 ＋，没有 ⋯ 菜单。
 *   2) 目录树：目录 + 挂载条目（folders/folder_items）。该空间有目录树行时才渲染，
 *      保留 ＋ 菜单（创建目录/创建文档/上传文件）与 ⋯ 菜单（删除目录树）。
 * 两者都没有就显示空态和两个入口（新建页面 / 新建目录树）。内容区分派：页面树走 <PageTreeBoard>
 * （PageTree.tsx），目录树走 <FolderTreeBoard>（FolderTree.tsx）。
 * 空间动作（改名/删除空间）只在底部空间切换器，不在这里。 */
import { useEffect, useRef, useState } from 'react'
import { pagesInPageTree } from '@ramet/shared/page-tree'
import { api, type Board, type BoardsPayload, type Page } from './api'
import { useCachedLoad } from './cached-load'
import { COPY } from './copy'
import { uploadFile } from './editor/media'
import { PageTreeBoard, type PageNode } from './PageTree'
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
  /** 树结构变化（拖拽/改名）后通知 Shell 刷新 */
  onPageChanged: () => void
}) {
  /** 整块折叠态（key=section 标识：页面树用空间 id，目录树用 boardId） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 本次挂载里用户亲手开合过的 section：只有它们展开时播入场 */
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  /** 目录行展开态（key=folderId；与 section 折叠 Set 分开存）；跨刷新保持 */
  const [expandedFolders, toggleFolder] = usePersistentSet('ramet.tree.folders')
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

  // 目录条目里的页面标题来自 boards payload（静态快照）；页面改名走编辑器实时写回 → pages 变化，
  // 以「挂载条目的页面 id + 最新标题」为键重拉列表，条目名才不陈旧（键值不变则不触发）。
  // 页已不在活列表里必须换成别的标记：新文档标题是空串，消失后回落也是空串，键不变就永远不重拉，
  // 目录树会留着已回收页面的挂载，再点删除就是对已回收页再 trash，得到 404 page not found
  const itemTitleKey =
    pages === null
      ? ''
      : (data?.items ?? [])
          .filter((it) => it.kind === 'page')
          .map((it) => {
            const page = pages.find((p) => p.id === it.item_id)
            return page ? `${it.item_id}:${page.title}` : `${it.item_id}:gone`
          })
          .join('|')
  // 挂载那一次由上面的 hook 取，这里只管之后键变了的重拉
  const seenTitleKey = useRef<string | null>(null)
  useEffect(() => {
    if (seenTitleKey.current !== null && seenTitleKey.current !== itemTitleKey) void loaded.reload()
    seenTitleKey.current = itemTitleKey
  }, [itemTitleKey, loaded.reload])

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

  /** 删目录树：树里挂的页面移入回收站（可恢复），文件条目只脱挂 */
  function deleteBoardWithConfirm(board: Board): void {
    if (!window.confirm(COPY.tree.confirmDeleteTree)) return
    api
      .deleteBoard(board.id)
      .then(() => {
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
  const forest = buildForest(data?.folders ?? [], data?.items ?? [])
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
              items={data?.items ?? []}
              cb={{
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
                    .then(() => {
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
                onDetachItem: (it) => {
                  // 页面恒属一个空间：页面条目移入回收站（可恢复）；
                  // 文件条目只脱挂（文件永不删除）
                  if (it.kind === 'file') {
                    run(() => api.detachItem(it.id), COPY.tree.detachFailed)
                    return
                  }
                  // 活列表里已经没有这页（页面树刚回收过，或回收广播先到）：挂载是过期投影。
                  // 再 trash 会 404 page not found。重拉后服务端按 live_pages 把条目摘掉
                  if (pages !== null && !pages.some((p) => p.id === it.item_id)) {
                    refresh()
                    onPageChanged()
                    return
                  }
                  if (!window.confirm(COPY.tree.confirmTrash(it.title || COPY.untitled))) return
                  api
                    .trashPage(it.item_id)
                    .then(() => {
                      refresh()
                      onPageChanged()
                    })
                    .catch((err: unknown) => {
                      if (err instanceof Error && err.message === 'page not found') {
                        refresh()
                        onPageChanged()
                        return
                      }
                      console.error(err)
                      window.alert(err instanceof Error && err.message ? err.message : COPY.tree.deleteFailed)
                    })
                },
                onNavigate,
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
