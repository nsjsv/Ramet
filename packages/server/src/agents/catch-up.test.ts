/* ---------- 原生会话的增量提示词（catch-up.ts）：只发会话没见过的块，带署名 ---------- */
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { CATCH_UP_MAX_CHARS, catchUpPrompt, deltaPrompt, type Names } from './catch-up.js'
import { lastUserMessage, serializeBlocks, serializeDoc, stripLastUserMessage } from './doc.js'
import { promptHash, type PromptEnv } from './prompt-env.js'

function para(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph')
  el.insert(0, [new Y.XmlText(text)])
  return el
}

function el(name: string, attrs: Record<string, string>, text: string): Y.XmlElement {
  const node = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.insert(0, [para(text)])
  return node
}

const msg = (id: string, text: string, author = ''): Y.XmlElement => el('user_message', { id, ...(author ? { author } : {}) }, text)
const reply = (id: string, agent: string, text: string, run = ''): Y.XmlElement => el('agent_reply', { id, agent, ...(run ? { run } : {}) }, text)

function build(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const frag = new Y.Doc().getXmlFragment('prosemirror')
  frag.insert(0, blocks)
  return frag
}

const process: Record<string, string[]> = { 'run-y': ['过程 page:run-y（共 2 步）：', '- 读取 src/a.ts', '- 执行 npm test'] }
const env = (tools: PromptEnv['tools'] = 'full', memory = ''): PromptEnv => ({
  atoms: () => undefined,
  process: (r) => process[String(r.getAttribute('run') ?? '')],
  memory,
  tools,
})
const names: Names = {
  user: (id) => ({ u1: 'alice', u2: 'bob' })[id],
  agent: (id) => ({ 'c:m2:codex': 'Codex（laptop）', fake: 'Fake' })[id],
}

function prompt(frag: Y.XmlFragment, seen: string, e: PromptEnv = env()): string {
  const docText = serializeDoc(frag, frag.length, e)
  return catchUpPrompt({ fragment: frag, seen, end: frag.length, env: e, names, pageId: 'P', message: lastUserMessage(docText) ?? docText })
}

test('serializeDoc 就是 serializeBlocks 逐块拼接（空块不占位），过程摘要并进回复的引用行', () => {
  const frag = build(msg('m1', '第一问'), reply('r1', 'fake', '答一', 'run-y'), para(''), msg('m2', '第二问'))
  expect(serializeDoc(frag, frag.length, env())).toBe(
    '>> 第一问\n\n> 过程 page:run-y（共 2 步）：\n> - 读取 src/a.ts\n> - 执行 npm test\n> 答一\n\n>> 第二问',
  )
  expect(serializeBlocks(frag, 1, 3, env()).map((b) => b.el?.nodeName)).toEqual(['agent_reply', 'paragraph'])
})

test('只多了新消息：与原来的增量逐字节一致（lastUserMessage），不包标签', () => {
  const frag = build(msg('m1', '第一问'), reply('r1', 'fake', '答一'), msg('m2', '第二问\n第二段'))
  expect(prompt(frag, 'r1')).toBe(lastUserMessage(serializeDoc(frag)))
  expect(prompt(frag, 'r1')).toBe('第二问\n第二段')
})

test('记住的那块被删了（不在视图里）：只发新消息', () => {
  const frag = build(msg('m1', '第一问'), reply('r1', 'fake', '答一'), msg('m2', '第二问'))
  expect(prompt(frag, 'gone')).toBe('第二问')
})

test('中间多了别人的消息、别的机器上的回复与文档段落：带标签与署名的一段 + 新消息', () => {
  const frag = build(
    msg('m1', '第一问', 'u1'),
    reply('r1', 'fake', '答一'),
    msg('m2', '换台机器问', 'u2'),
    reply('r2', 'c:m2:codex', '在 laptop 上答', 'run-y'),
    para('随手记的一段'),
    para('又一段'),
    msg('m3', '回到原来的', 'u1'),
  )
  expect(prompt(frag, 'r1')).toBe(
    [
      '<ramet-catch-up>',
      '你上次回复之后，对话里新增了下面这些内容（来自共享文档，不是你说的，也不一定是当前用户说的）：',
      '',
      '[bob 的消息]',
      '>> 换台机器问',
      '',
      '[Codex（laptop）的回复]',
      '> 过程 page:run-y（共 2 步）：',
      '> - 读取 src/a.ts',
      '> - 执行 npm test',
      '> 在 laptop 上答',
      '',
      '[文档内容]',
      '随手记的一段',
      '',
      '又一段',
      '</ramet-catch-up>',
      '',
      '回到原来的',
    ].join('\n'),
  )
})

