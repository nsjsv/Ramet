/* ---------- 手机端块手柄 ----------
 * 触屏无 hover、无 HTML5 DnD，桌面那套 BlockHandleProvider（mousemove 定位单手柄 +
 * draggable/dragstart）在手机上整条链路失效。触屏时 Editor.tsx 分流到本模块：
 * - 顶层每块前挂一个 decoration widget 手柄：淡灰常显、加大触区（样式见 editor.css）；
 * - 点按手柄用 createBlockMenu 弹菜单（与桌面同一套删除 / 复制 / 转换动作）；
 * - 长按 ~450ms 进拖拽：块克隆 ghost 跟手、蓝线指示落点，松手 delete + replaceRange 搬块
 *   （事务顺序与 prosemirror-view 原生 drop 同款：先删源块，落点边界过 mapping 再插入）。
 * pos 一律事件时现算：widget 会随 doc 变化被 PM 映射复用，创建时捕获的 pos 会过期。
 * 反查路径：手柄 div 的 nextElementSibling 即块 DOM，取 rect 中心 posAtCoords 再爬到顶层，
 * 命中检测思路与 editor/block-handle.ts 的 selectRootNodeByPoint 同源。
 * 事件模型用 Pointer Events，不设显式捕获（见 bindHandle 上方注释）。
 * 真机坑：安卓手势导航的侧滑返回区（屏边 ~20-25px）会抢走从边缘起手的触摸，
 * 手柄抓握区必须留在手势区外（editor.css 页容器左右 30px 保证）；
 * 火狐安卓长按手势结束后还会补零时长合成 tap，见 dragEndedAt / downAt 两道守卫。
 */
import { $prose } from '@milkdown/utils'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { NodeSelection, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { createBlockMenu } from './block-menu'
import { boundaryGapY } from './block-handle'
import { moveBlockToPage, setPageRefHighlight } from './page-drop'
import { iconSvg } from '../icons'

const LONG_PRESS_MS = 450
const MOVE_CANCEL_PX = 12 // 长按生效前手指位移超过此值就是在滚动 / 误触，取消长按
const HANDLE_SVG = iconSvg('handle', 20, 22)

/** 触屏判定：无 hover 且粗指针（手机 / 平板），桌面窄窗口不算 */
export function isTouchEditor(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches
}

interface BlockRef {
  pos: number
  node: PMNode
  el: HTMLElement
}

/** 坐标反查顶层块。posAtCoords 的 inside 是点所在节点的起始位置（nodeAt(inside) 即该节点，
 * 可能指向嵌套内层，沿 before 爬到 depth 1；点在块间缝隙时 inside=-1，用 hit.pos 边界近似） */
function topLevelBlockAt(view: EditorView, x: number, y: number): BlockRef | null {
  try {
    const hit = view.posAtCoords({ left: x, top: y })
    if (!hit) return null
    const doc = view.state.doc
    const raw = hit.inside >= 0 ? hit.inside : hit.pos
    let $pos = doc.resolve(raw)
    while ($pos.depth > 1) $pos = doc.resolve($pos.before($pos.depth))
    // depth 0（inside=0 或文档首尾边界）时 raw 本身就是顶层块起点，直接用；
    // 指到末尾边界（pos == docSize）时 nodeAt 为空，向前退到最近块的起点
    const pos0 = $pos.depth >= 1 ? $pos.before(1) : raw
    let pos = pos0
    let node = doc.nodeAt(pos)
    if (!node && pos > 0) {
      let q = Math.min(pos, doc.content.size) - 1
      while (q > 0 && !doc.nodeAt(q)) q--
      pos = q
      node = doc.nodeAt(q)
    }
    const el = node ? view.nodeDOM(pos) : null
    if (!node || !(el instanceof HTMLElement)) return null
    return { pos, node, el }
  } catch {
    return null
  }
}

/** 手柄 div：自身 0×0 不占布局，svg 绝对定位到左 gutter（editor.css）。
 * 垂直位置由 alignSelf() 实测首行居中，各行高不同（标题 / 正文 / 矮原子块），定数对不齐 */
function makeHandle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'block-handle-touch'
  el.innerHTML = HANDLE_SVG
  return el
}

