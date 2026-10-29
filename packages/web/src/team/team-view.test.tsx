import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { TeamState, TeamTask } from '@ramet/shared/run-model'
import { Gantt } from './Gantt'
import { ProgressCard } from './ProgressCard'

const task = (id: string, extra: Partial<TeamTask> = {}): TeamTask => ({ id, title: `任务${id}`, assignee: 'claude', dependsOn: [], status: 'pending', spans: [], ...extra })
const team = (tasks: TeamTask[], extra: Partial<TeamState> = {}): TeamState => ({ planId: 'p', title: '拆分存储层', leader: 'claude', status: 'running', tasks, ...extra })

const running = team([
  task('a', { status: 'done', output: '接口 + 两个实现', steps: 6, spans: [{ t: 1000, end: 5000 }] }),
  task('b', { status: 'running', assignee: 'codex', spans: [{ t: 2000, waits: [{ t: 3000 }] }] }),
  task('c', { dependsOn: ['b'] }),
])

describe('进度卡（服务端渲染冒烟：不崩、关键信息都在）', () => {
  test('运行中：默认展开，列出任务序号 / 标题 / 状态；等批准的任务单独标出；依赖没做完的显示在等谁', () => {
    const html = renderToStaticMarkup(<ProgressCard team={running} startedAt={Date.now() - 6000} ended={false} />)
    expect(html).toContain('拆分存储层')
    expect(html).toContain('任务a')
    expect(html).toContain('等你批准') // b 在等审批
    expect(html).toContain('等 #2 做完') // c 依赖 b
    expect(html).toContain('1/3 个任务完成')
    expect(html).toContain('team-gt-seg is-live') // b 的条还在伸长
    expect(html).toContain('team-gt-wait') // 斜线
  })

  test('跑完：收成一行胶囊（不展开任务列表 / 甘特），状态标「已完成」', () => {
    const done = team([task('a', { status: 'done', spans: [{ t: 0, end: 3000 }] })], { status: 'done' })
    const html = renderToStaticMarkup(<ProgressCard team={done} ended />)
    expect(html).toContain('已完成')
    expect(html).toContain('data-open="false"')
    expect(html).not.toContain('team-tasks')
    expect(html).not.toContain('team-gantt')
  })

  test('静态快照里还开着的段不当作"还在跑"：没有 is-live', () => {
    const html = renderToStaticMarkup(<ProgressCard team={running} ended />)
    expect(html).not.toContain('is-live')
  })

  test('失败 / 跳过的任务把原因摆出来（跑着的时候展开可见）', () => {
    const t = team([task('a', { status: 'failed', error: '测试没过', spans: [{ t: 0, end: 1000 }] }), task('b', { status: 'skipped', error: '前置任务 #1 没做成' })])
    const html = renderToStaticMarkup(<ProgressCard team={t} startedAt={Date.now()} ended={false} />)
    expect(html).toContain('原因：测试没过')
    expect(html).toContain('原因：前置任务 #1 没做成')
    expect(html).toContain('已跳过')
  })

  test('跑完的卡展开后能看到各任务的结果摘要入口', () => {
    const t = team([task('a', { status: 'done', output: '接口 + 两个实现', spans: [{ t: 0, end: 1000 }] })])
    const html = renderToStaticMarkup(<ProgressCard team={t} startedAt={Date.now()} ended={false} />)
    expect(html).toContain('展开这个任务的结果')
  })
})

describe('甘特', () => {
  test('一个任务都没开工 = 不画', () => {
    expect(renderToStaticMarkup(<Gantt team={team([task('a')])} />)).toBe('')
  })

  test('每行一个任务，图例按负责人，打回的段标 is-again', () => {
    const t = team([task('a', { status: 'done', backs: 1, spans: [{ t: 0, end: 1000 }, { t: 3000, end: 4000 }] }), task('b', { assignee: 'codex', spans: [{ t: 0, end: 2000 }] })])
    const html = renderToStaticMarkup(<Gantt team={t} />)
    expect(html.match(/class="team-gt-row"/g)).toHaveLength(2)
    expect(html).toContain('is-again')
    expect(html.match(/<li/g)).toHaveLength(2)
  })
})
