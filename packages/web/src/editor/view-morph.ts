/* ---------- 文档 ⇄ 对话切换：保持阅读位置；文字直接平移到新位置，气泡这些壳淡入淡出 ----------
 * - 配对单位是「文字」：普通顶层块是块本身（键 = 块 id）；消息块（用户消息 / AI 回复）是它里面的每个子块
 *   （键 = 块 id#序号；对话侧是气泡正文里标了 data-part 的元素）。AI 回复的抬头行两种模式是同一套元素
 *   （ai-block.ts 的 buildReplyHead），整行配对（键 = 块 id@head）。用户气泡底色、头像、署名行、色条这些壳
 *   不命名，留在根画面里淡出 / 淡入。草稿正文第一段与对话输入框配成一对（composer，有字才配）。
 * - 动画（styles/chat.css 的 :root[data-view-morph] 规则）：配上对的组只画新画面、按原尺寸不缩放，跟着组从旧位置
 *   平移到新位置；旧画面不画。只有一边的组照常淡出 / 淡入。<html data-view-morph> 只在切换期间挂，
 *   进出过程页的变形（run-door.ts）不受影响。
 * - 名字不写在 ProseMirror 管的元素上：给块写 style（viewTransitionName）会被 PM 的 DOMObserver 当成内容变动，
 *   它把这一块标脏、按文档状态重画，新元素没有名字，配对全丢、只剩淡入淡出。
 *   所以编辑器 / 对话视图里的元素用一张临时样式表、按 :nth-child 路径选中命名；
 *   视图外的元素（对话输入框）才写行内样式。
 * - View Transitions 的名字一次切换内发号（blk-<序号>），不拼块 id（老标题的 slug id 不一定是合法 ident）。
 *   旧画面只给视口 ±200px 的可见元素命名（一次别动几百个）；新画面只给旧画面命名过的键命名（不凭空多出组）。
 *   同名的两个可见元素会让整次变形作废：VT 回调里先清旧名再命名新视图。
 * - 位置：切换前记下视口里靠上的那段文字的屏幕高度，切完把同一段放回同一高度（两个视图共用滚动口 .main）。
 * - 不支持 startViewTransition / 减弱动效：不动画，位置照样保持。
 *
 * 时序依赖（改这里或升级 React / y-prosemirror 前先核对）：
 * - createRoot + React 18 下 flushSync 的提交会同步冲刷 passive effects（react-dom commitRootImpl 的
 *   SyncLane 分支），所以 flushSync(change) 返回时 ChatView 的只读视图已建好 / 已销毁、登记与可见视图一致；
 *   y-prosemirror 1.3.7 的 ySyncPlugin 在 view 初始化里同步渲染，气泡此刻已在 DOM。
 * - ChatView 挂载时 chat-follow 的 stick() 先滚到底并记下 ownTop，这里随后改 scrollTop；下一帧的 scroll
 *   事件（渲染步骤里先于 ResizeObserver）让 chat-follow 按 atBottom() 重新判定跟不跟随。 */
import { flushSync } from 'react-dom'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { diagLog } from '../debug-log'
import { reducedMotion } from '../motion'

type ViewTransitionDoc = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<unknown>; finished: Promise<unknown> }
}

/** 一个视图里可配对的文字单元：键 → 屏幕上的元素（文档顺序） */
export type UnitMap = Map<string, HTMLElement>

const COMPOSER = 'composer'

const isMessage = (node: ProsemirrorNode): boolean => node.type.name === 'user_message' || node.type.name === 'agent_reply'
const hasText = (el: Element): boolean => Boolean(el.textContent?.trim())

let chatUnitsSource: (() => UnitMap) | null = null

/** ChatView 建视图时登记自己的单元来源（chatUnits），销毁时注销（同一时刻只有一个 ChatView） */
export function registerChatUnits(source: () => UnitMap): () => void {
  chatUnitsSource = source
  return () => {
    if (chatUnitsSource === source) chatUnitsSource = null
  }
}

/** 文档视图的单元：普通块取节点 DOM；消息块取各子块的节点 DOM；草稿只取有字的第一段（配输入框）；
 *  正在跑的回复（is-live，正文是实时视图）不取 */
function docUnits(view: EditorView): UnitMap {
  const out: UnitMap = new Map()
  view.state.doc.forEach((node, off) => {
    const id: unknown = node.attrs.id
    if (typeof id !== 'string' || !id) return
    const dom = view.nodeDOM(off)
    if (!(dom instanceof HTMLElement)) return
    if (!isMessage(node)) return void out.set(id, dom)
    if (dom.classList.contains('is-live')) return
    const head = dom.querySelector<HTMLElement>(':scope > .reply-head')
    if (head) out.set(`${id}@head`, head)
    const draft = dom.classList.contains('is-draft')
    node.forEach((_child, childOff, i) => {
      const el = view.nodeDOM(off + 1 + childOff)
      if (!(el instanceof HTMLElement)) return
      if (!draft) out.set(`${id}#${i}`, el)
      else if (i === 0 && hasText(el)) out.set(COMPOSER, el)
    })
  })
  return out
}

