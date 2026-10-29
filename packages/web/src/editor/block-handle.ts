// ---------- 块手柄与拖拽落点指示 ----------
// 悬停命中、手柄定位、拖拽起点、落点横条都在这里。要点：
//   - 即时命中（无 throttle），指针必须落在某顶层行矩形内才显示手柄（selectRootNodeByPoint）；
//   - 定位只挂 offset，不挂 flip()；hide 后用 hidden 标志丢弃未决的异步定位结果；
//   - 点击不 dispatch NodeSelection：mousedown 只记 activeSelection + activeDOMRect，
//     拖拽 dragstart 现算 NodeSelection 取 slice；点击态是 blockSelectKey 行高亮 + PM caret；
//   - 嵌套 li 下钻到最深命中条目（drillIntoListItems）；AI 回复下钻到直接子块
//     （可寻址块，见 @ramet/shared/block-address），子块里的 li 再下钻。
// 落点横条自绘：官方 prosemirror-dropcursor 1.8 起事件直接挂 view.dom，插件优先级拦不住，无法按拖拽源抑制。
// 列表条目三段落点拖拽由 list-drag 的 list-drop-line 接管，dragover 首行命中 computeDropTarget 即清线返回。
// ProseMirror 模块一律从 @milkdown/kit/prose/* 引。

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { browser } from '@milkdown/kit/prose'
import { dropPoint } from '@milkdown/kit/prose/transform'
import type { Node as PMNode, ResolvedPos } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { computePosition, offset } from '@floating-ui/dom'
// import cycle（list-drag 与 block-handle）只发生在类型 / 常量引用上，运行时无环调用
import { computeDropTarget } from './list-drag'
// page-drop 反向引用本文件（命中口径）成环：三方都只在事件回调里互调，ESM 惰性求值安全
import { markBlockDrag, pageRefDropTarget, setPageRefHighlight } from './page-drop'
import { beginRangeDrag, endRangeDrag } from './block-ops'

/** 命中结果的通用结构：顶层块或下钻到的最深 li。block-menu 直接消费，list-drag 复用 */
export interface BlockMenuActive {
  $pos: ResolvedPos
  node: PMNode
  el: HTMLElement
}

type FilterNodes = ($pos: ResolvedPos, node: PMNode | null) => boolean

/** 默认过滤器：表格内的块不出手柄，也不被拖拽落点命中 */
export const defaultNodeFilter: FilterNodes = ($pos) => {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'table') return false
  }
  return true
}

// ---------- 命中检测 ----------

// li 嵌套深度是祖先链上的 li 个数（0 是顶层块的直接条目）。下钻取最深的命中者：
// 父 li 矩形盖住整个子树，悬停嵌套条目时父子同时命中，深者才是指针真正所在
function liDepth(li: HTMLElement): number {
  let depth = 0
  for (let p = li.parentElement; p; p = p.parentElement) if (p.tagName === 'LI') depth++
  return depth
}

function drillIntoListItems(
  view: EditorView,
  blockEl: Element,
  clientY: number,
  filterNodes: FilterNodes,
): BlockMenuActive | null {
  const items = blockEl.querySelectorAll('li')
  let best: { li: HTMLElement; depth: number } | null = null
  for (const li of items) {
    const rect = li.getBoundingClientRect()
    if (!rect.height && !rect.width) continue
    const style = getComputedStyle(li)
    const marginTop = parseFloat(style.marginTop) || 0
    const marginBottom = parseFloat(style.marginBottom) || 0
    // 底边 +1px 容差：半开区间 [top,bottom) 会把恰好压在底边的指针判到界外，
    // li 无 margin 缓冲，非整数缩放（165%）下取整坐标正好压线，悬停和拖拽都会失效
    if (clientY < rect.top - marginTop || clientY > rect.bottom + marginBottom + 1) continue
    const depth = liDepth(li)
    if (!best || depth > best.depth) best = { li, depth }
  }
  if (!best) return null
  try {
    // posAtDOM(li, 0) 在 li 开口之后（非叶 node desc 的 border=1），-1 回到 li 节点起点：
    // NodeSelection（拖拽 slice）、行高亮、菜单快照全都锚在节点自身起点上，差 1 全错
    const pos = view.posAtDOM(best.li, 0) - 1
    const $pos = view.state.doc.resolve(pos)
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'list_item') return null
    if (!filterNodes($pos, node)) return null // 与顶层同一过滤器（默认只排除表格内）
    return { node, $pos, el: best.li }
  } catch {
    return null // DOM 已不在编辑器内等异常，回退顶层块
  }
}

