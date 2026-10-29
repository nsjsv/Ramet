// 整行块选择（文本列外拖选是块选择）：插件、点手柄后的残留选区清理、列外拖选监听。
import { $prose } from '@milkdown/kit/utils'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { bandSelect, type Band } from '../collection/marquee'
import { isImageItem } from './media'
import { isCollectionBlock } from './collection-block'
import { blockSelectKey, CLEAR_BLOCK_SELECT } from './block-select-key'

export { blockSelectKey, CLEAR_BLOCK_SELECT }

/* ---------- 整行块选择高亮 ----------
 * 文本列内拖选是纯文字选择（无行背景）；列外（左右边缘之外，含手柄 gutter）按下拖选是块选择（仅整行高亮）。
 * 范围存在插件状态里，不走 PM 选区，否则会画出原生蓝色文字选中，双重显示。
 * mousedown 在编辑器外层（body capture）监听，列外区域编辑器 DOM 收不到事件。
 * decoration 不改文档，collab 安全，文档变更时自动失效。 */

/* 找 pos 附近的真光标位置。不能用 TextSelection.near：它碰到原子节点（如 --- 分隔线）会返回
 * 该节点的 NodeSelection，折叠原地打转，无限微任务循环卡死页面。
 * findFrom 的 textOnly=true 只返回 TextSelection；纯 hr 文档找不到光标则返回 null（调用方跳过折叠）。 */
export function caretNear(doc: ProsemirrorNode, pos: number): TextSelection | null {
  const $pos = doc.resolve(pos)
  return (TextSelection.findFrom($pos, 1, true) ?? TextSelection.findFrom($pos, -1, true)) as TextSelection | null
}

/** pos 所在顶层块的 [起点, 终点)：Shift 扩选要按顶层块对齐，否则端点落进块内会把块劈开。
 * 半开区间 [off, off+nodeSize)：块起点是上一块的终点（同一位置），必须归给后一块 */
export function topBlockSpan(doc: ProsemirrorNode, pos: number): { from: number; to: number } | null {
  let off = 0
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    if (pos >= off && pos < off + node.nodeSize) return { from: off, to: off + node.nodeSize }
    off += node.nodeSize
  }
  // 文档末尾（pos === content.size）归最后一块
  if (doc.childCount && pos === doc.content.size) {
    const last = doc.child(doc.childCount - 1)
    return { from: off - last.nodeSize, to: off }
  }
  return null
}

