/* ---------- 引用契约：提示词里的引用 = 定位 + 原块当前内容 ----------
 * 不变量（见 agents/refs.ts 文件头）：
 *  - 块提及 / 同步块进提示词是 page:<页>#<块>「原块当前内容」，原块改了下一轮拿到改后的（原生续聊也是：
 *    基线 hash 覆盖解析后的内容，变了就新建会话全文重放）；
 *  - 原块读不到（没权限 / 块删了）给快照并注明，不泄露原块现在的内容；
 *  - 只解一层：原块里的引用只给定位 + 快照；
 *  - 子页面块给 page:<页>「标题」；
 *  - 什么都没改时照常原生续聊：收尾基线 hash 与开头同一口径（引用按本轮开头解析的那份算）；
 *  - read_page 能按块读同一份文字，正文里的 page: 记号可以原样当参数。
 * agent 拿到什么，用 fake agent 的回显提示词看（提示词包进代码块原样回复，回复块的文字就是提示词）。 */

import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { fileURLToPath } from 'node:url'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  SSECollector,
  agentSession,
  base,
  connectDoc,
  continuePage,
  insertUser,
  login,
  pageOwnership,
  pool,
  postJson,
  replyBlocks,
  settled,
  setupPage,
  startConnector,
  waitFor,
} from './test-kit.js'
import { mintPageToken } from '../page-read.js'

const READ_PAGE_MCP = fileURLToPath(new URL('../mcp/ramet.mjs', import.meta.url))

function text(value: string): Y.XmlText {
  const t = new Y.XmlText()
  t.insert(0, value)
  return t
}

function element(name: string, attrs: Record<string, unknown>, children: Array<Y.XmlElement | Y.XmlText> = []): Y.XmlElement {
  const el = new Y.XmlElement(name)
  // Yjs 的 attr 签名只收 string，运行期原样存值（checked / level 要真布尔与数字，同 y-prosemirror）
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string)
  if (children.length) el.insert(0, children)
  return el
}

/** 段落：文字与行内原子节点按顺序排 */
function paragraph(attrs: Record<string, unknown>, ...parts: Array<string | Y.XmlElement>): Y.XmlElement {
  return element('paragraph', attrs, parts.map((part) => (typeof part === 'string' ? text(part) : part)))
}

/** 一条待办：bullet_list > list_item(checked) > paragraph */
function todo(listId: string, itemId: string, value: string, checked: boolean): Y.XmlElement {
  return element('bullet_list', { id: listId }, [element('list_item', { id: itemId, checked }, [paragraph({}, value)])])
}

function userMessage(...parts: Array<string | Y.XmlElement>): Y.XmlElement {
  return element('user_message', {}, [paragraph({}, ...parts)])
}

async function newSpace(cookie: string): Promise<string> {
  return ((await (await postJson('/api/spaces', cookie, { name: 's' })).json()) as { id: string }).id
}

async function newPage(cookie: string, spaceId: string): Promise<string> {
  return ((await (await postJson('/api/pages', cookie, { space_id: spaceId })).json()) as { id: string }).id
}

/** 服务端已经收到这页的这份内容（新连一个客户端读） */
async function serverHas(pageId: string, cookie: string, pred: (body: Y.XmlFragment) => boolean): Promise<void> {
  await waitFor(async () => {
    const check = await connectDoc(pageId, cookie)
    const ok = pred(check.document.getXmlFragment('prosemirror'))
    check.destroy()
    return ok
  })
}

/** 跑一轮并拿回显的提示词（第 n 条回复的文字）。agent 缺省 = 中心本机的 fake */
async function echo(sse: SSECollector, p: HocuspocusProvider, pageId: string, cookie: string, n: number, agent = 'fake'): Promise<string> {
  expect(await continuePage(pageId, cookie, { agent })).toBe(202)
  await settled(sse, n)
  await waitFor(() => replyBlocks(p)[n - 1]?.outcome === 'end')
  return replyBlocks(p)[n - 1]!.text
}

/** 提示词里最后一条用户消息（全文重放里前面的消息也在，断言只看最新这条） */
function lastUserLine(prompt: string): string {
  return prompt.split('\n').filter((l) => l.startsWith('>> ')).at(-1) ?? ''
}