/** 行矩形命中：clientY 落在元素矩形内，矩形按上下 margin 外扩（hr 这类细高元素自身只有 2px，
 * margin 区不外扩的话手柄基本没法悬停）；底边 +1px 容差同 drillIntoListItems */
function rowHit(element: Element, clientY: number): boolean {
  const rect = element.getBoundingClientRect()
  if (!rect.height && !rect.width) return false
  const style = getComputedStyle(element)
  const marginTop = parseFloat(style.marginTop) || 0
  const marginBottom = parseFloat(style.marginBottom) || 0
  return clientY >= rect.top - marginTop && clientY <= rect.bottom + marginBottom + 1
}

/** AI 回复下钻：命中回复的直接子块（与顶层同一矩形口径），子块里有列表再下钻到最深命中条目。
 * 一个子块都没命中（顶栏、内边距）返回 null，由调用方回落整条回复（「重新生成」等整块动作从那里出） */
function drillIntoReply(
  view: EditorView,
  replyPos: number,
  reply: PMNode,
  clientY: number,
  filterNodes: FilterNodes,
): BlockMenuActive | null {
  let hit: BlockMenuActive | null = null
  reply.forEach((child, childOffset) => {
    if (hit) return
    const pos = replyPos + 1 + childOffset
    const el = view.nodeDOM(pos)
    if (!(el instanceof HTMLElement) || !rowHit(el, clientY)) return
    const $pos = view.state.doc.resolve(pos)
    if (!filterNodes($pos, child)) return
    hit = drillIntoListItems(view, el, clientY, filterNodes) || { node: child, $pos, el }
  })
  return hit
}

/** 分栏下钻：按横坐标选中那一栏（落在栏间空隙取最近的一栏），再像 AI 回复一样按纵坐标命中栏里的子块 */
function drillIntoColumns(
  view: EditorView,
  columnsPos: number,
  columns: PMNode,
  clientX: number,
  clientY: number,
  filterNodes: FilterNodes,
): BlockMenuActive | null {
  let best: { pos: number; node: PMNode; dist: number } | null = null
  columns.forEach((column, offset) => {
    const pos = columnsPos + 1 + offset
    const el = view.nodeDOM(pos)
    if (!(el instanceof HTMLElement)) return
    const rect = el.getBoundingClientRect()
    const dist = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
    if (!best || dist < best.dist) best = { pos, node: column, dist }
  })
  const hit = best as { pos: number; node: PMNode } | null
  return hit ? drillIntoReply(view, hit.pos, hit.node, clientY, filterNodes) : null
}

/** 命中检测：clientY 落在某顶层块行矩形（按上下 margin 外扩）内才命中；AI 回复下钻到子块，
 * 块内含 li 时下钻到最深命中条目。clientX 只在分栏里用（选哪一栏）；不给（拖拽落点、侧栏拖放）时命中分栏整块。
 * list-drag 复用同一口径 */
export function selectRootNodeByPoint(
  view: EditorView,
  clientY: number,
  filterNodes: FilterNodes,
  clientX?: number,
): BlockMenuActive | null {
  if (!view.dom.parentElement) return null
  let hit: BlockMenuActive | null = null
  try {
    view.state.doc.forEach((node, offset) => {
      if (hit) return
      const element = view.nodeDOM(offset)
      if (!(element instanceof Element) || !rowHit(element, clientY)) return
      const $pos = view.state.doc.resolve(offset)
      if (!filterNodes($pos, node)) return
      // AI 回复：先下钻到命中的子块（子块里再下钻 li），没命中子块（顶栏 / 内边距）就是整条回复。
      // 其余块：含 li 时下钻到最深命中条目，一条 li 都没命中（如悬停列表上下 margin 区）则维持顶层块
      const drilled =
        node.type.name === 'agent_reply'
          ? drillIntoReply(view, offset, node, clientY, filterNodes)
          : node.type.name === 'columns' && clientX !== undefined
            ? drillIntoColumns(view, offset, node, clientX, clientY, filterNodes)
            : drillIntoListItems(view, element, clientY, filterNodes)
      hit = drilled || { node, $pos, el: element as HTMLElement }
    })
  } catch {
    return null
  }
  return hit
}

