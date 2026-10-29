// ---------- 文字框选菜单（Notion 式单行格式条） ----------
// 框选正文文字时浮出一行：`[当前块类型 ▾] | B I U S | 颜色 链接 行内码 清除格式 | 复制链接 引用`（颜色下拉见 color-menu.ts）。
//   - 「转换成 ▾」：选区在一个块里 = 显示这一块（最近可寻址块，text-anchor.ts 的 addressableAt）的类型；跨了几个块 =
//     「N 个块」，转换作用于选区盖住的全部块。动作与块菜单「转换」同一实现（block-turn.ts 的 turnInto）。
//   - 「复制链接」= 定位到这段文字的链接（text-anchor.ts）；「引用」= 把这段字作为块引用 chip 放进正在写的 `>>` 消息
//     （doc-send.ts 的 quoteIntoDraft，与块菜单 / 过程页步骤的「引用」同一个落点）。
// 机制：tooltipFactory + TooltipProvider（@milkdown/plugin-tooltip），floating-ui 定位在选区上方（顶部放不下翻到下方）。
// 与 slash 菜单同款接线：ctx.update(key, { view }) 工厂模式，collab 重建插件视图时工厂重跑、监听随 DOM 重挂。
// 按钮一律 mousedown preventDefault，编辑器焦点与选区不被抢走（slash 菜单同理）。
// 链接是工具栏切到一行输入框（link-input.ts）；Mod-K 经 openLinkEditor 走同一个输入框。
// viewer（只读）也弹，但只有「复制链接」：只读视图拿不到焦点、PM 选区不跟着鼠标走，选区从 DOM 读（readOnlyRange），
// 显隐全靠松手 / 按下自己驱动。样式见 styles/menus.css。
import { tooltipFactory, TooltipProvider } from '@milkdown/kit/plugin/tooltip'
import type { Ctx } from '@milkdown/kit/ctx'
import { toggleMark } from '@milkdown/kit/prose/commands'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { posToDOMRect } from '@milkdown/kit/prose'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { turnItemsFor } from './block-menu'
import { selectionTurnRange, TURN_INTO_ITEMS, turnInto, turnUnits } from './block-turn'
import { createLinkEditor, hrefIn, linkRangeAt, type LinkRange } from './link-input'
import { createColorMenu } from './color-menu'
import { quoteWithFly } from './doc-send'
import { openQuickAi } from './quick-ai'
import { QUICK_KEY_LABEL } from './quick-keys'
import { anchorOfRange, textLinkHref } from './text-anchor'

export const selectionTooltip = tooltipFactory('ramet-selection')

/** 松手到弹出的延迟：盖过双击/误选的瞬时选区，又不至于让人觉得没反应。 */
const SELECTION_MENU_DELAY = 250

/** 引用 chip 上的文字上限（同过程页步骤的引用） */
const QUOTE_MAX = 160

interface MenuButton {
  title: string
  /** 额外类名（B / I / U / S 的字形样式） */
  cls?: string
  render: (el: HTMLButtonElement) => void
  /** 是否点亮（选区内已带该格式）。缺省 = 永不点亮 */
  check?: (view: EditorView) => boolean
  run: (view: EditorView, btn: HTMLButtonElement) => void
  /** viewer（只读）也显示 */
  readOnlyOk?: boolean
}

/** 只读视图的选区：从 DOM 选区换算（PM 不可编辑时不维护 state 选区）。没有 / 折叠 / 不全在正文里 → null */
function readOnlyRange(view: EditorView): { from: number; to: number } | null {
  const sel = view.dom.ownerDocument.getSelection()
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return null
  if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return null
  try {
    const a = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
    const b = view.posAtDOM(sel.focusNode, sel.focusOffset)
    return a === b ? null : { from: Math.min(a, b), to: Math.max(a, b) }
  } catch {
    return null // DOM 节点不在文档描述里（外壳 / widget）
  }
}

/** 菜单作用的选区：可编辑走 PM 选区，只读走 DOM 选区 */
function selectedRange(view: EditorView): { from: number; to: number } | null {
  if (!view.editable) return readOnlyRange(view)
  const { from, to, empty } = view.state.selection
  return empty ? null : { from, to }
}

/** 选区能不能弹菜单：非空、有字、不在代码块里 */
function menuRange(view: EditorView): { from: number; to: number } | null {
  const r = selectedRange(view)
  if (!r) return null
  const { doc } = view.state
  if (doc.resolve(r.from).parent.type.spec.code || !doc.textBetween(r.from, r.to).length) return null
  return r
}

