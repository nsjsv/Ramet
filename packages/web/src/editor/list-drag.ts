// 嵌套列表条目拖拽。手柄拖拽分两类源（dragSourceKind）：
//   - 'li'：list_item，全接管 drop，三段语义（上 1/3 前 / 下 1/3 后 / 中 1/3 变子级）；
//   - 'block'：顶层普通块（图片块 = 段落含图等），落点是条目时同样三段：中 1/3 包成
//     子条目（li 里塞块，图片块从此有自己的手柄 / 菜单粒度），上 / 下 1/3 裸块插到条目
//     所在列表块的前 / 后；落点是普通块则不接管，走默认路径。
// PM 默认 replace 路径对拖到条目上的块会把内容内联进段落 / 条目（图片 / page_ref 失去块粒度、
// 错位结构），对 li slice 会产出非法结构，所以落点命中条目时一律 return true 挡死（非法落点
// no-op 也不放默认）；落点是普通块（块间搬运）才放行默认路径。
// 非手柄拖拽（外部内容 / 文件 / 原生 img 拖拽无 node 字段）return false 走既有路径。
//
// 落点事务（moveListItem）单 tr 完成，一次撤销全还原：
//   删源（父 list 只剩本条目 → 连壳删，空文档补空段落）→ 插入位置过 tr.mapping.map →
//   插入（嵌套同级 / child 直插 li；顶层落点包一层单条目 list 壳，attrs 抄源 list、id 置空串，
//   守「顶层一条目一块」，有序编号由 listNormalize 的 renumberOrderedRuns 同 tick 兜底）
//   → NodeSelection + setMeta('uiEvent','drop')（复用 blockSelectKey 的 drop 跟随高亮 +
//   caret 折叠防闪链路）。
//
// 合法性守卫（computeDropTarget 内）：插入边界 b 落在源条目 [srcPos, srcEnd] 上 / 内 →
// target=null（原地 no-op、拖进自己子树）。指示线随之隐藏；drop 无操作但仍 return true
// （挡住默认路径）。
//
// 指示线：绝对定位 overlay div（.list-drop-line，fixed 挂 body，视口坐标，同 block-touch
// 的 block-drop-line），dragover 时按目标 rect 定位（child 模式左缘缩进到子级）；
// drop / dragend / dragleave / keydown 清理，scroll 重定位。零 PM 状态，不产生事务。
// 触屏端（block-touch.ts）不受影响：本插件只认 HTML5 DnD 的 handleDrop / dragover。

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode, Slice } from '@milkdown/kit/prose/model'
// 与块手柄同一套命中口径（行矩形 + margin 外扩 + li 下钻）
import { boundaryGapY, defaultNodeFilter, selectRootNodeByPoint } from './block-handle'

/** 手柄拖拽源的形态：'li' = 列表条目（既有路径）；'block' = 顶层普通块（图片块等）；
 * null = 非手柄起拖（外部拖入没有 node 字段）或源已被协同端删掉。
 * 依据 view.dragging.node（补丁版 BlockService dragstart 写入的 NodeSelection 快照）
 * 对当前 doc 重解析，不信任快照时的坐标。 */
export type DragSourceKind = 'li' | 'block'

function dragSourceKind(view: EditorView): DragSourceKind | null {
  const node = (view.dragging as DraggingWithNode | null)?.node
  if (!node) return null
  const pos = node.$from.pos
  const cur = view.state.doc.nodeAt(pos)
  if (!cur) return null
  if (cur.type.name === 'list_item') return 'li'
  return view.state.doc.resolve(pos).depth === 0 ? 'block' : null
}

/** 补丁版 BlockService 在 dragstart 额外写进 view.dragging 的 node 字段（官方类型未声明）：
 * NodeSelection 快照，$from.pos = 源条目起点（dragstart 时刻坐标，用时须对当前 doc 重校验：
 * 拖拽期间协同端可能已动过文档）。外部拖拽（非本编辑器手柄起拖）没有该字段 → -1。 */
export type DraggingWithNode = { slice: Slice; move: boolean; node?: { $from: { pos: number } } }

function dragSourcePos(view: EditorView): number {
  const node = (view.dragging as DraggingWithNode | null)?.node
  return node?.$from.pos ?? -1
}

/** 手柄拖拽源解析为顶层块（li 源不算：条目无稳定 id，跨页搬块不支持条目粒度，
 * 见 page-drop.ts）。无源/源已被协同端删掉 → null。page-drop 共用此口径。 */