/** 对话视图的单元：普通块取节点 DOM；消息块取气泡正文里的 [data-part] 元素（chat-view.tsx 的 buildBubble 标的）；
 *  输入框有字时算 composer。host 是只读视图的挂载点 */
export function chatUnits(view: EditorView, host: HTMLElement): UnitMap {
  const bubbles = new Map<string, HTMLElement>()
  const heads = new Map<string, HTMLElement>()
  for (const row of host.querySelectorAll<HTMLElement>('.chat-msg[data-blk]')) {
    if (row.classList.contains('is-live')) continue
    const key = row.dataset.blk ?? ''
    const bubble = row.querySelector<HTMLElement>(':scope > .chat-bubble')
    const head = row.querySelector<HTMLElement>(':scope > .reply-head')
    if (bubble) bubbles.set(key, bubble)
    if (head) heads.set(key, head)
  }
  const out: UnitMap = new Map()
  view.state.doc.forEach((node, off) => {
    const id: unknown = node.attrs.id
    if (typeof id !== 'string' || !id) return
    if (!isMessage(node)) {
      const dom = view.nodeDOM(off)
      if (dom instanceof HTMLElement) out.set(id, dom)
      return
    }
    const head = heads.get(id)
    if (head) out.set(`${id}@head`, head)
    for (const part of bubbles.get(id)?.querySelectorAll<HTMLElement>(':scope > [data-part]') ?? []) {
      out.set(`${id}#${part.dataset.part}`, part)
    }
  })
  // 输入框是迷你 ProseMirror（composer-input.tsx）：空框根上挂着 data-empty
  const input = document.querySelector<HTMLElement>('.chat-composer .chat-input')
  if (input && !input.hasAttribute('data-empty') && input.textContent?.trim()) out.set(COMPOSER, input)
  return out
}

/** 当前可见视图的单元：有对话来源登记就是对话视图，否则文档视图；只留渲染出来的元素 */
function visibleUnits(docView: () => EditorView | undefined): UnitMap {
  const view = docView()
  const all = chatUnitsSource ? chatUnitsSource() : view && !view.isDestroyed ? docUnits(view) : new Map<string, HTMLElement>()
  for (const [key, el] of all) if (el.offsetParent === null) all.delete(key)
  return all
}

interface Anchor {
  key: string
  top: number
}

/** 视口里的单元，首选第一个顶边落在可视区里的（整段从屏幕里开始），其余按文档顺序做后备 */
function anchorsOf(units: UnitMap, scroller: HTMLElement): Anchor[] {
  const box = scroller.getBoundingClientRect()
  const hits: Anchor[] = []
  for (const [key, el] of units) {
    const r = el.getBoundingClientRect()
    if (r.bottom > box.top && r.top < box.bottom) hits.push({ key, top: r.top })
  }
  const first = hits.findIndex((a) => a.top >= box.top)
  return first > 0 ? [...hits.slice(first), ...hits.slice(0, first)] : hits
}

/** 把第一个在新视图里还在的锚放回切换前的屏幕高度，返回诊断用的描述 */
function restore(anchors: Anchor[], units: UnitMap, scroller: HTMLElement): string {
  for (const a of anchors) {
    const el = units.get(a.key)
    if (!el) continue
    const dy = el.getBoundingClientRect().top - a.top
    const before = scroller.scrollTop
    if (Math.abs(dy) >= 1) scroller.scrollTop += dy
    return `anchor=${a.key} dy=${Math.round(dy)} scroll=${Math.round(before)}->${Math.round(scroller.scrollTop)}`
  }
  return `anchor=none of ${anchors.length}`
}

/** 编辑器 / 对话视图里元素的唯一选择器：从挂载点（.editor-root 是 .editor-page 的直接孩子、.chat-root 只有一个）
 *  一路 :nth-child 下去。挂载点不在 PM 的观察范围内；视图外的元素返回 null */
function pathSelector(el: HTMLElement): string | null {
  const anchor = el.closest<HTMLElement>('.editor-root, .chat-root')
  if (!anchor) return null
  const steps: string[] = []
  for (let n: Element = el; n !== anchor; ) {
    const parent = n.parentElement
    if (!parent) return null
    steps.unshift(`:nth-child(${Array.prototype.indexOf.call(parent.children, n) + 1})`)
    n = parent
  }
  const base = anchor.classList.contains('chat-root') ? '.editor-page .chat-root' : '.editor-page > .editor-root'
  return `${base} > ${steps.join(' > ')}`
}

