import { describe, expect, test } from 'vitest'
import type { TeamPlanView, TeamState, TeamTask } from '@ramet/shared/run-model'
import {
  askSource,
  assigneeLabel,
  canEditPlan,
  depNumbers,
  ganttLayout,
  isInitiator,
  isPlanSnapshot,
  isWaiting,
  startBlocker,
  taskElapsed,
  taskView,
  teamNow,
  teamWall,
  unusableIds,
} from './team-model'

const task = (id: string, extra: Partial<TeamTask> = {}): TeamTask => ({
  id,
  title: `任务 ${id}`,
  assignee: 'claude',
  dependsOn: [],
  status: 'pending',
  spans: [],
  ...extra,
})
const team = (tasks: TeamTask[], extra: Partial<TeamState> = {}): TeamState => ({
  planId: 'p1',
  title: '计划',
  leader: 'claude',
  status: 'running',
  tasks,
  ...extra,
})

describe('甘特布局', () => {
  test('一个任务都没开工 = 没有甘特', () => {
    expect(ganttLayout(team([task('a'), task('b')]))).toBeNull()
  })

  test('每个任务一行（没开工的也占一行）；条的位置与宽度按整条轴的百分比', () => {
    const g = ganttLayout(
      team([
        task('a', { status: 'done', spans: [{ t: 1000, end: 3000 }] }),
        task('b', { status: 'done', spans: [{ t: 3000, end: 5000 }] }),
        task('c'),
      ]),
    )!
    expect(g.rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(g.t0).toBe(1000)
    expect(g.total).toBe(4000)
    expect(g.rows[0]!.segs[0]).toMatchObject({ left: 0, width: 50, live: false, again: false })
    expect(g.rows[1]!.segs[0]).toMatchObject({ left: 50, width: 50 })
    expect(g.rows[2]!.segs).toEqual([])
  })

  test('还开着的段：传 now 就伸到 now 且标 live；不传（静态）就收口到已知的最晚时刻、不标 live', () => {
    const t = team([task('a', { status: 'done', spans: [{ t: 0, end: 4000 }] }), task('b', { status: 'running', spans: [{ t: 2000 }] })])
    const live = ganttLayout(t, 10_000)!
    expect(live.total).toBe(10_000)
    expect(live.rows[1]!.segs[0]).toMatchObject({ live: true, to: 10_000, left: 20, width: 80 })
    const still = ganttLayout(t)!
    expect(still.total).toBe(4000)
    expect(still.rows[1]!.segs[0]).toMatchObject({ live: false, to: 4000 })
  })

  test('最短条宽：很短的任务也看得见；时钟比开工时刻早（now < t）不出负宽', () => {
    const g = ganttLayout(team([task('a', { spans: [{ t: 0, end: 9000 }] }), task('b', { spans: [{ t: 9000, end: 9001 }] })]))!
    const tiny = g.rows[1]!.segs[0]!
    expect(tiny.width).toBeGreaterThanOrEqual(0.6)
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(100 + 1e-9)
    const skew = ganttLayout(team([task('a', { spans: [{ t: 5000 }] })]), 1000)!
    expect(skew.rows[0]!.segs[0]!.width).toBeGreaterThan(0)
  })

  test('等批准的时段：占这一段宽度的百分比；还开着的等待算到段尾；越出段的部分被夹住', () => {
    const g = ganttLayout(
      team([
        task('a', {
          spans: [{ t: 0, end: 10_000, waits: [{ t: 2000, end: 4000 }, { t: 8000 }] }],
        }),
      ]),
    )!
    const waits = g.rows[0]!.segs[0]!.waits
    expect(waits).toEqual([
      { left: 20, width: 20, ms: 2000 },
      { left: 80, width: 20, ms: 2000 },
    ])
    expect(g.hasWait).toBe(true)
    expect(ganttLayout(team([task('a', { spans: [{ t: 0, end: 5000 }] })]))!.hasWait).toBe(false)
  })

  test('打回重做 = 同一行第二段，标 again', () => {
    const g = ganttLayout(team([task('a', { status: 'done', backs: 1, spans: [{ t: 0, end: 2000 }, { t: 6000, end: 8000 }] })]))!
    expect(g.rows[0]!.segs.map((s) => s.again)).toEqual([false, true])
  })

  test('颜色槽按负责人首次出现的顺序分配，同一个 agent 恒同色；图例一一对应', () => {
    const g = ganttLayout(
      team([
        task('a', { assignee: 'codex', spans: [{ t: 0, end: 1000 }] }),
        task('b', { assignee: 'claude', spans: [{ t: 0, end: 1000 }] }),
        task('c', { assignee: 'codex', spans: [{ t: 0, end: 1000 }] }),
      ]),
    )!
    expect(g.rows.map((r) => r.slot)).toEqual([0, 1, 0])
    expect(g.legend).toEqual([
      { assignee: 'codex', slot: 0 },
      { assignee: 'claude', slot: 1 },
    ])
  })

  test('颜色槽循环使用，不越界', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, { assignee: `a${i}`, spans: [{ t: 0, end: 1000 }] }))
    const g = ganttLayout(team(tasks))!
    expect(Math.max(...g.rows.map((r) => r.slot))).toBeLessThan(5)
  })
})