/** 集合块的块手柄只在块头（集合名那一行及以上）出：块头以下是表格行 / 看板卡片，它们有自己的手柄，
 * 块手柄再亮在标题行上，指针在哪一行、手柄指的是谁就对不上了。只管悬停，拖放落点仍按整块命中 */
function inCollectionBody(hit: BlockMenuActive, clientY: number): boolean {
  if (!hit.el.classList.contains('cl-block')) return false
  const head = hit.el.querySelector(':scope > .cl-block-head')
  return head instanceof HTMLElement && clientY > head.getBoundingClientRect().bottom
}

/** 手柄以块第一行的垂直中心对齐（与手机端 block-touch alignSelf 同规则；默认是整块
 * 矩形居中，多行 / 图片块会滑到中间）：虚拟矩形零高锚在块顶 + 首行半高，floating-ui
 * placement=left 纵向居中后手柄中心恰好落在首行中线。矮原子块（hr）钳到自身高 */
function handlePositionRect(active: BlockMenuActive): DOMRect {
  const r = active.el.getBoundingClientRect()
  // 列表条目（li）：矩形左缘是文字起点，marker 挂在父 list 的 padding 区里，直接用会把
  // 手柄压到 marker / 文字上。锚到父 list 盒左缘（li.left - 父 padding-left）：顶层条目回到
  // 正文列左缘，嵌套条目自动落到上一层缩进列
  // 表格：锚在 <table> 本身的左缘。宽表格横向滚动时表格在滚动层里左移（table-scroll.ts），手柄跟着表格左上角走，
  // 不留在原地压住滑进左侧留白的格子；滚到表格左缘出了滚动层，手柄也跟着出去（落在 .main 外 / 侧栏底下）
  const table = active.el.classList.contains('table-block') ? active.el.querySelector(':scope > .table-scroll > table') : null
  let left = table ? table.getBoundingClientRect().left : r.left
  if (active.el.tagName === 'LI') {
    const list = active.el.parentElement
    if (list instanceof HTMLElement) left -= parseFloat(getComputedStyle(list).paddingLeft) || 0
  }
  const cs = getComputedStyle(active.el)
  const fs = parseFloat(cs.fontSize) || 16
  const lh = parseFloat(cs.lineHeight) || fs * 1.75 // line-height:normal 兼容（同手机端）
  const firstHalf = Math.min(r.height || lh, lh) / 2
  // 光学 +1px：中文字形视觉中心比行盒几何中心偏沉，以标准文本行为基准校准（2px 过头）
  const y = r.top + firstHalf + 1
  return { x: left, y, width: r.width, height: 0, top: y, left, right: r.right, bottom: y } as DOMRect
}

// ---------- BlockHandleProvider：手柄 DOM + 拖拽事件 + floating-ui 定位 ----------
// brokenClipboardAPI：老 IE / 老 iOS WebKit 的 dataTransfer 只认 Text 类型，
// 现代浏览器两个分支走同一结果，但判定本身不能删（与上游 dragstart 逐行等价）
const browserAny = browser as { ie?: boolean; ie_version?: number; ios?: boolean; webkit_version?: number }
const brokenClipboardAPI = Boolean(
  (browserAny.ie && (browserAny.ie_version ?? 99) < 15) || (browserAny.ios && (browserAny.webkit_version ?? 999) < 604),
)

export class BlockHandleProvider {
  /** 当前命中的块 / 条目（hover 态快照）；block-menu 与 Editor.tsx 块选链路直接消费 */
  active: BlockMenuActive | null = null

  private readonly content: HTMLElement
  private getView: () => EditorView | undefined = () => undefined
  /** 当前页 id（侧栏树拖放数据用）：dragstart 时往 dataTransfer 外的模块级登记写 {pageId, blockId} */
  private getPageId: () => string | undefined = () => undefined
  private activeSelection: NodeSelection | null = null
  private activeDOMRect: DOMRect | undefined
  private dragging = false
  private initialized = false
  /** show / hide 竞态：hide 后丢弃未决的异步定位结果 */
  private hidden = true

  constructor(options: { content: HTMLElement; getPageId?: () => string | undefined }) {
    this.content = options.content
    if (options.getPageId) this.getPageId = options.getPageId
    this.content.dataset.show = 'false'
  }