test('没有作者 / 认不出的 agent：写「用户」/ 原 id', () => {
  const frag = build(msg('m1', '一'), reply('r1', 'fake', '答'), msg('m2', '插话'), reply('r2', 'ghost', '鬼答'), msg('m3', '新'))
  const out = prompt(frag, 'r1')
  expect(out).toContain('[用户的消息]\n>> 插话')
  expect(out).toContain('[ghost 的回复]\n> 鬼答')
})

test('任务通知（带 notice 的用户消息）：头一行标明不是用户发的；做新消息时原样发，补发时署名「Ramet 的任务通知」', () => {
  const notice = (id: string, text: string): Y.XmlElement => el('user_message', { id, notice: 'done', task: 't1' }, text)
  const frag = build(msg('m1', '派个活'), reply('r1', 'fake', '派好了'), notice('n1', '任务 一 已完成'), notice('n2', '任务 二 已完成'))
  expect(prompt(frag, 'r1')).toBe(
    [
      '<ramet-catch-up>',
      '你上次回复之后，对话里新增了下面这些内容（来自共享文档，不是你说的，也不一定是当前用户说的）：',
      '',
      '[Ramet 的任务通知]',
      '>> [Ramet 任务通知：不是用户发的]',
      '>> ',
      '>> 任务 一 已完成',
      '</ramet-catch-up>',
      '',
      '[Ramet 任务通知：不是用户发的]',
      '',
      '任务 二 已完成',
    ].join('\n'),
  )
})

test('定时提醒（notice=timer）：头一行标明是定时到点、不是用户此刻发的；补发时署名「Ramet 的定时提醒」', () => {
  const timer = (id: string, text: string): Y.XmlElement => el('user_message', { id, notice: 'timer', timer: 'tm1' }, text)
  const frag = build(msg('m1', '每天提醒我'), reply('r1', 'fake', '设好了'), timer('n1', '定时「喝水」· 每天 09:00'), timer('n2', '定时「日报」· 每天 18:00'))
  const out = prompt(frag, 'r1')
  expect(out).toContain('[Ramet 的定时提醒]\n>> [Ramet 定时提醒：不是用户此刻发的，是用户设的定时到点了]')
  expect(out.endsWith('[Ramet 定时提醒：不是用户此刻发的，是用户设的定时到点了]\n\n定时「日报」· 每天 18:00')).toBe(true)
})

test('@ 链：新消息之后已有前一家的回复，放在新消息后面另起一段（顺序不变）', () => {
  const frag = build(msg('m1', '一'), reply('r1', 'fake', '答'), msg('m2', '@A @B 看看'), reply('r2', 'c:m2:codex', 'A 的看法'))
  expect(prompt(frag, 'r1')).toBe(
    ['@A @B 看看', '', '<ramet-catch-up>', '这条消息之后，对话里接着有：', '', '[Codex（laptop）的回复]', '> A 的看法', '</ramet-catch-up>'].join('\n'),
  )
})

test('超过上限：最近的块完整，更早的只留署名 + read_page 定位；无档不提 read_page', () => {
  const big = 'x'.repeat(CATCH_UP_MAX_CHARS - 4)
  const frag = build(msg('m1', '一'), reply('r1', 'fake', '答'), msg('m2', '很早的', 'u2'), para('早先的段落'), reply('r2', 'fake', big), msg('m3', '新'))
  const out = prompt(frag, 'r1')
  expect(out).toContain('[bob 的消息]（较早的内容略，需要时用 read_page 读 page:P#m2）')
  expect(out).toContain('[文档内容]（较早的内容略，需要时用 read_page 读 page:P）')
  expect(out).toContain(`[Fake 的回复]\n> ${big}`)
  expect(out.endsWith('</ramet-catch-up>\n\n新')).toBe(true)
  const none = prompt(frag, 'r1', env('none'))
  expect(none).toContain('[bob 的消息]（较早的内容略）')
  expect(none).not.toContain('read_page')
})

test('deltaPrompt：有 seen 走补发；老记录 hash 相等只发新消息、不等 null（全文重放）', () => {
  const frag = build(msg('m1', '第一问'), reply('r1', 'fake', '答一'), msg('m2', '第二问'))
  const e = env('full', '记忆')
  const docText = serializeDoc(frag, frag.length, e)
  const view = { fragment: frag, end: frag.length, docText, env: e, names, pageId: 'P' }
  const base = { sessionId: 's', cwd: '/' }
  expect(deltaPrompt({ ...base, seen: 'r1' }, view)).toBe('第二问')
  expect(deltaPrompt({ ...base, seen: 'm1' }, view)).toContain('[Fake 的回复]\n> 答一')
  const legacy = promptHash('记忆', stripLastUserMessage(docText))
  expect(deltaPrompt({ ...base, lastSyncedHash: legacy }, view)).toBe('第二问')
  expect(deltaPrompt({ ...base, lastSyncedHash: 'stale' }, view)).toBeNull()
})