/** 一次切换的命名：键发号；PM 管的元素进临时样式表（见文件头），其余写行内样式；结束时都清掉 */
function createNamer() {
  const seq = new Map<string, number>()
  const rules: string[] = []
  const inline: HTMLElement[] = []
  let sheet: HTMLStyleElement | null = null
  const name = (el: HTMLElement, key: string): void => {
    let n = seq.get(key)
    if (n === undefined) {
      n = seq.size
      seq.set(key, n)
    }
    const value = key === COMPOSER ? COMPOSER : `blk-${n}`
    const selector = pathSelector(el)
    if (selector) rules.push(`${selector} { view-transition-name: ${value}; }`)
    else {
      el.style.viewTransitionName = value
      inline.push(el)
    }
  }
  /** 把这一轮的规则写进样式表（命名完一次写一次） */
  const commit = (): void => {
    if (!sheet) {
      sheet = document.createElement('style')
      sheet.dataset.viewMorph = ''
      document.head.append(sheet)
    }
    sheet.textContent = rules.join('\n')
  }
  return {
    /** 旧画面：视口 ±200px 内的单元；返回命名过的键 */
    nameOld(units: UnitMap): Set<string> {
      const keys = new Set<string>()
      const vh = window.innerHeight
      for (const [key, el] of units) {
        const r = el.getBoundingClientRect()
        if (r.bottom <= -200 || r.top >= vh + 200) continue
        name(el, key)
        keys.add(key)
      }
      commit()
      return keys
    },
    /** 新画面：只给旧画面命名过的键（配成对的数量） */
    nameNew(units: UnitMap, oldKeys: Set<string>): number {
      let paired = 0
      for (const key of oldKeys) {
        const el = units.get(key)
        if (!el) continue
        name(el, key)
        paired++
      }
      commit()
      return paired
    },
    clear(): void {
      rules.length = 0
      sheet?.remove()
      sheet = null
      for (const el of inline.splice(0)) el.style.viewTransitionName = ''
    },
  }
}

/** change = 切换（React 状态 + 搬输入）；after = 切完、新视图已在 DOM 里之后要做的事（如落光标）；
 *  docView = 文档模式的正文视图（滚动口与文档侧的单元都从它取）。
 *  两条路径都 flushSync(change)，之后先把阅读位置放回、再 after()：after 看到的永远是切完、位置已复原的 DOM */
export function morphViewMode(opts: { change: () => void; after?: () => void; docView: () => EditorView | undefined }): void {
  const { change, after, docView } = opts
  const scroller = docView()?.dom.closest<HTMLElement>('.main') ?? null
  const oldUnits = visibleUnits(docView)
  const anchors = scroller ? anchorsOf(oldUnits, scroller) : []
  // 诊断日志（?diag=1 才记，debug-log.ts）
  const dir = chatUnitsSource ? 'chat→doc' : 'doc→chat'
  let placed = ''
  const run = (): void => {
    flushSync(change)
    if (scroller) placed = restore(anchors, visibleUnits(docView), scroller)
    after?.()
  }
  const start = (document as ViewTransitionDoc).startViewTransition?.bind(document)
  const reduced = reducedMotion()
  if (!start || reduced) {
    run()
    diagLog(`morph ${dir} no-vt support=${Boolean(start)} reduced=${reduced} ${placed}`)
    return
  }
  const root = document.documentElement
  const namer = createNamer()
  const oldKeys = namer.nameOld(oldUnits)
  root.dataset.viewMorph = '' // 切换期间才挂：styles/chat.css 的平移 / 淡入规则只作用于这次切换
  const done = (): void => {
    namer.clear()
    delete root.dataset.viewMorph
  }
  try {
    const transition = start(() => {
      namer.clear() // 旧画面已经拍好：先摘旧名字，免得和新视图里的同名元素撞上
      run()
      const newUnits = visibleUnits(docView)
      const paired = namer.nameNew(newUnits, oldKeys)
      diagLog(`morph ${dir} units=${oldUnits.size}->${newUnits.size} named=${oldKeys.size} paired=${paired} ${placed} vh=${window.innerHeight}`)
    })
    void transition.ready.then(
      () => diagLog('morph ready'),
      (err: unknown) => diagLog(`morph skipped ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`),
    )
    void transition.finished.finally(done)
  } catch (err) {
    done()
    run()
    diagLog(`morph threw ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
  }
}