/** svg 中心对准块首行中心。创建后逐帧实测直到连续稳定（上限 30 帧），覆盖样式 / 字体晚就绪的情况 */
function alignSelf(ref: { view: EditorView | null }, el: HTMLElement, offset: number): void {
  let stable = 0
  const tick = (): void => {
    const view = ref.view
    const dom = view && !view.isDestroyed ? (view.nodeDOM(offset) as HTMLElement | null) : null
    if (!dom || !el.isConnected) return // 手柄 / 块没了，停止
    const r = dom.getBoundingClientRect()
    const cs = getComputedStyle(dom)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.75 // line-height:normal 兼容
    const half = Math.min(r.height || lh, lh) / 2 // 矮原子块（hr）用自身高，多行块取首行
    // 相对块盒子定位：widget div 落在上块下边缘（margin 穿透），有 margin-top 的块直接用
    // div.top 会偏一个 margin，必须减掉块顶与 div 顶的差
    const top = r.top + half - 17 - el.getBoundingClientRect().top
    const svg = el.firstElementChild as HTMLElement | null
    if (svg && svg.style.top !== `${top}px`) {
      svg.style.top = `${top}px`
      stable = 0 // 变了就重新计稳定窗口
    }
    if (++stable < 30) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** widget 手柄与块 DOM 同级且在前一位，取块矩形中心反查顶层块 */
function blockFromHandle(view: EditorView, handle: HTMLElement): BlockRef | null {
  const blockDom = handle.nextElementSibling
  if (!blockDom) return null
  const r = blockDom.getBoundingClientRect()
  if (!r.width && !r.height) return null
  return topLevelBlockAt(view, r.left + Math.min(24, r.width / 2), r.top + r.height / 2)
}

/** 拖拽命中兜底：正文下方空白算最后一块之后，上方算第一块之前。
 * posAtCoords 在 min-height 撑出的空白区 / 块间缝隙里返回不稳（常给文档末尾边界或 null） */
function edgeBlockAt(view: EditorView, y: number): BlockRef | null {
  try {
    const doc = view.state.doc
    if (!doc.lastChild || !doc.firstChild) return null
    const lastPos = doc.content.size - doc.lastChild.nodeSize
    const lastEl = view.nodeDOM(lastPos)
    const firstEl = view.nodeDOM(0)
    if (y >= (lastEl instanceof HTMLElement ? lastEl.getBoundingClientRect().bottom : 0)) {
      return lastEl instanceof HTMLElement ? { pos: lastPos, node: doc.lastChild, el: lastEl } : null
    }
    if (y <= (firstEl instanceof HTMLElement ? firstEl.getBoundingClientRect().top : Infinity)) {
      return firstEl instanceof HTMLElement ? { pos: 0, node: doc.firstChild, el: firstEl } : null
    }
    return null
  } catch {
    return null
  }
}

export interface TouchBlockSetup {
  /** milkdown 插件（$prose 产物），宿主 .use() 挂进编辑器 */
  plugin: ReturnType<typeof $prose>
  /** 与 BlockHandleProvider.active 对齐：触屏无 hover 态，onBodyMouseDown 手柄分支取到 null 就清高亮 */
  active: null
  destroy(): void
}

/** 手机端手柄整套：decoration 常显手柄 + tap 菜单 + 长按拖拽 */
export function setupTouchBlockHandles(
  getView: () => EditorView | undefined,
  /** 复制链接菜单项要用的页面 id（与桌面 attachBlockMenu 同语义，缺省时该按钮静默不动） */
  getPageId?: () => string | undefined,
): TouchBlockSetup {
  const ref: { view: EditorView | null } = { view: null }
  let menuAnchor: HTMLElement | null = null // 开菜单那一刻的锚（手柄），定位与点外部关闭都用它
  const menu = createBlockMenu({ getView, getAnchorEl: () => menuAnchor, getPageId })

  // 拖拽状态：单指单手柄，同一时刻最多一组
  let drag: {
    source: BlockRef
    ghost: HTMLElement
    line: HTMLElement
    dx: number
    dy: number
    drop: { pos: number; after: boolean } | null
  } | null = null

  function beginDrag(handle: HTMLElement, x: number, y: number): void {
    const view = ref.view
    if (!view || view.isDestroyed || drag) return
    const source = blockFromHandle(view, handle)
    if (!source) return
    menu.close() // 菜单开着时直接长按：先收菜单
    navigator.vibrate?.(10) // 有触觉反馈的设备给个已进入拖拽的信号
    const rect = source.el.getBoundingClientRect()
    const ghost = document.createElement('div')
    ghost.className = 'block-drag-ghost'
    ghost.style.width = `${rect.width}px`
    // ghost 要真嵌套两层 .editor-root > .ProseMirror：正文排版选择器全是祖先到后代的形态
    // （.editor-root .ProseMirror p / > ul > li > p / 手机 17px 字号），两个类叠在同一元素上不命中。
    // todo 复选框的 top 校准依赖顶层 li 直属 p 零外距的规则命中，单层结构下 p 挂 UA 默认
    // margin，文字下推、复选框悬空
    const wrap = document.createElement('div')
    wrap.className = 'editor-root'
    const inner = document.createElement('div')
    inner.className = 'ProseMirror'
    inner.appendChild(source.el.cloneNode(true))
    wrap.appendChild(inner)
    ghost.appendChild(wrap)
    const line = document.createElement('div')
    line.className = 'block-drop-line'
    document.body.append(ghost, line)
    drag = { source, ghost, line, dx: x - rect.left, dy: y - rect.top, drop: null }
    moveDrag(x, y)
  }

  function moveDrag(x: number, y: number): void {
    if (!drag) return
    // 用 transform 而非 left / top：免逐帧 layout，跟手更流畅
    drag.ghost.style.transform = `translate3d(${x - drag.dx}px, ${y - drag.dy}px, 0)`
    const view = ref.view
    const vr = view?.dom.getBoundingClientRect()
    if (!view || view.isDestroyed || !vr) {
      if (drag) {
        drag.drop = null
        drag.line.style.display = 'none'
      }
      return
    }
    // 采样点钉进正文列：手指在 gutter / 拖出边界时 posAtCoords 会拿不到命中；
    // 拖出上下边界按首 / 末块处理（拖到最顶就是插到第一块前）
    const pad = parseFloat(getComputedStyle(view.dom).paddingLeft) || 0
    const cx = Math.min(Math.max(x, vr.left + pad + 4), vr.right - 4)
    const cy = Math.min(Math.max(y, vr.top + 2), vr.bottom - 2)
    let hover = topLevelBlockAt(view, cx, cy)
    if (!hover) hover = edgeBlockAt(view, cy)
    if (!hover) {
      drag.drop = null // 两侧兜底都落空：不显示落点，松手即取消
      drag.line.style.display = 'none'
      setPageRefHighlight(null)
      return
    }
    // 悬停 page_ref 是整块进目标页的语义：不画横条，高亮 page_ref 块（桌面同款）
    if (hover.node.type.name === 'page_ref') {
      setPageRefHighlight(hover.el)
      drag.drop = { pos: hover.pos, after: false }
      drag.line.style.display = 'none'
      return
    }
    setPageRefHighlight(null)
    const r = hover.el.getBoundingClientRect()
    const after = y > r.top + r.height / 2 // 上半插到块前，下半插到块后
    drag.drop = { pos: hover.pos, after }
    // 线画在落点边界两侧邻块间隙的中点：插 A 后与插 B 前是同一边界，画同一根线
    const boundary = after ? hover.pos + hover.node.nodeSize : hover.pos
    const lineY = boundaryGapY(view, boundary) ?? (after ? r.bottom : r.top)
    drag.line.style.display = 'block'
    drag.line.style.left = `${vr.left}px`
    drag.line.style.width = `${vr.width}px`
    drag.line.style.transform = `translate3d(0, ${lineY - 1.5}px, 0)`
  }

  function endDrag(): void {
    const d = drag
    drag = null
    dragEndedAt = performance.now() // 见 dragEndedAt 声明处的注释
    setPageRefHighlight(null)
    d?.ghost.remove()
    d?.line.remove()
    const view = ref.view
    if (!d || !view || view.isDestroyed || !d.drop) return
    const doc = view.state.doc
    const src = doc.nodeAt(d.source.pos) // 拖拽期间源块被协同端删了就放弃
    if (!src) return
    const hovered = doc.nodeAt(d.drop.pos) // 落点边界已被协同改掉就放弃
    if (!hovered) return
    // page_ref 落点：整块进目标页（跨页搬运走 page-drop 管线，不与本页排序路径混）。
    // 落回源块自己是原地 no-op，源块无 id（老数据未补齐）则无事可做
    if (hovered.type.name === 'page_ref') {
      const targetPageId = typeof hovered.attrs.pageId === 'string' ? hovered.attrs.pageId : ''
      const pageId = getPageId?.()
      const blockId = typeof src.attrs.id === 'string' ? src.attrs.id : ''
      if (targetPageId && pageId && blockId && d.source.pos !== d.drop.pos) {
        void moveBlockToPage(pageId, blockId, targetPageId)
      }
      return
    }
    const insertPos = d.drop.after ? d.drop.pos + hovered.nodeSize : d.drop.pos
    if (insertPos === d.source.pos || insertPos === d.source.pos + src.nodeSize) return // 原地不动
    const slice = NodeSelection.create(doc, d.source.pos).content()
    const tr = view.state.tr
    tr.delete(d.source.pos, d.source.pos + src.nodeSize)
    const at = tr.mapping.map(insertPos)
    tr.replaceRange(at, at, slice)
    view.dispatch(tr)
    // 不 focus：手机上 focus 会弹出键盘，拖完只是排序（桌面路径才 focus）
  }

  /** 手柄接线：短按弹菜单，长按进拖拽。
   * 全链路 Pointer Events + window 级监听：火狐安卓对捕获元素上派发的 pointermove 有坑
   * （document 捕获层看得到事件，元素监听器收不到），Chrome 的合成线程也可能在 pan-y 下抢走手势断流，
   * 所以 move / up 挂 window，pointerdown 落在手柄上记 pointerId，必达。
   * 手柄 touch-action:none 让浏览器无权拿这个触摸去滚动 / 缩放。
   * 不调 setPointerCapture：火狐安卓捕获期的 move 连坐标都是过期值。触摸指针天然有隐式捕获
   * （target 锁死在起手元素，事件照常冒泡到 window），显式捕获只有坑没有收益。 */
  let gesture: { el: HTMLElement; pid: number; downAt: number; timer?: number; sx: number; sy: number } | null = null

  function cancelGesture(): void {
    if (gesture?.timer !== undefined) clearTimeout(gesture.timer)
    gesture = null
  }

  /* 火狐安卓长按手势结束后会补合成 tap，两种形态：
   * a) touchend 后 3-7ms 一整套新 down/up，靠 dragEndedAt 冷却吞；
   * b) 延迟 0.7~1.3s 的零时长 down/up（接触仅 4-7ms，人手最快约 50ms），靠 tap 接触时长 <25ms 判假。
   * 真拖动（有位移）不补。 */
  let dragEndedAt = 0

  const onWinPointerMove = (e: PointerEvent): void => {
    // 不看 pointerType / pid：火狐安卓的 move 事件这两个字段都会与 down / up 不一致。
    // 手势入口（pointerdown）已限定 touch + 单手势守卫，接受一切 move 是安全的
    if (drag) {
      moveDrag(e.clientX, e.clientY)
      return
    }
    if (gesture?.timer !== undefined && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > MOVE_CANCEL_PX) {
      clearTimeout(gesture.timer) // 位移视为误触（touch-action:none 下滚不动页面，手势作废）
      gesture.timer = undefined
    }
  }

  const onWinPointerUp = (): void => {
    const g = gesture
    cancelGesture()
    if (!g) {
      if (drag) endDrag()
      return
    }
    if (g.timer !== undefined) {
      clearTimeout(g.timer)
      if (performance.now() - g.downAt < 25) return // 火狐安卓零时长合成 tap，见 dragEndedAt 声明处的注释
      const view = ref.view
      const info = view && !view.isDestroyed ? blockFromHandle(view, g.el) : null
      if (!info) return
      menuAnchor = g.el
      menu.open({ pos: info.pos, node: info.node })
    } else if (drag) {
      endDrag()
    }
  }

  const onWinPointerCancel = (): void => {
    cancelGesture()
    if (drag) endDrag() // drop 无效时 endDrag 内部直接放弃
  }

  // 用捕获阶段：火狐安卓对被捕获指针的 pointermove 不冒泡（document 捕获层可见，window 冒泡层收不到），
  // 下沉阶段必经，两浏览器通吃
  window.addEventListener('pointermove', onWinPointerMove, true)
  window.addEventListener('pointerup', onWinPointerUp, true)
  window.addEventListener('pointercancel', onWinPointerCancel, true)

  function bindHandle(el: HTMLElement): HTMLElement {
    // 安卓长按 contenteditable 会弹系统文字菜单，压掉（iOS 靠 -webkit-touch-callout，见 css）
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || gesture || drag) return // 只认手指，单手势，忽略后续
      if (performance.now() - dragEndedAt < 250) return // 火狐安卓合成 tap，见 dragEndedAt 声明处的注释
      // preventDefault：压掉兼容鼠标事件 / click 合成与文字选择，不抢编辑器焦点
      e.preventDefault()
      const view = ref.view
      if (!view || view.isDestroyed || !view.editable) return
      menuAnchor = el
      const g: { el: HTMLElement; pid: number; downAt: number; timer?: number; sx: number; sy: number } = {
        el, pid: e.pointerId, downAt: performance.now(), sx: e.clientX, sy: e.clientY,
      }
      g.timer = window.setTimeout(() => {
        g.timer = undefined
        beginDrag(el, g.sx, g.sy) // gesture 保留到手势结束，拖拽期间 pointerId 过滤仍生效（防第二根手指）
      }, LONG_PRESS_MS)
      gesture = g
    })
    return el
  }

  const plugin = new Plugin({
    key: new PluginKey('MILKDOWN_TOUCH_BLOCK_HANDLES'),
    props: {
      decorations: (state) => {
        if (!state.doc.childCount) return DecorationSet.empty
        const decos: Decoration[] = []
        const caret = state.selection.from
        state.doc.forEach((node, offset) => {
          // 光标 / 选区所在的那一块打 touch-active，只有它的手柄露出来（styles/mobile.css）
          if (caret >= offset && caret <= offset + node.nodeSize) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'touch-active' }))
          }
          decos.push(
            Decoration.widget(offset, () => {
              const el = bindHandle(makeHandle())
              alignSelf(ref, el, offset)
              return el
            }, {
              side: -1,
              // key 随 pos：doc 上方一变就换 key，PM 重建该手柄 DOM（监听重挂，无过期 pos）
              key: `tbh${offset}`,
              stopEvent: () => true, // 手柄上的事件不让 PM 处理（点它不该动光标 / 选区）
            }),
          )
        })
        return DecorationSet.create(state.doc, decos)
      },
    },
    view: (view) => {
      ref.view = view
      return {
        destroy: () => {
          ref.view = null
          // 插件视图被重建（collab 初始化）时把拖拽中途的状态一并清掉：幽灵块 / 落点线
          // 会失去 PM 的 DOM 托管，永远挂在页面上
          if (drag) endDrag()
        },
      }
    },
  })

  return {
    plugin: $prose(() => plugin),
    active: null,
    destroy() {
      window.removeEventListener('pointermove', onWinPointerMove, true)
      window.removeEventListener('pointerup', onWinPointerUp, true)
      window.removeEventListener('pointercancel', onWinPointerCancel, true)
      cancelGesture()
      if (drag) {
        drag.ghost.remove()
        drag.line.remove()
        drag = null
      }
      menu.close()
    },
  }
}