test('引用一条待办：agent 拿到它当前的内容与勾选状态；改了原块再发拿到改后的，且新建会话全文重放', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const source = await newPage(cookie, spaceId)
  const src = await connectDoc(source, cookie)
  src.document.getXmlFragment('prosemirror').insert(0, [todo('U1', 'L1', '买牛奶', false)])
  await serverHas(source, cookie, (b) => b.length === 1)

  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const p = await connectDoc(pageId, cookie)
  const body = p.document.getXmlFragment('prosemirror')
  const ref = () => element('block_ref', { pageId: source, blockId: 'L1', text: '插入时的快照' })
  body.insert(0, [userMessage('回显提示词 先做 ', ref(), ' 这条')])
  const first = await echo(sse, p, pageId, cookie, 1)
  expect(lastUserLine(first)).toBe(`>> 回显提示词 先做 page:${source}#L1「- [ ] 买牛奶」 这条`)
  const firstSession = (await agentSession(pageId))?.fake?.sessionId
  expect(firstSession).toBeTruthy()

  // 原块勾上、补字；再发一条同样引用它的消息
  src.document.transact(() => {
    const li = (src.document.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlElement
    li.setAttribute('checked', true as unknown as string)
    const t = (li.get(0) as Y.XmlElement).get(0) as Y.XmlText
    t.insert(t.length, '和面包')
  })
  await serverHas(source, cookie, (b) => b.toString().includes('和面包'))
  body.insert(body.length, [userMessage('回显提示词 再看 ', ref())])
  const second = await echo(sse, p, pageId, cookie, 2)
  expect(lastUserLine(second)).toBe(`>> 回显提示词 再看 page:${source}#L1「- [x] 买牛奶和面包」`)
  // 前一条消息里的同一引用也是当前内容（整页重放）
  expect(second).toContain(`>> 回显提示词 先做 page:${source}#L1「- [x] 买牛奶和面包」 这条`)
  // 引用的内容变了 = 文档变了：不走原生续聊的增量，新建会话
  expect((await agentSession(pageId))?.fake?.sessionId).not.toBe(firstSession)

  sse.stop()
  p.destroy()
  src.destroy()
})

test('页面里有引用、什么都没改：下一轮照常原生续聊（收尾基线与开头同一口径，引用按开头解析的那份算）', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId } = await pageOwnership(pageId)
  const source = await newPage(cookie, spaceId)
  const src = await connectDoc(source, cookie)
  src.document.getXmlFragment('prosemirror').insert(0, [paragraph({ id: 'P1' }, '原块内容')])
  await serverHas(source, cookie, (b) => b.length === 1)

  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const p = await connectDoc(pageId, cookie)
  const body = p.document.getXmlFragment('prosemirror')
  body.insert(0, [
    element('page_ref', { id: 'R1', pageId: source, title: '子页' }),
    userMessage('第一问 ', element('block_ref', { pageId: source, blockId: 'P1', text: '快照' })),
  ])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 1)
  await waitFor(() => replyBlocks(p)[0]?.outcome === 'end')
  expect(replyBlocks(p)[0]!.text).toContain('turn:full')
  const session = (await agentSession(pageId))?.fake?.sessionId

  body.insert(body.length, [userMessage('第二问')])
  expect(await continuePage(pageId, cookie, { agent: 'fake' })).toBe(202)
  await settled(sse, 2)
  await waitFor(() => replyBlocks(p)[1]?.outcome === 'end')
  expect(replyBlocks(p)[1]!.text).toContain('turn:delta')
  expect((await agentSession(pageId))?.fake?.sessionId).toBe(session)

  sse.stop()
  p.destroy()
  src.destroy()
})

