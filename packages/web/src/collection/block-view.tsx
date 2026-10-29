// ---------- 正文里的集合块（编辑器的 nodeView）：块里挂一个 React 根，画 CollectionSurface ----------
// 节点定义与源码记号在 editor/collection-block.ts；公开页 / 快照面板没有 nodeView，画 toDOM 的静态占位。
// - 该画什么见 embed-verdict.ts：页面列表来自集合 store（App 经 syncCollectionPages 喂进来），不在列表里才问状态接口。
// - 集合连接走 openCollection（store 按集合引用计数），同一集合的整页、多个块共用一条。
// - 块的 viewId attr 是默认视图（导出 / 源码记号带它）；viewId 为空（刚从斜杠菜单插入、或手写的记号）时，能写的一端补成第一个视图。
// - 块头改集合名要同时写集合文档的 title 片段与 pages.title，只写其一，打开整页时标题会话会拿旧名写回去。
// - nodeView 吃掉块里的事件（stopEvent，正文块拖放除外）、忽略 DOM 变化（ignoreMutation），块里是另一个应用，不是正文。
//   销毁时推迟一个微任务卸载 React 根（PM 可能在 React 渲染途中重建 nodeView，同步卸载会告警）。
// - 看板横向滚动时伸出正文列铺到画面两边：伸出量由 editor/bleed.ts 量，写成块上的 --bleed-l / --bleed-r（collection-block.css 用）。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $view } from '@milkdown/kit/utils'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeViewConstructor } from '@milkdown/kit/prose/view'
import { api } from '../api'
import { COPY } from '../copy'
import { trackBleed } from '../editor/bleed'
import { blockAttrs, collectionInlineSchema, collectionLinkSchema, type CollectionBlockAttrs } from '../editor/collection-block'
import { writeTitleFragment } from '../editor/title-fragment'
import { collectionApi, type CollectionState } from './collection-api'
import { useCollection, useCollectionPages, useCollectionSchema, useCollectionSpaces, type CollectionHandle } from './collection-store'
import CollectionSurface from './CollectionSurface'
import { BulkSlot } from './bulk-slot'
import { blockVerdict, blockWritable, needsState } from './embed-verdict'
import { NameInput } from './PropEditor'

const C = COPY.collection.embed

// 本端正在建 / 建失败的集合（斜杠「集合」先插块、后建集合的中间态）

const creating = new Set<string>()
const failed = new Set<string>()
let flagRev = 0
const flagListeners = new Set<() => void>()
const bump = (): void => {
  flagRev++
  flagListeners.forEach((l) => l())
}
const subscribeFlags = (cb: () => void): (() => void) => {
  flagListeners.add(cb)
  return () => flagListeners.delete(cb)
}

/** 斜杠「集合」：插块之前登记，服务端建好或失败时摘（建好后页面列表还没跟上的那一下由状态接口补位） */
export function markCreating(cid: string): void {
  creating.add(cid)
  bump()
}
export function markCreated(cid: string, ok: boolean): void {
  creating.delete(cid)
  if (!ok) failed.add(cid)
  bump()
}

// 块里当前看的视图：个人偏好，按块 id 记在 localStorage，同一集合的多个块各记各的

const blockViewKey = (blockId: string): string => `ramet.collection.block-view.${blockId}`

function readBlockView(blockId: string): string | null {
  if (!blockId) return null
  try {
    return localStorage.getItem(blockViewKey(blockId))
  } catch {
    return null
  }
}

function writeBlockView(blockId: string, viewId: string): void {
  if (!blockId) return // 刚插的块还没补上 id：只在本次切换里生效
  try {
    localStorage.setItem(blockViewKey(blockId), viewId)
  } catch (err) {
    console.error(err) // 隐私模式 / 配额满：只是不记住，不影响切换
  }
}

export type BlockOpts = {
  hostId: string
  editable: boolean
  navigate: (to: string) => void
  onChanged: () => void
}

