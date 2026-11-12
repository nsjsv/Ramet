import { describe, expect, it } from 'vitest'
import { GENET_MARK, MENTION_MARK, plainBody, spaceAiMark } from './comments-api'

describe('评论正文的提及记号', () => {
  it('成员与 Genet 都认，摘要里只留名字', () => {
    expect(GENET_MARK).toBe('@[Genet](agent:ramet:assistant)')
    const body = `${GENET_MARK} 帮 @[bob](user:u-1) 看看`
    expect([...body.matchAll(MENTION_MARK)].map((m) => m[2])).toEqual(['agent:ramet:assistant', 'user:u-1'])
    expect(plainBody(body)).toBe('@Genet 帮 @bob 看看')
  })

  it('空间 AI 的记号也认；几种记号挨着各认各的，不互相吞', () => {
    expect(spaceAiMark('小助手')).toBe('@[小助手](agent:ramet:space-ai)')
    const body = `@[bob](user:u-1) 问 ${spaceAiMark('小助手')} 一下`
    expect([...body.matchAll(MENTION_MARK)].map((m) => [m[1], m[2]])).toEqual([
      ['bob', 'user:u-1'],
      ['小助手', 'agent:ramet:space-ai'],
    ])
    expect(plainBody(body)).toBe('@bob 问 @小助手 一下')
  })

  it('别的 agent 记号不认（评论里叫不动）', () => {
    expect(plainBody('@[Codex](agent:codex) 你好')).toBe('@[Codex](agent:codex) 你好')
  })
})
