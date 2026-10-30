// 行内链接悬浮栏：指针在正文的行内链接（link mark）上停 HOVER_DELAY 后，链接下方浮出一栏：链接图标 + 缩略地址 | 复制 | 编辑 | 转成书签
// （下方放不下翻到上方）。指针从链接移到栏上栏不动，离开两者 LEAVE_DELAY 后收起。
//   - 点缩略地址 = 打开（link-nav.ts 的 linkTarget：站内 /page/ 走路由，其余新标签）；复制 = 完整地址（站内相对地址补 origin）。
//   - 编辑 = 栏原地切成「文本 + 链接」表单：Enter 应用（link-edit.ts 的 editLinkTr，一步撤销）、Esc / 点外面放弃；
//     底行「删除链接」= 摘掉链接留文字（同样一步撤销）。
//   - 转成书签（只对 http(s) 链接）= bookmark.ts 的 linkToBookmark：独占一段就整段换成书签卡，句中的在该段下面插一张。
//   - viewer 没有编辑和转成书签。左键按着（拖选）、链接在选区里（框选工具栏在管）不弹；查看态下敲键 / 滚动 / 按下鼠标就收起。
// 栏挂 body、fixed 定位，纯 DOM；按钮 mousedown preventDefault（编辑器焦点 / 选区不被抢走，selection-menu 同款）。
// 正文一变（本地或协同对端）就按内容找回这条链接（link-edit.ts 的 findLink），没了就收起。
// 只挂编辑器（editor-session.ts）；不加 schema，公开页不用同步注册。样式在 styles/menus.css。

import { posToDOMRect } from '@milkdown/kit/prose'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { copyText } from '../clipboard'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { absoluteHref, editLinkTr, findLink, shortHref } from './link-edit'
import { linkRangeAt, type LinkRange } from './link-input'
import { linkTarget } from './link-nav'
import { linkToBookmark } from './bookmark'
import { safeBookmarkUrl } from '@ramet/shared/md-dialect'

const L = COPY.linkHover

/** 指针停多久才弹（扫过链接不闪） */
const HOVER_DELAY = 300
/** 离开链接 / 栏多久收起（够把指针挪到栏上） */
const LEAVE_DELAY = 250
const GAP = 6
const VIEW_MARGIN = 8

interface LinkHoverOptions {
  navigate: (to: string) => void
  openExternal: (href: string) => void
}

/** 指针下的 a 对应的正文链接整段；a 的 href 与 link mark 对不上（附件 / 目录等 nodeView 里的 a）= null */
function linkOfAnchor(view: EditorView, a: HTMLAnchorElement): LinkRange | null {
  let pos: number
  try {
    pos = view.posAtDOM(a, 0)
  } catch {
    return null // 不在文档描述里（widget / 外壳）
  }
  const range = linkRangeAt(view.state, pos)
  return range && range.href === a.getAttribute('href') ? range : null
}

/** 链接跨行时取指针所在那一行的矩形（栏贴着那一行出） */
function lineRectAt(a: HTMLElement, y: number): DOMRect {
  const rects = Array.from(a.getClientRects())
  return rects.find((r) => y >= r.top && y <= r.bottom) ?? rects[0] ?? a.getBoundingClientRect()
}

const sameRange = (a: LinkRange, b: LinkRange): boolean => a.from === b.from && a.to === b.to

function button(icon: Parameters<typeof iconSvg>[0], title: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.title = title
  btn.innerHTML = iconSvg(icon, 16)
  return btn
}

function field(label: string, input: HTMLInputElement): HTMLLabelElement {
  const row = document.createElement('label')
  row.className = 'lh-field'
  const name = document.createElement('span')
  name.textContent = label
  input.spellcheck = false
  row.append(name, input)
  return row
}