type BlockProps = {
  attrs: CollectionBlockAttrs
  link: boolean
  opts: BlockOpts
  setViewId: (viewId: string) => void
  removeBlock: () => void
}

function CollectionBlock({ attrs, link, opts, setViewId, removeBlock }: BlockProps) {
  const cid = attrs.collectionId
  const pages = useCollectionPages()
  useSyncExternalStore(subscribeFlags, () => flagRev)
  const isCreating = creating.has(cid)
  const isFailed = failed.has(cid)
  const [state, setState] = useState<CollectionState | null | undefined>(undefined)
  const ask = needsState({ pages, collectionId: cid, creating: isCreating, failed: isFailed })
  useEffect(() => {
    if (!ask) return
    let live = true
    setState(undefined)
    collectionApi.state(cid).then(
      (s) => live && setState(s),
      (err: unknown) => {
        console.error(err)
        if (live) setState(null)
      },
    )
    return () => {
      live = false
    }
  }, [ask, cid])
  const verdict = blockVerdict({ link, hostId: opts.hostId, collectionId: cid, pages, state, creating: isCreating, failed: isFailed })
  const handle = useCollection(verdict.kind === 'show' ? cid : null)
  const schema = useCollectionSchema(handle)
  // 块里切到哪个视图只记在本机、不写块的 attr：写了就是改了宿主页（多一条「最近编辑」、多一个版本，
  // 别人打开看到的视图也跟着变）。attr 的 viewId 只是默认视图，没切过或切过的视图已被删就用它
  const [bulkSlot, setBulkSlot] = useState<HTMLElement | null>(null)
  const [localView, setLocalView] = useState<string | null>(() => readBlockView(attrs.id))
  useEffect(() => setLocalView(readBlockView(attrs.id)), [attrs.id])
  const viewId = localView && schema?.views.some((v) => v.id === localView) ? localView : attrs.viewId
  const chooseView = (next: string): void => {
    setLocalView(next)
    writeBlockView(attrs.id, next)
  }

  // 空的 viewId 补成第一个视图（源码记号与导出里就有了确定的视图）
  const first = schema?.views[0]?.id
  useEffect(() => {
    if (opts.editable && !attrs.viewId && first) setViewId(first)
  }, [opts.editable, attrs.viewId, first, setViewId])

  const listed = pages?.find((p) => p.id === cid)
  const title = listed?.title ?? state?.title ?? attrs.title
  const show = verdict.kind === 'show'
  // 集合层面的写（改值、属性与视图定义、改名、恢复）按集合所在空间的角色算，不按宿主页：
  // 从别的空间粘贴来的链接视图，我在那个空间是 viewer 就只读。块自己的 attr（看哪个视图、删块）仍归宿主页
  const spaces = useCollectionSpaces()
  const writable = blockWritable(opts.editable, spaces, listed?.space_id ?? (verdict.kind === 'show' ? verdict.spaceId : null))

  const rename = (name: string, h: CollectionHandle): void => {
    h.doc.transact(() => writeTitleFragment(h.doc.getXmlFragment('title'), name))
    api
      .renamePage(cid, name)
      .then(opts.onChanged)
      .catch((err: unknown) => console.error(err))
  }
  const restore = (): void => {
    api
      .restorePage(cid)
      .then(opts.onChanged)
      .catch((err: unknown) => {
        console.error(err)
        window.alert(err instanceof Error && err.message ? err.message : C.restoreFailed)
      })
  }

  const placeholder = (text: string, action?: { label: string; run: () => void; enabled: boolean }) => (
    <div className="cl-block-note">
      <span>{text}</span>
      {action?.enabled && (
        <button type="button" className="cl-bar-btn" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )

  return (
    <>
      <div className="cl-block-head">
        {show && handle && writable ? (
          <NameInput className="cl-block-name" value={title} placeholder={C.name} onCommit={(name) => rename(name, handle)} />
        ) : (
          <span className="cl-block-name is-static">{title || COPY.untitled}</span>
        )}
        {link && <span className="cl-block-tag">{C.linkTag}</span>}
        <div ref={setBulkSlot} className="cl-bulk-slot" />
      </div>
      {show && handle && bulkSlot && (
        <BulkSlot.Provider value={bulkSlot}>
        <CollectionSurface
          handle={handle}
          readOnly={!writable}
          spaceId={verdict.spaceId}
          onOpenRow={(rowId) => opts.navigate(`/page/${rowId}`)}
          viewId={viewId}
          onViewChange={chooseView}
          manageViews={!link}
        />
        </BulkSlot.Provider>
      )}
      {show && !handle && placeholder(C.loading)}
      {(verdict.kind === 'loading' || verdict.kind === 'creating') && placeholder(C.loading)}
      {verdict.kind === 'failed' && placeholder(C.createFailed, { label: C.removeBlock, run: removeBlock, enabled: opts.editable })}
      {verdict.kind === 'trashed' && placeholder(C.trashed, { label: C.restore, run: restore, enabled: writable })}
      {verdict.kind === 'elsewhere' && placeholder(C.elsewhere)}
      {verdict.kind === 'unavailable' && placeholder(C.unavailable)}
    </>
  )
}

const DRAG_EVENTS = new Set(['dragenter', 'dragover', 'dragleave', 'drop'])

function factory(opts: BlockOpts, link: boolean): NodeViewConstructor {
  return (initial: PMNode, view: EditorView, getPos) => {
    let node = initial
    const dom = document.createElement('div')
    dom.className = 'cl-block' + (link ? ' is-link' : '')
    dom.contentEditable = 'false'
    const root: Root = createRoot(dom)

    /** 当前这个块在文档里的位置（协同端可能已经删了它 / 换了类型：不写） */
    const here = (): number | null => {
      const pos = getPos()
      if (typeof pos !== 'number') return null
      return view.state.doc.nodeAt(pos)?.type === node.type ? pos : null
    }
    const setViewId = (viewId: string): void => {
      const pos = here()
      if (pos === null || view.isDestroyed || !view.editable) return
      const current = view.state.doc.nodeAt(pos)
      if (!current || current.attrs.viewId === viewId) return
      // 看哪个视图不进撤销栈：空 viewId 的自动补写若进了栈，⌘Z 撤掉它后块里的 effect 立刻补回、
      // 又压一条，撤销永远退不到插块之前
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, viewId }).setMeta('addToHistory', false))
    }
    const removeBlock = (): void => {
      const pos = here()
      if (pos === null || view.isDestroyed || !view.editable) return
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize))
    }
    const render = (): void => root.render(<CollectionBlock attrs={blockAttrs(node)} link={link} opts={opts} setViewId={setViewId} removeBlock={removeBlock} />)
    render()
    const stopBleed = trackBleed({ view, block: dom, target: dom })

    return {
      dom,
      update: (next) => {
        // 换了集合（或类型）就重建：块里的连接、窗口都跟着集合走
        if (next.type !== node.type || next.attrs.collectionId !== node.attrs.collectionId) return false
        node = next
        render()
        return true
      },
      // 块里的事件都不归编辑器；唯一例外是正文块的拖放（view.dragging 只由手柄拖起时设置）经过 / 落在块上：
      // 交给编辑器算落点，否则拖到集合块上方松手什么都不发生。块里自己的行 / 视图拖动不设 view.dragging，不受影响
      stopEvent: (event) => !(view.dragging && DRAG_EVENTS.has(event.type)),
      ignoreMutation: () => true,
      destroy: () => {
        stopBleed()
        queueMicrotask(() => root.unmount())
      },
    }
  }
}

/** 编辑器（editor-session.ts）挂：两种块各一个 nodeView。公开页不挂（toDOM 占位） */
export function collectionBlockViews(opts: BlockOpts) {
  return [$view(collectionInlineSchema.node, () => factory(opts, false)), $view(collectionLinkSchema.node, () => factory(opts, true))]
}
