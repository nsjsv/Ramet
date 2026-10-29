/* ---------- 这一轮那条用户消息里的图（lastUserMessageImages）：只认视图里最后一条、本站文件、至多 4 张 ---------- */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { lastUserMessageImages, MAX_PROMPT_IMAGES } from './doc.js'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function image(src: string): Y.XmlElement {
  const el = new Y.XmlElement('image')
  el.setAttribute('src', src)
  return el
}

function message(...srcs: string[]): Y.XmlElement {
  const msg = new Y.XmlElement('user_message')
  const para = new Y.XmlElement('paragraph')
  para.insert(0, srcs.map(image))
  msg.insert(0, [para])
  return msg
}

function build(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('prosemirror')
  frag.insert(0, blocks)
  return frag
}

test('最后一条用户消息里的本站图片（原图 / display 地址都认，外链不认，去重）', () => {
  const frag = build(message(`/api/files/${id(1)}`), new Y.XmlElement('agent_reply'), message(`/api/files/${id(2)}/display`, 'https://x.com/a.png', `/api/files/${id(2)}`))
  expect(lastUserMessageImages(frag)).toEqual([id(2)])
})

test('至多 MAX_PROMPT_IMAGES 张；视图边界之后的消息不算（重新生成）', () => {
  const many = Array.from({ length: 6 }, (_, i) => `/api/files/${id(i + 10)}`)
  const frag = build(message(...many), new Y.XmlElement('agent_reply'), message(`/api/files/${id(99)}`))
  expect(lastUserMessageImages(frag, 2)).toEqual(many.slice(0, MAX_PROMPT_IMAGES).map((s) => s.split('/').pop()))
  expect(lastUserMessageImages(build())).toEqual([])
})
