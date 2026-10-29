/* ---------- 带队的执行进度：任务列表和实时甘特，跑完收成胶囊 ----------
 * 数据是一份 TeamState 快照：运行中取 RunState.team（SSE 快照加 team 事件，共享 reducer 归约），收尾后取回复块的 team 属性，
 * 过程页取 runs.record.team。三处用同一个组件，所以运行中、收尾、刷新、过程页看起来是同一张卡。
 * 运行中默认展开，跑完（status 不再是 running）默认收成一行胶囊，点开看任务、甘特和各任务结果摘要。
 * team 里的时间全是相对本轮开始的毫秒，startedAt（本机时钟下的本轮起点，只有实时视图有）把现在换算到同一基准，让进行中的条伸长。 */

import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { teamProgress, type TeamState, type TeamTask } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { fmtDuration } from '../editor/run-format'
import { Icon, type IconName } from '../icons'
import { flip, followersAfter } from '../motion'
import { Gantt } from './Gantt'
import { agentLabel } from './team-agents'
import { assigneeLabel, depNumbers, taskElapsed, taskView, teamWall, type TaskView } from './team-model'

const T = COPY.team

/** 每秒一个现在（进行中的用时 / 甘特条随它伸长），不活跃时不转 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

const STATE_ICON: Partial<Record<TaskView, IconName>> = { done: 'check', failed: 'x', ask: 'clock', cancelled: 'stop' }

function TaskRow({ n, task, team, rel }: { n: number; task: TeamTask; team: TeamState; rel: number | undefined }) {
  const view = taskView(task)
  const [open, setOpen] = useState(false)
  const elapsed = taskElapsed(task, rel)
  const unmet = view === 'pending' ? depNumbers(task, team, { unmetOnly: true }) : []
  const bits = [
    T.task.status[view] + (unmet.length > 0 ? ` · ${T.task.after(unmet)}` : ''),
    elapsed !== null ? T.task.elapsed(fmtDuration(elapsed)) : '',
    task.steps ? T.task.steps(task.steps) : '',
    task.backs ? T.task.backs(task.backs) : '',
  ].filter(Boolean)
  const icon = STATE_ICON[view]
  // 失败 / 跳过 / 取消的原因一直显示，完成的结果摘要点开才看
  const reason = view === 'failed' || view === 'skipped' || view === 'cancelled' ? task.error : undefined
  const expandable = view === 'done' || Boolean(task.output)
  return (
    <li className={`team-task is-${view}`}>
      <span className="team-mark" aria-hidden="true">
        {icon ? <Icon name={icon} size={12} /> : null}
      </span>
      <div className="team-task-main">
        <div className="team-task-top">
          <span className="team-no">{n}</span>
          <span className="team-task-title" title={task.title}>
            {task.title}
          </span>
          <span className="team-who" title={task.assignee}>
            {assigneeLabel(task, agentLabel)}
          </span>
        </div>
        <div className="team-task-line">{bits.join(' · ')}</div>
        {reason && <div className="team-task-reason">{`${T.task.reason}：${reason}`}</div>}
        {expandable && (
          <button
            type="button"
            className="team-more"
            aria-expanded={open}
            aria-label={open ? T.task.collapse : T.task.expand}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? T.task.collapse : T.task.expand}
          </button>
        )}
        {open && <div className="team-result">{task.output || T.task.noResult}</div>}
      </div>
    </li>
  )
}

export function ProgressCard({ team, startedAt, ended }: { team: TeamState; startedAt?: number; ended: boolean }) {
  const finished = team.status !== 'running' || ended
  const now = useNow(!finished && startedAt !== undefined)
  const rel = startedAt !== undefined && !finished ? Math.max(0, now - startedAt) : undefined
  const [open, setOpen] = useState(!finished)
  const ref = useRef<HTMLDivElement>(null)
  // 收尾时自动收成胶囊（刷新 / 过程页进来时 finished 一开始就是真，初始值已是收起）
  const wasFinished = useRef(finished)
  useEffect(() => {
    if (finished && !wasFinished.current) setOpen(false)
    wasFinished.current = finished
  }, [finished])

  // 展开 / 收起会带动下面所有内容，量好位置再平移补位（只有用户点的才播，flushSync 在事件处理里合法）
  const toggle = (): void => {
    const el = ref.current
    if (!el) return setOpen((v) => !v)
    flip(followersAfter(el), () => flushSync(() => setOpen((v) => !v)))
  }

  const { done, total } = teamProgress(team)
  const wall = teamWall(team, rel)
  return (
    <div ref={ref} className={`team-card is-${team.status}${finished ? ' is-finished' : ''}`} data-open={open} role="group" aria-label={T.title}>
      <button type="button" className="team-head" aria-expanded={open} aria-label={T.toggle} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        <Icon name="users" size={14} />
        <span className="team-head-title">{T.title}</span>
        <span className="team-head-name" title={team.title}>
          {team.title}
        </span>
        <span className="team-head-sum">{T.summary(done, total, wall > 0 ? fmtDuration(wall) : '')}</span>
        <span className={`team-state is-${team.status}`}>{T.state[team.status]}</span>
        <Icon name="caret" size={14} className="team-chev" />
      </button>
      {open && (
        <div className="team-body">
          <ol className="team-tasks">
            {team.tasks.map((task, i) => (
              <TaskRow key={task.id} n={i + 1} task={task} team={team} rel={rel} />
            ))}
          </ol>
          <Gantt team={team} now={rel} />
        </div>
      )}
    </div>
  )
}