  /** 插件 view 工厂里注入视图获取方式 */
  bind(getView: () => EditorView | undefined): void {
    this.getView = getView
  }

  /** 挂 DOM + 监听（rAF 惰性初始化：update 可能在 editorViewCtx 就绪前调用）。
   * PM 重建插件视图时会重调，同一函数引用重复 addEventListener 会自动去重，安全 */
  update(): void {
    requestAnimationFrame(() => {
      if (this.initialized) return
      try {
        this.init()
        this.initialized = true
      } catch {
        /* 视图未就绪：下一帧 / 下次重建再试 */
      }
    })
  }

  destroy(): void {
    this.getView()?.dom.removeEventListener('scroll', this.handleInnerScroll, true)
    const el = this.content
    el.removeEventListener('mousedown', this.handleMouseDown)
    el.removeEventListener('mouseup', this.handleMouseUp)
    el.removeEventListener('dragstart', this.handleDragStart)
    el.removeEventListener('dragend', this.handleDragEnd)
    el.remove()
    this.active = null
    this.activeSelection = null
    this.initialized = false
  }

  /** instant：直接落位不走滑动过渡（跟着块内横向滚动重新定位时用） */
  show(active: BlockMenuActive, instant = false): void {
    this.hidden = false
    const dom = active.el
    const virtualEl = {
      contextElement: dom,
      getBoundingClientRect: () => handlePositionRect(active),
    }
    // 不挂 flip()：块无左 gutter 时 flip 会把手柄甩到块右侧。
    // offset mainAxis 6：手柄整体后退 6px，右缘贴住块选高亮的 -6px 前缘线（同手机端 -44 让位逻辑）
    computePosition(virtualEl, this.content, { placement: 'left', middleware: [offset(6)] })
      .then(({ x, y }) => {
        if (this.hidden) return // 定位期间已被 hide（如 mouseleave），丢弃过期结果
        // 位置走 transform（CSS 读 --x / --y）。已显示时在块之间滑过去；刚出现时先落位再淡入，
        // 不从上次消失的地方滑过来；跟着块内滚动（instant）也直接落位，不拖着过渡在后面追
        const s = this.content.style
        const jump = instant || this.content.dataset.show !== 'true'
        if (jump) s.transition = 'none'
        s.setProperty('--x', `${x}px`)
        s.setProperty('--y', `${y}px`)
        if (jump) {
          void this.content.offsetWidth // 在 transition: none 下提交落位
          s.transition = ''
        }
        this.content.dataset.show = 'true'
      })
      .catch(console.error)
  }

  hide(): void {
    this.hidden = true
    this.content.dataset.show = 'false'
    this.active = null
  }

  private init(): void {
    const view = this.getView()
    if (!view) throw new Error('view not ready')
    const parent = view.dom.parentElement
    if (!parent) throw new Error('view.dom has no parent')
    parent.appendChild(this.content)
    view.dom.addEventListener('scroll', this.handleInnerScroll, true) // 块内滚动不冒泡，capture 才收得到
    const el = this.content
    el.addEventListener('mousedown', this.handleMouseDown)
    el.addEventListener('mouseup', this.handleMouseUp)
    el.addEventListener('dragstart', this.handleDragStart)
    el.addEventListener('dragend', this.handleDragEnd)
    el.draggable = true
  }

  /** 块内横向滚动（宽表格）：手柄锚在表格左缘，跟着滚动重新定位 */
  private handleInnerScroll = (e: Event): void => {
    const active = this.active
    if (this.hidden || !active || !(e.target instanceof Node) || !active.el.contains(e.target)) return
    this.show(active, true)
  }

  /** mousedown：只记快照，不 dispatch NodeSelection。dispatch 后 focus 和后续任何
   * dispatch（含 collab 同步）都会同步把盖住整块的原生 DOM 选区写进页面，JS 清除只能
   * 异步跑，必闪。点击态是行高亮 decoration（Editor.tsx blockSelectKey）+ PM caret；
   * 拖拽在 dragstart 现算 NodeSelection（不 dispatch，仅用于取 slice） */
  private handleMouseDown = (): void => {
    const active = this.active
    const view = this.getView()
    this.activeDOMRect = active?.el.getBoundingClientRect()
    if (active && view && NodeSelection.isSelectable(active.node)) {
      this.activeSelection = NodeSelection.create(view.state.doc, active.$pos.pos)
    } else {
      this.activeSelection = null
    }
  }