export function topBlockDragSource(view: EditorView): { pos: number; node: PMNode } | null {
  if (dragSourceKind(view) !== 'block') return null
  const pos = dragSourcePos(view)
  const node = view.state.doc.nodeAt(pos)
  return node ? { pos, node } : null
}

/** 落点锚：li（kind=item）或顶层块（kind=block）。pos/node/el 恒为 computeDropTarget
 * 执行时刻的当前 doc 坐标（drop 时整体重算，无跨事件复用）。 */
interface DropAnchor {
  pos: number
  node: PMNode
  el: HTMLElement
}

export interface DropTarget {
  kind: 'item' | 'block'
  mode: 'before' | 'after' | 'child'
  anchor: DropAnchor
  /** 插入边界（删源前的 doc 坐标）：moveListItem 里过 tr.mapping.map 换算。
   * 恒为某节点边界（不在文本内部），且保证不在源删除区间内部（守卫已滤）。 */
  boundary: number
  /** true = 包一层单条目 list 壳插入（li 源顶层前/后落点 / child 模式目标无子 list）：
   * list_item 无 block group，裸 li 插进 li 内容是非法结构，会被 PM fitter 挪到外层；
   * false = 直接插节点（父为 list，合法且贴合边界）。
   * bare = block 源的顶层前/后落点：块原样插顶层不包壳，仅 block 源会置 true */
  wrap: boolean
  bare?: boolean
}

function isList(node: PMNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list'
}

/** 拖动条目/块时的落点目标。event 只用 clientY（与悬停命中同一口径，整行都是热区）。
 * 非法落点（原地/拖进自己子树/源已被协同端删掉/块源落在非条目上）返回 null。 */
export function computeDropTarget(view: EditorView, event: Pick<DragEvent, 'clientY'>): DropTarget | null {
  if (!view.editable) return null
  const kind = dragSourceKind(view)
  if (!kind) return null
  const doc = view.state.doc
  const srcPos = dragSourcePos(view)
  const src = srcPos >= 0 ? doc.nodeAt(srcPos) : null
  if (!src || (kind === 'li' ? src.type.name !== 'list_item' : doc.resolve(srcPos).depth !== 0)) return null
  const srcEnd = srcPos + src.nodeSize
  // 守卫：插入边界落在源范围上（== 边界 = 原地 no-op）或内部（拖进自己子树）→ 非法
  const legal = (b: number): boolean => b < srcPos || b > srcEnd

  const hit = selectRootNodeByPoint(view, event.clientY, defaultNodeFilter)
  if (!hit) return null
  if (hit.node.type.name === 'list_item') {
    // 拖到自己（前/后/变自己子级全是原地或自嵌套）= no-op
    if (hit.$pos.pos === srcPos) return null
    const anchor: DropAnchor = { pos: hit.$pos.pos, node: hit.node, el: hit.el }
    const rect = anchor.el.getBoundingClientRect()
    if (rect.height <= 0) return null
    const rel = (event.clientY - rect.top) / rect.height
    const mode: DropTarget['mode'] = rel < 1 / 3 ? 'before' : rel > 2 / 3 ? 'after' : 'child'
    const $anchor = doc.resolve(anchor.pos)
    if (mode === 'child') {
      // 追加进条目自己的子 list（取最后一个 list 子节点的末尾）；没有则新建 → 条目内容末尾。
      // 无子 list 时 wrap=true：插入的是新 list 节点（裸 li 在 li 内容里是非法结构，见 wrap 注释）
      let boundary = anchor.pos + anchor.node.nodeSize - 1
      let intoSubList = false
      anchor.node.forEach((child, offset) => {
        if (isList(child)) {
          boundary = anchor.pos + 1 + offset + child.nodeSize - 1
          intoSubList = true
        }
      })
      return legal(boundary) ? { kind: 'item', mode, anchor, boundary, wrap: !intoSubList } : null
    }
    // resolve(li 起点) 停在父 list 层：$anchor.depth = list 的深度。> 1 = list 非 doc 直接子代
    // （嵌套 list，或引用内的 list），可插同级兄弟（li 源插源条目；block 源在 moveListItem
    // 里包成 li 后插 —— 两类源都不再包壳，直接进父 list，不碰顶层不变量）
    if ($anchor.depth > 1) {
      const boundary = mode === 'before' ? anchor.pos : anchor.pos + anchor.node.nodeSize
      return legal(boundary) ? { kind: 'item', mode, anchor, boundary, wrap: false } : null
    }
    // 顶层单条目块的条目：不得插同级（铁律）→ li 源包壳插块前/后；block 源裸块插列表块前/后
    const listPos = $anchor.before(1)
    const block = doc.nodeAt(listPos)
    if (!block) return null
    const boundary = mode === 'before' ? listPos : listPos + block.nodeSize
    if (!legal(boundary)) return null
    return { kind: 'item', mode, anchor, boundary, wrap: kind === 'li', bare: kind === 'block' }
  }

  // 顶层块回退（段落/标题/图片/hr 等；悬停列表块总会下钻到 li，走不到这里）：仅 li 源有此
  // 回退（上半 → 放块前，下半 → 放块后；条目落到普通块 = 包壳成独立顶层列表块）。
  // block 源落到普通块 = 两个顶层块间搬运，交给默认路径（dropcursor 语义已足够）
  if (kind !== 'li') return null
  const anchor: DropAnchor = { pos: hit.$pos.pos, node: hit.node, el: hit.el }
  const rect = anchor.el.getBoundingClientRect()
  if (rect.height <= 0) return null
  const after = event.clientY > rect.top + rect.height / 2
  const boundary = after ? anchor.pos + anchor.node.nodeSize : anchor.pos
  return legal(boundary) ? { kind: 'block', mode: after ? 'after' : 'before', anchor, boundary, wrap: true } : null
}

