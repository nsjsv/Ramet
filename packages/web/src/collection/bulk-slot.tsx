// ---------- 批量操作栏（BulkBar）画在哪 ----------
// 选中条目后盖在集合的标题行上，不另占一行顶开内容：正文里的集合块盖在块标题行（block-view.tsx 提供插槽），
// 整页集合没有块标题，盖在视图标签栏（CollectionSurface 自己的插槽）。
// 插槽是绝对定位的盖层（.cl-bulk-slot，空着不显示）；栏经 portal 画进去，React 事件仍沿视图组件的树冒泡。
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const BulkSlot = createContext<HTMLElement | null>(null)

/** 有插槽就画进插槽，没有（插槽还没挂上）就原地画 */
export function InBulkSlot({ children }: { children: ReactNode }) {
  const slot = useContext(BulkSlot)
  return slot ? createPortal(children, slot) : <>{children}</>
}
