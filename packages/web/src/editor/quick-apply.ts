// ---------- 随手 AI：选区 → markdown，结果 markdown → 一次编辑事务 ----------
// 纯函数，序列化 / 解析由调用方传进来，所以能用最小 schema 单测。收下是一个事务（一次 ⌘Z 回到原样）。落点规则：
//   - 代码块里：当纯文本换（去掉模型多包的一层围栏）；
//   - 选区 / 插入点在同一个文本块里、结果是单个段落：只换行内内容，所在块（类型 / id / 列表项）不动；
//   - 选区盖住整个文本块（或整段同级文本块）、结果是块：整块换掉，旧块 id 经 carryBlockIds 带给新块（见 block-carry.ts）；
//   - 其余的块结果：插在所在文本块之后（光标在空块里就换掉这个空块）；选了一半的块被换成块，与粘贴走同一个 PM 拟合。
// 返回 null = 放不进去。块 id 不在这里发，由补 id 插件统一处理。

import type { Fragment, Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { carryBlockIds } from './block-carry'

/** 选区的 markdown（发给模型的原文）：同一文本块里的选区包成段落序列化，保住粗体 / 链接 / 行内码；跨块按块序列化；
 *  序列化不了就退回纯文字，代码块里直接是纯文字 */
export function selectionMarkdown(state: EditorState, from: number, to: number, serialize: (doc: PMNode) => string): string {
  const { doc, schema } = state
  const $from = doc.resolve(from)
  const plain = (): string => doc.textBetween(from, to, '\n\n')
  if ($from.parent.type.spec.code) return plain()
  try {
    if ($from.sameParent(doc.resolve(to)) && $from.parent.isTextblock) {
      const para = schema.nodes.paragraph!.create(null, doc.slice(from, to).content)
      return serialize(schema.topNodeType.create(null, para)).trim() || plain()
    }
    const whole = schema.topNodeType.createAndFill(null, doc.slice(from, to).content)
    return (whole ? serialize(whole).trim() : '') || plain()
  } catch {
    return plain()
  }
}

/** 光标前 / 后的纯文字上下文（给模型接得上）。块之间用换行，行内原子记一个空格 */
export function textBefore(state: EditorState, pos: number, max: number): string {
  return state.doc.textBetween(Math.max(0, pos - max * 2), pos, '\n', ' ').slice(-max)
}
export function textAfter(state: EditorState, pos: number, max: number): string {
  return state.doc.textBetween(pos, Math.min(state.doc.content.size, pos + max * 2), '\n', ' ').slice(0, max)
}

/** 代码块里收下：去掉模型多包的一层围栏（``` 语言 … ```） */
export function stripFence(text: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim())
  return m ? (m[1] ?? '') : text
}

export interface ApplyArgs {
  from: number
  to: number
  /** true = 换掉 [from, to]；false = 只在 from 处插入（from === to） */
  replace: boolean
  /** 模型输出的原文（代码块里用它） */
  markdown: string
  /** 解析 + 顶层列表归一后的块（调用方做，见 quick-ai.ts） */
  blocks: Fragment
}

/** 光标落在刚放进去的内容之后 */
function endOf(tr: Transaction, rangeEnd: number): Transaction {
  const end = tr.mapping.map(rangeEnd, 1)
  return tr.setSelection(TextSelection.near(tr.doc.resolve(end), -1))
}

export function applyQuickResult(state: EditorState, args: ApplyArgs): Transaction | null {
  const { from, to, replace, blocks } = args
  const { doc } = state
  if (from < 0 || to > doc.content.size || from > to) return null
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  const tr = state.tr
  const sameBlock = $from.sameParent($to) && $from.parent.isTextblock

  try {
    if (sameBlock && $from.parent.type.spec.code) {
      const text = stripFence(args.markdown)
      if (!text) return null
      tr.insertText(text, from, to)
      return endOf(tr, to)
    }
    if (blocks.childCount === 0) return null

    const single = blocks.childCount === 1 ? blocks.firstChild : null
    if (sameBlock && single && single.type.name === 'paragraph') {
      if (single.content.size === 0) return null
      tr.replaceWith(from, to, single.content)
      return endOf(tr, to)
    }

    if (replace && from < to) {
      // 选区盖住整个文本块 / 同级的一串文本块：整块换，旧块 id 带给新块
      const covers =
        $from.parent.isTextblock &&
        $to.parent.isTextblock &&
        $from.parentOffset === 0 &&
        $to.parentOffset === $to.parent.content.size &&
        $from.depth === $to.depth &&
        $from.node($from.depth - 1) === $to.node($to.depth - 1)
      if (covers) {
        const start = $from.before()
        const end = $to.after()
        const old = doc.slice(start, end).content
        tr.replaceWith(start, end, carryBlockIds(old, blocks, { forceFirst: old.childCount === 1 }))
        return endOf(tr, end)
      }
      // 选了一半：与粘贴走同一个 PM 拟合
      tr.replaceWith(from, to, blocks)
      return tr.docChanged ? endOf(tr, to) : null
    }
    // 插入：光标在空文本块里就换掉这个空块，否则插在所在文本块之后
    if ($from.parent.isTextblock && $from.depth > 0) {
      if ($from.parent.content.size === 0) {
        tr.replaceWith($from.before(), $from.after(), blocks)
        return tr.docChanged ? endOf(tr, $from.after()) : null
      }
      tr.insert($from.after(), blocks)
      return tr.docChanged ? endOf(tr, $from.after()) : null
    }
    tr.replaceWith(from, to, blocks)
    return tr.docChanged ? endOf(tr, to) : null
  } catch {
    return null
  }
}

/** 预览落点：块结果挂在所在文本块之后（和收下时的落点一致）；不在文本块里就是原位 */
export function blockPreviewAt(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(pos)
  return $pos.parent.isTextblock && $pos.depth > 0 ? $pos.after() : pos
}
