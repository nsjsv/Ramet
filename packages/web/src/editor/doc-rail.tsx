/* ---------- 右轨：文档导航（地标一列小横杠；悬停出预览，点击跳转） ----------
 * 地标是文档里跳得过去的东西：顶层标题（heading 1-6）和消息块（user_message / agent_reply）。
 * 口径只有一处：landmarks() 一遍遍历出 id / 种类 / 标题 / 位置，右轨条目与 DOM 锚（data-rail=<id>）同源，
 * 文档怎么变（本端编辑 / 远端到达 / 流式追加）都不会错位。
 * 锚挂在可见元素上：文档模式两种地标都是文档块（本文件的插件装饰节点）；聊天模式消息的可见元素是气泡
 * （chat-view.tsx 的 chatDecorations 挂），标题块仍走节点装饰。
 * 挂载点只有一个（Editor.tsx 直出 .main 里，视口级 HUD）：竖向钉视口中央，横向贴画面右缘。
 * Dock 式跟随、预览与波浪都由 DocRail 直接写 DOM（.is-near / --grow），不走 React state。 */

import { useEffect, useRef, useState } from 'react'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { decodeStats } from '@ramet/shared/reply-stats'

/** 地标种类：标题层级（h1-h6）或消息块（user 是用户消息，ai 是 AI 回复），横杠的形态和颜色按它分 */
type RailKind = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'user' | 'ai'

/** 右轨条目（渲染输入；off / node 不进 React，每次遍历都换身份） */
interface RailItem {
  id: number
  kind: RailKind
  title: string
}

/** 地标 = 右轨条目 + 装饰要的文档位置 */
interface Landmark extends RailItem {
  off: number
  node: ProsemirrorNode
}

/** 悬停提示的标题上限；取标题只扫块首这么多字符，首行足够，也免得超长回复块每次 update 都全量抽一遍文本 */
const TITLE_MAX = 80
const TITLE_SCAN = 400

/** 空标题的回落名：横杠还在（地标确实存在），提示得说得出它是什么 */
function emptyTitle(kind: RailKind): string {
  if (kind === 'user') return '用户消息'
  if (kind === 'ai') return 'AI 回复'
  return `标题 ${kind.slice(1)}`
}

/** 标题文本取块内首个非空行（跳过前置空段），过长截断 */
function titleOf(node: ProsemirrorNode, kind: RailKind): string {
  // 运行中的回复在文档里只是占位（正文走实时视图，收尾才落进来）
  if (kind === 'ai' && decodeStats(node.attrs.stats).o === 'run') return '正在回复…'
  const head = node.textBetween(0, Math.min(node.content.size, TITLE_SCAN), '\n')
  const first = head.split('\n').find((line) => line.trim())?.trim()
  if (!first) return emptyTitle(kind)
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first
}

/** 地标种类：顶层 heading（按 attrs.level 分档）与两个消息块；其余块不是地标 */
function kindOf(node: ProsemirrorNode): RailKind | null {
  const name = node.type.name
  if (name === 'heading') {
    const level: unknown = node.attrs.level
    return typeof level === 'number' && level >= 1 && level <= 6 ? (`h${level}` as RailKind) : null
  }
  return name === 'user_message' ? 'user' : name === 'agent_reply' ? 'ai' : null
}

/** 地标清单：唯一的遍历口径（右轨条目与 data-rail 锚都由它出） */
export function landmarks(doc: ProsemirrorNode): Landmark[] {
  const out: Landmark[] = []
  doc.forEach((node, off) => {
    const kind = kindOf(node)
    if (!kind) return
    out.push({ id: out.length, kind, title: titleOf(node, kind), off, node })
  })
  return out
}

function railItems(doc: ProsemirrorNode): RailItem[] {
  return landmarks(doc).map(({ id, kind, title }) => ({ id, kind, title }))
}

/** 两份清单是否等价：编辑 / 流式追加时 update 很密，等价就别惊动 React */
function sameRail(a: RailItem[], b: RailItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const next = b[i]!
      return m.id === next.id && m.kind === next.kind && m.title === next.title
    })
  )
}

