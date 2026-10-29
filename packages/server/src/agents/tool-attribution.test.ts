import { expect, test } from 'vitest'
import { chunkParent, toolFace } from './tool-attribution.js'

test('claude：子步骤挂到 Agent 调用上，子正文也认这个 parent', () => {
  expect(toolFace({
    _meta: { claudeCode: { parentToolUseId: 'agent-1', toolName: 'Read' } },
  })).toEqual({ parentId: 'agent-1' })
  expect(chunkParent({ _meta: { claudeCode: { parentToolUseId: 'agent-1' } } })).toBe('agent-1')
  expect(chunkParent({})).toBeUndefined()
})

test('omp：progress 快照变成一行 activity', () => {
  expect(toolFace({
    rawOutput: { details: { progress: [{ currentTool: 'read', currentToolIntent: 'hostname' }] } },
  })).toEqual({ activity: 'read · hostname' })
})

test('codex：agentsStates 的 message 是当前动作', () => {
  expect(toolFace({
    rawInput: { agentsStates: { thr_1: { status: 'running', message: 'Reading README' } } },
  })).toEqual({ activity: 'Reading README' })
})

test('opencode：subagent_type 和 description 合成一行', () => {
  expect(toolFace({
    rawInput: { subagent_type: 'explore', description: 'Inspect fixture', prompt: 'long' },
  })).toEqual({ activity: 'explore · Inspect fixture' })
})

test('pi：agent + task 合成一行，不误伤带 subagent_type 的参数', () => {
  expect(toolFace({ rawInput: { agent: 'worker', task: 'list files' } })).toEqual({ activity: 'worker · list files' })
  expect(toolFace({ rawInput: { agent: 'worker', task: 'list files', subagent_type: 'explore' } }).activity).toBe('explore')
})
