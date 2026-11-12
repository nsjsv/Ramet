import { describe, expect, it } from 'vitest'
import { canDeleteComment, canEditComment, commentAi } from './comment-ai'
import type { Comment } from './comments-api'

const comment = (patch: Partial<Comment>): Comment => ({
  id: 'c1',
  author: { id: 'u1', name: 'bob' },
  body: 'x',
  createdAt: '2026-11-11T00:00:00Z',
  editedAt: null,
  deleted: false,
  ...patch,
})

describe('评论框 @ 菜单里的 AI', () => {
  it('个人空间没开空间 AI（或还不知道是哪个空间）：是 Genet，落成 Genet 的记号', () => {
    const genet = { id: 'ramet:assistant', label: 'Genet', mark: '@[Genet](agent:ramet:assistant)' }
    expect(commentAi(null)).toEqual(genet)
    expect(commentAi({ spaceId: 'me', enabled: false, name: 'AI', personal: true })).toEqual(genet)
  })

  it('开着空间 AI（个人空间也一样）：换成它（名字跟配置），落成它的记号', () => {
    expect(commentAi({ spaceId: 'me', enabled: true, name: '我的助手', personal: true })?.id).toBe('ramet:space-ai')
    expect(commentAi({ spaceId: 's1', enabled: true, name: '小助手', personal: false })).toEqual({
      id: 'ramet:space-ai',
      label: '小助手',
      mark: '@[小助手](agent:ramet:space-ai)',
    })
  })

  it('自建的空间没开：两个都不给（不出个人 Genet）', () => {
    expect(commentAi({ spaceId: 's1', enabled: false, name: 'AI', personal: false })).toBeNull()
  })
})

describe('谁能改 / 删（同服务端 mayDelete）', () => {
  const ai = comment({ author: { ai: 'space', name: '小助手' }, invoker: 'u2' })

  it('人写的：作者本人能改能删，owner 能删不能改，别人都不能', () => {
    const c = comment({})
    expect([canEditComment(c, 'u1'), canDeleteComment(c, 'u9', 'u1', false)]).toEqual([true, true])
    expect([canEditComment(c, 'u3'), canDeleteComment(c, 'u9', 'u3', true)]).toEqual([false, true])
    expect(canDeleteComment(c, 'u3', 'u3', false)).toBe(false)
  })

  it('AI 写的：没人能改；串的发起人、叫它的人、owner 能删，别的成员不能', () => {
    for (const me of ['u1', 'u2', 'u3']) expect(canEditComment(ai, me)).toBe(false)
    expect(canDeleteComment(ai, 'u1', 'u1', false)).toBe(true) // 串的发起人
    expect(canDeleteComment(ai, 'u1', 'u2', false)).toBe(true) // 叫它的人
    expect(canDeleteComment(ai, 'u1', 'u3', true)).toBe(true) // owner
    expect(canDeleteComment(ai, 'u1', 'u4', false)).toBe(false)
  })

  it('删掉的占位、还不知道我是谁：都不能', () => {
    expect(canDeleteComment(comment({ deleted: true }), 'u1', 'u1', true)).toBe(false)
    expect(canDeleteComment(ai, undefined, '', false)).toBe(false)
    expect(canEditComment(comment({}), '')).toBe(false)
  })
})