  private handleMouseUp = (): void => {
    if (!this.dragging) {
      requestAnimationFrame(() => {
        if (!this.activeDOMRect) return
        this.getView()?.focus()
      })
      return
    }
    this.dragging = false
    this.activeSelection = null
  }

  private handleDragStart = (event: DragEvent): void => {
    this.dragging = true
    const view = this.getView()
    if (!view) return
    view.dom.dataset.dragging = 'true'
    // 拖起的块落在多块选区里：整段一起拖（block-ops.ts 登记，落点由它的 handleDrop 接管）。
    // 不写 dragging.node：PM 原生 drop 与 list-drag 只认单节点，写了会只删第一块
    const range = this.active ? beginRangeDrag(view, this.active.$pos.pos) : null
    if (range && event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove'
      const { dom, text } = view.serializeForClipboard(range)
      event.dataTransfer.clearData()
      event.dataTransfer.setData(brokenClipboardAPI ? 'Text' : 'text/html', dom.innerHTML)
      if (!brokenClipboardAPI) event.dataTransfer.setData('text/plain', text)
      const activeEl = this.active?.el
      if (activeEl) event.dataTransfer.setDragImage(activeEl, 0, 0)
      view.dragging = { slice: range, move: true } as EditorView['dragging']
      return
    }
    // 点击态不 dispatch NodeSelection，拖拽启动时按当前文档现算，保证 slice 最新
    // （鼠标移动期间文档可能变了，重校验 nodeAt(pos)）
    if (this.active && view.state.doc.nodeAt(this.active.$pos.pos)) {
      this.activeSelection = NodeSelection.create(view.state.doc, this.active.$pos.pos)
    }
    const selection = this.activeSelection
    if (event.dataTransfer && selection) {
      const slice = selection.content()
      event.dataTransfer.effectAllowed = 'copyMove'
      const { dom, text } = view.serializeForClipboard(slice)
      event.dataTransfer.clearData()
      event.dataTransfer.setData(brokenClipboardAPI ? 'Text' : 'text/html', dom.innerHTML)
      if (!brokenClipboardAPI) event.dataTransfer.setData('text/plain', text)
      const activeEl = this.active?.el
      if (activeEl) event.dataTransfer.setDragImage(activeEl, 0, 0)
      view.dragging = {
        slice,
        move: true,
        // node 字段：list-drag 的 dragSourcePos 依赖它判定拖拽源（官方类型未声明，必须保留）
        node: selection,
      } as EditorView['dragging']
      // 侧栏树拖放：顶层块源登记 {pageId, blockId}（受保护模式下 dragover 读不到 dataTransfer，
      // 见 page-drop.ts blockDragTarget）。li 源（条目粒度不支持跨页）不登记，树行不亮
      const srcNode = this.active?.node
      const srcId = srcNode && srcNode.type.name !== 'list_item' && typeof srcNode.attrs.id === 'string' ? srcNode.attrs.id : ''
      const pageId = this.getPageId()
      if (srcId && pageId) markBlockDrag(pageId, srcId)
    }
  }

  private handleDragEnd = (): void => {
    const view = this.getView()
    this.dragging = false
    endRangeDrag()
    if (view) view.dom.dataset.dragging = 'false'
    this.hide()
    if (!view) return
    const dragging = view.dragging
    window.setTimeout(() => {
      if (view.dragging === dragging) view.dragging = null
    }, 50)
  }
}

// ---------- 落点横条（自绘） ----------
// 坐标换算照官方 prosemirror-dropcursor 1.8.4 的 updateOverlay：挂在 view.dom.offsetParent，
// 含缩放（offsetWidth / rect 比）与滚动（parent.scrollLeft / Top）修正；挂 body 时按页面坐标。
// 横条样式只动 CSS（.block-drop-cursor：height 2px、background var(--accent)、z-index 50）。

/** 落点边界两侧邻块间隙的视觉中点（(before.bottom + after.top) / 2，与 updateOverlay
 * 画线同口径）。只有一侧有 DOM 时取该侧边缘，两侧都没有返回 null。
 * 拖拽指示线（list-drop-line / block-drop-line）统一用它定 y：「插到 A 后」与
 * 「插到 B 前」是同一条 doc 边界，必须画同一根线，不能各自骑在 A 底 / B 顶两处。 */
