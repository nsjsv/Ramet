/* ---------- 文档模式的抬头行操作（块操作放在块自己的抬头行，悬停 / 聚焦出现） ----------
 * AI 回复：复制 · 引用 · 收藏 · 重新生成 · 删除（挂在用量标签左边，ai-block.ts 的 replyChipView）；
 * 已发出的用户消息：复制 · 引用 · 收藏 · 删除（署名行末尾，message-chips.tsx）。草稿 / 正在跑的回复不出。
 * 按钮与对话气泡同一份（chat-acts.ts 的 buildActs），动作也走同一条写路径，不同处只有两点：
 *   - 引用进文档末尾正在写的消息（doc-send.ts 的 quoteWithFly，带飞行），不是对话输入框；
 *   - 删除淡出的是块本身（按钮所在的顶层块）。
 * 抬头 widget 不随正文改动重建，所以动作执行时按块 id 现查节点（复制拿到的是当前内容）。 */
import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { findBlockIdPos } from './block-id'
import { bubbleActsFor, buildActs, type BubbleActs } from './chat-acts'
import { quoteWithFly } from './doc-send'

/** 引用进草稿的文字上限，同选区菜单的 QUOTE_MAX */
const QUOTE_MAX = 160

function docActsFor(pageId: string, getEditor: () => Editor | undefined): BubbleActs {
  const base = bubbleActsFor(pageId, getEditor)
  const mainView = (): EditorView | undefined => {
    let view: EditorView | undefined
    getEditor()?.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view && !view.isDestroyed ? view : undefined
  }
  /** 按块 id 现查当前节点，找不到退回 widget 建立时的那个 */
  const current = (node: PMNode): PMNode => {
    const view = mainView()
    const id: unknown = node.attrs.id
    const pos = view && typeof id === 'string' && id ? findBlockIdPos(view.state.doc, id) : null
    return (view && pos !== null ? view.state.doc.nodeAt(pos) : null) ?? node
  }
  return {
    ...base,
    copy: (node) => base.copy(current(node)),
    quote(node, btn) {
      const view = mainView()
      const id: unknown = node.attrs.id
      if (!view || typeof id !== 'string' || !id) return
      const text = current(node).textContent.replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX)
      quoteWithFly(view, { pageId, blockId: id, text }, btn.getBoundingClientRect())
    },
    // el 是操作行，淡出的是它所在的顶层块
    remove: (node, el) => base.remove(node, el.closest<HTMLElement>('.ProseMirror > *') ?? el),
  }
}

/** 给 ai-block / message-chips 用的抬头操作行工厂：canWrite 表示有写权（viewer 只有复制 / 收藏） */
export function docHeadActs(
  pageId: string,
  getEditor: () => Editor | undefined,
  canWrite: boolean,
): (kind: 'user' | 'ai', node: PMNode) => HTMLElement | null {
  const acts = docActsFor(pageId, getEditor)
  return (kind, node) => {
    const row = buildActs(kind, node, acts, canWrite, null)
    row?.classList.add('is-head')
    return row
  }
}
