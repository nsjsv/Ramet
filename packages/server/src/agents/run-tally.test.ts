/* ---------- 一轮的统计口径（shared/run-tally.ts）：岛、工作台面板、回复块 stats 共用 ---------- */
import { expect, test } from 'vitest'
import { decodeStats } from '@ramet/shared/reply-stats'
import { lineDiff, runTally, type RunEntry, type ToolEntry } from '@ramet/shared/run-model'
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

/** 改成经视图读之前的统计实现，原样留在测试里当对照：老记录的口径不能变 */
function legacyFiles(entries: RunEntry[]): { path: string; add: number; del: number }[] {
  const files = new Map<string, { path: string; add: number; del: number }>()
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const touch = (path: string, add: number, del: number) => {
    if (!path) return
    const f = files.get(path) ?? { path, add: 0, del: 0 }
    f.add += add
    f.del += del
    files.set(path, f)
  }
  for (const e of entries) {
    if (e.k !== 'tool' || !['edit', 'delete', 'move'].includes(e.kind) || e.status === 'failed') continue
    const content = Array.isArray(e.acp?.content) ? e.acp.content : []
    let diffs = 0
    for (const item of content) {
      const d = rec(item)
      if (d?.type !== 'diff') continue
      diffs++
      let add = 0
      let del = 0
      for (const line of lineDiff(str(d.oldText), str(d.newText))) {
        if (line.t === '+') add++
        else if (line.t === '-') del++
      }
      touch(str(d.path), add, del)
    }
    if (diffs > 0) continue
    const loc = Array.isArray(e.acp?.locations) ? rec(e.acp.locations[0]) : undefined
    touch(str(loc?.path) || e.detail || '', 0, 0)
  }
  return [...files.values()]
}

test('老记录（只有 ACP 载荷）的改动统计与改造前一致：文件集合、增减行', () => {
  const entries: RunEntry[] = [
    // claude-agent-acp 的 Edit：content 里整文件 diff + locations + rawInput（rawInput 的 old/new 不参与统计）
    tool('c1', {
      kind: 'edit',
      acp: {
        rawInput: { file_path: '/src/a.ts', old_string: 'b', new_string: 'B\nC' },
        content: [diff('/src/a.ts', 'a\nb\nc\n', 'a\nB\nC\nc\n')],
        locations: [{ path: '/src/a.ts' }],
      },
    }),
    // 新建文件：oldText 为 null
    tool('c2', { kind: 'edit', acp: { content: [{ type: 'diff', path: '/src/new.ts', oldText: null, newText: 'x\ny\n' }] } }),
    // 一步改了两个文件
    tool('c3', { kind: 'edit', acp: { content: [diff('/src/a.ts', 'q\n', 'r\n'), diff('/src/b.ts', '', 'z\n')] } }),
    // diff 太大被适配器省掉：只有 rawInput 与 locations —— 记文件、0 / 0（不从 rawInput 推行数）
    tool('c4', { kind: 'edit', acp: { rawInput: { file_path: '/big.ts', old_string: 'a', new_string: 'b\nc' }, locations: [{ path: '/big.ts' }] } }),
    // 只有 rawInput、没有 locations：老口径退到 detail
    tool('c5', { kind: 'edit', detail: '/d.ts', acp: { rawInput: { file_path: '/elsewhere.ts', content: 'all\nnew\n' } } }),
    // diff 没有路径：不记，也不退到 locations
    tool('c6', { kind: 'edit', acp: { content: [{ type: 'diff', oldText: 'a', newText: 'b' }], locations: [{ path: '/loc.ts' }] } }),
    tool('c7', { kind: 'delete', acp: { locations: [{ path: '/gone.ts' }] } }),
    tool('c8', { kind: 'move', detail: '/moved.ts', acp: { title: 'mv' } }),
    tool('c9', { kind: 'edit', status: 'failed', acp: { content: [diff('/fail.ts', '', 'q\n')] } }),
    tool('c10', { kind: 'read', acp: { locations: [{ path: '/read.ts' }] } }),
    // 审批折进来的步骤（只有 toolCall 与 permission）
    tool('c11', { kind: 'execute', acp: { toolCallId: 'c11', title: 'npm test', permission: { options: [] } } }),
  ]
  const t = runTally({ entries }, 1000)
  expect(t.files).toEqual(legacyFiles(entries))
  expect(t.files).toEqual([
    { path: '/src/a.ts', add: 3, del: 2 },
    { path: '/src/new.ts', add: 2, del: 0 },
    { path: '/src/b.ts', add: 1, del: 0 },
    { path: '/big.ts', add: 0, del: 0 },
    { path: '/d.ts', add: 0, del: 0 },
    { path: '/gone.ts', add: 0, del: 0 },
    { path: '/moved.ts', add: 0, del: 0 },
  ])
  expect(t.asks).toBe(1)
})

test('只有视图、没有 ACP 载荷的步骤（原生驱动）照样统计：diff、只有路径、审批记录、子运行', () => {
  const entries: RunEntry[] = [
    tool('n1', { kind: 'edit', view: { tool: 'Edit', path: '/src/a.ts', diffs: [{ path: '/src/a.ts', old: 'x\n', new: 'y\nz\n' }] } }),
    tool('n2', { kind: 'edit', view: { tool: 'Write', path: '/src/w.ts', diffs: [{ path: '/src/w.ts', old: '', new: 'one\n' }] } }),
    tool('n3', { kind: 'delete', view: { path: '/rm.ts' } }),
    tool('n4', { kind: 'edit', status: 'failed', view: { path: '/f.ts', diffs: [{ path: '/f.ts', old: '', new: 'q\n' }] } }),
    // 审批折进来：acp 里只有 Ramet 自己的键，视图照常读
    tool('n5', { kind: 'edit', acp: { toolCallId: 'n5', permission: { options: [] } }, view: { path: '/p.ts', diffs: [{ path: '/p.ts', old: 'a\n', new: 'b\n' }] } }),
    tool('n6', { acp: { subRun: { agent: 'codex', outcome: 'end' } } }),
  ]
  const t = runTally({ entries }, 0)
  expect(t.files).toEqual([
    { path: '/src/a.ts', add: 2, del: 1 },
    { path: '/src/w.ts', add: 1, del: 0 },
    { path: '/rm.ts', add: 0, del: 0 },
    { path: '/p.ts', add: 1, del: 1 },
  ])
  expect(t.asks).toBe(1)
  expect(t.agents).toEqual([{ id: 'n6', kind: 'call', agent: 'codex', label: 'codex', status: 'done' }])
})
