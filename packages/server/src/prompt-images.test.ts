// ---------- 截图直接给模型看（真库 + 假 agent） ----------
// 用户消息里的本站图片作为图片块跟在文本后面发给 agent，agent 在 initialize 里声明了 promptCapabilities.image 才发。
// 假 agent 的「报图片」回显收到的图片块数，FAKE_IMAGE=1 让它声明能收图（子进程继承本进程的环境变量）。
import sharp from 'sharp'
import { afterAll, beforeAll, expect, test } from 'vitest'
import * as Y from 'yjs'
import { base, connectDoc, continuePage, docText, setupPage, SSECollector, userMessage, waitFor } from './agents/test-kit.js'

beforeAll(() => {
  process.env.FAKE_IMAGE = '1'
})
afterAll(() => {
  delete process.env.FAKE_IMAGE
})

/** 1×1 PNG，每次颜色不同：上传按内容去重，同样的字节会拿回同一个 id */
let shade = 0
const png = (): Promise<Buffer> =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: { r: shade++, g: 0, b: 0 } } }).png().toBuffer()

async function upload(cookie: string): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([await png()], { type: 'image/png' }), 'shot.png')
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie }, body: form })
  expect(res.status).toBe(201)
  return ((await res.json()) as { url: string }).url
}

/** 文档最后一条用户消息末尾加一段图片，形状与前端 appendUserMessage 的附件一致 */
function attachImages(doc: Y.Doc, srcs: string[]): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = frag.get(frag.length - 1) as Y.XmlElement
  const p = new Y.XmlElement('paragraph')
  p.insert(
    0,
    srcs.map((src) => {
      const img = new Y.XmlElement('image')
      img.setAttribute('src', src)
      return img
    }),
  )
  msg.insert(msg.length, [p])
}

test('消息里的图作为图片块发给能收图的 agent；外链与超过 4 张的不带', async () => {
  const { cookie, pageId } = await setupPage()
  const url = await upload(cookie)
  const a = await connectDoc(pageId, cookie)
  userMessage(a.document, '报图片')
  attachImages(a.document, [url, 'https://example.com/x.png'])
  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  expect(await continuePage(pageId, cookie)).toBe(202)
  await sse.wait((ev) => ev.type === 'status' && ev.state === 'done')
  await waitFor(() => /images:1:image\//.test(docText(a)))

  // 第二轮 6 张本站图只带前 4 张
  const urls = await Promise.all(Array.from({ length: 6 }, () => upload(cookie)))
  userMessage(a.document, '报图片')
  attachImages(a.document, urls)
  expect(await continuePage(pageId, cookie)).toBe(202)
  await waitFor(() => /images:4:/.test(docText(a)))
  sse.stop()
  a.destroy()
})