describe('用时', () => {
  test('任务用时 = 各段相加（打回间隔不算）；没开始 = null；开着的段算到 now', () => {
    expect(taskElapsed(task('a'))).toBeNull()
    expect(taskElapsed(task('a', { spans: [{ t: 0, end: 2000 }, { t: 6000, end: 9000 }] }))).toBe(5000)
    expect(taskElapsed(task('a', { spans: [{ t: 1000 }] }), 4000)).toBe(3000)
  })

  test('墙钟用时 = 第一个开工到最后一个收工', () => {
    expect(teamWall(team([task('a')]))).toBe(0)
    expect(teamWall(team([task('a', { spans: [{ t: 1000, end: 3000 }] }), task('b', { spans: [{ t: 2000, end: 7000 }] })]))).toBe(6000)
    expect(teamWall(team([task('a', { spans: [{ t: 1000 }] })]), 5000)).toBe(4000)
  })
})

describe('任务的展示状态', () => {
  test('进行中 + 最后一个等待还开着 = 等你批准；等待收口了回到进行中', () => {
    const waiting = task('a', { status: 'running', spans: [{ t: 0, waits: [{ t: 100 }] }] })
    expect(isWaiting(waiting)).toBe(true)
    expect(taskView(waiting)).toBe('ask')
    const resumed = task('a', { status: 'running', spans: [{ t: 0, waits: [{ t: 100, end: 200 }] }] })
    expect(taskView(resumed)).toBe('running')
    // 段已经收口的任务不算在等（即使等待没收：reducer 会一起收口，这里不依赖它）
    expect(isWaiting(task('a', { status: 'done', spans: [{ t: 0, end: 5, waits: [{ t: 1 }] }] }))).toBe(false)
  })

  test('其余状态原样', () => {
    for (const s of ['pending', 'done', 'failed', 'skipped', 'cancelled'] as const) expect(taskView(task('a', { status: s }))).toBe(s)
  })

  test('依赖用序号展示；只看没做完的；指向不存在的任务忽略', () => {
    const t = team([task('a', { status: 'done' }), task('b'), task('c', { dependsOn: ['a', 'b', 'ghost'] })])
    expect(depNumbers(t.tasks[2]!, t)).toEqual([1, 2])
    expect(depNumbers(t.tasks[2]!, t, { unmetOnly: true })).toEqual([2])
  })

  test('负责人显示名：目录里的 > 记下的 > id', () => {
    const lookup = (id: string) => (id === 'claude' ? 'Claude Code' : undefined)
    expect(assigneeLabel({ assignee: 'claude', label: '旧名' }, lookup)).toBe('Claude Code')
    expect(assigneeLabel({ assignee: 'c:x:codex', label: '机器 · Codex' }, lookup)).toBe('机器 · Codex')
    expect(assigneeLabel({ assignee: 'c:x:codex' }, lookup)).toBe('c:x:codex')
  })
})

describe('运行条上的一句话（组长还没开口的那段）', () => {
  test('一个都没开工 = 准备中；有在跑 = 在跑；全收工 = 等组长审查；中间空档（没有在跑但还有没做的）仍算在跑', () => {
    expect(teamNow(team([task('a'), task('b')])).phase).toBe('prepare')
    const running = teamNow(team([task('a', { status: 'done', spans: [{ t: 0, end: 1 }] }), task('b', { status: 'running', spans: [{ t: 1 }] })]))
    expect(running).toEqual({ phase: 'run', running: 1, done: 1, total: 2 })
    expect(teamNow(team([task('a', { status: 'done', spans: [{ t: 0, end: 1 }] }), task('b', { status: 'failed', spans: [{ t: 0, end: 1 }] })])).phase).toBe('review')
    expect(teamNow(team([task('a', { status: 'done', spans: [{ t: 0, end: 1 }] }), task('b')])).phase).toBe('run')
  })
})