function createLinkHover(view: EditorView, opts: LinkHoverOptions) {
  const bar = document.createElement('div')
  bar.className = 'pop-card link-hover'

  // 查看态：图标 + 缩略地址 | 复制 编辑
  const show = document.createElement('div')
  show.className = 'lh-view'
  const addr = document.createElement('button')
  addr.type = 'button'
  addr.className = 'lh-addr'
  const addrText = document.createElement('span')
  addr.innerHTML = iconSvg('link', 14)
  addr.append(addrText)
  const sep = document.createElement('span')
  sep.className = 'sel-sep'
  const copy = button('copy', L.copy)
  const edit = button('edit', L.edit)
  const toBookmark = button('bookmark', L.toBookmark)
  show.append(addr, sep, copy, edit, toBookmark)

  // 编辑态：文本 / 链接两行 + 键位提示
  const form = document.createElement('div')
  form.className = 'lh-form'
  const textInput = document.createElement('input')
  textInput.type = 'text'
  const hrefInput = document.createElement('input')
  hrefInput.type = 'url'
  hrefInput.placeholder = L.hrefPlaceholder
  // 底行：删除链接（摘链接、文字原样留着）+ 键位提示
  const foot = document.createElement('div')
  foot.className = 'lh-foot'
  const unlink = document.createElement('button')
  unlink.type = 'button'
  unlink.className = 'lh-unlink'
  unlink.title = L.unlinkTitle
  unlink.innerHTML = iconSvg('trash', 14)
  unlink.append(L.unlink)
  const hint = document.createElement('span')
  hint.className = 'lh-hint'
  hint.textContent = L.hint
  foot.append(unlink, hint)
  form.append(field(L.text, textInput), field(L.href, hrefInput), foot)
  bar.append(show, form)

  /** 栏盯着的链接：range 随正文变化重新定位；text = 链接文字（找回用 / 表单预填） */
  let shown: { range: LinkRange; text: string } | null = null
  let editing = false
  /** 上一次 mousemove 落在的 a（同一个元素里移动不重复算位置） */
  let hovered: HTMLAnchorElement | null = null
  let showTimer: number | undefined
  let hideTimer: number | undefined

  const cancelShow = (): void => {
    window.clearTimeout(showTimer)
    showTimer = undefined
  }
  const cancelHide = (): void => {
    window.clearTimeout(hideTimer)
    hideTimer = undefined
  }
  const scheduleHide = (): void => {
    if (!shown || editing || hideTimer !== undefined) return
    hideTimer = window.setTimeout(hide, LEAVE_DELAY)
  }

  function place(rect: { left: number; top: number; bottom: number }): void {
    bar.style.left = `${Math.max(VIEW_MARGIN, Math.min(rect.left, window.innerWidth - bar.offsetWidth - VIEW_MARGIN))}px`
    const below = rect.bottom + GAP
    const flip = below + bar.offsetHeight > window.innerHeight - VIEW_MARGIN
    bar.style.top = `${flip ? Math.max(VIEW_MARGIN, rect.top - bar.offsetHeight - GAP) : below}px`
  }

  function open(a: HTMLAnchorElement, y: number): void {
    const range = linkOfAnchor(view, a)
    const sel = document.getSelection()
    if (!range || (sel && !sel.isCollapsed && sel.containsNode(a, true))) return
    cancelHide()
    shown = { range, text: view.state.doc.textBetween(range.from, range.to) }
    editing = false
    bar.classList.remove('is-editing')
    addrText.textContent = shortHref(range.href) || range.href
    addr.title = L.open(range.href)
    edit.hidden = !view.editable
    toBookmark.hidden = !view.editable || !safeBookmarkUrl(range.href)
    copy.innerHTML = iconSvg('copy', 16)
    if (!bar.isConnected) {
      document.body.append(bar)
      document.addEventListener('mousedown', onOutside, true)
      window.addEventListener('scroll', onScroll, true)
    }
    place(lineRectAt(a, y))
  }

  /** 收起栏。不动待弹的计时：从一条链接直接移到另一条时，旧栏的离开计时先到，新栏照样要弹 */
  function hide(): void {
    cancelHide()
    if (!shown) return
    shown = null
    editing = false
    bar.remove()
    document.removeEventListener('mousedown', onOutside, true)
    window.removeEventListener('scroll', onScroll, true)
  }

  /** 收起并作废待弹的（敲键 / 滚动 / 点击 / 改完）：指针得再动一下才会重新弹 */
  function reset(): void {
    cancelShow()
    hovered = null
    hide()
  }

  function startEdit(): void {
    if (!shown || !view.editable) return
    cancelHide()
    editing = true
    textInput.value = shown.text
    hrefInput.value = shown.range.href
    bar.classList.add('is-editing')
    // 换了尺寸：按链接当前的位置重新摆（查看态下不会滚动，滚了就收起了）
    place(posToDOMRect(view, shown.range.from, shown.range.to))
    textInput.focus()
    textInput.select()
  }

  /** save = 按表单应用；unlink = 摘掉链接、文字保持文档里现在的样子（表单里没保存的改动作废）；cancel = 不写 */
  function finish(how: 'save' | 'unlink' | 'cancel'): void {
    const range = shown?.range
    const { state } = view
    let tr: Transaction | null = null
    if (range && how === 'save') tr = editLinkTr(state, range, textInput.value, hrefInput.value)
    if (range && how === 'unlink') tr = editLinkTr(state, range, state.doc.textBetween(range.from, range.to), '')
    reset()
    if (tr && range) {
      // 光标落到改完的链接末尾
      tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.to)))
      view.dispatch(tr.scrollIntoView())
    }
    view.focus()
  }

  function onOutside(e: MouseEvent): void {
    if (!bar.contains(e.target as Node)) reset() // 编辑态 = 放弃；焦点跟着这次点击走
  }
  function onScroll(): void {
    if (!shown) return
    if (editing) place(posToDOMRect(view, shown.range.from, shown.range.to))
    else reset()
  }

  function onMove(e: MouseEvent): void {
    if (editing) return
    if (e.buttons & 1) {
      cancelShow() // 拖选中不弹
      return
    }
    const a = (e.target as Element | null)?.closest('a') ?? null
    const target = a && view.dom.contains(a) ? a : null
    if (target === hovered) return
    hovered = target
    cancelShow()
    const range = target && linkOfAnchor(view, target)
    if (!target || !range) return scheduleHide()
    if (shown && sameRange(range, shown.range)) return cancelHide()
    scheduleHide()
    const y = e.clientY
    showTimer = window.setTimeout(() => {
      showTimer = undefined
      if (hovered === target && target.isConnected) open(target, y)
    }, HOVER_DELAY)
  }
  function onLeave(): void {
    hovered = null
    cancelShow()
    scheduleHide()
  }
  function onKey(): void {
    if (!editing) reset()
  }
  function onDown(): void {
    cancelShow()
    hovered = null
  }

  for (const btn of [addr, copy, edit, toBookmark]) btn.addEventListener('mousedown', (e) => e.preventDefault())
  unlink.addEventListener('click', () => finish('unlink'))
  addr.addEventListener('click', () => {
    if (!shown) return
    const { internal, href } = linkTarget(shown.range.href)
    reset()
    if (internal) opts.navigate(href)
    else opts.openExternal(href)
  })
  copy.addEventListener('click', () => {
    if (!shown) return
    void copyText(absoluteHref(shown.range.href, location.origin)).then((ok) => {
      if (!ok) return
      copy.innerHTML = iconSvg('check', 16)
      window.setTimeout(() => (copy.innerHTML = iconSvg('copy', 16)), 1200)
    })
  })
  edit.addEventListener('click', startEdit)
  toBookmark.addEventListener('click', () => {
    if (!shown || !view.editable) return
    const { range } = shown
    reset()
    const tr = linkToBookmark(view.state, range.from, range.to, range.href)
    if (tr) view.dispatch(tr)
    view.focus()
  })
  for (const input of [textInput, hrefInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Enter') {
        e.preventDefault()
        finish('save')
      } else if (e.key === 'Tab') {
        e.preventDefault() // 焦点只在两个框之间转，不跑出栏
        ;(input === textInput ? hrefInput : textInput).focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish('cancel')
      }
    })
  }
  bar.addEventListener('mouseenter', cancelHide)
  bar.addEventListener('mouseleave', scheduleHide)
  view.dom.addEventListener('mousemove', onMove)
  view.dom.addEventListener('mouseleave', onLeave)
  view.dom.addEventListener('mousedown', onDown)
  view.dom.addEventListener('keydown', onKey)

  return {
    update(v: EditorView, prev: EditorState): void {
      if (!shown || v.state.doc === prev.doc) return
      // 正文变了：按内容找回这条链接，没了就收起
      const next = findLink(v.state, { href: shown.range.href, text: shown.text, from: shown.range.from })
      if (!next) return reset()
      const text = v.state.doc.textBetween(next.from, next.to)
      // 表单开着、文本框没动过：跟上对端改的文字（否则保存会把对端的改动写回旧字）
      if (editing && textInput.value === shown.text) textInput.value = text
      const moved = !sameRange(next, shown.range)
      shown = { range: next, text }
      if (editing || moved) place(posToDOMRect(v, next.from, next.to))
    },
    destroy(): void {
      reset()
      view.dom.removeEventListener('mousemove', onMove)
      view.dom.removeEventListener('mouseleave', onLeave)
      view.dom.removeEventListener('mousedown', onDown)
      view.dom.removeEventListener('keydown', onKey)
    },
  }
}

export function linkHover(opts: LinkHoverOptions) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('ramet-link-hover'),
        view: (view) => createLinkHover(view, opts),
      }),
  )
}
