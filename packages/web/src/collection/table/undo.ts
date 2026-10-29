/* ---------- 表格的撤销 / 重做（⌘Z / ⌘⇧Z / ⌘Y）：本表格这次打开以来做过的格子改动 ----------
 * 一步 = 一次动作的格子变更清单（编辑一格 / 选区编辑、粘贴、剪切、清空、填充）；撤销按「改前」写回，重做按「改后」再写。
 * 只记格子值与名称：新建 / 删除 / 挪动行、改属性定义不进栈。别人后来又改过的格子照样写回（最后写入为准，同 Notion）。 */
import type { CellChange } from './range-ops'

const LIMIT = 100

export type UndoStack = {
  push: (changes: CellChange[]) => void
  /** 要撤销的那一步（调用方按 before 写）；没有 = null */
  undo: () => CellChange[] | null
  /** 要重做的那一步（调用方按 after 写）；没有 = null */
  redo: () => CellChange[] | null
}

export function createUndoStack(): UndoStack {
  const done: CellChange[][] = []
  const undone: CellChange[][] = []
  return {
    push: (changes) => {
      if (changes.length === 0) return
      done.push(changes)
      if (done.length > LIMIT) done.shift()
      undone.length = 0
    },
    undo: () => {
      const step = done.pop()
      if (!step) return null
      undone.push(step)
      return step
    },
    redo: () => {
      const step = undone.pop()
      if (!step) return null
      done.push(step)
      return step
    },
  }
}