test('读不到的原块给快照并注明（没权限不泄露现在的内容）；同步块、嵌套引用只解一层；子页面块带定位', async () => {
  const { cookie, pageId } = await setupPage()
  const { spaceId, ownerId } = await pageOwnership(pageId)
  // 发起人要是普通用户。本机 agent 只有 admin 能用，所以这一轮跑在 alice 自己接入的 connector 上（机器主人 = 配对人 alice）
  await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [ownerId])
  const connectorId = await startConnector({ spaceId, ownerId, name: 'refbox', cookie })
  const agent = `c:${connectorId}:fake`

  // bob 自己空间里的页：alice 读不到
  await insertUser('bob')
  const bob = await login('bob')
  const secret = await newPage(bob, await newSpace(bob))
  const sec = await connectDoc(secret, bob)
  sec.document.getXmlFragment('prosemirror').insert(0, [paragraph({ id: 'S1' }, '现在的机密')])
  await serverHas(secret, bob, (b) => b.length === 1)

  // alice 同空间的源页：段落里还引用了 bob 的块（嵌套引用只给定位 + 快照，不再解析）
  const source = await newPage(cookie, spaceId)
  const src = await connectDoc(source, cookie)
  src.document.getXmlFragment('prosemirror').insert(0, [
    paragraph({ id: 'P1' }, '源段落 ', element('block_ref', { pageId: secret, blockId: 'S1', text: '旧机密' })),
    element('heading', { id: 'H1', level: 2 }, [text('小标题')]),
  ])
  await serverHas(source, cookie, (b) => b.length === 2)

  const sse = new SSECollector()
  await sse.start(pageId, cookie)
  const p = await connectDoc(pageId, cookie)
  p.document.getXmlFragment('prosemirror').insert(0, [
    element('page_ref', { id: 'R1', pageId: source, title: '源页' }),
    element('block_sync', { id: 'Y1', pageId: source, blockId: 'H1' }),
    element('block_sync', { id: 'Y2', pageId: source, blockId: 'gone' }),
    userMessage(
      '回显提示词 ',
      element('block_ref', { pageId: source, blockId: 'P1', text: '段落快照' }),
      ' 和 ',
      element('block_ref', { pageId: secret, blockId: 'S1', text: '引用时的机密' }),
    ),
  ])
  const prompt = await echo(sse, p, pageId, cookie, 1, agent)

  expect(prompt).toContain(`page:${source}「源页」`)
  expect(prompt).toContain(`page:${source}#H1「## 小标题」`)
  expect(prompt).toContain(`page:${source}#gone（原块已不可读）`)
  expect(lastUserLine(prompt)).toBe(
    `>> 回显提示词 page:${source}#P1「源段落 page:${secret}#S1「旧机密」（引用时的快照）」` +
      ` 和 page:${secret}#S1「引用时的机密」（原块已不可读，这是引用时的快照）`,
  )
  expect(prompt).not.toContain('现在的机密')

  sse.stop()
  p.destroy()
  src.destroy()
  sec.destroy()
})

test('read_page 按块读：与提示词「」里的内容同一份；正文里的 page: 记号可以原样当参数；块不在了说清楚', async () => {
  const { cookie, pageId } = await setupPage()
  const p = await connectDoc(pageId, cookie)
  p.document.getXmlFragment('prosemirror').insert(0, [paragraph({ id: 'P1' }, '第一段'), todo('U1', 'L1', '买牛奶', false)])
  await serverHas(pageId, cookie, (b) => b.length === 2)
  const token = mintPageToken((await pageOwnership(pageId)).ownerId, 'fake')
  const read = (query: string) => fetch(`${base}/api/pages/${pageId}/text${query}`, { headers: { authorization: `Bearer ${token}` } })

  const res = await read('?block=L1')
  expect(res.status).toBe(200)
  expect(((await res.json()) as { lines: string[] }).lines).toEqual(['- [ ] 买牛奶'])
  const missing = await read('?block=nope')
  expect(missing.status).toBe(404)
  expect(((await missing.json()) as { error: string }).error).toBe('block not found')

  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [READ_PAGE_MCP],
      env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: token },
      stderr: 'inherit',
    }),
  )
  const call = async (args: Record<string, string>) => {
    const out = (await client.callTool({ name: 'read_page', arguments: args })) as { content: Array<{ text: string }> }
    return out.content[0]!.text
  }
  expect(await call({ pageId: `page:${pageId}#L1` })).toContain('1\t- [ ] 买牛奶')
  expect(await call({ pageId, blockId: 'L1' })).toContain('（块 L1）')
  expect(await call({ pageId: `page:${pageId}` })).toContain('2\t买牛奶')
  expect(await call({ pageId: `page:${pageId}#nope` })).toContain(`页面 ${pageId} 里没有块 nope`)
  await client.close()
  p.destroy()
})
