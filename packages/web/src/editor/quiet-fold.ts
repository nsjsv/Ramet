/* ---------- 「不用处理」折叠：Genet 标了 quiet 的回复 + 它前面紧挨着的通知 → 一行灰字 ----------
 * Genet 看了一条事件通知、判断不用管时调 mark_handled（server routes/mark-handled.ts），这一轮的回复块带上 quiet = 理由。
 * 这条回复连同它前面紧挨着的通知块（带 notice 的 user_message，一轮可能一起看了几条）折成一行：
 * 「看了 bob 在《周报》的评论：只是确认，不用处理」，点开两者照原样显示，再点收起。对话视图与文档模式各挂一份（同一套判定与 DOM），
 * 展开过的按回复块 id 记在调用方给的 Set 里：文档一变装饰就重算，不记的话每来一个字就收回去。
 * 只折收好尾的回复（stats 是 o:end）：还在跑的要看得到过程，失败 / 停止的要露出失败条与重试。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { decodeStats } from '@ramet/shared/reply-stats'
import { COPY } from '../copy'
import { iconSvg } from '../icons'

const Q = COPY.assistant.quiet

const quietKey = new PluginKey('quietFold')

/** 一个顶层块在判定里要看的东西（纯数据，单测用） */
export type FoldBlock = {
  name: string
  id: string
  /** user_message 的 notice（任务 done / failed、定时 timer、事件 event）；不是通知为空 */
  notice: string
  /** agent_reply 的 quiet */
  quiet: string
  /** agent_reply 的 stats.o */
  outcome: string
  /** 第一段的文字（通知的抬头） */
  headline: string
}

/** 一组折叠：start..end 是块序号（end = 回复块），line = 那一行灰字 */
export type QuietGroup = { id: string; start: number; end: number; line: string }

/** 名字与后面的说明之间的分隔（server triggers/notice.ts 的抬头：「规则「名」· …」「定时「名」· …」） */
const NAME_END = '」· '

/** 通知的来由：事件 = 抬头「规则「名」· bob 在《周报》的评论」的后半句；定时 = 「定时「名」」；任务通知的抬头里是页面提及，取不到字 */
export function causeOf(b: FoldBlock): string {
  const at = b.headline.indexOf(NAME_END)
  if (b.notice === 'event') return at >= 0 ? b.headline.slice(at + NAME_END.length).trim() : b.headline.trim()
  if (b.notice === 'timer') return at >= 0 ? b.headline.slice(0, at + 1).trim() : b.headline.trim()
  return Q.task
}

export function quietGroups(blocks: readonly FoldBlock[]): QuietGroup[] {
  const out: QuietGroup[] = []
  blocks.forEach((b, i) => {
    if (b.name !== 'agent_reply' || !b.quiet || b.outcome !== 'end' || !b.id) return
    let start = i
    while (start > 0) {
      const prev = blocks[start - 1]!
      if (prev.name !== 'user_message' || !prev.notice) break
      start--
    }
    const notices = blocks.slice(start, i)
    const reason = b.quiet.trim()
    const line = notices.length === 0 ? Q.alone(reason) : notices.length === 1 ? Q.line(causeOf(notices[0]!), reason) : Q.many(notices.length, reason)
    out.push({ id: b.id, start, end: i, line })
  })
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function blockOf(node: PMNode): FoldBlock {
  return {
    name: node.type.name,
    id: str(node.attrs.id),
    notice: node.type.name === 'user_message' ? str(node.attrs.notice) : '',
    quiet: node.type.name === 'agent_reply' ? str(node.attrs.quiet) : '',
    outcome: node.type.name === 'agent_reply' ? (decodeStats(node.attrs.stats).o ?? '') : '',
    headline: node.firstChild?.textContent ?? '',
  }
}

function buildLine(group: QuietGroup, open: boolean, mode: 'chat' | 'doc', toggle: (view: EditorView) => void): (view: EditorView) => HTMLElement {
  return (view) => {
    const dom = document.createElement('div')
    dom.className = (mode === 'chat' ? 'chat-msg chat-quiet ' : '') + 'quiet-fold' + (open ? ' is-open' : '')
    dom.contentEditable = 'false'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'quiet-line'
    btn.setAttribute('aria-expanded', String(open))
    const icon = document.createElement('span')
    icon.className = 'quiet-ic'
    icon.innerHTML = iconSvg('check', 12)
    const text = document.createElement('span')
    text.className = 'quiet-text'
    text.textContent = group.line
    const more = document.createElement('span')
    more.className = 'quiet-more'
    more.textContent = open ? Q.hide : Q.show
    btn.append(icon, text, more)
    // 文档模式里别让编辑器拿这次按下去挪光标
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', () => toggle(view))
    dom.append(btn)
    return dom
  }
}

/**
 * 折叠的装饰：每组一行（挂在组里第一块前面），收起时组里的块都 display:none。hidden = 收起的块的起点（对话视图据此不画气泡）。
 * live：对话视图里这条回复还归实时视图管（收尾动画没飞完）就先不折，飞完重算时再折。
 */
export function quietDecorations(
  doc: PMNode,
  expanded: Set<string>,
  mode: 'chat' | 'doc',
  live?: (node: PMNode) => boolean,
): { decos: Decoration[]; hidden: Set<number> } {
  const decos: Decoration[] = []
  const hidden = new Set<number>()
  const nodes: Array<{ node: PMNode; off: number }> = []
  doc.forEach((node, off) => nodes.push({ node, off }))
  // 没有 quiet 的回复就不必逐块读抬头（绝大多数页面）
  if (!nodes.some((n) => n.node.type.name === 'agent_reply' && n.node.attrs.quiet)) return { decos, hidden }
  const toggle = (id: string) => (view: EditorView) => {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(quietKey, true).setMeta('addToHistory', false))
  }
  for (const g of quietGroups(nodes.map((n) => blockOf(n.node)))) {
    const reply = nodes[g.end]!
    if (live?.(reply.node)) continue
    const open = expanded.has(g.id)
    const first = nodes[g.start]!
    decos.push(
      Decoration.widget(first.off, buildLine(g, open, mode, toggle(g.id)), {
        side: -1,
        key: `quiet:${g.id}:${open ? 1 : 0}:${g.line}`,
        stopEvent: () => true,
        ignoreSelection: true,
      }),
    )
    if (open) continue
    for (let i = g.start; i <= g.end; i++) {
      const n = nodes[i]!
      hidden.add(n.off)
      decos.push(Decoration.node(n.off, n.off + n.node.nodeSize, { style: 'display:none' }))
    }
  }
  return { decos, hidden }
}


/** 文档模式：一个编辑器一份展开记录（对话视图的在 chat-view.tsx 里，与通知卡的展开记录放一起） */
export const quietFoldView = $prose(() => {
  const expanded = new Set<string>()
  return new Plugin({
    key: quietKey,
    props: {
      decorations: (state) => {
        const { decos } = quietDecorations(state.doc, expanded, 'doc')
        return decos.length > 0 ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
      },
    },
  })
})
