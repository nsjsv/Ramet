/* ---------- 空行粘贴网址：链接 / 提及 / 书签三选 ----------
 * 在空段落里粘贴一个裸 http(s) 网址：先照常变成链接（markdown.ts 的 linkifyPaste），再在光标下弹三选：
 * 「链接」保持原样；「提及」把这条链接换成行内网页提及（link-mention.ts，图标 + 标题）；「书签」整段换成书签卡。
 * Esc / 点别处 = 保持链接。站内地址（页面链接、块链接）不弹：它们有自己的去处（page_ref、块链接三选）。
 * 选择时按位置找回那一段，内容已经不是这条链接了（期间又打了字 / 协同对端改了）就什么都不做。 */

import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { COPY } from '../copy'
import { openChoiceOverlay } from './block-link-paste'
import { replaceWithBookmark } from './bookmark'

const C = COPY.bookmark

/** 粘贴前的选区落在空段落里（且没有选中内容）= 返回该段落的起点，否则 null */
export function blankParagraphAt(view: EditorView): number | null {
  const { $from, empty } = view.state.selection
  if (!empty || $from.depth < 1 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) return null
  return $from.before()
}

function isInternal(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin
  } catch {
    return true
  }
}

/** linkifyPaste 之后调：at = 粘贴前那个空段落的起点 */
export function offerLinkChoices(view: EditorView, at: number, url: string): void {
  if (isInternal(url)) return
  const { schema } = view.state
  const bookmark = schema.nodes.bookmark
  const mention = schema.nodes.link_mention
  if (!bookmark || !mention) return
  // 段落所在的容器放不下块（表格单元格之类）就没有「书签」这项
  const $at = view.state.doc.resolve(at)
  const blockOk = $at.parent.canReplaceWith($at.index(), $at.index() + 1, bookmark)

  /** 那一段还是不是刚粘的这条链接；是就返回它的范围 */
  const target = (): { from: number; to: number } | null => {
    if (view.isDestroyed) return null
    const node = view.state.doc.nodeAt(at)
    return node && node.type.name === 'paragraph' && node.textContent === url ? { from: at, to: at + node.nodeSize } : null
  }

  openChoiceOverlay(view, [
    { label: C.keepLink, hint: C.keepLinkHint, run: () => view.focus() },
    {
      label: C.mention,
      hint: C.mentionHint,
      run: () => {
        const range = target()
        if (range) {
          // 段落里的链接文字整段换成一颗提及，光标落在它后面
          const tr = view.state.tr.replaceWith(range.from + 1, range.to - 1, mention.create({ url }))
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, range.from + 2)).scrollIntoView())
        }
        view.focus()
      },
    },
    ...(blockOk
      ? [
          {
            label: C.bookmark,
            hint: C.bookmarkHint,
            run: () => {
              const range = target()
              const tr = range && replaceWithBookmark(view.state, range.from, range.to, url)
              if (tr) view.dispatch(tr)
              view.focus()
            },
          },
        ]
      : []),
  ])
}