/** 清单暂存（每个页面一个）：插件往里推，右轨订阅它，只有右轨重渲染，不牵动整页 */
export interface RailStore {
  items: RailItem[]
  push(next: RailItem[]): void
  subscribe(listener: () => void): () => void
}

export function createRailStore(): RailStore {
  const listeners = new Set<() => void>()
  const store: RailStore = {
    items: [],
    push(next) {
      if (sameRail(store.items, next)) return
      store.items = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return store
}

/** 跟随半径 / 最大鼓包 / 提示半径（px），Dock 式：指针在整条右轨里的位置决定鼓包，不要求压在 3px 的横杠上；
 * 半径内按距离线性衰减，远处不参与。半径要贴着横杠间距（9px）量，给太大整列会一起涨落，看着像整块在晃 */
const FOLLOW = 24
const GROW_MAX = 10
const NEAR = 24

/** 右轨：地标一列小横杠。onJump 由挂载方给（各视图的滚动容器不同） */
export function DocRail({ store, onJump }: { store: RailStore; onJump: (id: number) => void }) {
  const [items, setItems] = useState<RailItem[]>(store.items)
  const stackRef = useRef<HTMLDivElement>(null)
  // 横杠中心（相对轨道盒）：进轨时量一次，同一轮悬停里布局不变，移动时不读布局
  const centersRef = useRef<number[]>([])
  const nearRef = useRef(-1)
  useEffect(() => {
    setItems(store.items) // 挂载与订阅之间可能已经推过一轮
    return store.subscribe(() => setItems(store.items))
  }, [store])

  // 条目变了（发送 / 流式追加）横杠数量就变，旧中心与旧鼓包都得清掉
  useEffect(() => {
    reset()
    // 只跟着条目的数量走：标题文本流式变化时不必重来（横杠位置没动）
  }, [items.length])

  /** 量横杠中心（相对轨道盒的 padding 边）：offsetTop 不受 transform 与滚动影响 */
  function measure(): HTMLElement[] {
    const ticks = stackRef.current ? ([...stackRef.current.children] as HTMLElement[]) : []
    centersRef.current = ticks.map((el) => el.offsetTop + el.offsetHeight / 2)
    return ticks
  }

  /** 离开轨道（或横杠数量变了）时鼓包与提示一起收干净 */
  function reset() {
    const stack = stackRef.current
    if (stack) {
      for (const el of stack.children) {
        ;(el as HTMLElement).style.removeProperty('--grow')
        el.classList.remove('is-near')
      }
    }
    centersRef.current = []
    nearRef.current = -1
  }

  /** 指针 Y（相对轨道盒的 padding 边）最近的一条横杠下标，没有返回 -1 */
  function nearestAt(y: number, ticks: HTMLElement[]): number {
    let near = -1
    let best = Infinity
    for (let i = 0; i < ticks.length; i++) {
      const d = Math.abs(y - (centersRef.current[i] ?? 0))
      if (d < best) {
        best = d
        near = i
      }
    }
    return near
  }

  /** 指针在轨道里移动：按到各横杠中心的距离写鼓包量（只有标题类起飞），最近的一条出提示。
   * 只读一次布局（轨道盒顶边）并写内联变量 / 类名，不动 React state，悬停不触发重渲染 */
  function follow(e: React.PointerEvent<HTMLDivElement>) {
    const stack = stackRef.current
    if (!stack) return
    let ticks = [...stack.children] as HTMLElement[]
    if (centersRef.current.length !== ticks.length) ticks = measure()
    const y = e.clientY - stack.getBoundingClientRect().top
    const nearIdx = nearestAt(y, ticks)
    const near = nearIdx >= 0 && Math.abs(y - (centersRef.current[nearIdx] ?? 0)) <= NEAR ? nearIdx : -1
    for (let i = 0; i < ticks.length; i++) {
      const el = ticks[i]!
      const d = Math.abs(y - (centersRef.current[i] ?? 0))
      const grow = Math.max(0, 1 - d / FOLLOW) * GROW_MAX
      const next = grow < 0.3 ? '' : grow.toFixed(1) // 无单位：CSS 拿它算 scaleX
      if (el.style.getPropertyValue('--grow') !== next) {
        if (next) el.style.setProperty('--grow', next)
        else el.style.removeProperty('--grow')
      }
    }
    if (nearRef.current !== near) {
      if (nearRef.current >= 0) ticks[nearRef.current]?.classList.remove('is-near')
      if (near >= 0) ticks[near]?.classList.add('is-near')
      nearRef.current = near
    }
  }

  /** 点轨道里任意位置（横杠之间的空隙、内边距）都跳到最近的那条：横杠本身只有 3px 高，只认横杠太难点。
   * 判定与 is-near 同一套，浮出的名字就是点下去会跳的那条 */
  function clickRail(e: React.MouseEvent<HTMLDivElement>) {
    const stack = stackRef.current
    if (!stack || e.target !== e.currentTarget) return // 点在横杠上：走它自己的 onClick（键盘激活同路）
    const ticks = [...stack.children] as HTMLElement[]
    if (centersRef.current.length !== ticks.length) measure()
    const near = nearestAt(e.clientY - stack.getBoundingClientRect().top, ticks)
    const item = near >= 0 ? items[near] : undefined
    if (item) onJump(item.id)
  }

  if (items.length === 0) return null
  return (
    <nav className="doc-rail" aria-label="文档导航">
      <div
        className="doc-rail-stack"
        ref={stackRef}
        onPointerMove={follow}
        onPointerLeave={reset}
        onClick={clickRail}
      >
        {items.map((m) => (
          <button
            key={m.id}
            className={`doc-rail-tick rail-${m.kind}`}
            data-title={m.title}
            aria-label={m.title}
            onClick={() => onJump(m.id)}
          />
        ))}
      </div>
    </nav>
  )
}

/** 在 scope 里找 [data-rail=<id>]，把它滚到主滚动口 .main 的中央（两种视图共用这一个滚动口） */
export function scrollRailTarget(scope: HTMLElement | null, id: number): void {
  const target = scope?.querySelector<HTMLElement>(`[data-rail="${id}"]`)
  const root = scope?.closest<HTMLElement>('.main')
  if (!root || !target) return
  const t = target.getBoundingClientRect()
  const r = root.getBoundingClientRect()
  root.scrollTo({ top: root.scrollTop + t.top - r.top - (r.height - t.height) / 2, behavior: 'smooth' })
}

/** 当前视图的地标查找范围：聊天模式是气泡区，文档模式是整个主滚动口。
 *  聊天模式的正文编辑器是隐藏的（chat-hidden），同一份文档里也挂着 data-rail，必须按视图限定范围 */
export function railScope(chat: boolean): HTMLElement | null {
  return document.querySelector<HTMLElement>(chat ? '.chat-thread' : '.main')
}

/** 地标节点的 data-rail 装饰：节点装饰在块元素上挂属性（与 ai-block 的顶栏同机制） */
function railDecoration(doc: ProsemirrorNode): DecorationSet {
  return DecorationSet.create(
    doc,
    landmarks(doc).map((m) => Decoration.node(m.off, m.off + m.node.nodeSize, { 'data-rail': String(m.id) })),
  )
}

/** 文档模式的插件：给地标节点挂跳转锚，文档一变就把清单推给右轨（挂主编辑器，聊天模式也在跑） */
export function docRail(onChange: (items: RailItem[]) => void) {
  return $prose(() => {
    const key = new PluginKey<DecorationSet>('docRail')
    return new Plugin({
      key,
      state: {
        init: (_, state) => railDecoration(state.doc),
        apply: (_tr, _prev, _old, state) => railDecoration(state.doc),
      },
      props: { decorations: (state) => key.getState(state) ?? DecorationSet.empty },
      view: (view) => {
        onChange(railItems(view.state.doc))
        return {
          update: (v) => onChange(railItems(v.state.doc)),
        }
      },
    })
  })
}
