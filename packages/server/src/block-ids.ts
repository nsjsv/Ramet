// ---------- 块 id（服务端侧） ----------
// 可寻址块的判定在 @ramet/shared/block-address，与 web 共用；web 端的补 id / 去重插件是 web/src/editor/block-id.ts。
// 服务端建块时直接写 id（agents/markdown.ts 的 materialize），不等客户端各补一份：
// 多端同时补会各发一份增量，收敛前复制的链接还可能指向被覆盖掉的 id。

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'

/** 新块 id（与 web 端同为随机 uuid） */
export function newBlockId(): string {
  return randomUUID()
}

/** 按 id 找块（任意深度），找不到返回 null。服务端按块 id 找块的唯一实现：
 *  提及快照（routes/blocks.ts）、提示词里的块引用（agents/refs.ts）、read_page 按块读都走这里。 */
export function findBlockElement(root: Y.XmlFragment, id: string): Y.XmlElement | null {
  if (!id) return null
  let found: Y.XmlElement | null = null
  root.forEach((child) => {
    if (found || !(child instanceof Y.XmlElement)) return
    if (child.getAttribute('id') === id) found = child
    else found = findBlockElement(child, id)
  })
  return found
}
