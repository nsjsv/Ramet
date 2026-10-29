/* ---------- 一次性触发会话：`/` 斜杠菜单、`@` / `[[` 引用菜单 ----------
 * 菜单显隐不能无状态地看光标前像不像一段查询：光标挪回旧的 `/`、`@` 后面菜单会又冒出来；
 * 中文没有空格，`@` 后面接着写正文，查询词一直不终止，菜单（连同「没有匹配」）会一直挂着。
 * 所以做成会话：只有刚打出触发符的那一下开启，之后打字是筛选；会话一结束不再复活。
 *   结束：光标离开触发符所在的那段查询 / 触发符被删 / 失焦 / Esc / 选中一项 / 没有候选（后三者由宿主调 end）。
 *   不开启：协同端写入、撤销重做（y-sync 事务）、粘贴 / 拖放进来的触发符、只是把光标挪到触发符后面。
 * 查询怎么解析（触发符规则、查询词字符集）归各自的 parser（mention-query.ts 的 mentionQuery、本文件的 slashQuery），
 * 这里只管会话。PM 宿主（文档 `/`、文档 `@`）用 sessionField；textarea 宿主（对话输入框 `@`）直接用 advance。 */

import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { ResolvedPos } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ySyncPluginKey } from 'y-prosemirror'

/** 一个解析结果：触发符、它在文本里的下标、触发符与光标之间的查询词 */
export type Parsed = { trigger: string; start: number; query: string }
export type Parser = (text: string, cursor: number) => Parsed | null

/** 会话：触发符 + 它在宿主坐标里的起点（PM = 文档位置，textarea = 字符下标） */
export type Session = { trigger: string; at: number }

/** 会话推进（纯函数）。parsed 是当下光标处的解析（`at` 已换成宿主坐标），startedNow 表示这次变化刚打出了触发符。
 *  刚打出且查询为空开新会话；已有会话且解析出的还是同一个触发符起点就延续；其余结束（null） */
export function advance(prev: Session | null, parsed: (Parsed & { at: number }) | null, startedNow: boolean): Session | null {
  if (!parsed) return null
  if (startedNow && parsed.query === '') return prev && prev.trigger === parsed.trigger && prev.at === parsed.at ? prev : { trigger: parsed.trigger, at: parsed.at }
  return prev && prev.trigger === parsed.trigger && prev.at === parsed.at ? prev : null
}

/** `/` 的查询：光标前最后一个 `/` 到光标之间不含空白与 `/`（与 SlashProvider 一样，不要求 `/` 前是空白） */
export function slashQuery(text: string, cursor: number): Parsed | null {
  const m = /\/([^\s/]*)$/.exec(text.slice(0, cursor))
  return m ? { trigger: '/', start: m.index, query: m[1] ?? '' } : null
}

/** 新文档里 pos 处的那一个字符是不是这个事务插进来的（逐个 step 的插入区间映射到最终文档里比对） */
export function insertedAt(tr: Transaction, pos: number): boolean {
  const maps = tr.mapping.maps
  for (let i = 0; i < maps.length; i++) {
    let hit = false
    const rest = tr.mapping.slice(i + 1)
    maps[i]!.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (hit || newEnd <= newStart) return
      if (rest.map(newStart, 1) <= pos && pos + 1 <= rest.map(newEnd, -1)) hit = true
    })
    if (hit) return true
  }
  return false
}

/** 这个事务能不能打出触发符：本地输入才算（协同 / 撤销重做走 y-sync，粘贴 / 拖放带 uiEvent） */
function typedLocally(tr: Transaction): boolean {
  if (!tr.docChanged) return false
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined
  if (sync?.isChangeOrigin) return false
  const ui: unknown = tr.getMeta('uiEvent')
  return ui !== 'paste' && ui !== 'drop'
}

/** PM 宿主里光标处的解析：光标所在文本块里、光标前的文字（原子占一个 ￼，下标与位置一一对应）。
 *  where 决定哪些文本块里才算（slash 只在段落里，引用菜单在任意非代码文本块） */
export function parseAt(state: EditorState, parse: Parser, where: ($from: ResolvedPos) => boolean): (Parsed & { at: number }) | null {
  const { empty, $from } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || !where($from)) return null
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const p = parse(text, text.length)
  return p ? { ...p, at: $from.start() + p.start } : null
}

/** 宿主手动结束会话（Esc / 选中 / 没有候选 / 失焦）用的 meta 值 */
export const END_SESSION = 'end'

/** PM 插件 state 字段：挂到宿主插件的 `state` 上。meta === END_SESSION 结束；其余按 advance 推进 */
export function sessionField(meta: (tr: Transaction) => unknown, parse: Parser, where: ($from: ResolvedPos) => boolean) {
  return {
    init: (): Session | null => null,
    apply(tr: Transaction, prev: Session | null, _old: EditorState, state: EditorState): Session | null {
      if (meta(tr) === END_SESSION) return null
      const mapped = prev ? { trigger: prev.trigger, at: tr.mapping.map(prev.at) } : null
      if (!tr.docChanged && !tr.selectionSet) return mapped && mapped.at === prev?.at ? prev : mapped
      const parsed = parseAt(state, parse, where)
      const startedNow = parsed !== null && parsed.query === '' && typedLocally(tr) && insertedAt(tr, state.selection.from - 1)
      return advance(mapped && mapped.at === prev?.at ? prev : mapped, parsed, startedNow)
    },
  }
}

/** 在下一个微任务里结束会话（宿主常在 view.update 里发现没有候选，那时不能同步 dispatch） */
export function endSessionSoon(view: EditorView, setMeta: (tr: Transaction) => Transaction, alive: () => boolean): void {
  queueMicrotask(() => {
    if (view.isDestroyed || !alive()) return
    view.dispatch(setMeta(view.state.tr))
  })
}
