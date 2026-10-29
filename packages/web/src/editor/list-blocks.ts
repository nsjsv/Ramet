// 列表条目拆独立块。不变量：顶层（doc 直接子代）bullet_list / ordered_list 恰含 1 个 list_item；嵌套 list 不动。
// 三层实现：
//  1. Enter 拆块（listEnterKeymap）：顶层非空条目回车 = 单事务「拆条目 + 拆列表」，光标落新条目；
//     空条目 / 嵌套条目返回 false 放行 milkdown 原链路（lift → 转正文 / splitListItem）。
//     $prose 插件排在 milkdown 合并 keymap 之前，天然抢在 listItemKeymap 前。
//  2. 粘贴拆块：configPaste（markdown.ts）在 replaceWith 前过 normalizeTopLevelLists。
//  3. listNormalize：appendTransaction 兜底（老文档首灌、旧端写入、Mod-Alt-8 多块包裹、快照恢复），
//     守卫 isUndoRedoOperation（undo 回放的多条目老数据必须原样保留）+ view.editable（同 block-id.ts 的 ensureBlockIds）。
//     拆分 / 续号幂等，第二轮返回 null 可终止。
// 有序编号：每块 order attr = 所在「相邻连续 ordered_list 段」内序号（1 起），toDOM 输出 <ol start=N>。

import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { canSplit } from '@milkdown/kit/prose/transform'
import { $prose } from '@milkdown/kit/utils'
import { ySyncPluginKey } from 'y-prosemirror'

function isList(node: PMNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list'
}

/** 把一个顶层多条目 list 拆成 N 个单条目兄弟块：attrs 全复制（spread/order 等）。拆出块同 id 由补 id
 * 插件按「身份跟着内容走」去重（block-id.ts 的不变量），这里不碰 id。 */
function splitListNode(list: PMNode): PMNode[] {
  const pieces: PMNode[] = []
  list.forEach((item) => {
    pieces.push(list.type.create({ ...list.attrs }, item))
  })
  return pieces
}

/** 纯函数：扫顶层子节点，childCount>1 的 list 拆成相邻单条目兄弟块。无事可做时原样返回 doc.content。
 * 粘贴路径（configPaste）与归一化器共用同一套 splitListNode 拆分逻辑。 */
export function normalizeTopLevelLists(doc: PMNode): Fragment {
  const out: PMNode[] = []
  let changed = false
  doc.forEach((child) => {
    const pieces = isList(child) && child.childCount > 1 ? splitListNode(child) : null
    if (pieces) {
      out.push(...pieces)
      changed = true
    } else {
      out.push(child)
    }
  })
  return changed ? Fragment.fromArray(out) : doc.content
}

/** 遍历顶层，把每段「相邻连续 ordered_list」的 order 重排为段内序号（1 起）；非 ordered_list 块打断后下一段从 1。
 * 值相同不写（幂等零事务）。把差异写进调用方给的 tr，返回是否有改动。 */
export function renumberOrderedRuns(doc: PMNode, tr: Transaction): boolean {
  let changed = false
  let expected = 0 // 0 = 不在连续段内；进入 ordered_list 即 +1
  doc.forEach((node, offset) => {
    if (node.type.name === 'ordered_list') {
      expected += 1
      const order: unknown = node.attrs.order
      if (order !== expected) {
        tr.setNodeMarkup(offset, undefined, { ...node.attrs, order: expected })
        changed = true
      }
    } else {
      expected = 0
    }
  })
  return changed
}

/** 顶层非空条目内回车：单事务先按 splitListItem 方式拆条目（tr.split depth=2），再在条目边界
 * 把父 list 拆成两个相邻兄弟 list（tr.split depth=1，typesAfter 带新 attrs）。拆条目后边界恰在
 * $from.pos+2（split 在该位插入 [文本块闭合][条目闭合][条目开启][文本块开启] 四个 token，
 * 由 prosemirror-transform 的 split 源码推得）。第二个 list 的 order = 第一个 +1（重算 pass 兜底）。
 * 嵌套条目（depth≥4）与空条目末尾一律返回 false，保持 milkdown 现状行为。 */
function splitTopListItem(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return false
  const { $from, $to } = selection
  // 深度校准：doc(0) > list(1) > list_item(2) > 文本块(3)。光标在嵌套 list/blockquote 内时 depth ≥ 4 → 不拦
  if ($from.depth !== 3 || !$from.sameParent($to)) return false
  const item = $from.node(2)
  const list = $from.node(1)
  const listItem = state.schema.nodes.list_item
  if (!listItem || item.type !== listItem) return false
  if (!isList(list)) return false
  // 空条目末尾 Enter：放行 milkdown 原链路（lift→转正文）。条件同 splitListItem：
  // 光标所在文本块为空，且它是条目最后一个子块
  if ($from.parent.content.size === 0 && item.childCount === $from.indexAfter(2)) return false

  // 光标在文本块末尾时，新条目首块重置为条目内容的默认类型（同 splitListItem 的 types 语义）
  const nextTextblock = $to.pos === $from.end() ? item.contentMatchAt(0).defaultType : null
  const types = nextTextblock ? [null, { type: nextTextblock }] : undefined
  try {
    const tr = state.tr.delete($from.pos, $to.pos)
    if (!canSplit(tr.doc, $from.pos, 2, types)) return false
    tr.split($from.pos, 2, types)
    const boundary = $from.pos + 2 // 拆条目后的条目边界（list 内部位置）
    // 两段同 id（list 与条目都是 split 抄过去的）交给补 id 插件去重：开头回车时带内容的后半段保留身份
    const list2Attrs: Record<string, unknown> = { ...list.attrs }
    if (list.type.name === 'ordered_list') {
      const order: unknown = list.attrs.order
      list2Attrs.order = (typeof order === 'number' && Number.isFinite(order) ? order : 1) + 1
    }
    const list2Types = [{ type: list.type, attrs: list2Attrs }]
    if (!canSplit(tr.doc, boundary, 1, list2Types)) return false
    tr.split(boundary, 1, list2Types)
    if (dispatch) {
      // 选区落新条目首段：boundary+3 = list2 开口 + item 开口之后，near 向前吸附到文本位
      tr.setSelection(TextSelection.near(tr.doc.resolve(boundary + 3), 1))
      dispatch(tr.scrollIntoView())
    }
    return true
  } catch {
    // 任何步骤异常都不 dispatch（tr 丢弃），返回 false 落回 milkdown splitListItem，形态由归一化器兜底
    return false
  }
}

