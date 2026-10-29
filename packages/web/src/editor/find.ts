// 页内查找 / 替换（Ctrl+F / Ctrl+H）：模块级单源 store（开关 / 查询词 / 命中清单）+ 订阅者，decoration 插件读 store。
// 命中 = 逐文本块（textblock）拼接其全部 text 节点后子串搜索，跨 mark（粗体内换行等）可命中，跨块不命中。
// 当前命中 = PM 选区（Enter 跳转即 setSelection），不另建「当前项」decoration。UI（FindBar.tsx）只调这里导出的 action。
// viewer 只读可查找，替换动作经 view.editable 守卫静默无效。
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'

export interface FindMatch {
  from: number
  to: number
}

interface FindStore {
  /** 关闭 = 不查不渲染；replaceOpen = 显示替换行（Ctrl+H） */
  open: boolean
  replaceOpen: boolean
  query: string
  replacement: string
  caseSensitive: boolean
  matches: FindMatch[]
  /** 当前命中下标（-1 = 无） */
  index: number
  /** 每次变更 +1：React useSyncExternalStore 的快照（store 就地变更，不换对象身份） */
  version: number
}

const listeners = new Set<() => void>()
const views = new Set<EditorView>()

export const findStore: FindStore = {
  open: false,
  replaceOpen: false,
  query: '',
  replacement: '',
  caseSensitive: false,
  matches: [],
  index: -1,
  version: 0,
}

function notify(): void {
  findStore.version += 1
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 踢所有挂载视图重算 decoration（开关一翻、各视图派一笔事务） */
function kickViews(): void {
  for (const view of views) {
    if (view.isDestroyed) continue
    view.dispatch(view.state.tr.setMeta(findKey, { recalc: true }))
  }
}

function patch(p: Partial<FindStore>): void {
  let changed = false
  const set = <K extends keyof FindStore>(k: K, v: FindStore[K]): void => {
    if (findStore[k] !== v) {
      findStore[k] = v
      changed = true
    }
  }
  if (p.open !== undefined) set('open', p.open)
  if (p.replaceOpen !== undefined) set('replaceOpen', p.replaceOpen)
  if (p.query !== undefined) set('query', p.query)
  if (p.replacement !== undefined) set('replacement', p.replacement)
  if (p.caseSensitive !== undefined) set('caseSensitive', p.caseSensitive)
  if (p.matches !== undefined) set('matches', p.matches)
  if (p.index !== undefined) set('index', p.index)
  if (changed) notify()
}

/** 单个文本块内的命中：拼块内全部 text 节点（记下每段在串里的起点 = PM pos），子串搜索后映射回 doc 位置 */
function matchesInTextblock(node: PMNode, pos: number, query: string, ci: boolean, out: FindMatch[]): void {
  const parts: Array<{ text: string; start: number }> = []
  node.forEach((child, offset) => {
    if (child.isText && child.text) parts.push({ text: child.text, start: pos + offset + 1 })
  })
  const whole = parts.map((p) => p.text).join('')
  if (!whole) return
  const hay = ci ? whole.toLowerCase() : whole
  const needle = ci ? query.toLowerCase() : query
  let i = hay.indexOf(needle)
  // 串索引 → doc pos：命中可能跨 text 节点，逐段定位（命中起点落在哪段就 + 该段剩余长度）
  const posAt = (idx: number): number => {
    for (const p of parts) {
      if (idx < p.text.length) return p.start + idx
      idx -= p.text.length
    }
    return pos
  }
  while (i !== -1) {
    out.push({ from: posAt(i), to: posAt(i + needle.length) })
    i = hay.indexOf(needle, i + Math.max(1, needle.length))
  }
}

export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): FindMatch[] {
  const q = query.trim()
  if (!q) return []
  const out: FindMatch[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock && !node.isLeaf) matchesInTextblock(node, pos, q, !caseSensitive, out)
    // code_block 内也找，textblock 判定已覆盖
    return true
  })
  return out
}

export function openFind(replaceMode: boolean): void {
  patch({ open: true, replaceOpen: replaceMode || findStore.replaceOpen })
  kickViews()
}

export function closeFind(): void {
  patch({ open: false, replaceOpen: false, query: '', replacement: '', matches: [], index: -1 })
  kickViews()
  for (const view of views) {
    if (!view.isDestroyed) view.focus()
  }
}