export function boundaryGapY(view: EditorView, boundary: number): number | null {
  const $b = view.state.doc.resolve(boundary)
  const beforeEl = $b.nodeBefore ? view.nodeDOM(boundary - $b.nodeBefore.nodeSize) : null
  const afterEl = $b.nodeAfter ? view.nodeDOM(boundary) : null
  const top = afterEl instanceof Element ? afterEl.getBoundingClientRect().top : null
  const bottom = beforeEl instanceof Element ? beforeEl.getBoundingClientRect().bottom : null
  if (top != null && bottom != null) return (top + bottom) / 2
  return top ?? bottom
}

class BlockDropCursorView {
  private cursorPos: number | null = null
  private element: HTMLElement | null = null
  private timeout = -1
  private lastDragEvent: DragEvent | null = null
  private readonly handlers: Array<{ name: string; handler: (e: Event) => void }> = []

  constructor(private readonly view: EditorView) {
    for (const name of ['dragover', 'dragend', 'drop', 'dragleave']) {
      const handler = (e: Event) => {
        this[name as 'dragover' | 'dragend' | 'drop' | 'dragleave'](e as DragEvent)
      }
      view.dom.addEventListener(name, handler)
      this.handlers.push({ name, handler })
    }
  }

  destroy(): void {
    this.setCursor(null)
    for (const { name, handler } of this.handlers) this.view.dom.removeEventListener(name, handler)
  }

  update(view: EditorView, prevState: EditorState): void {
    if (this.cursorPos != null && prevState.doc != view.state.doc) {
      // 拖拽期间文档变了（协同端写入）：重算落点并重画
      if (this.lastDragEvent) {
        const target = this.computeTarget(this.lastDragEvent)
        if (target == this.cursorPos) this.updateOverlay()
        else this.setCursor(target)
      } else {
        this.updateOverlay()
      }
    }
  }

  private setCursor(pos: number | null): void {
    if (pos == this.cursorPos) return
    this.cursorPos = pos
    if (pos == null) {
      this.element?.parentNode?.removeChild(this.element)
      this.element = null
    } else {
      this.updateOverlay()
    }
  }

  private updateOverlay(): void {
    if (this.cursorPos == null) return
    const $pos = this.view.state.doc.resolve(this.cursorPos)
    const isBlock = !$pos.parent.inlineContent
    let rect: { left: number; right: number; top: number; bottom: number } | undefined
    const editorDOM = this.view.dom
    const editorRect = editorDOM.getBoundingClientRect()
    const scaleX = editorRect.width / editorDOM.offsetWidth
    const scaleY = editorRect.height / editorDOM.offsetHeight
    const width = 2 // 落点横条厚度（CSS 类同名约束；改样式动 .block-drop-cursor）
    if (isBlock) {
      const before = $pos.nodeBefore
      const after = $pos.nodeAfter
      if (before || after) {
        const node = this.view.nodeDOM(this.cursorPos - (before ? before.nodeSize : 0))
        if (node) {
          const nodeRect = (node as Element).getBoundingClientRect()
          let top = before ? nodeRect.bottom : nodeRect.top
          if (before && after)
            top = (top + (this.view.nodeDOM(this.cursorPos) as Element).getBoundingClientRect().top) / 2
          const halfWidth = (width / 2) * scaleY
          rect = { left: nodeRect.left, right: nodeRect.right, top: top - halfWidth, bottom: top + halfWidth }
        }
      }
    }
    if (!rect) {
      const coords = this.view.coordsAtPos(this.cursorPos)
      const halfWidth = (width / 2) * scaleX
      rect = { left: coords.left - halfWidth, right: coords.left + halfWidth, top: coords.top, bottom: coords.bottom }
    }
    const parent = editorDOM.offsetParent as HTMLElement | null
    if (!this.element && parent) {
      this.element = parent.appendChild(document.createElement('div'))
      this.element.className = 'block-drop-cursor'
    }
    if (!this.element) return
    let parentLeft: number
    let parentTop: number
    if (!parent || (parent == document.body && getComputedStyle(parent).position == 'static')) {
      parentLeft = -pageXOffset
      parentTop = -pageYOffset
    } else {
      const pRect = parent.getBoundingClientRect()
      const parentScaleX = pRect.width / parent.offsetWidth
      const parentScaleY = pRect.height / parent.offsetHeight
      parentLeft = pRect.left - parent.scrollLeft * parentScaleX
      parentTop = pRect.top - parent.scrollTop * parentScaleY
    }
    this.element.style.left = `${(rect.left - parentLeft) / scaleX}px`
    this.element.style.top = `${(rect.top - parentTop) / scaleY}px`
    this.element.style.width = `${(rect.right - rect.left) / scaleX}px`
    this.element.style.height = `${(rect.bottom - rect.top) / scaleY}px`
  }

