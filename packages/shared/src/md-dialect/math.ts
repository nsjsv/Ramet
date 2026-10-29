// ---------- 数学公式的误判回退（Pandoc 规则） ----------
// remark-math 的单美元行内公式只看成对：「$5 和 $10」会被认成公式「5 和 」。Pandoc 的约定是开 `$` 后面、收 `$` 前面
// 不能是空白，收 `$` 后面不能紧跟数字，不满足的 inlineMath 还原成原文 `$…$`（普通文字）。块级 `$$` 不受影响。

import type { Md } from './types.js'

export function revertFalseInlineMath(children: Md[]): Md[] {
  return children.map((node, i) => {
    if (node.type !== 'inlineMath') return node
    const value = typeof node.value === 'string' ? node.value : ''
    const next = children[i + 1]
    const nextText = next?.type === 'text' && typeof next.value === 'string' ? next.value : ''
    if (!value || /^\s|\s$/.test(value) || /^\d/.test(nextText)) return { type: 'text', value: `$${value}$` }
    return node
  })
}
