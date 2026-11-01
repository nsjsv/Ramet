import { describe, expect, test } from 'vitest'
import { toolOf } from '@ramet/shared/reply-stats'
import { agentsForPage } from './default-agent'

describe('工具名 toolOf（两端同一份）', () => {
  test('本机 agent 的 id 就是工具名', () => {
    expect(toolOf('claude')).toBe('claude')
    expect(toolOf('codex')).toBe('codex')
  })

  test('connector 上的 agent 取第二个冒号之后的部分，工具名自身可含冒号', () => {
    expect(toolOf('c:7f1c2d3e-0000-4000-8000-000000000001:claude')).toBe('claude')
    expect(toolOf('c:abc:my:tool')).toBe('my:tool')
  })

  test('形状不对的 c: 前缀原样返回', () => {
    expect(toolOf('c:')).toBe('c:')
    expect(toolOf('c::claude')).toBe('c::claude')
    expect(toolOf('')).toBe('')
  })
})

describe('agentsForPage：这一页能选的 agent', () => {
  const list = [{ id: 'claude' }, { id: 'c:m1:claude' }, { id: 'c:m2:codex' }, { id: 'c:m2:claude' }, { id: 'pi' }]

  test('没锁（还没有回复）：全部原样', () => {
    expect(agentsForPage(list, '')).toBe(list)
  })

  test('锁定后只留这个工具在各台机器上的 agent', () => {
    expect(agentsForPage(list, 'claude').map((a) => a.id)).toEqual(['claude', 'c:m1:claude', 'c:m2:claude'])
    expect(agentsForPage(list, 'codex').map((a) => a.id)).toEqual(['c:m2:codex'])
  })

  test('锁定的工具一台在线的都没有：空列表，不回落到别的工具', () => {
    expect(agentsForPage(list, 'gemini')).toEqual([])
  })
})