  private scheduleRemoval(timeout: number): void {
    window.clearTimeout(this.timeout)
    this.timeout = window.setTimeout(() => this.setCursor(null), timeout)
  }

  private computeTarget(event: DragEvent): number | null {
    const pos = this.view.posAtCoords({ left: event.clientX, top: event.clientY })
    const node = pos && pos.inside >= 0 && this.view.state.doc.nodeAt(pos.inside)
    const disableDropCursor = node && node.type.spec.disableDropCursor
    const disabled =
      typeof disableDropCursor == 'function'
        ? (disableDropCursor as (v: EditorView, p: unknown, e: DragEvent) => boolean)(this.view, pos, event)
        : disableDropCursor
    if (!pos || disabled) return null
    let target = pos.pos
    if (this.view.dragging && this.view.dragging.slice) {
      const point = dropPoint(this.view.state.doc, target, this.view.dragging.slice)
      if (point != null) target = point
    }
    return target
  }

  private dragover(event: DragEvent): void {
    // 列表条目三段落点拖拽（computeDropTarget 非 null）由 list-drag 的 list-drop-line 接管落点指示，
    // 这里清线返回，避免双线打架。setCursor(null) 后不再续期，所以兜底定时器要重新排：
    // 从 li 区滑回普通块区时若已超 5s，残留的旧定时器会把刚画上的横条立刻清掉（闪一下）
    if (computeDropTarget(this.view, event)) {
      this.setCursor(null)
      this.scheduleRemoval(5000)
      return
    }
    // page_ref 落点（page-drop）的语义是整块进目标页，不画插入横条而画块高亮，
    // 同样清线 + 重排兜底定时器。非 page_ref 悬停时顺手把高亮摘掉
    const refHit = pageRefDropTarget(this.view, event)
    setPageRefHighlight(refHit ? refHit.el : null)
    if (refHit) {
      this.setCursor(null)
      this.scheduleRemoval(5000)
      return
    }
    if (!this.view.editable) return
    this.lastDragEvent = event
    const target = this.computeTarget(event)
    if (target != null) {
      this.setCursor(target)
      this.scheduleRemoval(5000)
    }
  }

  private dragend(): void {
    setPageRefHighlight(null)
    this.scheduleRemoval(20)
  }

  private drop(): void {
    setPageRefHighlight(null)
    this.scheduleRemoval(20)
  }

  private dragleave(event: DragEvent): void {
    if (!this.view.dom.contains(event.relatedTarget as Node | null)) {
      this.setCursor(null)
      // 拖进侧栏树（树行有自己的高亮）等编辑器外区域：块高亮跟着交出去
      setPageRefHighlight(null)
    }
  }
}

