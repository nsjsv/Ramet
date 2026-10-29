// ---------- 后退 / 前进回到原位（文档模式与集合页） ----------
// 文档页用 useReadPosition（锚 = 顶层块），集合页用同一个 useScrollAnchor（锚 = 表格的行，collection/CollectionPage.tsx）。
// .main 是所有路由共用的滚动口，所以换页一律先归零，否则上一页残留的 scrollTop 会被新页高度截断成半截位置；
// 只有浏览器后退 / 前进（react-router 的 POP）回到某条历史记录时，才把位置放回离开时的样子。
// 记录只在本标签页内存里（按历史记录的 location.key），刷新即清。
// 记的是视口顶上那一块的 id + 块顶到滚动口顶的距离，而不是 scrollTop：图片 / 公式晚到撑高也回得到同一段。
//
// 恢复：编辑器建好 / ws synced（editorTick）与正文每次长高都对一次锚，直到
// 用户自己动（滚轮 / 触摸 / 按键 / 按下指针）、别处的代码滚了它或 SETTLE_MS 到期。
// 恢复期间不记，并关掉浏览器的滚动锚定（它也改 scrollTop，会被误判成「别处滚了」）。
// 对话模式不管（chat-follow 贴底）；进页时带 ?block= 也不恢复（定位优先）。
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import type { EditorView } from '@milkdown/kit/prose/view'
import { findBlockIdPos } from './block-id'
import { readViewMode } from '../view-mode'

const SETTLE_MS = 3000

type Anchor = { b: string; y: number }

/** 可当锚的元素（按文档顺序）：id 跨渲染稳定（块 id / 行 id） */
export type ScrollTarget = { id: string; el: HTMLElement }

/** 历史记录 key → 离开时的锚（本标签页内存；在页顶不记） */
const positions = new Map<string, Anchor>()

/** 视口顶上那一块：第一个底边越过滚动口顶边的锚元素。在页顶返回 null */
function capture(targets: Iterable<ScrollTarget>, scroller: HTMLElement): Anchor | null {
  if (scroller.scrollTop < 1) return null
  const top = scroller.getBoundingClientRect().top
  for (const t of targets) {
    const r = t.el.getBoundingClientRect()
    if (r.bottom > top) return { b: t.id, y: r.top - top }
  }
  return null
}

/** 把锚元素放回原来的高度；它还没到（缓存是旧的 / 等 ws / 行还没加载）返回 false */
function apply(el: HTMLElement | null, scroller: HTMLElement, anchor: Anchor): boolean {
  if (!el) return false
  const dy = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.y
  if (Math.abs(dy) >= 1) scroller.scrollTop += dy
  return true
}

/** 正文的顶层块（惰性：capture 找到就停，不为后面的块取 DOM） */
function* blockTargets(view: EditorView): Generator<ScrollTarget> {
  const doc = view.state.doc
  for (let i = 0, offset = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    const id: unknown = node.attrs.id
    if (typeof id === 'string' && id) {
      const dom = view.nodeDOM(offset)
      if (dom instanceof HTMLElement) yield { id, el: dom }
    }
    offset += node.nodeSize
  }
}

function blockDom(view: EditorView, id: string): HTMLElement | null {
  const pos = findBlockIdPos(view.state.doc, id)
  if (pos === null) return null
  const dom = view.nodeDOM(pos)
  return dom instanceof HTMLElement ? dom : null
}

/** 挂在 EditorPage：rootRef = 正文挂载点（.main 里）；getView 必须只返回属于当前页的正文视图；
 *  tick = editorTick（编辑器建好 / ws synced 各 +1）；enabled = 当前是文档模式（管记录）；skip = 进页时带定位参数 */
export function useReadPosition(p: {
  pageId: string | undefined
  rootRef: RefObject<HTMLElement | null>
  getView: () => EditorView | undefined
  tick: number
  enabled: boolean
  skip: boolean
}): void {
  const live = (): EditorView | null => {
    const view = p.getView()
    return view && !view.isDestroyed ? view : null
  }
  useScrollAnchor({
    ...p,
    targets: () => {
      const view = live()
      return view ? blockTargets(view) : null
    },
    locate: (id) => {
      const view = live()
      return view ? blockDom(view, id) : null
    },
    // 进页时按目标页的模式判（enabled 来自 chatMode state，换页这一帧还是上一页的值）
    restorable: (pageId) => !readViewMode(pageId),
  })
}

/** 同一套记录 / 恢复，锚元素由调用方给（文档的顶层块、集合表格的行，见 collection/CollectionPage.tsx）。
 *  targets 返回 null = 还没就绪（不记，也不清掉已记的）；locate 找不到锚 = 还没到，有 more 就请它多取一些再对。
 *  pageId 变了才重建（换页）；tick 变了补对一次锚，内容长高由 ResizeObserver 补对 */
export function useScrollAnchor(p: {
  pageId: string | undefined
  rootRef: RefObject<HTMLElement | null>
  targets: () => Iterable<ScrollTarget> | null
  locate: (id: string) => HTMLElement | null
  tick: number
  enabled: boolean
  skip: boolean
  restorable?: (pageId: string) => boolean
  more?: () => void
}): void {
  const entryKey = useLocation().key
  const back = useNavigationType() === 'POP'
  const o = { ...p, entryKey, back }
  const live = useRef(o)
  live.current = o
  // 本页的恢复动作（换页的 layout effect 里建、tick effect 里补一枪）；null = 不在恢复期
  const restoreRef = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    const pageId = o.pageId
    const root = live.current.rootRef.current
    const scroller = root?.closest<HTMLElement>('.main')
    if (!pageId || !root || !scroller) return
    const entry = live.current.entryKey
    const canRestore = live.current.restorable?.(pageId) ?? true
    const saved = live.current.back && canRestore && !live.current.skip ? positions.get(entry) ?? null : null
    let restoring = saved !== null
    let ownTop = 0
    let raf = 0
    let settleTimer = 0
    scroller.scrollTop = 0 // 上一页残留的位置不算数

    const settle = (): void => {
      if (!restoring) return
      restoring = false
      restoreRef.current = null
      scroller.style.removeProperty('overflow-anchor')
      window.clearTimeout(settleTimer)
    }
    const restore = (): void => {
      if (!restoring || !saved) return
      if (apply(live.current.locate(saved.b), scroller, saved)) ownTop = scroller.scrollTop
      else live.current.more?.()
    }
    const onScroll = (): void => {
      if (restoring) {
        // 被内容变矮截断不算别人动；别的改动 = 用户或别处代码接管了位置
        const clamped = scroller.scrollTop < ownTop && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1
        if (Math.abs(scroller.scrollTop - ownTop) >= 1 && !clamped) settle()
        else ownTop = scroller.scrollTop
        if (restoring) return
      }
      if (!live.current.enabled || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const targets = live.current.targets()
        if (!targets || !live.current.enabled) return
        const anchor = capture(targets, scroller)
        if (anchor) positions.set(entry, anchor)
        else positions.delete(entry)
      })
    }
    const observer = new ResizeObserver(restore)
    if (restoring) {
      settleTimer = window.setTimeout(settle, SETTLE_MS)
      scroller.style.setProperty('overflow-anchor', 'none')
      restoreRef.current = restore
      observer.observe(root)
      restore()
    }
    const userInput = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const t of userInput) scroller.addEventListener(t, settle, { passive: true })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      settle()
      observer.disconnect()
      for (const t of userInput) scroller.removeEventListener(t, settle)
      scroller.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [o.pageId])

  useEffect(() => {
    restoreRef.current?.()
  }, [o.tick])
}
