// ---------- 「外壳 + pre > code」nodeView 的 ignoreMutation ----------
// 代码块（code-view.ts）与公式块（math-view.ts）都是：外壳（contenteditable=false 的顶栏 / 渲染结果）+ pre > code（contentDOM）。
// 不能把 code 之外的变动一律忽略，那会挡掉 PM 的自愈：Firefox 删掉 code 里最后一个字时，会把变空的行内元素
// <code>（就是 contentDOM）一起删掉（变动记在 pre 上）。PM 据此把这一块整块重读（contentLost）、重画；
// 被忽略的话画面是空块，模型里却还留着字，contentDOM 也脱离了文档：之后退格不去样式，
// 选区写进脱离的节点（打字没反应），等下一次重画，模型里的旧字连同换行又冒出来。
// 所以只忽略确定是外壳自己造成的三类变动：外壳元素里的；contentDOM 之外的属性（class / data-*）；dom 上增删外壳元素。
// 其余（编辑落在 contentDOM 里或外面、contentDOM 被浏览器删掉 / 换掉）都交给 PM，contentDOM 外的 childList 它会整块重读再重画。

import type { ViewMutationRecord } from '@milkdown/kit/prose/view'

export function shellMutationFilter(dom: Node, contentDOM: Node, shells: readonly Node[]): (mutation: ViewMutationRecord) => boolean {
  return (mutation) => {
    if (mutation.type === 'selection') return false
    const target = mutation.target
    if (shells.some((el) => el.contains(target))) return true
    if (mutation.type === 'attributes') return target === contentDOM || !contentDOM.contains(target)
    if (mutation.type === 'childList' && target === dom) {
      const changed = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)]
      return changed.length > 0 && changed.every((node) => shells.includes(node))
    }
    return false
  }
}
