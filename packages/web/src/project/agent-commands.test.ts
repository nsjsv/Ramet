import { expect, test } from 'vitest'
import type { RunEntry, ToolEntry } from '@ramet/shared/run-model'
import type { Page } from '../api'
import { agentCommandsOf, mergeCommands, recentRunPages, rememberCommands } from './agent-commands'

const tool = (id: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ k: 'tool', id, kind: 'execute', title: `cmd ${id}`, status: 'completed', ...extra })

test('只列命令类步骤；命令行取 rawInput.command，没有就用标题；状态：运行中 / 完成 / 失败（含退出码非 0、被信号终止）', () => {
  const entries: RunEntry[] = [
    { k: 'say', text: '先跑测试' },
    tool('a', { status: 'in_progress', acp: { rawInput: { command: 'npm test' }, content: [{ type: 'terminal', terminalId: 'T-a' }] } }),
    tool('b'),
    tool('c', { acp: { terminalExit: { exitCode: 1, signal: null } } }),
    tool('d', { acp: { terminalExit: { exitCode: null, signal: 'SIGTERM' } } }),
    tool('e', { status: 'failed' }),
    tool('r', { kind: 'read' }),
  ]
  const cmds = agentCommandsOf('reply-1', entries)
  expect(cmds.map((c) => [c.key, c.command, c.state, c.exitCode, c.signal, c.terminalId])).toEqual([
    ['reply-1:a', 'npm test', 'running', null, null, 'T-a'],
    ['reply-1:b', 'cmd b', 'done', null, null, null],
    ['reply-1:c', 'cmd c', 'failed', 1, null, null],
    ['reply-1:d', 'cmd d', 'failed', null, 'SIGTERM', null],
    ['reply-1:e', 'cmd e', 'failed', null, null, null],
  ])
})

test('rememberCommands：同 key 更新、新的追加，超过上限丢最老的；一轮结束 run 被清掉后看过的还在', () => {
  const mk = (key: string, state: 'running' | 'done' = 'running') =>
    ({ key, command: key, state, exitCode: null, signal: null, terminalId: null, entry: tool(key) }) as const
  let seen = rememberCommands([], [mk('a'), mk('b')])
  expect(seen.map((c) => c.key)).toEqual(['a', 'b'])
  seen = rememberCommands(seen, [mk('a', 'done'), mk('c')])
  expect(seen.map((c) => [c.key, c.state])).toEqual([['a', 'done'], ['b', 'running'], ['c', 'running']])
  seen = rememberCommands(seen, [], 30) // run 清掉了：什么都不丢
  expect(seen).toHaveLength(3)
  const many = rememberCommands([], Array.from({ length: 40 }, (_, i) => mk(`k${i}`)), 30)
  expect(many).toHaveLength(30)
  expect(many[0]!.key).toBe('k10')
})

test('recentRunPages：只取本页的过程页，按创建时间旧 → 新，留最近 n 轮', () => {
  const page = (id: string, kind: Page['kind'], parent_id: string | null, created_at: string) => ({ id, kind, parent_id, created_at }) as Page
  const pages = [
    page('r3', 'run', 'chat', '2026-10-22 06:10:08.389674+00'),
    page('chat', 'doc', null, '2026-10-12 06:58:32.867366+00'),
    page('r1', 'run', 'chat', '2026-10-20 01:00:00+00'),
    page('x', 'run', 'other', '2026-10-22 07:00:00+00'),
    page('r2', 'run', 'chat', '2026-10-21 01:00:00.5+00'),
    page('child', 'doc', 'chat', '2026-10-22 08:00:00+00'),
  ]
  expect(recentRunPages(pages, 'chat')).toEqual(['r1', 'r2', 'r3'])
  expect(recentRunPages(pages, 'chat', 2)).toEqual(['r2', 'r3'])
  expect(recentRunPages(null, 'chat')).toEqual([])
})

test('mergeCommands：归档的在前且为准，live 里没归档的接在后面', () => {
  const mk = (key: string, state: 'running' | 'done') =>
    ({ key, command: key, state, exitCode: null, signal: null, terminalId: null, entry: tool(key) }) as const
  const merged = mergeCommands([mk('r1:a', 'done'), mk('r2:b', 'done')], [mk('r2:b', 'running'), mk('r3:c', 'running')])
  expect(merged.map((c) => [c.key, c.state])).toEqual([['r1:a', 'done'], ['r2:b', 'done'], ['r3:c', 'running']])
  expect(mergeCommands([mk('a', 'done'), mk('b', 'done')], [mk('c', 'running')], 2).map((c) => c.key)).toEqual(['b', 'c'])
})
