/* ---------- 不经标题编辑器、直接把页面文档的 title 片段写成新名 ----------
 * 侧栏树上改名（PageTree.tsx）与正文里集合块的块头改名（collection/block-view.tsx）共用。
 * 只清段落里的字、首段写新名（段落结构保留，打开着的标题编辑器经 ySync 即时跟名）；
 * 片段还是空的（旧页未播种）就自建单段，形状与服务端播种一致。调用方自己包事务 / 选连接。 */
import * as Y from 'yjs'

export function writeTitleFragment(frag: Y.XmlFragment, text: string): void {
  if (frag.length === 0) {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    frag.insert(0, [paragraph])
    return
  }
  frag.toArray().forEach((child, index) => {
    if (!(child instanceof Y.XmlElement)) return
    child.delete(0, child.length)
    if (index === 0) child.insert(0, [new Y.XmlText(text)])
  })
}