describe('审批来自哪个组员', () => {
  const t = team(
    [
      task('a', { assignee: 'codex', status: 'running', spans: [{ t: 0, waits: [{ t: 1 }] }] }),
      task('b', { assignee: 'codex', status: 'running', spans: [{ t: 0 }] }),
      task('c', { assignee: 'claude', status: 'running', spans: [{ t: 0 }] }),
    ],
    { leader: 'claude' },
  )

  test('有开着的等待就只认那些任务；组员不是组长 = foreign', () => {
    const src = askSource(t, 'codex')
    expect(src.tasks.map((x) => x.id)).toEqual(['a'])
    expect(src.foreign).toBe(true)
  })

  test('等待事件还没到：退回该 agent 正在跑的任务', () => {
    const src = askSource(t, 'claude')
    expect(src.tasks.map((x) => x.id)).toEqual(['c'])
    expect(src.foreign).toBe(false)
  })

  test('不是带队执行中（没有 team / 已收尾）= 没有额外说明', () => {
    expect(askSource(undefined, 'codex')).toEqual({ tasks: [], foreign: false })
    expect(askSource({ ...t, status: 'done' }, 'codex')).toEqual({ tasks: [], foreign: false })
  })
})

describe('计划卡：可编辑 / 可开工判定', () => {
  const view = (extra: Partial<TeamPlanView> = {}): TeamPlanView => ({
    ...team([task('a', { usable: true }), task('b', { usable: true })], { status: 'draft' }),
    pageId: 'pg',
    initiatorId: 'u1',
    initiator: 'alice',
    createdAt: '2026-10-18T00:00:00Z',
    ...extra,
  })

  test('可编辑 = 草稿 + 我是发起人 + 页面可写；缺一不可', () => {
    expect(canEditPlan(view(), 'u1', true)).toBe(true)
    expect(canEditPlan(view(), 'u2', true)).toBe(false) // 别人发起的
    expect(canEditPlan(view(), 'u1', false)).toBe(false) // viewer / 公开页
    for (const status of ['running', 'done', 'cancelled', 'error'] as const) expect(canEditPlan(view({ status }), 'u1', true)).toBe(false)
  })

  test('发起人：广播里没有 mine，用 initiatorId 对；initiatorId 缺失才信 mine', () => {
    expect(isInitiator(view(), 'u1')).toBe(true)
    expect(isInitiator(view({ mine: false }), 'u1')).toBe(true)
    expect(isInitiator(view({ initiatorId: '', mine: true }), 'u9')).toBe(true)
    expect(isInitiator(view({ initiatorId: '' }), 'u1')).toBe(false)
  })

  test('开工可用判定：没加载 / 没任务 / 有任务用不了 / 页面忙，各挡一道；全 OK = null', () => {
    expect(startBlocker(null, false)).toBe('loading')
    expect(startBlocker(view({ tasks: [] }), false)).toBe('empty')
    expect(startBlocker(view({ tasks: [task('a', { usable: true }), task('b', { usable: false })] }), false)).toBe('unusable')
    expect(startBlocker(view({ tasks: [task('a', { usable: true, assignee: '' })] }), false)).toBe('unusable')
    expect(startBlocker(view(), true)).toBe('busy')
    expect(startBlocker(view(), false)).toBeNull()
  })

  test('服务端没标 usable（缺省）不替它拒绝；用不了的先于忙报（先让人换人）', () => {
    expect(startBlocker(view({ tasks: [task('a')] }), false)).toBeNull()
    expect(startBlocker(view({ tasks: [task('a', { usable: false })] }), true)).toBe('unusable')
  })

  test('不可用的任务 id 逐个列出', () => {
    expect(unusableIds(view({ tasks: [task('a', { usable: true }), task('b', { usable: false }), task('c')] }))).toEqual(['b'])
  })

  test('来源快照是草稿 = 计划卡模式；开工之后的快照 = 进度模式', () => {
    expect(isPlanSnapshot({ status: 'draft' })).toBe(true)
    for (const status of ['running', 'done', 'cancelled', 'error'] as const) expect(isPlanSnapshot({ status })).toBe(false)
  })
})
