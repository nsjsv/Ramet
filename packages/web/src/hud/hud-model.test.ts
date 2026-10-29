import { describe, expect, it } from 'vitest'
import { encodeStats } from '@ramet/shared/reply-stats'
import { encodePlan, runTally, type RunEntry, type RunState } from '@ramet/shared/run-model'
import type { LiveRun, PermissionReq } from '../editor/agent-bar'
import { askBarOf, dockView, highlights, hudFromLive, islandOf, spendParts } from './hud-model'

const tool = (id: string, extra: Partial<Extract<RunEntry, { k: 'tool' }>> = {}): RunEntry => ({ k: 'tool', id, kind: 'other', title: id, status: 'completed', ...extra })
const state = (entries: RunEntry[], extra: Partial<RunState> = {}): RunState => ({ entries, text: '', textAt: null, textEnd: null, textSlot: null, thoughtChars: 0, ...extra })

describe('岛：在飞的一轮', () => {
  const live: LiveRun = {
    replyId: 'r1',
    agent: 'claude',
    startedAt: 1_000,
    version: 0,
    state: state(
      [
        tool('e', { kind: 'edit', acp: { content: [{ type: 'diff', path: '/a', oldText: 'a\n', newText: 'b\n' }] } }),
        tool('task', { title: '子任务', status: 'in_progress' }),
        tool('c', { parentId: 'task' }),
      ],
      { plan: [{ content: '一', status: 'completed' }, { content: '二', status: 'in_progress' }] },
    ),
  }
  it('分段：任务进度、改动增减行、协作；有待批时是审批条', () => {
    const run = hudFromLive(live, 4_000)
    expect(run.ms).toBe(3_000)
    const view = islandOf(run, runTally(run, run.ms), false)
    expect(view).toMatchObject({ agent: 'claude', phase: 'live', steps: 3, plan: { done: 1, total: 2, current: true }, files: { n: 1, add: 1, del: 1 } })
    expect(view.agents).toEqual({ n: 1, ids: ['claude'], live: true })
    expect(islandOf(run, runTally(run, run.ms), true).phase).toBe('ask')
    expect(islandOf({ ...run, live: false, outcome: 'cancelled' }, runTally(run, 0), true).phase).toBe('cancelled')
  })
})

describe('停靠的岛：只读回复块属性', () => {
  it('终态 stats + plan 属性；没有改动 / 协作数的老回复不出那两段；没收尾的老块是 broken', () => {
    const plan = encodePlan([{ content: '一', status: 'completed' }])
    expect(dockView({ agent: 'codex', stats: encodeStats({ o: 'end', ms: 5_000, st: 4, fc: 2, fa: 10, ag: 1 }), plan, run: 'p1' })).toEqual({
      agent: 'codex',
      phase: 'end',
      ms: 5_000,
      steps: 4,
      plan: { done: 1, total: 1, current: false },
      files: { n: 2, add: 10, del: 0 },
      agents: { n: 1, ids: [], live: false },
    })
    expect(dockView({ agent: 'x', stats: encodeStats({ o: 'end', ms: 1, st: 1 }), plan: '', run: 'p' })).toMatchObject({ files: null, agents: null, plan: null })
    expect(dockView({ agent: 'x', stats: encodeStats({ o: 'run' }), plan: '', run: null })?.phase).toBe('broken')
    expect(dockView({ agent: 'x', stats: '', plan: '', run: null })).toBeNull()
  })
})

describe('岛上的审批条', () => {
  const base: PermissionReq = { agentId: 'a', requestId: 'p', title: '运行命令', options: [{ optionId: 'allow', name: '允许' }, { optionId: 'deny', name: '拒绝' }] }
  it('审批：agent 的选项原样成按钮；提问能快选就是选项，否则只有「回答」', () => {
    expect(askBarOf(base)).toEqual({ kind: 'approve', title: '运行命令', buttons: [{ label: '允许', optionId: 'allow' }, { label: '拒绝', optionId: 'deny' }] })
    const quick = { ...base, title: 'Approve?', form: { message: 'Approve?', required: ['value'], fields: [{ key: 'value', kind: 'choice' as const, multi: false, options: [{ value: 'Approve', label: 'Approve' }] }] } }
    expect(askBarOf(quick).buttons).toEqual([{ label: 'Approve', optionId: 'accept', content: { value: 'Approve' } }])
    const full = { ...quick, form: { ...quick.form, fields: [...quick.form.fields, { key: 'note', kind: 'text' as const }] } }
    expect(askBarOf(full)).toMatchObject({ kind: 'question', buttons: null })
  })
})

describe('总览', () => {
  it('时间花在哪：固定顺序、0 的不出；要点只说数据里有的事', () => {
    const run = hudFromLive({ replyId: 'r', startedAt: 0, version: 0, state: state([tool('x', { kind: 'execute', t: 0, end: 300, status: 'failed' })]) }, 1_000)
    const tally = runTally(run, 1_000)
    expect(spendParts(tally).map((p) => [p.key, p.ms])).toEqual([['term', 300], ['think', 700]])
    expect(highlights(run, tally, () => '')).toEqual(['有 1 步失败'])
    expect(highlights({ ...run, entries: [], live: false }, runTally({ entries: [] }, 0), () => '')).toEqual(['只读排查，没有改动'])
  })
})