export const blockHandle = $prose(() => {
  const key = new PluginKey('MILKDOWN_BLOCK_HANDLE')
  const buffer = 20 // 边缘自动滚动触发带宽
  let dragging = false
  let view: EditorView | null = null
  let onMouseMove: ((e: MouseEvent) => void) | null = null
  let onMouseLeave: ((e?: MouseEvent) => void) | null = null

  return new Plugin({
    key,
    props: {
      handleDOMEvents: {
        keydown: (v, event) => {
          // 修饰键不算交互：Shift 点手柄是扩选手势（Editor.tsx 的 mousedown 分支要读
          // provider.active），按键本身就清快照会让扩选永远拿不到块
          if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return false
          dragging = false
          v.dom.dataset.dragging = 'false'
          onMouseLeave?.()
          return false
        },
        // 拖拽期间贴近编辑器上 / 下边缘时自动滚动
        dragover: (v, event) => {
          if (!dragging) return false
          const root = v.dom.parentElement
          if (!root) return false
          const hasVerticalScrollbar = root.scrollHeight > root.clientHeight
          const rootRect = root.getBoundingClientRect()
          if (hasVerticalScrollbar) {
            if (root.scrollTop > 0 && Math.abs(event.y - rootRect.y) < buffer) {
              root.scrollTop = root.scrollTop > 10 ? root.scrollTop - 10 : 0
              return false
            }
            const totalHeight = Math.round(v.dom.getBoundingClientRect().height)
            if (Math.round(root.scrollTop + rootRect.height) < totalHeight && Math.abs(event.y - (rootRect.height + rootRect.y)) < buffer) {
              root.scrollTop = root.scrollTop + 10
              return false
            }
          }
          return false
        },
        dragenter: (v) => {
          if (!v.dragging) return false
          dragging = true
          v.dom.dataset.dragging = 'true'
          return false
        },
        dragleave: (v, event) => {
          const x = event.clientX
          const y = event.clientY
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
            dragging = false
            v.dom.dataset.dragging = 'false'
          }
          return false
        },
        drop: (v) => {
          dragging = false
          v.dom.dataset.dragging = 'false'
          return false
        },
        dragend: (v) => {
          dragging = false
          v.dom.dataset.dragging = 'false'
          return false
        },
      },
    },
    view: (v) => {
      view = v
      const provider = blockHandleProviderRef
      provider.bind(() => view ?? undefined)
      provider.update()
      viewHooks.onView?.()
      const dom = v.dom
      // hover 即时命中（无 throttle）。mouseleave 也在这里挂（挂在 view.dom 的父容器上），
      // 插件视图销毁重建时跟着摘 / 挂，不会丢 hide 链路
      onMouseMove = (e: MouseEvent) => {
        if (v.composing || !v.editable) return
        const hit = selectRootNodeByPoint(v, e.clientY, defaultNodeFilter, e.clientX)
        if (!hit || inCollectionBody(hit, e.clientY)) {
          if (provider.active) provider.hide()
          return
        }
        provider.active = hit
        provider.show(hit)
      }
      onMouseLeave = (e?: MouseEvent) => {
        // keydown 无参调用是键盘交互，直接 hide。
        // mouseleave：Chrome 在分数缩放（如 165%）下，指针跨越 img 等替换元素 / 可拖拽
        // 节点边界时会伪发 .editor-root 的 mouseleave，指针坐标仍在编辑器 rect 内。
        // 无条件 hide 会吞掉刚 show 的手柄：mousemove 命中，show() 置 hidden=false、
        // floating-ui 异步定位，伪 leave 触发 hide()，定位 promise 返回时被 hidden 丢弃，
        // 嵌套图片行的手柄就永远不显示。所以复核坐标：指针仍在编辑器父容器 rect 内（2px 容差）则忽略本次 leave。
        if (!e) {
          provider.hide()
          return
        }
        const root = dom.parentElement
        if (root) {
          const r = root.getBoundingClientRect()
          if (e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) return
        }
        provider.hide()
      }
      dom.addEventListener('mousemove', onMouseMove)
      dom.parentElement?.addEventListener('mouseleave', onMouseLeave)
      const dropCursorView = new BlockDropCursorView(v)
      return {
        update: (uv: EditorView, prev: EditorState) => dropCursorView.update(uv, prev),
        destroy: () => {
          dropCursorView.destroy()
          if (onMouseMove) dom.removeEventListener('mousemove', onMouseMove)
          onMouseMove = null
          if (onMouseLeave) dom.parentElement?.removeEventListener('mouseleave', onMouseLeave)
          onMouseLeave = null
          provider.destroy()
          viewHooks.onViewDestroy?.()
          dragging = false
          view = null
        },
      }
    },
  })
})

/** Editor.tsx 在 configBlock 里创建 provider 后塞进这里，插件 view 工厂取用（$prose 工厂
 * 拿不到 React 组件闭包，经模块级引用传递；同一时刻只有一个正文编辑器，不会串） */
export let blockHandleProviderRef: BlockHandleProvider = new BlockHandleProvider({
  content: document.createElement('div'),
})
export function setBlockHandleProvider(provider: BlockHandleProvider): void {
  blockHandleProviderRef = provider
}

/** 插件视图重建钩子：Editor.tsx 的块菜单 bind/destroy 要跟着 PM 插件视图生命周期走
 * （collab 初始化会销毁重建插件视图，destroy 摘过的监听必须补挂） */
let viewHooks: { onView?: () => void; onViewDestroy?: () => void } = {}
export function setBlockHandleViewHooks(hooks: { onView?: () => void; onViewDestroy?: () => void }): void {
  viewHooks = hooks
}
