import { describe, expect, test } from 'vitest'
import type { AgentInfo } from '../api'
import { agentShortLabel, authorLabel, QUICK_AUTHOR } from './labels'

const agents = [{ id: 'c:m1:claude', label: '我的电脑 · Claude' }] as unknown as AgentInfo[]

describe('authorLabel：改动列表里「谁改的」', () => {
  test('没有 by = 你；quick = 你（随手 AI）；agent 的 catalog id = agent 短名', () => {
    expect(authorLabel(undefined, agents, '你', '你（随手 AI）')).toBe('你')
    expect(authorLabel(QUICK_AUTHOR, agents, '你', '你（随手 AI）')).toBe('你（随手 AI）')
    expect(authorLabel('c:m1:claude', agents, '你', '你（随手 AI）')).toBe('Claude')
  })

  test('目录里已经没有的 agent 退回原生 id；随手 AI 的标记不会被当成 agent id', () => {
    expect(agentShortLabel('c:gone:codex', agents)).toBe('codex')
    expect(authorLabel('c:gone:codex', agents, '你', '你（随手 AI）')).toBe('codex')
  })
})
