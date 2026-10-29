/* ---------- 带队甘特：每个任务一行，条是一次执行（打回重做多一段），斜线是等你批准的时段 ----------
 * 只画不算，布局全在 team-model.ts 的 ganttLayout。条的位置和宽度是占整条轴的百分比，进行中的条随 now 伸长，
 * 不做 width 过渡（每秒重画一次就够了）。同一个 agent 恒同色（data-slot 对应 --team-c0..c4）。 */
import type { TeamState } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { fmtClock, fmtDuration } from '../editor/run-format'
import { agentLabel } from './team-agents'
import { ganttLayout } from './team-model'

const T = COPY.team.gantt

export function Gantt({ team, now }: { team: TeamState; now?: number }) {
  const g = ganttLayout(team, now)
  if (!g) return null
  const who = (assignee: string): string => agentLabel(assignee) ?? team.tasks.find((t) => t.assignee === assignee)?.label ?? assignee
  return (
    <div className="team-gantt">
      <div className="team-gantt-title">{T.title}</div>
      <div className="team-gt-rows" role="list">
        {g.rows.map((row, i) => (
          <div className="team-gt-row" role="listitem" key={row.id}>
            <span className="team-gt-label" title={row.title}>
              <b>{i + 1}</b>
              <span>{row.title}</span>
            </span>
            <span className="team-gt-track" data-slot={row.slot}>
              {row.segs.map((seg, k) => (
                <span
                  key={k}
                  className={'team-gt-seg' + (seg.live ? ' is-live' : '') + (seg.again ? ' is-again' : '')}
                  style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                  title={`${T.segTip(who(row.assignee), row.title, fmtClock(seg.from - g.t0), fmtClock(seg.to - g.t0))}${seg.again ? ` · ${T.again}` : ''}`}
                >
                  {seg.waits.map((w, j) => (
                    <span key={j} className="team-gt-wait" style={{ left: `${w.left}%`, width: `${w.width}%` }} title={T.waitTip(fmtDuration(w.ms))} />
                  ))}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="team-gt-axis" aria-hidden="true">
        <span>{T.start}</span>
        <span>{fmtClock(g.total)}</span>
      </div>
      <ul className="team-gt-legend">
        {g.legend.map((item) => (
          <li key={item.assignee} data-slot={item.slot}>
            <i />
            {who(item.assignee)}
          </li>
        ))}
        {g.hasWait && (
          <li className="is-wait">
            <i />
            {T.wait}
          </li>
        )}
      </ul>
    </div>
  )
}
