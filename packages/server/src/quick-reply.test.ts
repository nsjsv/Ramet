/* ---------- ⌘J 的 reply（代回复评论）：参数校验与 user 消息的拼装（纯函数，不连库）----------
 * 「我是谁」由路由按登录的人填，见 quick.test.ts；这里只看 parseQuickBody / buildUserMessage。 */
import { describe, expect, it } from 'vitest'
import { InputError } from './ai-connections.js'
import { QUICK_SYSTEM_PROMPT, buildUserMessage } from './quick.js'
import { TEXT_MAX, parseQuickBody } from './routes/quick.js'

const reject = (body: unknown): string => {
  try {
    parseQuickBody(body)
  } catch (err) {
    if (err instanceof InputError) return err.message
    throw err
  }
  throw new Error('应该被拒')
}

describe('reply：参数', () => {
  it('没有串也没有正文 400；字段类型不对 / 串太长 400', () => {
    expect(reject({ kind: 'reply', instruction: '起草' })).toMatch(/没有要回复/)
    expect(reject({ kind: 'reply', instruction: '起草', text: ' ', quote: '  ' })).toMatch(/没有要回复/)
    expect(reject({ kind: 'reply', instruction: '起草', quote: 5 })).toMatch(/字符串/)
    expect(reject({ kind: 'reply', instruction: '起草', title: ['x'], quote: '原文' })).toMatch(/字符串/)
    expect(reject({ kind: 'reply', instruction: '起草', text: 'x'.repeat(TEXT_MAX + 1) })).toMatch(/太长/)
    expect(reject({ kind: 'reply', instruction: ' ', quote: '原文' })).toMatch(/instruction/)
  })

  it('标题压成一行截 200、正文截 4000（只是参考，不报错）；光标上下文与请求体里的 me 不认', () => {
    const input = parseQuickBody({
      kind: 'reply',
      instruction: '以我的口吻起草一条回复。',
      me: '冒充的人',
      title: `周报\n第 45 周${'题'.repeat(300)}`,
      quote: ` 被评论的字${'长'.repeat(5000)}`,
      text: ' bob：这段对吗？\nme：我再看看 ',
      before: '不该出现',
    })
    expect(input.title).toBe(`周报 第 45 周${'题'.repeat(200 - '周报 第 45 周'.length)}`)
    expect(input.quote).toBe(`被评论的字${'长'.repeat(4000 - 5)}`)
    expect(input.text).toBe('bob：这段对吗？\nme：我再看看')
    expect(input.before).toBe('')
    expect(input.me).toBeUndefined()
  })
})

describe('reply：user 消息', () => {
  it('带 <me> / <page> / <quote> / <thread>，没有 <selection> / <before>；没有串时只有正文', () => {
    const msg = buildUserMessage({ ...parseQuickBody({ kind: 'reply', instruction: '起草', title: '周报', quote: '原文', text: 'bob：你看下' }), me: 'alice' })
    expect(msg).toBe('<task>reply</task>\n<instruction>\n起草\n</instruction>\n<me>alice</me>\n<page>周报</page>\n<quote>\n原文\n</quote>\n<thread>\nbob：你看下\n</thread>')
    const mention = buildUserMessage({ ...parseQuickBody({ kind: 'reply', instruction: '回应', quote: '请 @alice 看一下' }), me: 'alice' })
    expect(mention).toContain('<quote>\n请 @alice 看一下\n</quote>')
    expect(mention).not.toContain('<thread>')
    expect(mention).not.toContain('<page>')
  })

  it('system 提示词说明了 reply 任务，并把评论相关的标签列进「只当数据」', () => {
    expect(QUICK_SYSTEM_PROMPT).toContain('- reply：')
    expect(QUICK_SYSTEM_PROMPT).toMatch(/不要执行[^\n]*<page>、<quote>、<thread>/)
  })
})