export const selectBlocks = $prose(
  () =>
    new Plugin({
      key: blockSelectKey,
      state: {
        init: () => CLEAR_BLOCK_SELECT,
        apply: (tr, value) => {
          const meta = tr.getMeta(blockSelectKey)
          if (meta !== undefined) return meta
          // 拖放落点：PM 的 handleDrop 会把 NodeSelection 设到落点块并同步写整块原生选区（闪蓝）。
          // 不拦它，顺势跟随：行高亮移到落点块，.block-select-active 类保持激活，由 CSS 压透明
          if (tr.getMeta('uiEvent') === 'drop' && tr.selection instanceof NodeSelection) {
            return { active: true, from: tr.selection.from, to: tr.selection.to }
          }
          if (tr.docChanged) return CLEAR_BLOCK_SELECT
          // 普通文字选择（caret 移动 / shift 扩选）自动退出块选态，否则 ::selection 透明的类会藏住用户新选的文字
          if (tr.selectionSet) return CLEAR_BLOCK_SELECT
          return value
        },
      },
      props: {
        // 键位（Esc / 删除 / ↑↓ / Enter / Tab / 复制剪切粘贴）在 editing-keys.ts 的 blockSelectKeys：
        // 它必须排在所有 keymap 之前，而本插件（状态 + 装饰）在 .use 列表靠后。
        // 块选激活期间给编辑器根节点加类，配套 CSS 把 ::selection 压透明：
        // PM 的 focus() / mouseup rAF 会同步把 NodeSelection 写回盖住整块的原生 DOM 选区，
        // JS 清除（见下面 view.update）只能异步跑，先画后清必闪一下，只能在绘制层压掉
        attributes: (state) => {
          const sel = blockSelectKey.getState(state)
          return sel && sel.active ? { class: 'block-select-active' } : { class: '' }
        },
        decorations: (state) => {
          const sel = blockSelectKey.getState(state)
          if (!sel || !sel.active || sel.from >= sel.to) return DecorationSet.empty
          const doc = state.doc
          // 纯图片块 / 条目：高亮改成贴图包边（CSS selected-img-item），判定见 media.ts isImageItem
          const decoClass = (n: ProsemirrorNode): string =>
            isImageItem(n) ? 'selected-block selected-img-item' : 'selected-block'
          // 单节点选区（手柄点击 / drop 跟随都长这样：from 是节点起点，to = from + nodeSize）：
          // 精确节点粒度 deco，嵌套 li 只亮自己那行（连嵌套子树）
          const target = doc.nodeAt(sel.from)
          if (target && sel.from + target.nodeSize === sel.to) {
            // 特例：顶层单条目块的条目（resolve(li 起点) 停在 list 层，depth=1）deco 整个顶层块：
            // 亮 ul 含 padding 区，视觉与其它块选一致（否则亮的是 li，缺左缘缩进区）
            if (target.type.name === 'list_item') {
              const $pos = doc.resolve(sel.from)
              if ($pos.depth === 1) {
                const from = $pos.before(1)
                return DecorationSet.create(doc, [
                  Decoration.node(from, from + $pos.parent.nodeSize, { class: decoClass($pos.parent) }),
                ])
              }
            }
            return DecorationSet.create(doc, [Decoration.node(sel.from, sel.to, { class: decoClass(target) })])
          }
          // gutter 框选（from < to 跨块）：顶层块求交
          const decos: Decoration[] = []
          doc.forEach((node, offset) => {
            if (offset < sel.to && offset + node.nodeSize > sel.from) {
              decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'selected-block' }))
            }
          })
          return DecorationSet.create(doc, decos)
        },
      },
      // 拖放落点：PM handleDrop 写整块原生 DOM 选区，同一 update 里先清掉；但 PM state 里的 NodeSelection
      // 还会被后续任何 focus() / dispatch 重写，尤其 PM 的 DOM focus handler 走 setTimeout 直调
      // selectionToDOM，不经过 dispatch，本 update 不会触发。
      // 所以在微任务里（paint 前）把 state 折叠成 caret：之后一切 selectionToDOM 只会写光标，
      // 蓝色选区无从产生。行高亮由 decoration 保持，不依赖选区。
      view: () => {
        let scheduled = false
        return {
          update: (v: EditorView) => {
            const st = blockSelectKey.getState(v.state)
            if (!st || !st.active) return
            const sel = window.getSelection()
            if (sel && !sel.isCollapsed) sel.removeAllRanges()
            if (!v.state.selection.empty && !scheduled) {
              scheduled = true
              Promise.resolve().then(() => {
                scheduled = false
                if (v.isDestroyed) return
                const cur = blockSelectKey.getState(v.state)
                if (!cur || !cur.active || v.state.selection.empty) return
                // caret 落在块附近；near() 会把 --- 折回 NodeSelection 造成死循环（见 caretNear），
                // 找不到光标就不 dispatch，让 NodeSelection 原样保留（不会再调度，循环终止）
                const caret = caretNear(v.state.doc, cur.from)
                if (!caret) return
                v.dispatch(v.state.tr.setSelection(caret).setMeta(blockSelectKey, cur))
              })
            }
          },
        }
      },
    }),
)

