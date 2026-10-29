// ---------- 光标所在的有外壳的块挂 is-active ----------
// 代码块（mermaid 据此显示源码、顶栏按钮常显）、公式块（显示源码）、表格（显示「⋯」）共用：
// 从选区起点往上找最近的这类节点，打一个 node decoration（PM 把 class 打到 nodeView 的 dom 上）。两个宿主都要 .use。

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

const ACTIVE = new Set(['code_block', 'math_block', 'table'])

export const activeBlock = $prose(
  () =>
    new Plugin({
      key: new PluginKey('RAMET_ACTIVE_BLOCK'),
      props: {
        decorations: (state) => {
          const { $from } = state.selection
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d)
            if (!ACTIVE.has(node.type.name)) continue
            const pos = $from.before(d)
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'is-active' })])
          }
          return DecorationSet.empty
        },
      },
    }),
)