function markOn(view: EditorView, name: string): boolean {
  const { from, to } = view.state.selection
  const type = view.state.schema.marks[name]
  return !!type && view.state.doc.rangeHasMark(from, to, type)
}

/** 块在「转换成」按钮上显示的类型名；认不出（表格、原子块……）= null，按钮不出现 */
function blockTypeLabel(node: PMNode, parent: PMNode | null): string | null {
  switch (node.type.name) {
    case 'paragraph':
      return '正文'
    case 'heading':
      return `标题 ${String(node.attrs.level)}`
    case 'blockquote':
      return '引用'
    case 'callout':
      return '提示框'
    case 'toggle':
      return '折叠块'
    case 'bullet_list':
    case 'ordered_list':
      return node.firstChild ? blockTypeLabel(node.firstChild, node) : null
    case 'list_item':
      if (parent?.type.name === 'ordered_list') return '有序列表'
      return node.attrs.checked === null || node.attrs.checked === undefined ? '无序列表' : '待办'
    default:
      return null
  }
}

/** 「转换成」的对象：选区在一个可寻址块里 = 这一块；跨了几个顶层块 = 这一段（显示「N 个块」） */
function targetBlocks(view: EditorView): { from: number; to: number; node: PMNode | null; label: string } | null {
  const r = selectedRange(view)
  const target = r && selectionTurnRange(view.state, r)
  if (!target) return null
  const doc = view.state.doc
  if (target.node) {
    const label = blockTypeLabel(target.node, doc.resolve(target.from).parent)
    return label ? { ...target, label } : null
  }
  const count = turnUnits(doc, target.from, target.to).length
  return count > 1 ? { ...target, label: `${count} 个块` } : null
}

/** 每个编辑器视图的「打开链接输入框」（Mod-K 用；菜单视图随 collab 重建时覆盖） */
const linkOpeners = new WeakMap<EditorView, (range: LinkRange) => void>()

/** Mod-K：有选区 = 给选区加 / 改链接；折叠光标在链接里 = 改这条链接；否则在光标处插入新链接。代码块里不管 */
export function openLinkEditor(view: EditorView): boolean {
  const { selection } = view.state
  if (selection.$from.parent.type.spec.code || !view.editable) return false
  const open = linkOpeners.get(view)
  if (!open) return false
  const range: LinkRange = selection.empty
    ? (linkRangeAt(view.state, selection.from) ?? { from: selection.from, to: selection.from, href: '' })
    : { from: selection.from, to: selection.to, href: hrefIn(view.state, selection.from, selection.to) }
  open(range)
  return true
}