/** 把拖动的条目/块搬进 target。删源与插入全在一条 tr 里（单次撤销）。非法/异常时不派发。 */
export function moveListItem(view: EditorView, target: DropTarget): boolean {
  const kind = dragSourceKind(view)
  if (!kind) return false
  const doc = view.state.doc
  const srcPos = dragSourcePos(view)
  const src = srcPos >= 0 ? doc.nodeAt(srcPos) : null
  if (!src || (kind === 'li' ? src.type.name !== 'list_item' : doc.resolve(srcPos).depth !== 0)) return false
  const $src = doc.resolve(srcPos)
  // list 类型/attrs：li 源抄源条目所在 list（ordered 的 order/spread 等，拖哪像哪）；
  // block 源抄目标条目的父 list（子级跟目标风格；ordered 下续号由 listNormalize 兜底）。
  // id 置空串交补 id 插件补
  const refList = kind === 'li' ? $src.parent : doc.resolve(target.anchor.pos).parent
  const listType = refList.type
  const listAttrs = { ...refList.attrs, id: '' }

  const tr = view.state.tr
  if (kind === 'li') {
    // 删源（li）：父 list 只剩本条目 → 连壳删（顶层：整块消失；嵌套：空 ul 壳消失，父条目仍有首段落）。
    // resolve(li 起点) 停在 list 层（不进入 li）：$src.parent = 父 list，$src.depth = list 的深度
    const parentList = $src.parent
    if (parentList.childCount === 1) {
      const shellFrom = $src.before($src.depth)
      tr.delete(shellFrom, shellFrom + parentList.nodeSize)
    } else {
      tr.delete(srcPos, srcPos + src.nodeSize)
    }
  } else {
    // 删源（顶层块）：直接删，无壳逻辑
    tr.delete(srcPos, srcPos + src.nodeSize)
  }
  // 删空文档补空段落（同 block-menu runDelete，保住 doc(block+) 合法）
  if (!tr.doc.childCount) {
    const paragraph = view.state.schema.nodes.paragraph
    if (paragraph) tr.insert(0, paragraph.create())
  }

  // 插入位置换算：守卫保证 boundary 不在删除区间内部 → mapping 结果精确无歧义
  const at = tr.mapping.map(target.boundary)
  let itemAt: number
  try {
    if (target.bare) {
      // block 源顶层前/后落点：块原样插顶层（不包壳）
      tr.insert(at, src)
      itemAt = at
    } else {
      // 被插的条目：li 源 = 源条目本身（拖拽期间协同端对条目内容的修改随当前 doc 一起带走）；
      // block 源 = 新建 li 包住块。li 内容要求首子为 paragraph —— 非段落块（标题/代码等）
      // createAndFill 失败返回 null → 放行默认路径（现状行为），需要时再补首段包裹
      const listItem = view.state.schema.nodes.list_item
      const item =
        kind === 'li' ? src.copy(src.content) : listItem ? listItem.createAndFill({}, [src]) : null
      if (!item) return false
      if (target.wrap) {
        // 包壳 = 新单条目 list（li 源顶层落点 / child 模式无子 list 新建于 list）
        tr.insert(at, listType.create(listAttrs, [item]))
        itemAt = at + 1 // 壳开口之后即条目起点
      } else {
        tr.insert(at, item)
        itemAt = at
      }
    }
  } catch (err) {
    // 内容匹配异常（理论不可达，兜底防崩）：事务不派发，文档零改动
    console.error('list-drag: insert failed', err)
    return false
  }
  tr.setSelection(NodeSelection.create(tr.doc, itemAt))
  tr.setMeta('uiEvent', 'drop') // 复用 blockSelectKey 的 drop 跟随高亮 + caret 折叠防闪
  view.dispatch(tr)
  return true
}

