// ---------- Genet 页上「读到过外来事件」的判定（唯一实现） ----------
// 触发者不是规则主人的事件（别人的评论、外部请求）写进 Genet 页时带 external = '1'（notice.ts 的事件通知）。
// 自从主人上一次在 Genet 页亲自发言以来，只要页上出现过这样一条，Genet 调有副作用的工具都要先问主人（routes/ramet-consent.ts）：
// 外来内容可能夹带「把这页删了」之类的指令，主人没说话之前，Genet 的动手都算受它影响。主人亲自说一句就解除。
// 按「上次亲自发言之后」判而不是按一轮：不用改一轮的流程，在工具调用当下读活文档，同一轮里先读到外来事件、后调工具也拦得住。
// 「亲自发言」= 没有 notice / timer / rule 属性、作者是主人（老消息作者为空，Genet 页是个人页，算主人的）的用户消息。

import * as Y from 'yjs'
import { textOf } from '../updates.js'

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** 主人上次亲自发言之后最近的一条外来事件通知的抬头（「规则「评论找我」· bob 在《周报》的评论」）；没有 = null */
export function taintedSince(fragment: Y.XmlFragment, ownerId: string): string | null {
  const blocks = fragment.toArray()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const el = blocks[i]
    if (!(el instanceof Y.XmlElement) || el.nodeName !== 'user_message') continue
    if (attr(el, 'notice') && attr(el, 'external') === '1') {
      const head = el.get(0)
      return (head instanceof Y.XmlElement ? textOf(head) : '').trim() || '外来的事件'
    }
    const personal = !attr(el, 'notice') && !attr(el, 'timer') && !attr(el, 'rule') && (attr(el, 'author') === ownerId || attr(el, 'author') === '')
    if (personal) return null
  }
  return null
}