/* ---------- 点手柄后清掉残留文字选区 ----------
 * 根因（prosemirror-view）：
 *  1) 双击选词后 DOMObserver.flush()（selectionchange 到 readDOMChange）把词选读进 PM 状态，
 *     之后任何 selectionToDOM（dispatch、focus 后 20ms 定时器）都会把词选写回 DOM；
 *  2) 手柄 draggable=true 且在 editable 外：点它不会折叠文字选区，mousedown 默认行为还会按
 *     双击遗留的 word 粒度重设词选，发生在所有同步 handler 之后，mousedown / click 里同步清必然被覆盖
 *     （preventDefault 可拦，但会取消拖拽启动，不可用）；
 *  3) 手柄 mouseup 后 block-handle.ts 在 rAF 里 view.focus()，Chrome 重新聚焦 contenteditable 时
 *     会异步恢复 blur 时缓存的词选（晚于 focus() 内的 selectionToDOM），词选再次回到 DOM。
 * 对策（配合 onBodyMouseDown 手柄分支）：
 *  a) 手柄分支把 PM 内部选区折叠成 caret，PM 不再持有词选，后续 selectionToDOM 写回的只会是 caret；
 *  b) 本监听器在模块加载时注册，早于 prosemirror DOMObserver 的 selectionchange 监听
 *     （同 document、同阶段，按注册顺序回调），所以先清空，DOMObserver 随后看到空选区
 *     （hasSelection 因 anchorNode 为 null 返回 false）直接忽略，词选进不了 PM；
 *  c) 窗口内每次非折叠选区都清（只清第一次会被后续写回击穿），折叠 caret 保留（不与 PM 的 selectionToDOM 互搏）；
 *  d) 任何新 mousedown / keydown / dragstart（capture）立即关窗：正文拖选 / 双击必始于新
 *     mousedown，先关窗再选择，零误伤；拖手柄（dragstart）也不受影响；
 *  e) focus() / mouseup rAF 仍会同步重写 NodeSelection 的原生选区（先画后清必闪），
 *     视觉兜底在 CSS：块选激活期间 .block-select-active ::selection 压透明（styles.css）。 */
let clearSelectionUntil = 0
document.addEventListener('selectionchange', () => {
  if (!clearSelectionUntil || Date.now() > clearSelectionUntil) return
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed) sel.removeAllRanges()
})
for (const type of ['mousedown', 'keydown', 'dragstart'] as const) {
  document.addEventListener(
    type,
    () => {
      clearSelectionUntil = 0
    },
    true,
  )
}
// 词粒度重选在 mouseup 默认行为里提交，窗口内拦截；拖拽路径 dragstart 后无 mouseup（且已关窗），不受影响
document.addEventListener(
  'mouseup',
  (e) => {
    if (!clearSelectionUntil || Date.now() > clearSelectionUntil) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
  },
  true,
)

/** 手柄当前指着的块（桌面 BlockHandleProvider / 触屏 TouchBlockSetup 的 active 同形） */
type ActiveBlock = { $pos: { pos: number }; node: { nodeSize: number } }

/** 清块选区：本来就没有块选就不派事务。body 上每一次按下都会走到这里，空事务会让所有插件 view.update 一遍，
 *  `@` 引用菜单（挂 body）正是在按下与松开之间被重建，click 落空 */
function clearBlockSelect(view: EditorView): void {
  if (blockSelectKey.getState(view.state)?.active) view.dispatch(view.state.tr.setMeta(blockSelectKey, CLEAR_BLOCK_SELECT))
}

/** 按下点归表格自己：表格横向滚动层伸出正文列（table-scroll.ts），列外也有格子、+ 条、⋯ 和横向滚动条 */
function ownedByTable(target: Element, e: MouseEvent): boolean {
  if (target.closest('.table-scroll td, .table-scroll th, .table-add, .table-menu-btn')) return true
  const scroller = target.closest('.table-scroll')
  return scroller instanceof HTMLElement && e.clientY >= scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight
}

/** 按下点归集合块自己：块里是另一个应用（手柄 / 勾选框在宽屏下挪到正文列左外侧，表格 / 看板伸出正文列），各有各的点击与框选 */
function ownedByCollection(target: Element): boolean {
  return target.closest('.cl-block') !== null
}

/** 视口高度 y 处的顶层集合块 DOM（列外拖选起点在它旁边时选条目，见 applyRange） */
function collectionBlockAt(view: EditorView, y: number): HTMLElement | null {
  let found: HTMLElement | null = null
  view.state.doc.forEach((node, offset) => {
    if (found || !isCollectionBlock(node.type.name)) return
    const el = view.nodeDOM(offset)
    if (!(el instanceof HTMLElement)) return
    const r = el.getBoundingClientRect()
    if (y >= r.top && y <= r.bottom) found = el
  })
  return found
}

