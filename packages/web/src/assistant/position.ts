/* ---------- 从哪一页唤起的 Genet：选中了正文里的一段字，就预先放进输入框的那颗块引用 ----------
 * 与气泡「引用」同一种记号（composer-bridge.ts 的 composerQuote），放进输入框后升成 chip，用户可以删。
 * 没选中不放东西：当前页不进输入框，由浮窗记在每条消息的 ctx 上（message-blocks.ts），Genet 读到就知道「这页」是哪页。 */
import type { EditorView } from '@milkdown/kit/prose/view'
import { composerQuote } from '../editor/composer-bridge'
import { anchorOfRange } from '../editor/text-anchor'

/** 正文视图里选中的那段字所在块的块引用（后面带一个空格，光标落在 chip 之后接着打字）；
 *  没选中、选在块外、或正文此刻藏着（对话模式：它的选区不是用户看到的）返回空串 */
export function positionMark(pageId: string, view: EditorView | undefined): string {
  if (!view || view.dom.offsetParent === null) return ''
  const { from, to, empty } = view.state.selection
  const anchor = empty ? null : anchorOfRange(view.state.doc, from, to)
  return anchor ? `${composerQuote(pageId, anchor.blockId, anchor.text)} ` : ''
}
