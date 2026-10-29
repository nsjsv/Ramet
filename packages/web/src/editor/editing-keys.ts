/* ---------- 编辑键位的装配 ----------
 * 两个插件，都要排在 messageDeleteKeymap / listEnterKeymap / milkdown 合并 keymap 之前（editor-session.ts 的 .use 顺序）：
 *   blockSelectKeys：块选区激活时的键位与剪贴板 / 拖放（block-ops.ts），没有块选时只认 Esc（选中光标所在块）。
 *     必须最先，块选激活时 PM 那边只有一个折叠 caret，后面任何 keymap 都会把按键当成在 caret 处编辑。
 *   editingKeys：与块选无关的编辑键，块首退格先去样式再并进前一块、跨块选区删除、Tab 缩进、副本 / 移动、Mod-A 两段式。
 * Tab / Shift-Tab 不论有没有人处理都不让焦点跑出编辑器（插件视图在 view.dom 上后挂的 keydown，PM 自己的处理先跑）。 */

import { chainCommands } from '@milkdown/kit/prose/commands'
import { keydownHandler } from '@milkdown/kit/prose/keymap'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { mergeIntoPrevious, stripBlockStyle } from './block-backspace'
import {
  activeRange,
  copyBlocks,
  dropBlockRange,
  duplicateBlocks,
  enterBlock,
  extendBlockSelection,
  indentBlocks,
  moveBlocks,
  outdentBlocks,
  prepareBlockPaste,
  selectBlockAtCursor,
  stepBlockSelection,
} from './block-ops'
import { deleteBlockRange } from './block-delete'
import { blockSelectKey, CLEAR_BLOCK_SELECT, type BlockSelectState } from './block-select-key'
import { indentCommand, outdentCommand } from './list-indent'
import { cutAcrossBlocks, deleteSelectionCommand } from './range-delete'

function setBlockSelect(view: EditorView, next: BlockSelectState | null): boolean {
  if (!next) return false
  view.dispatch(view.state.tr.setMeta(blockSelectKey, next).scrollIntoView())
  scrollBlockIntoView(view, next.from)
  return true
}

/** 块选移动后把那一块滚进可视区（块选区不在 PM 选区里，scrollIntoView 不管它） */
function scrollBlockIntoView(view: EditorView, pos: number): void {
  const dom = view.nodeDOM(pos)
  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'nearest' })
}

function onBlockSelectKey(view: EditorView, event: KeyboardEvent): boolean {
  if (view.composing || event.isComposing || !view.editable) return false
  const mod = event.ctrlKey || event.metaKey
  const sel = activeRange(view.state)
  if (!sel) {
    if (event.key === 'Escape' && !mod && !event.altKey && !event.shiftKey) return setBlockSelect(view, selectBlockAtCursor(view.state))
    return false
  }
  if (mod || event.altKey) return false // Mod-D / Mod-Shift-↑↓ 等交给 editingKeys（它们认块选）
  switch (event.key) {
    case 'Escape':
      view.dispatch(view.state.tr.setMeta(blockSelectKey, CLEAR_BLOCK_SELECT))
      return true
    case 'Backspace':
    case 'Delete':
      return deleteBlockRange(view, sel.from, sel.to)
    case 'ArrowUp':
    case 'ArrowDown': {
      const dir = event.key === 'ArrowDown' ? 1 : -1
      return setBlockSelect(view, event.shiftKey ? extendBlockSelection(view.state, dir) : stepBlockSelection(view.state, dir)) || true
    }
    case 'Enter': {
      const tr = enterBlock(view.state)
      if (tr) view.dispatch(tr)
      return true
    }
    case 'Tab':
      return (event.shiftKey ? outdentBlocks : indentBlocks)(view.state, view.dispatch)
    default:
      // 块选状态下打字不往 caret 里插字（caret 只是块选的落脚点，用户看不见）
      return event.key.length === 1
  }
}

export const blockSelectKeys = $prose(
  () =>
    new Plugin({
      key: new PluginKey('RAMET_BLOCK_SELECT_KEYS'),
      props: {
        handleKeyDown: onBlockSelectKey,
        handleDOMEvents: {
          copy: (view, event) => copyBlocks(view, event, false),
          cut: (view, event) => copyBlocks(view, event, true),
          paste: (view) => {
            prepareBlockPaste(view)
            return false // 内容照常由 PM（与 configPaste）粘进来
          },
        },
        handleDrop: (view, event) => dropBlockRange(view, event),
      },
    }),
)

/** Mod-A 两段式：先选当前文本块的全部文字，这一块已经全选了再按才全选全文（PM 默认） */
export function selectTextblock(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to } = state.selection
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return false
  const start = $from.start()
  const end = $from.end()
  if (start === end || ($from.pos === start && $to.pos === end)) return false
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)))
  return true
}

const editingBindings = {
  Backspace: chainCommands(stripBlockStyle, mergeIntoPrevious, deleteSelectionCommand),
  Delete: deleteSelectionCommand,
  Tab: indentCommand,
  'Shift-Tab': outdentCommand,
  'Mod-d': duplicateBlocks,
  'Mod-Shift-ArrowUp': moveBlocks(-1),
  'Mod-Shift-ArrowDown': moveBlocks(1),
  'Mod-a': selectTextblock,
}

export const editingKeys = $prose(() => {
  const handle = keydownHandler(editingBindings)
  return new Plugin({
    key: new PluginKey('RAMET_EDITING_KEYS'),
    props: {
      handleKeyDown: (view, event) => (view.composing ? false : handle(view, event)),
      handleDOMEvents: {
        cut: (view, event) => (view.editable ? cutAcrossBlocks(view, event) : false),
      },
    },
    view: (view) => {
      // Tab 兜底：PM 与各插件都没处理的 Tab（表格外的普通段落等）也不让浏览器把焦点移出编辑器
      const keepFocus = (event: KeyboardEvent): void => {
        if (event.key === 'Tab' && !event.defaultPrevented && view.editable) event.preventDefault()
      }
      view.dom.addEventListener('keydown', keepFocus)
      return { destroy: () => view.dom.removeEventListener('keydown', keepFocus) }
    },
  })
})