/** 列外块拖选：编辑器 DOM 收不到列外区域的 mousedown，只能在外层（body capture）监听。返回卸载函数 */
export function attachBlockDragSelect(getView: () => EditorView | undefined, getActive: () => ActiveBlock | null | undefined): () => void {

  function onBodyMouseDown(e: MouseEvent) {
    const target = e.target as Element | null
    const view = getView()
    if (!view || !target) return
    // 编辑器不可见时（聊天模式 .chat-hidden / 源码模式 .source-hidden 都是 display:none）它不占位，
    // getBoundingClientRect() 全是 0，下面按列外判定会把 clientX > -2 的每一次点击都 preventDefault 掉，
    // 聊天输入框 / 源码框永远拿不到焦点。不可见就没有 gutter 可谈，直接不参与。
    const rect = view.dom.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    if (target.closest('.block-handle, .block-handle-touch')) {
      // 点手柄选中该块（整行高亮，非文字选区）；残留词选的清除见模块级 clearSelectionUntil 注释。
      // 先开窗再 dispatch：dispatch 的 selectionToDOM 也会触发 selectionchange。
      // 三种点法：Shift 点以当前选区为一端扩选；点已在选区内的块保持多选（菜单删除 / Delete
      // 才能作用于整个选区）；其余单选这块。
      clearSelectionUntil = Date.now() + 300
      const active = getActive()
      const doc = view.state.doc
      const prev = blockSelectKey.getState(view.state)
      const hit = active ? { from: active.$pos.pos, to: active.$pos.pos + active.node.nodeSize } : null
      let next = CLEAR_BLOCK_SELECT
      if (hit) {
        if (e.shiftKey && prev && prev.active) {
          // 扩选两端各自归到所在顶层块的范围：跨块删除只删整块（端点落进块内会把块劈开）
          const a = topBlockSpan(doc, prev.from)
          const b = topBlockSpan(doc, hit.from)
          next = a && b
            ? { active: true, from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }
            : { active: true, ...hit }
        } else if (prev && prev.active && prev.from <= hit.from && prev.to >= hit.to) {
          next = prev
        } else {
          next = { active: true, ...hit }
        }
      }
      const from = hit ? hit.from : -1
      const tr = view.state.tr.setMeta(blockSelectKey, next)
      if (!view.state.selection.empty) {
        // PM 内部若还持有双击词选，之后任何 selectionToDOM 都会把它写回 DOM：
        // 先折叠成 caret（caretNear 避开 --- 等原子节点的 near() 死循环）。
        // 手柄点击不 dispatch NodeSelection（block-handle.ts），PM state 只剩 caret，
        // focus() 写回的永远是光标，无蓝色选区可闪
        const caret = caretNear(doc, from >= 0 ? from : view.state.selection.head)
        if (caret) tr.setSelection(caret)
      }
      view.dispatch(tr)
      return
    }
    if (!target.closest('.main')) {
      // 块菜单 / 飞出面板挂在 body 上（不在 .main 里）：点它是执行动作，不能当成点编辑器外
      // 把块选区清掉，多选后点菜单删除正是靠选区还在才能删整段
      if (!target.closest('.block-menu, .block-menu-sub')) {
        clearBlockSelect(view)
      }
      return
    }
    const padLeft = parseFloat(getComputedStyle(view.dom).paddingLeft) || 0
    const outside = e.clientX < rect.left + padLeft - 4 || e.clientX > rect.right - 2
    if (!outside || ownedByTable(target, e) || ownedByCollection(target)) {
      // 列内（或落在伸出列外的表格 / 集合块上）是文字选择，清块选状态
      clearBlockSelect(view)
      return
    }
    // 列外：单击不选中，只有拖动才进入块选择。
    // stopPropagation：gutter 在 ProseMirror padding 内，不拦住的话 PM 会同时开始文字选择
    e.preventDefault()
    e.stopPropagation()
    clearBlockSelect(view)
    // 锚点存相对编辑器顶部的偏移，不存视口 y：拖选中滚轮滚动时内容整体移位，
    // 视口坐标的锚点会漂到别的块上（起点跟着变）
    const anchorOffset = e.clientY - rect.top
    const anchorX = e.clientX
    let lastX = e.clientX
    let lastY = e.clientY
    let dragging = false
    // 拖选框（同集合视图框选的 .cl-marquee）：挂 body 的 fixed 元素，祖先有 transform 时 fixed 会错位。
    // 竖向起点同样按编辑器顶部偏移算，滚动时框的起边跟着内容走
    let box: HTMLDivElement | null = null
    const drawBox = () => {
      if (!box) {
        box = document.createElement('div')
        box.className = 'cl-marquee'
        document.body.appendChild(box)
      }
      const startY = view.dom.getBoundingClientRect().top + anchorOffset
      box.style.left = `${Math.min(anchorX, lastX)}px`
      box.style.top = `${Math.min(startY, lastY)}px`
      box.style.width = `${Math.abs(lastX - anchorX)}px`
      box.style.height = `${Math.abs(lastY - startY)}px`
    }
    // 起点在集合块旁边：没拖出这块就把选框转给块里的视图选条目（行 / 卡片，框碰到才算），不整块选；拖出去了才回到整块选择。
    // 块里没有能选的视图（加载中、只读）时 bandSelect 返回 false，照旧整块选
    const clBlock = collectionBlockAt(view, e.clientY)
    let band: Band = null
    const applyRange = (y: number) => {
      const doc = view.state.doc
      const startY = view.dom.getBoundingClientRect().top + anchorOffset
      const yMin = Math.min(y, startY)
      const yMax = Math.max(y, startY)
      if (clBlock?.isConnected) {
        const r = clBlock.getBoundingClientRect()
        const next = { left: Math.min(anchorX, lastX), right: Math.max(anchorX, lastX), top: yMin, bottom: yMax }
        if (y >= r.top && y <= r.bottom && bandSelect(clBlock, next)) {
          band = next
          clearBlockSelect(view)
          return
        }
        if (band) {
          band = null
          bandSelect(clBlock, null)
        }
      }
      let from = -1
      let to = -1
      let offset = 0
      for (let i = 0; i < doc.childCount; i++) {
        const node = doc.child(i)
        const el = view.nodeDOM(offset)
        if (el instanceof HTMLElement) {
          const rowRect = el.getBoundingClientRect()
          if (rowRect.bottom >= yMin && rowRect.top <= yMax) {
            if (from < 0) from = offset
            to = offset + node.nodeSize
          }
        }
        offset += node.nodeSize
      }
      if (from >= 0 && to > from) {
        // 范围没变不派事务（滚动每帧都会进来）
        const cur = blockSelectKey.getState(view.state)
        if (cur?.active && cur.from === from && cur.to === to) return
        // 只存范围画高亮，不走 PM 选区，避免双重选中样式
        view.dispatch(view.state.tr.setMeta(blockSelectKey, { active: true, from, to }))
      }
    }
    const move = (ev: MouseEvent) => {
      dragging = true
      lastX = ev.clientX
      lastY = ev.clientY
      drawBox()
      applyRange(lastY)
    }
    // 滚动不发 mousemove：按住期间滚动按最后的指针位置重算（与原生文字拖选一致，滚动即扩选）。
    // 元素滚动不冒泡，capture 才收得到；只认包着编辑器的滚动容器
    const scroll = (ev: Event) => {
      if (!(ev.target instanceof Node) || !ev.target.contains(view.dom)) return
      dragging = true
      drawBox()
      applyRange(lastY)
    }
    const up = () => {
      box?.remove()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.removeEventListener('scroll', scroll, true)
      if (band && clBlock) {
        bandSelect(clBlock, band, true)
        return
      }
      // 上面 preventDefault 了 mousedown，焦点不会跟进编辑器：编辑器原本没焦点时（刚打开页、焦点在标题框里），
      // 拖选后的 Backspace / Delete / ↑↓ / Esc 落在 body 或标题框上，blockSelectKeys 收不到。
      // 拖出了块选就把焦点交给编辑器，caret 放到选区开头（带上块选 meta，不清块选）
      const sel = blockSelectKey.getState(view.state)
      if (!dragging || !sel?.active || view.hasFocus()) return
      const caret = caretNear(view.state.doc, sel.from)
      if (caret) view.dispatch(view.state.tr.setSelection(caret).setMeta(blockSelectKey, sel))
      view.focus()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.addEventListener('scroll', scroll, true)
  }
  document.body.addEventListener('mousedown', onBodyMouseDown, true)
  return () => document.body.removeEventListener('mousedown', onBodyMouseDown, true)
}
