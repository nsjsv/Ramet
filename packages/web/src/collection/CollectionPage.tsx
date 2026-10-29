// ---------- 整页集合：顶栏 + 图标 + 标题 + 集合内容区，没有正文编辑器 ----------
// PageRoute 按 kind 分流到这里（集合页没有正文、对话视图、源码模式、右轨、反链，不往 EditorPage 里加分支）。
// 标题与普通页面走同一个标题会话（editor/title-session.ts），绑的是集合 store 那条 page:<cid> 连接，同一集合在一页上只开一条。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { Page } from '../api'
import TopBar from '../TopBar'
import HistoryDrawer from '../HistoryDrawer'
import { PageIconHeader } from '../PageIcon'
import { cursorIdentity } from '../identity'
import { recordRecentPage } from '../recent-pages'
import { refreshEditMarks } from '../edit-marks-store'
import { startTitleSession } from '../editor/title-session'
import { useScrollAnchor, type ScrollTarget } from '../editor/read-position'
import { openCollection, type CollectionHandle } from './collection-store'
import CollectionSurface from './CollectionSurface'
import { restoreCollection } from './schema-ops'

type Props = {
  pages: Page[] | null
  onChanged: () => void
  /** 标题一变就上报（Shell 乐观更新侧栏）；必须稳定引用（同 EditorPage） */
  onTitleLive: (id: string, title: string) => void
  username: string
  readOnly?: boolean
}

const noop = (): void => undefined

export default function CollectionPage({ pages, onChanged, onTitleLive, username, readOnly = false }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const titleRef = useRef<HTMLDivElement>(null)
  const titleViewRef = useRef<EditorView | null>(null)
  const [handle, setHandle] = useState<CollectionHandle | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 标题会话经 ref 读最新的页面列表与上树回调（同 EditorPage：它们变了不能重建连接）
  const pagesRef = useRef(pages)
  useEffect(() => {
    pagesRef.current = pages
  })
  const onTitleLiveRef = useRef(onTitleLive)
  useEffect(() => {
    onTitleLiveRef.current = onTitleLive
  })
  const lastPersistedTitleRef = useRef<string | null>(null)

  useEffect(() => {
    if (!id) return
    setHistoryOpen(false)
    recordRecentPage(id) // `@` 大菜单的「最近」
    void refreshEditMarks(id) // 顶栏「X分钟前编辑」
  }, [id])

  // 集合连接 + 标题会话：服务端确认同步过才建标题视图（集合文档不挂 IndexedDB，没有本地缓存可先画）
  useEffect(() => {
    if (!id) return
    const h = openCollection(id)
    setHandle(h)
    const provider = h.provider
    if (!provider) return () => h.release()
    provider.setAwarenessField('user', cursorIdentity(username))
    const title = startTitleSession({ id, provider, readOnly, onChanged, pagesRef, onTitleLiveRef, lastPersistedTitleRef })
    const mount = (): void => {
      if (title.view() || h.status() !== 'ready') return
      title.normalize()
      titleViewRef.current = title.mount(titleRef.current, noop) ?? null // 集合页没有正文可跳：Enter 只是不换行
    }
    const off = h.subscribe(mount)
    mount()
    return () => {
      off()
      title.stop()
      titleViewRef.current = null
      setHandle(null)
      // 先拆标题视图、再释放连接：连接可能还被正文里的集合块用着（store 按集合引用计数）。
      // 拆视图时 yCursorPlugin 自己把本端标题光标从 awareness 里清掉，迟到的延迟派发由标题视图的
      // dispatchTransaction 守卫挡掉（title-editor.ts）；最后一个使用者走时 release 才静音 awareness、拆 provider
      title.destroyView()
      h.release()
    }
  }, [id, username, readOnly, onChanged])

  // 后退 / 前进回到原位：与文档页同一套记录（editor/read-position.ts），锚是视口顶上那一行；
  // 锚行还没加载（离开前往下翻过几页）就请表格续取，直到对上或用户自己动
  const surfaceRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<(() => void) | null>(null)
  const registerMore = useCallback((more: (() => void) | null) => {
    moreRef.current = more
  }, [])
  useScrollAnchor({
    pageId: id,
    rootRef: surfaceRef,
    targets: () => {
      const root = surfaceRef.current
      if (!root?.querySelector('[data-row-id]')) return null // 行还没画出来：不记，也不清掉已记的
      return [...root.querySelectorAll<HTMLElement>('[data-row-id]')].map((el): ScrollTarget => ({ id: el.dataset.rowId ?? '', el }))
    },
    locate: (rowId) => surfaceRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`) ?? null,
    tick: 0,
    enabled: true,
    skip: false,
    more: () => moreRef.current?.(),
  })

  // 恢复某个版本：属性定义与视图字段级写回集合文档（行里的值不动），标题经标题视图 dispatch 写回
  // （title-session 的防抖照常把 pages.title 双写上）。都走协同连接，记在当前用户名下
  const restoreVersion = useCallback(
    (snapshot: unknown, title: ProsemirrorNode) => {
      if (!handle || readOnly) return
      restoreCollection(handle.doc, snapshot)
      const view = titleViewRef.current
      if (view) view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, title.content))
    },
    [handle, readOnly],
  )

  const page = pages?.find((p) => p.id === id) ?? null
  return (
    <>
      <TopBar
        pages={pages}
        pageId={id}
        peers={[]}
        canPublish={false}
        published={false}
        includeRuns={false}
        onChanged={onChanged}
        onNavigate={navigate}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      <div className="editor-page collection-page" data-flip>
        {id && <PageIconHeader pageId={id} icon={page?.icon ?? null} readOnly={readOnly} onChanged={onChanged} />}
        <div className="page-title title-editor" ref={titleRef} />
        <div ref={surfaceRef}>
          {handle && (
            <CollectionSurface
              handle={handle}
              readOnly={readOnly}
              spaceId={page?.space_id ?? null}
              onOpenRow={(rowId) => navigate(`/page/${rowId}`)}
              registerMore={registerMore}
            />
          )}
        </div>
      </div>
      {historyOpen && id && (
        // 集合形态：「更新」里是属性定义 / 视图的变化，「历史版本」预览与恢复属性定义、视图和名称
        <HistoryDrawer
          pageId={id}
          readOnly={readOnly}
          username={username}
          history="collection"
          onRestoreCollection={restoreVersion}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  )
}
