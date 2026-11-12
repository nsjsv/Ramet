import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/kit/prose/model'
import type { Comment } from './comments-api'
import { blockText, COMMENT_CLIP, mentionReplyBody, QUOTE_CLIP, threadReplyBody, threadText } from './reply-context'

const c = (id: string, name: string | null, body: string, deleted = false): Comment => ({
  id,
  author: name === null ? null : { id: `u-${name}`, name },
  body,
  createdAt: '2026-11-09T00:00:00Z',
  editedAt: null,
  deleted,
})
const omitted = (n: number): string => `（省略 ${n} 条）`

describe('代回复的上下文', () => {
  it('整串评论按时间写成「作者：内容」：提及记号降成 @名字、删掉的不带、已注销的写占位名、多行内容缩进', () => {
    const text = threadText(
      [c('1', 'bob', '@[alice](user:u-alice) 这段对吗？'), c('2', 'carol', '', true), c('3', null, '我觉得\n不对'), c('4', 'alice', '@[Genet](agent:ramet:assistant) 看看')],
      '已注销用户',
      omitted,
    )
    expect(text).toBe('bob：@alice 这段对吗？\n已注销用户：我觉得\n  不对\nalice：@Genet 看看')
    expect(text).not.toContain('user:')
  })

  it('超预算：首条必留，其余从最近的往前留，中间注明省略了几条；单条太长截断', () => {
    const many = Array.from({ length: 10 }, (_, i) => c(String(i), `u${i}`, `第 ${i} 条`))
    const text = threadText(many, 'x', omitted, 30)
    const lines = text.split('\n')
    expect(lines[0]).toBe('u0：第 0 条')
    expect(lines[1]).toMatch(/^（省略 \d+ 条）$/)
    expect(lines.at(-1)).toBe('u9：第 9 条')
    expect(lines.length).toBeLessThan(10)
    const long = threadText([c('1', 'bob', '字'.repeat(COMMENT_CLIP + 10))], 'x', omitted)
    expect(long).toBe(`bob：${'字'.repeat(COMMENT_CLIP)}…`)
    expect(threadText([c('1', 'bob', '', true)], 'x', omitted)).toBe('')
  })

  it('请求体：回复串带标题 / 划词原文 / 评论串；正文 @ 只带标题与那一段；我是谁不带（服务端按登录的人填）', () => {
    const body = threadReplyBody({ instruction: '起草', title: ' 周报 ', quote: '原文', comments: [c('1', 'bob', '你看下')], deletedUser: 'x', omitted })
    expect(body).toEqual({ kind: 'reply', instruction: '起草', title: '周报', quote: '原文', text: 'bob：你看下' })
    const mention = mentionReplyBody({ instruction: '回应', title: '周报', quote: `请 @alice 看一下${'长'.repeat(QUOTE_CLIP)}` })
    expect(mention.kind).toBe('reply')
    expect(mention.text).toBeUndefined()
    expect([...mention.quote!].length).toBe(QUOTE_CLIP + 1)
    expect(Object.keys(mention)).not.toContain('me')
  })

  it('那一块的文字：@ 成员写成 @名字，带 leafText 的原子照它的，列表项里的几段换行', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        text: { group: 'inline' },
        user_mention: { group: 'inline', inline: true, atom: true, attrs: { userId: { default: '' }, name: { default: '' } } },
        math: { group: 'inline', inline: true, atom: true, attrs: { latex: { default: '' } }, leafText: (n) => `$${String(n.attrs.latex)}$` },
        paragraph: { group: 'block', content: 'inline*' },
        list_item: { group: 'block', content: 'paragraph+' },
      },
    })
    const n = schema.nodes
    const para = n.paragraph!.create(null, [schema.text('请 '), n.user_mention!.create({ userId: 'u-1', name: 'alice' }), schema.text(' 看 '), n.math!.create({ latex: 'x^2' })])
    expect(blockText(para)).toBe('请 @alice 看 $x^2$')
    expect(blockText(n.list_item!.create(null, [para, n.paragraph!.create(null, schema.text('第二段'))]))).toBe('请 @alice 看 $x^2$\n第二段')
  })
})
