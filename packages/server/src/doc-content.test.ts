import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { contentKey } from './doc-content.js'

function para(doc: Y.Doc, build: (text: Y.XmlText) => void): void {
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  paragraph.insert(0, [text])
  doc.getXmlFragment('prosemirror').insert(0, [paragraph])
  build(text)
}

test('内容键只看读得见的内容:文字怎么拆 item、多余格式标记、空的顶层类型都不影响', () => {
  const a = new Y.Doc()
  para(a, (t) => {
    t.insert(0, 'abc')
    t.format(1, 1, { strong: true })
  })
  const b = new Y.Doc()
  para(b, (t) => {
    t.insert(0, 'a')
    t.insert(1, 'c')
    t.insert(1, 'b', { strong: true })
    t.insert(3, 'xyz')
    t.delete(3, 3)
    t.format(0, 1, { em: null }) // 去掉本来就没有的格式
  })
  b.getXmlFragment('title') // 空的顶层类型
  expect(contentKey(a)).toBe(contentKey(b))

  // 从 update 还原出来的未定型顶层类型(没人 getXmlFragment 过)与原文档同键
  const restored = new Y.Doc()
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(b))
  expect(contentKey(restored)).toBe(contentKey(a))
})

test('内容键区分:文字、格式、节点属性、节点类型的任何差异', () => {
  const base = () => {
    const d = new Y.Doc()
    para(d, (t) => t.insert(0, 'abc'))
    return d
  }
  const key = contentKey(base())
  const text = base()
  ;((text.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, '!')
  const mark = base()
  ;((mark.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlText).format(0, 1, {
    link: { href: 'https://a' },
  })
  const attr = base()
  ;(attr.getXmlFragment('prosemirror').get(0) as Y.XmlElement).setAttribute('id', 'b1')
  const other = new Y.Doc()
  other.getText('t').insert(0, 'abc')
  for (const d of [text, mark, attr, other]) expect(contentKey(d)).not.toBe(key)
})
