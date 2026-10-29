// ---------- 点正文下方空白处建块 ----------
// 文档最后是图片 / 代码块 / AI 回复 / 子页面卡片这类块时，光标落不到它后面，想接着写没有地方点。
// 点在最后一块下方的空白（正文根元素自己的 min-height / padding-bottom 区，styles/prose.css）：
// 最后一个顶层块是空段落就把光标放进去，否则在文档末尾插一个空段落（一个撤销步）再放光标。
// 新段落永远是顶层块（末块是 AI 回复 / 用户消息也建在它们外面）。
// 只读 / 公开页不生效（view.editable）；聊天 / 源码模式编辑器 display:none 点不到；
// 左侧 gutter 的拖动框选由 block-select.ts 在 body capture 阶段先截走（stopPropagation），到不了这里。

import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

export const blankClick = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            // 只认点在正文根元素自己身上（块上和块里的点击 target 是块的 DOM）
            if (!view.editable || event.button !== 0 || event.target !== view.dom) return false
            const { doc, schema } = view.state
            const last = doc.lastChild
            const paragraph = schema.nodes.paragraph
            if (!last || !paragraph) return false
            const lastPos = doc.content.size - last.nodeSize
            const el = view.nodeDOM(lastPos)
            if (!(el instanceof HTMLElement)) return false
            const bottom = el.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(el).marginBottom) || 0)
            if (event.clientY <= bottom) return false // 块之间的缝隙：照旧交给 ProseMirror
            event.preventDefault()
            const tr = view.state.tr
            let caret: number
            if (last.type === paragraph && last.content.size === 0) {
              caret = lastPos + 1
            } else {
              tr.insert(doc.content.size, paragraph.create())
              caret = doc.content.size + 1
            }
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
            view.focus()
            return true
          },
        },
      },
    }),
)