// 跨 list 块边界的 Delete（与 Enter 对称）。顶层单条目 list 不变量下，PM 默认 joinForward 会把相邻两个
// 单条目 list join 成一个多条目 list，listNormalize 立刻按不变量拆回，Delete 就产出垃圾空条目。
// 这里只在「跨顶层 list 块边界」的合并场景拦截，其余 return false 放行默认。事务 = 一条 tr.delete 跨过
// 两块之间的全部开合 token：左右文本块经 delete 的 fit 逻辑并成一段。单事务 = 单个撤销步；续号由 listNormalize 兜底。
// 退格方向不在这里：块首第一次退格先去样式（列表项变正文），第二次把字并进前一块最后一行，都在 block-backspace.ts。

/** 光标在顶层条目末个文本块行尾，且后一个顶层块是 list → 把下一块并进来。
 * 段落后接段落等非 list 场景默认 joinForward 正常，不拦。 */
function mergeListItemForward(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection)) return false
  const { $from, $to } = selection
  if (!$from.sameParent($to) || $to.pos !== $from.end()) return false
  if ($from.depth !== 3 || $from.indexAfter(2) !== $from.node(2).childCount) return false
  const list = $from.node(1)
  if (!isList(list) || $from.node(2).type !== state.schema.nodes.list_item) return false
  const listStart = $from.before(1)
  const listEnd = listStart + list.nodeSize
  if (listEnd >= state.doc.content.size) return false // 文档最后一个块
  const next = state.doc.childAfter(listEnd)
  if (!next.node || !isList(next.node)) return false
  // 下条目（首个 list_item）的首子块必须是文本块；此时其内容起点 = listEnd + 3（list 开启+条目开启+文本块开启）
  const nextItem = next.node.firstChild
  const nextText = nextItem?.firstChild
  if (!nextItem || !nextText || !nextText.type.isTextblock) return false
  const nextTextStart = listEnd + 3
  if (dispatch) {
    const tr = state.tr.delete($to.pos, nextTextStart)
    dispatch(tr.scrollIntoView())
  }
  return true
}

export const listEnterKeymap = $prose(() =>
  keymap({ Enter: splitTopListItem, Delete: mergeListItemForward }),
)

export const listNormalize = $prose(() => {
  let editable = true
  return new Plugin({
    key: new PluginKey('MILKDOWN_LIST_NORMALIZE'),
    appendTransaction: (trs, _old, newState) => {
      if (!editable) return null
      if (!trs.some((tr) => tr.docChanged)) return null
      // undo/redo 回放的事务不拆：撤销恢复出的多条目列表（老数据）必须原样保留
      if (trs.some((tr) => tr.getMeta(ySyncPluginKey)?.isUndoRedoOperation)) return null
      const tr = newState.tr
      let changed = false
      // 拆分：先收集再倒序 replaceWith，后面的替换不影响前面列表的顶层 offset
      const targets: Array<{ offset: number; node: PMNode }> = []
      newState.doc.forEach((node, offset) => {
        if (isList(node) && node.childCount > 1) targets.push({ offset, node })
      })
      for (let i = targets.length - 1; i >= 0; i--) {
        const { offset, node } = targets[i]!
        tr.replaceWith(offset, offset + node.nodeSize, splitListNode(node))
        changed = true
      }
      // 续号作用于拆分后的 tr.doc；无改动时不写（幂等，第二轮 appendTransaction 返回 null 终止）
      if (renumberOrderedRuns(tr.doc, tr)) changed = true
      if (!changed) return null
      // Yjs→PM 方向事务（首灌/远程）触发的整理不得入撤销栈：appended tr 不带 addToHistory meta 时，
      // ySyncPlugin 的 state apply 会对它无条件刷回 true（sync-plugin.js：`pluginState.addToHistory =
      // tr.getMeta('addToHistory') !== false` 逐 tr 执行，applyTransaction 对 appended tr 同样调用），
      // 回写即被 UndoManager 捕获。补回 rootTr 的 meta，保住「首灌/远程整理不入撤销栈」。
      if (trs.some((t) => t.getMeta(ySyncPluginKey)?.isChangeOrigin)) tr.setMeta('addToHistory', false)
      return tr
    },
    view: (view) => {
      editable = view.editable
      return {
        update: (v) => {
          editable = v.editable
        },
      }
    },
  })
})
