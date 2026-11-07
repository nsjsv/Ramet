// Genet 的纯函数：任务链接的写法、任务状态的判定（与前端失败条同口径）、会话历史留下来的形状。不碰数据库
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { encodeStats, type ReplyOutcome } from '@ramet/shared/reply-stats'
import { ASSISTANT_ID, taskMention } from './assistant-agent.js'
import { agentNames } from './agent-names.js'
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type AssistantMessage, type ImageContent, type Message, type ToolResultMessage } from '@earendil-works/pi-ai'
import { forStorage, HISTORY_MAX_CHARS, isStoredHistory } from './drivers/assistant/history.js'
import { replyStatus } from './run-status.js'

describe('taskMention：回复里的任务链接', () => {
  // 回复的 markdown 落块时（@ramet/shared/markdown-blocks）「文字恰为 @名字、只有这一个 page: 链接」直接落成 page_mention：
  // 这里证明 Genet 写出来的链接正好是这个形状，标题原样回来
  const TASK = '0b6c2d7e-1f3a-4c5b-9d8e-7a6b5c4d3e2f'
  const mentions = (title: string) => {
    const { blocks } = parseBlocks(`派好了：${taskMention(title, TASK)}`)
    return (blocks[0]?.inlines ?? []).filter((i) => 'atom' in i)
  }

  it('[@标题](page:<id>)：落成一颗页面提及', () => {
    expect(taskMention('修 bug', TASK)).toBe(`[@修 bug](page:${TASK})`)
    expect(mentions('修 bug')).toEqual([{ atom: 'page_mention', attrs: { pageId: TASK, title: '修 bug' } }])
  })

  it('标题里的 markdown 记号、==高亮== 都不拆开它，标题原样回来', () => {
    for (const title of ['**加粗** 与 _斜体_', '[方括号] (圆括号)', 'a `code` ~删~ ==高亮== $x$', '路径 a/b\\c & <tag> #1', '换\n行   空白', 'a===b']) {
      expect(mentions(title)).toEqual([{ atom: 'page_mention', attrs: { pageId: TASK, title: title.replace(/\s+/g, ' ').trim() } }])
    }
  })
})

describe('replyStatus：与前端失败条同口径', () => {
  // 前端 web/src/editor/reply-fail.ts：isFailedReply = decodeStats(stats).o === 'error'，isStoppedReply = … === 'cancelled'。
  // 读的只有顶层 agent_reply 块的 stats 属性，结果位 o（run / end / cancelled / error）；这里逐个对照
  const doc = (...replies: Array<ReplyOutcome | null>): Y.XmlFragment => {
    const d = new Y.Doc()
    const frag = d.getXmlFragment('prosemirror')
    const msg = new Y.XmlElement('user_message')
    frag.insert(0, [msg])
    for (const o of replies) {
      const reply = new Y.XmlElement('agent_reply')
      if (o) reply.setAttribute('stats', encodeStats({ o, ms: 1200, st: 2 }))
      frag.insert(frag.length, [reply])
    }
    return frag
  }

  it('没有回复 = idle', () => expect(replyStatus(doc())).toBe('idle'))
  it('o:error（isFailedReply）= failed', () => expect(replyStatus(doc('error'))).toBe('failed'))
  it('o:cancelled（isStoppedReply）= failed', () => expect(replyStatus(doc('cancelled'))).toBe('failed'))
  it('o:end = done', () => expect(replyStatus(doc('end'))).toBe('done'))
  it('o:run（占位块还没收尾）= running', () => expect(replyStatus(doc('run'))).toBe('running'))
  it('没有 stats 的老回复 = done（既不是失败也不是停止）', () => expect(replyStatus(doc(null))).toBe('done'))
  it('看的是最后一块回复', () => {
    expect(replyStatus(doc('error', 'end'))).toBe('done')
    expect(replyStatus(doc('end', 'cancelled'))).toBe('failed')
  })
})

describe('forStorage：留下来的历史', () => {
  const user = (text: string, images: ImageContent[] = []): Message => ({ role: 'user', content: [{ type: 'text', text }, ...images], timestamp: 1 })
  const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): Message => ({ ...fauxAssistantMessage(content, { stopReason }), timestamp: 2 })
  const result = (id: string, content: ToolResultMessage['content']): Message => ({ role: 'toolResult', toolCallId: id, toolName: 't', content, isError: false, timestamp: 3 })

  it('图片字节换成说明、system 消息不存；文字、调用、思考块（含签名）照留', () => {
    const kept = forStorage([
      { role: 'system', content: '提示词', timestamp: 0 },
      user('看图', [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]),
      reply([fauxThinking('想想'), fauxText('好'), fauxToolCall('read_image', { fileId: 'f' }, { id: 'c1' })], 'toolUse'),
      result('c1', [{ type: 'image', mimeType: 'image/webp', data: 'BBBB' }]),
    ])
    expect(kept.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult'])
    expect(JSON.stringify(kept)).not.toContain('AAAA')
    expect(JSON.stringify(kept)).not.toContain('BBBB')
    expect(JSON.stringify(kept[0])).toContain('read_image')
    expect(JSON.stringify(kept[2])).toContain('read_image')
    expect((kept[1] as AssistantMessage).content.map((c) => c.type)).toEqual(['thinking', 'text', 'toolCall'])
  })

  it('超了从最早的一轮删起，开头总是一条用户消息；最后一轮哪怕自己就超了也留着', () => {
    const big = 'x'.repeat(HISTORY_MAX_CHARS / 3)
    const turn = (n: number): Message[] => [
      user(`q${n}`),
      reply([fauxText(big), fauxToolCall('t', {}, { id: `c${n}` })], 'toolUse'),
      result(`c${n}`, [{ type: 'text', text: 'r' }]),
      reply([fauxText(`a${n}`)]),
    ]
    const kept = forStorage([...turn(1), ...turn(2), ...turn(3), ...turn(4)])
    expect(kept[0]).toEqual(user('q3'))
    expect(kept).toHaveLength(8)
    const huge = forStorage([...turn(1), user('y'.repeat(HISTORY_MAX_CHARS * 2))])
    expect(huge).toHaveLength(1)
    expect(huge[0]!.role).toBe('user')
  })

  it('isStoredHistory：认得 pi 的消息，不认别的形状（如中性格式 {role, text}）', () => {
    expect(isStoredHistory([])).toBe(true)
    expect(isStoredHistory([user('q'), reply([fauxText('a')])])).toBe(true)
    expect(isStoredHistory([{ role: 'user', text: '旧' }])).toBe(false)
    expect(isStoredHistory([{ role: 'tool', results: [], timestamp: 1 }])).toBe(false)
    expect(isStoredHistory({ messages: [] })).toBe(false)
  })
})

describe('agentNames：服务端唯一的显示名来源', () => {
  it('Genet 是固定的名字，本机 agent 用配置里的，认不出的不在结果里；没有 connector 上的 agent 就不查库', async () => {
    const pool = { query: () => Promise.reject(new Error('不该查库')) }
    const host = { localAgents: () => [{ id: 'fake', label: 'Fake' }], onlineAgents: () => undefined }
    const names = await agentNames(pool, host, [ASSISTANT_ID, 'fake', 'nope', ASSISTANT_ID])
    expect([...names]).toEqual([
      [ASSISTANT_ID, { label: 'Genet' }],
      ['fake', { label: 'Fake' }],
    ])
  })
})
