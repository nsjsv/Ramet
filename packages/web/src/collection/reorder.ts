/* ---------- 列表拖动重排（视图标签、显示属性、选项共用；行的拖动在 table/ 里，要管分组与 FLIP） ----------
 * HTML5 拖放。落点按指针在目标项的前半 / 后半决定插在它前面还是后面；
 * onMove 收到的是「其余各项里的第 index 位」，与 schema-ops 的 moveProp / moveView / moveOption、prop-meta 的 moveTo 同一口径。 */
import { useRef, useState, type DragEvent } from 'react'

type Over = { id: string; after: boolean }

export type ReorderProps = {
  draggable?: boolean
  onDragStart?: (e: DragEvent<HTMLElement>) => void
  onDragOver?: (e: DragEvent<HTMLElement>) => void
  onDragLeave?: (e: DragEvent<HTMLElement>) => void
  onDrop?: (e: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  'data-drop'?: 'before' | 'after'
}

/** ids = 当前顺序；axis = 'x' 横排（视图标签）/ 'y' 竖排。enabled false（viewer）时什么都不挂 */
export function useReorder(
  ids: readonly string[],
  onMove: (id: string, index: number) => void,
  axis: 'x' | 'y' = 'y',
  enabled = true,
): (id: string) => ReorderProps {
  const dragged = useRef<string | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const side = (e: DragEvent<HTMLElement>): boolean => {
    const r = e.currentTarget.getBoundingClientRect()
    return axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2
  }
  return (id) => {
    if (!enabled) return {}
    return {
      draggable: true,
      onDragStart: (e) => {
        // 从输入框里起手是选文字，不是拖项
        if ((e.target as HTMLElement).closest('input, textarea')) {
          e.preventDefault()
          return
        }
        dragged.current = id
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', id)
        e.stopPropagation()
      },
      onDragOver: (e) => {
        if (!dragged.current || !ids.includes(dragged.current)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const after = side(e)
        setOver((prev) => (prev && prev.id === id && prev.after === after ? prev : { id, after }))
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((prev) => (prev?.id === id ? null : prev))
      },
      onDrop: (e) => {
        const from = dragged.current
        dragged.current = null
        setOver(null)
        if (!from || !ids.includes(from)) return
        e.preventDefault()
        e.stopPropagation()
        if (from === id) return
        const rest = ids.filter((x) => x !== from)
        const index = rest.indexOf(id) + (side(e) ? 1 : 0)
        onMove(from, index)
      },
      onDragEnd: () => {
        dragged.current = null
        setOver(null)
      },
      ...(over?.id === id ? { 'data-drop': over.after ? 'after' : 'before' } : {}),
    }
  }
}
