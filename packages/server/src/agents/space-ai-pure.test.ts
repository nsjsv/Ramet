// 空间 AI 的纯函数：凭证白名单、工具清单、名字、给页面 agent 签凭证的上下文
import { describe, expect, it } from 'vitest'
import { narrowedAllowed, normalizeSpaceAiName, pageToolCtx, SPACE_AI_ID, spaceTools } from './space-ai.js'
import { ToolLockedError } from './manager-types.js'

describe('凭证白名单', () => {
  it('只放行读 / 搜 / skill / 建移改名删页 / 提议记忆；方法也要对得上', () => {
    expect(narrowedAllowed('GET', '/api/ramet/tools', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/search', false)).toBe(true)
    expect(narrowedAllowed('GET', '/api/ramet/skills/周报', false)).toBe(true)
    expect(narrowedAllowed('GET', '/api/ramet/skills/周报/file', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/pages', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/pages/abc/move', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/pages/abc/rename', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/pages/abc/trash', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/memories/propose', false)).toBe(true)
    expect(narrowedAllowed('DELETE', '/api/ramet/pages/abc/trash', false)).toBe(false)
    expect(narrowedAllowed('GET', '/api/ramet/search', false)).toBe(false)
    for (const path of ['/api/ramet/dispatch', '/api/ramet/run-agent', '/api/ramet/wait-task', '/api/ramet/mark-handled', '/api/ramet/comments/reply', '/api/ramet/timers', '/api/ramet/watches', '/api/ramet/team/plan', '/api/ramet/pages/a/b/move', '/api/ramet/new-thing']) {
      expect([path, narrowedAllowed('POST', path, false)]).toEqual([path, false])
    }
  })

  it('只读再去掉有副作用的', () => {
    expect(narrowedAllowed('POST', '/api/ramet/search', true)).toBe(true)
    expect(narrowedAllowed('GET', '/api/ramet/skills/x', true)).toBe(true)
    expect(narrowedAllowed('GET', '/api/ramet/collections/c1', true)).toBe(true)
    expect(narrowedAllowed('GET', '/api/ramet/collections/c1/rows', true)).toBe(false)
    expect(narrowedAllowed('POST', '/api/ramet/rows/set', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/rows/set', true)).toBe(false)
    expect(narrowedAllowed('POST', '/api/ramet/collections', false)).toBe(true)
    expect(narrowedAllowed('POST', '/api/ramet/collections/c1/schema', true)).toBe(false)
    expect(narrowedAllowed('POST', '/api/ramet/pages', true)).toBe(false)
    expect(narrowedAllowed('POST', '/api/ramet/pages/abc/trash', true)).toBe(false)
    expect(narrowedAllowed('POST', '/api/ramet/memories/propose', true)).toBe(false)
  })
})

describe('工具清单与凭证上下文', () => {
  it('读写全有 / 只读只有读的；有 skill 才列 use_skill', () => {
    expect(spaceTools(false, false)).toEqual(['read_page', 'read_image', 'read_collection', 'search_pages', 'edit_page', 'set_props', 'create_collection', 'edit_collection', 'create_page', 'move_page', 'rename_page', 'trash_page', 'propose_memory'])
    expect(spaceTools(true, true)).toEqual(['read_page', 'read_image', 'read_collection', 'search_pages', 'use_skill'])
  })

  it('空间 AI 的凭证带空间、不能叫人；别的 agent 同原来', () => {
    expect(pageToolCtx({ id: SPACE_AI_ID, space: { id: 's1' } }, 'p', 'full')).toEqual({ pageId: 'p', agentId: SPACE_AI_ID, canDispatch: false, space: 's1' })
    expect(pageToolCtx({ id: SPACE_AI_ID, space: { id: 's1' } }, 'p', 'minimal')).toEqual({ pageId: 'p', agentId: SPACE_AI_ID, canDispatch: false, profile: 'minimal', space: 's1' })
    expect(pageToolCtx({ id: 'fake' }, 'p', 'full')).toEqual({ pageId: 'p', agentId: 'fake', canDispatch: true })
    expect(pageToolCtx({ id: 'fake' }, 'p', 'minimal')).toEqual({ pageId: 'p', agentId: 'fake', canDispatch: false, profile: 'minimal' })
  })

  it('名字：trim、压空白，1–20 字（按码点数）', () => {
    expect(normalizeSpaceAiName('  小 助手 ')).toBe('小 助手')
    expect(normalizeSpaceAiName('')).toBeNull()
    expect(normalizeSpaceAiName('  ')).toBeNull()
    expect(normalizeSpaceAiName(3)).toBeNull()
    expect(normalizeSpaceAiName('🤖'.repeat(20))).toBe('🤖'.repeat(20))
    expect(normalizeSpaceAiName('一'.repeat(21))).toBeNull()
  })
})

describe('锁定工具的报错', () => {
  it('锁成空间 AI：失败条上写「空间 AI」，不把内部 id 给用户看；各家 CLI 照写工具名', () => {
    expect(new ToolLockedError(SPACE_AI_ID).message).toBe('这个对话用的是 空间 AI，换工具请新开一页')
    expect(new ToolLockedError(SPACE_AI_ID, true).message).toBe('这个对话用的是 空间 AI，现在没有可用的 空间 AI')
    expect(new ToolLockedError('codex').message).toBe('这个对话用的是 codex，换工具请新开一页')
  })
})