export function setFindQuery(query: string): void {
  patch({ query })
  kickViews()
}

export function setFindReplacement(replacement: string): void {
  patch({ replacement })
}

export function setFindCase(caseSensitive: boolean): void {
  patch({ caseSensitive })
  kickViews()
}

/** 选中第 index 个命中（滚动可见；不 focus，焦点留在浮条里，Enter 可连续跳） */
function selectMatch(view: EditorView, m: FindMatch): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView())
}

export function findNext(dir: 1 | -1): void {
  const { matches, index } = findStore
  if (matches.length === 0) return
  // 无有效当前项（刚打开/文档变了）时：从各视图当前选区找最近的命中
  let next: number
  if (index >= 0 && index < matches.length) next = (index + dir + matches.length) % matches.length
  else {
    const view = [...views][0]
    const head = view?.state.selection.head ?? 0
    if (dir === 1) {
      next = matches.findIndex((m) => m.from >= head)
      if (next === -1) next = 0
    } else {
      next = matches.length - 1
      for (let i = 0; i < matches.length; i++) {
        if (matches[i]!.to <= head) next = i
      }
    }
  }
  patch({ index: next })
  kickViews() // 重画 decoration（当前命中加深不依赖 PM 选区）
  const view = [...views][0]
  if (view && !view.isDestroyed) selectMatch(view, findStore.matches[next]!)
}

export function replaceCurrent(): void {
  const view = [...views][0]
  const m = findStore.index >= 0 ? findStore.matches[findStore.index] : undefined
  if (!view || view.isDestroyed || !m || !view.editable) return
  view.dispatch(view.state.tr.replaceWith(m.from, m.to, view.state.schema.text(findStore.replacement)))
  // 命中清单由 doc change 的 update 路径重算；这里直接跳下一处（重算在微任务后，取最新）
  queueMicrotask(() => {
    if (findStore.open && findStore.matches.length > 0) findNext(1)
  })
}

export function replaceAll(): void {
  const view = [...views][0]
  const { matches, replacement } = findStore
  if (!view || view.isDestroyed || matches.length === 0 || !view.editable) return
  const tr = view.state.tr
  // 倒序替换：后面的位置改动不影响前面的
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!
    tr.replaceWith(m.from, m.to, view.state.schema.text(replacement))
  }
  view.dispatch(tr.scrollIntoView())
}

/** 键盘入口：Mod+F / Mod+H / Esc（FindBar 挂 window capture；IME 组合中放行） */
export function findKeyHandler(e: KeyboardEvent): boolean {
  if (e.isComposing) return false
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    openFind(false)
    return true
  }
  if (mod && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault()
    openFind(true)
    return true
  }
  if (e.key === 'Escape' && findStore.open) {
    e.preventDefault()
    closeFind()
    return true
  }
  return false
}

/** React 订阅入口 */
export function subscribeFind(l: () => void): () => void {
  return subscribe(l)
}

export const findKey = new PluginKey<DecorationSet>('RAMET_FIND')

export const findPlugin = $prose(() => {
  return new Plugin<DecorationSet>({
    key: findKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const meta = tr.getMeta(findKey) as { recalc?: boolean } | undefined
        if (!findStore.open || !findStore.query.trim()) return DecorationSet.empty
        if (meta?.recalc || tr.docChanged) {
          const matches = findMatches(tr.doc, findStore.query, findStore.caseSensitive)
          findStore.matches = matches
          // 文档变了：当前项下标按位置就近回收（简单起见 clamp，跳转时再就近取）
          if (findStore.index >= matches.length) findStore.index = matches.length - 1
          notify()
          const decos = matches.map((m, i) =>
            Decoration.inline(m.from, m.to, { class: 'find-hit' + (i === findStore.index ? ' current' : '') }),
          )
          return DecorationSet.create(tr.doc, decos)
        }
        return old.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations(state) {
        return findKey.getState(state)
      },
    },
    view: (view) => {
      views.add(view)
      return {
        update: (v, prevState) => {
          // 用户打字等非 recalc 的 doc 变化：store 里的清单是插件 apply 顺带更新的（docChanged 分支），
          // 无需再踢。
          void v
          void prevState
        },
        destroy: () => {
          views.delete(view)
        },
      }
    },
  })
})

/** 换页清理：关面板不写回（查找状态是纯视图态） */
export function resetFind(): void {
  if (findStore.open) closeFind()
}