let lineEl: HTMLElement | null = null
let lastTarget: DropTarget | null = null

function hideLine(): void {
  lineEl?.remove()
  lineEl = null
  lastTarget = null
}

function showLineEl(): HTMLElement {
  if (!lineEl) {
    lineEl = document.createElement('div')
    lineEl.className = 'list-drop-line'
    document.body.appendChild(lineEl)
  }
  return lineEl
}

/** 定位指示线。before/after → 边界两侧邻块间隙的视觉中点（同一边界的两种悬停热区
 * 画同一根线）；child → 行下缘、左缘缩进到子级。 */
function placeLine(view: EditorView, target: DropTarget): void {
  const el = target.anchor.el
  if (!el.isConnected) {
    hideLine()
    return
  }
  const rect = el.getBoundingClientRect()
  const line = showLineEl()
  let left = rect.left
  let width = rect.width
  let y = target.mode === 'before' ? rect.top : rect.bottom
  if (target.mode !== 'child') {
    const gap = boundaryGapY(view, target.boundary)
    if (gap != null) y = gap
  }
  if (target.kind === 'item' && target.mode === 'child') {
    // 缩进到子级位：已有子 list 用它的左缘；没有则按一个缩进层（24px）估计
    const sub = el.querySelector(':scope > ul, :scope > ol')
    const indent = sub instanceof HTMLElement ? sub.getBoundingClientRect().left - rect.left : 24
    const clamped = Math.max(16, Math.min(indent, width - 16))
    left += clamped
    width -= clamped
  }
  line.style.display = 'block'
  line.style.left = `${left}px`
  line.style.top = `${y - 1}px` // 线高 2px，骑在边界上
  line.style.width = `${Math.max(width, 16)}px`
}

export const listDrag = $prose(
  () =>
    new Plugin({
      key: new PluginKey('MILKDOWN_LIST_DRAG'),
      props: {
        // PM drop 主路径先调 handleDrop，返回 true 即 preventDefault 并跳过默认 replace。
        // 非手柄拖拽（无 node 字段）→ false 走默认；块源落到普通块上 → false 走默认（块间搬运）。
        handleDrop: (view, event) => {
          if (!view.editable) return false
          const kind = dragSourceKind(view)
          if (!kind) return false
          const target = computeDropTarget(view, event)
          hideLine()
          if (target) {
            const ok = moveListItem(view, target) // 失败也挡默认（防 PM 对源 slice 的错位 replace）
            return ok || kind === 'li' || target.kind === 'item'
          }
          // 非法落点（原地/拖进自己子树）：一律挡默认。
          // li 源：PM 默认 replace 对 li slice 产出非法/错位结构。
          // block 源：落点命中条目时默认 replaceRange 会把块塞进条目内容（块粒度丢失、落点错乱，
          // 如 page_ref 紧邻列表块时拖到条目上整块钻进 li），所以落点在条目上就必须接管（no-op）。
          // 块源落在普通块（块间搬运）才放行默认。
          if (kind === 'li') return true
          const hit = selectRootNodeByPoint(view, event.clientY, defaultNodeFilter)
          return hit?.node.type.name === 'list_item'
        },
        handleDOMEvents: {
          // 只更新指示线，不拦截：PM 默认 dragover（含 block 插件的边缘自动滚动）照常
          dragover: (view, event) => {
            if (!view.editable || !dragSourceKind(view)) return false
            const target = computeDropTarget(view, event)
            lastTarget = target
            if (target) placeLine(view, target)
            else hideLine()
            return false
          },
          dragleave: (view, event) => {
            if (!view.dom.contains(event.relatedTarget as Node | null)) hideLine()
            return false
          },
          dragend: () => {
            hideLine()
            return false
          },
          keydown: () => {
            hideLine()
            return false
          },
        },
      },
      view: (view) => {
        // 拖拽期间滚动（含边缘自动滚动）：按 lastTarget 的节点 rect 重定位（doc 位置不变）
        const onScroll = () => {
          if (lastTarget && lineEl) placeLine(view, lastTarget)
        }
        document.addEventListener('scroll', onScroll, true)
        return {
          destroy: () => {
            document.removeEventListener('scroll', onScroll, true)
            hideLine()
          },
        }
      },
    }),
)
