/* ---------- 一轮的统计口径（shared/run-tally.ts）：岛、工作台面板、回复块 stats 共用 ---------- */
import { expect, test } from 'vitest'
import { decodeStats } from '@ramet/shared/reply-stats'
import { runTally, type RunEntry, type ToolEntry } from '@ramet/shared/run-model'
import { RunRecord } from './run-record.js'

const tool = (id: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({ k: 'tool', id, kind: 'other', title: id, status: 'completed', ...extra })
const diff = (path: string, oldText: string, newText: string) => ({ type: 'diff', path, oldText, newText })

test('改动：编辑类步骤的 diff 按路径累加增减行；没有 diff 的按 locations 记文件；失败的编辑不算', () => {
  const entries: RunEntry[] = [
    tool('e1', { kind: 'edit', acp: { content: [diff('/a.ts', 'x\ny\n', 'x\nY\nz\n')] } }),
    tool('e2', { kind: 'edit', acp: { content: [diff('/a.ts', 'z\n', '')] } }),
    tool('e3', { kind: 'edit', acp: { locations: [{ path: '/b.ts' }] } }),
    tool('e4', { kind: 'edit', status: 'failed', acp: { content: [diff('/c.ts', '', 'q\n')] } }),
    tool('r1', { kind: 'read', acp: { locations: [{ path: '/d.ts' }] } }),
  ]
  const t = runTally({ entries }, 1000)
  expect(t.files).toEqual([
    { path: '/a.ts', add: 2, del: 2 },
    { path: '/b.ts', add: 0, del: 0 },
  ])
  expect(t.steps).toBe(5)
  expect(t.failed).toBe(1)
})

test('协作：子代理（被 parentId 引用）/ run_agent（acp.subRun）/ 带队组员', () => {
  const entries: RunEntry[] = [
    tool('task', { title: 'Task: 查资料', status: 'in_progress' }),
    tool('child', { parentId: 'task', kind: 'read' }),
    tool('call', { acp: { subRun: { agent: 'c:1:codex', label: 'Codex', outcome: 'end' } } }),
  ]
  const team = {
    planId: 'p', title: '计划', leader: 'claude', status: 'running' as const,
    tasks: [{ id: 't1', title: '写测试', assignee: 'codex', dependsOn: [], status: 'pending' as const, spans: [] }],
  }
  expect(runTally({ entries, team }, 0).agents).toEqual([
    { id: 'task', kind: 'sub', label: 'Task: 查资料', status: 'running' },
    { id: 'call', kind: 'call', agent: 'c:1:codex', label: 'Codex', status: 'done' },
    { id: 'team:t1', kind: 'team', agent: 'codex', label: '写测试', status: 'waiting' },
  ])
})

test('时间花在哪：顶层步骤按 kind 归类，子代理里的步骤不重复算；思考 = 余数且不为负；问过你几次', () => {
  const entries: RunEntry[] = [
    tool('e', { kind: 'edit', t: 0, end: 100 }),
    tool('x', { kind: 'execute', t: 100, end: 400, acp: { permission: { options: [] } } }),
    tool('s', { kind: 'search', t: 400, end: 450 }),
    tool('task', { t: 450, end: 700 }),
    tool('in-task', { parentId: 'task', kind: 'execute', t: 500, end: 600 }),
  ]
  const t = runTally({ entries }, 1000)
  expect(t.spend).toEqual({ edit: 100, term: 300, read: 50, call: 250, think: 300 })
  expect(t.asks).toBe(1)
  expect(runTally({ entries }, 10).spend.think).toBe(0)
})

test('收尾的 stats 带改动 / 协作数；0 不写', () => {
  const r = new RunRecord('', Date.now(), () => undefined)
  expect(decodeStats(r.stats('end', 5, undefined))).toEqual({ o: 'end', ms: 5, st: 0 })
  r.tool({ type: 'tool', id: 'e1', kind: 'edit', status: 'completed', acp: { content: [diff('/a.ts', '', 'a\nb\n')] } })
  expect(decodeStats(r.stats('end', 5, undefined))).toMatchObject({ st: 1, fc: 1, fa: 2 })
  expect(decodeStats(r.stats('end', 5, undefined)).fd).toBeUndefined()
})
