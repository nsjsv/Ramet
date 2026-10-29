/* ---------- @ 点名链（全栈：test-kit 里的两个 fake agent：fake / claude）----------
 * 不变量：
 *   - 进度就是文档（shared/mention-chain）：最后一条用户消息的点名序列 + 它之后的回复数；服务端 Yjs 与前端 PM 同一个函数
 *   - `@claude 写 @fake 审`：只跑被点名的、按出现顺序一家一家（请求体里的 agent 在有链时不起作用）
 *   - 失败：链停住，不自动重试；「继续剩下的」（普通 continue）跳过失败的那条接着跑后面的，不回头
 *   - 重试失败的那条成功后，链自动接着跑后面的
 *   - 点名的 agent 不可用：400，不悄悄换别家 */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { chainRest, mentionChainOf } from '@ramet/shared/run-model'
import { mentionChain } from './doc.js'
import {
  connectDoc,
  continuePage,
  postJson,
  serverReplies,
  settled,
  setupPage,
  SSECollector,
  waitFor,
} from './test-kit.js'

/** 用户消息：文字与 @ agent chip 交替（和前端 y-prosemirror 落的形状一致：段落里 XmlText 与 agent_mention 元素并列） */
function mentionMessage(doc: Y.Doc, parts: Array<string | { agent: string; label: string }>): void {
  const frag = doc.getXmlFragment('prosemirror')
  const msg = new Y.XmlElement('user_message')
  const p = new Y.XmlElement('paragraph')
  msg.insert(0, [p])
  frag.insert(frag.length, [msg])
  for (const part of parts) {
    if (typeof part === 'string') {
      const t = new Y.XmlText()
      p.insert(p.length, [t])
      t.insert(0, part)
    } else {
      const m = new Y.XmlElement('agent_mention')
      m.setAttribute('agentId', part.agent)
      m.setAttribute('label', part.label)
      p.insert(p.length, [m])
    }
  }
}

const FAKE = { agent: 'fake', label: 'Fake' }
const CLAUDE = { agent: 'claude', label: 'Claude' }

/** 文档里全部回复块的 (agent, 结果)，按出现顺序 */
async function repliesOf(pageId: string, cookie: string): Promise<Array<{ id: string; agent: string; outcome: string | undefined }>> {
  const blocks = await serverReplies(pageId, cookie)
  const p = await connectDoc(pageId, cookie)
  const out: Array<{ id: string; agent: string }> = []
  p.document.getXmlFragment('prosemirror').forEach((n) => {
    if (n instanceof Y.XmlElement && n.nodeName === 'agent_reply') out.push({ id: String(n.getAttribute('id')), agent: String(n.getAttribute('agent')) })
  })
  p.destroy()
  return out.map((r) => ({ ...r, outcome: blocks.find((b) => b.id === r.id)?.outcome }))
}

test('规则：进度 = 最后一条用户消息的点名序列 + 它之后的回复数；服务端 Yjs 与共享函数一致', () => {
  expect(mentionChainOf([])).toBeNull()
  expect(mentionChainOf([{ kind: 'user_message', mentions: [] }, { kind: 'agent_reply' }])).toBeNull() // 没点名 = 不是链
  const blocks = [
    { kind: 'user_message', mentions: ['a', 'b'] },
    { kind: 'agent_reply' },
    { kind: 'other' },
    { kind: 'user_message', mentions: ['b', 'a', 'b'] }, // 只认最后一条用户消息
    { kind: 'agent_reply' },
  ] as const
  const chain = mentionChainOf(blocks)
  expect(chain).toEqual({ agents: ['b', 'a', 'b'], replied: 1 })
  expect(chainRest(chain)).toBe(2)
  expect(chainRest(mentionChainOf([...blocks, { kind: 'agent_reply' }, { kind: 'agent_reply' }]))).toBe(0)

  const doc = new Y.Doc()
  mentionMessage(doc, ['前 ', CLAUDE, ' 中 ', FAKE, ' 后'])
  const frag = doc.getXmlFragment('prosemirror')
  expect(mentionChain(frag)).toEqual({ agents: ['claude', 'fake'], replied: 0 })
  const reply = new Y.XmlElement('agent_reply')
  frag.insert(frag.length, [reply])
  expect(mentionChain(frag)).toEqual({ agents: ['claude', 'fake'], replied: 1 })
})

test('@claude 写 @fake 审：只跑被点名的、按出现顺序；请求体里的 agent 在有链时不起作用', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  mentionMessage(a.document, ['先让 ', CLAUDE, ' 写，再让 ', FAKE, ' 审'])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202) // 请求体点的是 fake，链说先 claude
  await settled(sse, 2)
  const replies = await repliesOf(pageId, cookie)
  expect(replies.map((r) => [r.agent, r.outcome])).toEqual([['claude', 'end'], ['fake', 'end']])

  // 只点名一家：别家不跑
  mentionMessage(a.document, ['这回只让 ', CLAUDE])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 3)
  const after = await repliesOf(pageId, cookie)
  expect(after.map((r) => r.agent)).toEqual(['claude', 'fake', 'claude'])
  sse.stop()
  a.destroy()
})

test('失败：链停住不自动重试；「继续剩下的」跳过失败的接着跑后面的，不回头', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  // 失败一次：同一段提示词在每个 agent 进程里各只失败第一次
  mentionMessage(a.document, ['失败一次 ', CLAUDE, ' 然后 ', FAKE])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  await new Promise((r) => setTimeout(r, 600)) // 链若（错误地）自动往下走，这点时间足够让第二家起跑
  const stopped = await repliesOf(pageId, cookie)
  expect(stopped.map((r) => [r.agent, r.outcome])).toEqual([['claude', 'error']])

  // 继续剩下的 = 普通 continue：下一家是 fake（claude 那条失败的已经算一条回复）
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 2)
  const resumed = await repliesOf(pageId, cookie)
  expect(resumed.map((r) => r.agent)).toEqual(['claude', 'fake'])
  expect(resumed[0]!.outcome).toBe('error') // 失败的那条没有被偷偷重跑
  sse.stop()
  a.destroy()
})

test('重试失败的那条：成功后链自动接着跑后面的', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  const sse = new SSECollector()
  await sse.start(pageId, cookie)

  // 提示词要和上一条用例不同：fake agent 的「失败一次」按提示词记在进程里，适配器进程跨用例复用
  mentionMessage(a.document, ['失败一次 重试用例 ', CLAUDE, ' 然后 ', FAKE])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  const [failed] = await repliesOf(pageId, cookie)
  expect(failed).toMatchObject({ agent: 'claude', outcome: 'error' })

  expect((await postJson(`/api/pages/${pageId}/replies/${failed!.id}/regenerate`, cookie)).status).toBe(202)
  await settled(sse, 3) // 重试（claude，这回成功）+ 链接着跑的 fake
  await waitFor(async () => (await repliesOf(pageId, cookie)).length === 2)
  const done = await repliesOf(pageId, cookie)
  expect(done.map((r) => r.agent)).toEqual(['claude', 'fake'])
  expect(done[0]).toMatchObject({ id: failed!.id, outcome: 'end' })
  sse.stop()
  a.destroy()
})

test('点名的 agent 不可用：400，不悄悄换别家', async () => {
  const { cookie, pageId } = await setupPage()
  const a = await connectDoc(pageId, cookie)
  mentionMessage(a.document, ['叫 ', { agent: 'ghost', label: 'Ghost' }])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(400)
  expect(await repliesOf(pageId, cookie)).toEqual([])
  a.destroy()
})