function buildSelectionMenu(
  view: EditorView,
  pageId: string,
): { content: HTMLElement; refresh: (v: EditorView) => void; linkEditor: ReturnType<typeof createLinkEditor> } {
  const menu = document.createElement('div')
  menu.className = 'pop-card selection-menu'
  const linkEditor = createLinkEditor(menu)

  const t = (name: string) => view.state.schema.marks[name]
  const toggle = (name: string) => (v: EditorView) => {
    const type = t(name)
    if (type) toggleMark(type)(v.state, v.dispatch, v)
  }
  /** 按钮里换一下图标表示「成了」（没有全局 toast） */
  const flashDone = (btn: HTMLButtonElement, restore: string): void => {
    btn.innerHTML = iconSvg('check', 16)
    setTimeout(() => (btn.innerHTML = restore), 1200)
  }

  const groups: MenuButton[][] = [
    [
      { title: '加粗', cls: 'sel-b', render: (el) => (el.textContent = 'B'), check: (v) => markOn(v, 'strong'), run: toggle('strong') },
      { title: '斜体', cls: 'sel-i', render: (el) => (el.textContent = 'I'), check: (v) => markOn(v, 'emphasis'), run: toggle('emphasis') },
      { title: '下划线', cls: 'sel-u', render: (el) => (el.textContent = 'U'), check: (v) => markOn(v, 'underline'), run: toggle('underline') },
      { title: '删除线', cls: 'sel-s', render: (el) => (el.textContent = 'S'), check: (v) => markOn(v, 'strike_through'), run: toggle('strike_through') },
    ],
    [
      {
        title: '链接',
        render: (el) => (el.innerHTML = iconSvg('link', 16)),
        check: (v) => markOn(v, 'link'),
        run: (v) => {
          const { from, to } = v.state.selection
          linkEditor.open(v, { from, to, href: hrefIn(v.state, from, to) })
        },
      },
      { title: '行内代码', cls: 'sel-code', render: (el) => (el.textContent = '</>'), check: (v) => markOn(v, 'inlineCode'), run: toggle('inlineCode') },
      {
        title: '清除格式',
        render: (el) => (el.innerHTML = iconSvg('clear-format', 16)),
        // 一笔事务清掉选区内全部 mark（removeMark 不带 type = 清全部）= 单个撤销步
        run: (v) => {
          const { from, to } = v.state.selection
          v.dispatch(v.state.tr.removeMark(from, to))
        },
      },
    ],
    [
      {
        title: COPY.selection.copyLink,
        render: (el) => (el.innerHTML = iconSvg('copy', 16)),
        readOnlyOk: true,
        run: (v, btn) => {
          const r = selectedRange(v)
          const anchor = r && anchorOfRange(v.state.doc, r.from, r.to)
          if (!anchor) return
          void copyText(textLinkHref(pageId, anchor)).then((ok) => {
            if (ok) flashDone(btn, iconSvg('copy', 16))
          })
        },
      },
      {
        title: COPY.selection.quote,
        render: (el) => (el.innerHTML = iconSvg('quote', 16)),
        run: (v, btn) => {
          const r = selectedRange(v)
          const anchor = r && anchorOfRange(v.state.doc, r.from, r.to)
          if (!anchor) return
          const text = anchor.text.replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX)
          quoteWithFly(v, { pageId, blockId: anchor.blockId, text }, btn.getBoundingClientRect())
        },
      },
    ],
    [
      // 随手 AI：按钮本身就是「选中文字时旁边的 ✨ ⌘J 提示」；点它 = 按 ⌘J
      {
        title: COPY.quick.menuTitle,
        cls: 'sel-ai',
        render: (el) => (el.innerHTML = `${iconSvg('sparkle', 14)}<span>${QUICK_KEY_LABEL}</span>`),
        run: (v) => {
          openQuickAi(v)
        },
      },
    ],
  ]

  /* 「转换成 ▾」：按钮 + 挂 body 的下拉（fixed 定位在按钮下方）。任何一次视图更新（转换执行完、选区变了）都收起 */
  const turn = document.createElement('button')
  turn.type = 'button'
  turn.className = 'sel-turn'
  // 不用 title：原生悬停提示会盖在展开的下拉上
  turn.setAttribute('aria-label', COPY.selection.turnInto)
  const turnLabel = document.createElement('span')
  turn.append(turnLabel)
  turn.insertAdjacentHTML('beforeend', iconSvg('caret', 12))
  let dropdown: HTMLElement | null = null
  const closeDropdown = (): void => {
    dropdown?.remove()
    dropdown = null
    turn.classList.remove('on')
    document.removeEventListener('mousedown', onOutside, true)
  }
  function onOutside(e: MouseEvent): void {
    const target = e.target as Node
    if (!dropdown?.contains(target) && !turn.contains(target)) closeDropdown()
  }
  turn.addEventListener('mousedown', (e) => e.preventDefault())
  turn.addEventListener('click', () => {
    if (dropdown) return closeDropdown()
    const target = targetBlocks(view)
    if (!target) return
    const list = document.createElement('div')
    list.className = 'pop-card sel-turn-menu'
    for (const item of target.node ? turnItemsFor(target.node) : TURN_INTO_ITEMS) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = item.label === target.label ? 'pop-row is-current' : 'pop-row'
      const name = document.createElement('span')
      name.className = 'pop-t'
      name.textContent = item.label
      row.append(name)
      if (item.label === target.label) row.insertAdjacentHTML('beforeend', `<span class="pop-aside">${iconSvg('check', 14)}</span>`)
      row.addEventListener('mousedown', (e) => e.preventDefault())
      row.addEventListener('click', () => {
        closeDropdown()
        turnInto(view, target.from, target.to, item.action)
      })
      list.append(row)
    }
    document.body.append(list)
    const rect = turn.getBoundingClientRect()
    list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - list.offsetWidth - 8))}px`
    const below = rect.bottom + 6
    list.style.top = `${below + list.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - list.offsetHeight - 6) : below}px`
    dropdown = list
    turn.classList.add('on')
    document.addEventListener('mousedown', onOutside, true)
  })
  menu.append(turn)

  const buttons: Array<{ item: MenuButton; btn: HTMLButtonElement }> = []
  const seps: HTMLElement[] = []
  const colorMenu = createColorMenu(view)
  groups.forEach((group, groupIndex) => {
    const sep = document.createElement('span')
    sep.className = 'sel-sep'
    menu.append(sep)
    seps.push(sep)
    if (groupIndex === 1) menu.append(colorMenu.button) // 「颜色」排在 B I U S 之后、链接之前
    for (const item of group) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.title = item.title
      if (item.cls) btn.className = item.cls
      item.render(btn)
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', () => item.run(view, btn))
      menu.append(btn)
      buttons.push({ item, btn })
    }
  })

  const refresh = (v: EditorView) => {
    closeDropdown()
    colorMenu.close()
    const editable = v.editable
    colorMenu.button.hidden = !editable
    menu.classList.toggle('is-readonly', !editable)
    for (const { item, btn } of buttons) {
      btn.hidden = !editable && !item.readOnlyOk
      btn.classList.toggle('on', editable && !!item.check?.(v))
    }
    const target = editable ? targetBlocks(v) : null
    turn.hidden = !target
    turnLabel.textContent = target?.label ?? ''
    // 分隔线：前面有可见按钮、自己这组也有可见按钮才画
    let before = !turn.hidden
    seps.forEach((sep, i) => {
      const visible = groups[i]!.some((item) => editable || item.readOnlyOk)
      sep.hidden = !(before && visible)
      before = before || visible
    })
  }
  menu.append(linkEditor.row)
  refresh(view)
  return { content: menu, refresh, linkEditor }
}

/** pageId：「复制链接」拼链接用 */
export function configSelectionMenu(ctx: Ctx, pageId: string) {
  ctx.update(selectionTooltip.key, (prev) => ({
    ...prev,
    view: (view: EditorView) => {
      const { content, refresh, linkEditor } = buildSelectionMenu(view, pageId)
      // 「松手后才显示」+ 防抖：拖拽选字过程中（左键按住）不弹；松手后延迟再弹，误选/双击
      // 瞬时选区不会闪菜单。松手本身不产生新事务，必须主动补 show（update 的 isSame 短路）；
      // 延迟期内再按下/销毁要取消，弹出前重验选区（延迟期间可能已收起）。
      let dragging = false
      let showTimer: ReturnType<typeof setTimeout> | undefined
      const clearPending = () => {
        if (showTimer !== undefined) {
          clearTimeout(showTimer)
          showTimer = undefined
        }
      }
      const selectable = (): boolean => {
        if (!view.editable) return menuRange(view) !== null
        const { selection, doc } = view.state
        return (
          !selection.empty &&
          !selection.$from.parent.type.spec.code &&
          !!doc.textBetween(selection.from, selection.to).length &&
          view.hasFocus() &&
          view.editable
        )
      }
      const onMouseDown = (e: MouseEvent) => {
        if (e.button === 0) {
          dragging = true
          clearPending()
          // 只读时按下不产生事务，provider 不会自己收起，得主动收
          if (!view.editable) provider.hide()
        }
      }
      const onMouseUp = () => {
        if (!dragging) return
        dragging = false
        clearPending()
        showTimer = setTimeout(() => {
          showTimer = undefined
          const range = selectable() ? selectedRange(view) : null
          if (!range) return
          refresh(view)
          provider.show({ getBoundingClientRect: () => posToDOMRect(view, range.from, range.to) }, view)
        }, SELECTION_MENU_DELAY)
      }
      view.dom.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      // 代码块内选区：mark 套不上去（marks:""），菜单只会是摆设，所以自备选区判据。
      // 默认判据在 provider 私有方法里包不住，这里照抄它的语义：非空文本选区 + 焦点 + 可编辑
      const provider = new TooltipProvider({
        content,
        debounce: 0,
        shouldShow: (v) => {
          if (linkEditor.isOpen()) return true // 链接输入框开着：焦点在输入框里、选区可能是折叠的（Mod-K 插入新链接）
          if (dragging) return false
          if (!v.editable) return menuRange(v) !== null
          const { selection, doc } = v.state
          if (selection.empty || selection.$from.parent.type.spec.code) return false
          if (!doc.textBetween(selection.from, selection.to).length && selection instanceof TextSelection) return false
          return v.hasFocus() || content.contains(document.activeElement)
        },
      })
      linkOpeners.set(view, (range) => {
        clearPending()
        refresh(view)
        provider.show({ getBoundingClientRect: () => posToDOMRect(view, range.from, range.to) }, view)
        linkEditor.open(view, range)
      })
      return {
        update: (updatedView: EditorView, prevState?: Parameters<typeof provider.update>[1]) => {
          refresh(updatedView)
          provider.update(updatedView, prevState)
        },
        destroy: () => {
          linkOpeners.delete(view)
          clearPending()
          view.dom.removeEventListener('mousedown', onMouseDown)
          window.removeEventListener('mouseup', onMouseUp)
          provider.destroy()
          content.remove()
        },
      }
    },
  }))
}
