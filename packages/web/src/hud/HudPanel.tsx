/* ---------- 工作台面板：头部 · 审批区 · 五个分页 · 底部 ----------
 * 浮在右上角（HudLayer），或项目面板开着时嵌进「本轮」分页（embedded）。只画给定的这一轮（HudRun），
 * 数据来源由外层决定：在飞的来自 agent-bar store，跑完的来自过程页 record。 */
import { useEffect, useMemo, useRef } from 'react'
import { runTally, type RunTally, type TeamState } from '@ramet/shared/run-model'
import { useNavigate } from 'react-router-dom'
import { AgentBadgeView } from '../agent-marks'
import { api } from '../api'
import { Icon } from '../icons'
import { agentBadge, agentName } from '../editor/agent-badge'
import { setAgentRunError, type PermissionReq } from '../editor/agent-bar'
import { buildAskCard } from '../editor/ask-card'
import { fmtDuration, fmtTokens } from '../editor/run-format'
import { COPY } from '../copy'
import { HUD_COPY as C } from './hud-copy'
import { HUD_TABS, type HudRun, type HudTab } from './hud-model'
import { AgentsPane, FilesPane, OverviewPane, StepsPane, TasksPane } from './hud-panes'
import { openRunPage, setHudTab } from './hud-store'

/** 统计按「这一轮 + 第几次变化」重算（在飞的一轮 store 原地改数组）；思考时长随表走，不必重算 diff */
function useTally(run: HudRun | null): RunTally | null {
  const base = useMemo(() => (run ? runTally(run, run.ms) : null), [run?.replyId, run?.runId, run?.version, run?.entries])
  if (!run || !base) return null
  const others = base.spend.edit + base.spend.term + base.spend.call + base.spend.read
  return { ...base, spend: { ...base.spend, think: Math.max(0, run.ms - others) } }
}

function subLine(run: HudRun, steps: number): string {
  const time = fmtDuration(run.ms)
  if (run.live) return C.sub.live(time, steps)
  if (run.outcome === 'cancelled') return C.sub.stopped(time, steps)
  if (run.outcome === 'error') return C.sub.error(time, steps)
  return C.sub.done(time, steps)
}

/** 审批区：和运行条同一张卡（ask-card.ts）；换了一条才重建（填了一半的表单不丢） */
function AskBox({ pageId, req, team }: { pageId: string; req: PermissionReq; team: TeamState | undefined }) {
  const host = useRef<HTMLDivElement>(null)
  const key = `${req.agentId}:${req.requestId}`
  useEffect(() => {
    const node = host.current
    if (!node) return
    node.replaceChildren(buildAskCard(pageId, req, team))
    return () => node.replaceChildren()
  }, [pageId, key])
  return <div className="hp-askbox" ref={host} />
}

export function HudPanel({
  pageId,
  run,
  failed,
  ask,
  tab,
  embedded,
  canStop,
  onClose,
}: {
  pageId: string
  /** null = 还在拉（跑完的一轮）或拉不到（failed） */
  run: HudRun | null
  failed: boolean
  ask: PermissionReq | undefined
  tab: HudTab
  embedded: boolean
  canStop: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const tally = useTally(run)

  if (!run || !tally) {
    return (
      <div className={embedded ? 'hud-panel is-embedded' : 'hud-panel'} role="dialog" aria-label={C.label}>
        <p className="hp-empty">{failed ? C.loadFailed : C.loading}</p>
      </div>
    )
  }

  const done = run.plan.filter((p) => p.status === 'completed').length
  const counts: Record<HudTab, string> = {
    overview: '',
    steps: String(tally.steps),
    tasks: run.plan.length ? `${done}/${run.plan.length}` : '–',
    files: String(tally.files.length),
    agents: String(tally.agents.length),
  }
  const ctx = run.context && run.context.size > 0 ? run.context : null
  const openRun = (): void => {
    if (!run.runId) return
    const anchor = document.querySelector<HTMLElement>(`.island.is-docked[data-run="${CSS.escape(run.runId)}"]`)
    if (!openRunPage(run.runId, anchor)) navigate(`/page/${run.runId}`)
  }
  const stop = (): void => {
    void api.stopPage(pageId).catch((err: unknown) => {
      setAgentRunError(err instanceof Error ? `${COPY.run.stopFailed}：${err.message}` : COPY.run.stopFailed)
    })
  }

  return (
    <div className={embedded ? 'hud-panel is-embedded' : 'hud-panel'} role="dialog" aria-label={C.label}>
      <header className="hp-head">
        <span className={`hud-av${run.live ? ' is-live' : ''}`}>
          <AgentBadgeView badge={agentBadge(run.agent)} />
        </span>
        <div className="hp-title">
          <b>{agentName(run.agent)}</b>
          <span className={run.live ? 'hp-sub is-live' : 'hp-sub'}>{subLine(run, tally.steps)}</span>
        </div>
        {run.live && canStop && (
          <button type="button" className="hp-mini is-danger" onClick={stop}>
            <Icon name="stop" size={12} />
            {C.stop}
          </button>
        )}
        {!embedded && (
          <button type="button" className="hp-icon" onClick={onClose} title={C.close} aria-label={C.close}>
            <Icon name="x" size={16} />
          </button>
        )}
      </header>
      {ask && run.live && <AskBox pageId={pageId} req={ask} team={run.team} />}
      <nav className="hp-tabs" role="tablist" style={{ '--i': HUD_TABS.indexOf(tab) } as React.CSSProperties}>
        {HUD_TABS.map((t) => (
          <button key={t} type="button" role="tab" className="hp-tab" aria-selected={t === tab} onClick={() => setHudTab(t)}>
            {C.tabs[t]}
            {counts[t] && <span className="n">{counts[t]}</span>}
          </button>
        ))}
      </nav>
      <div className="hp-body" role="tabpanel">
        {tab === 'overview' && <OverviewPane run={run} tally={tally} onGoto={setHudTab} />}
        {tab === 'steps' && <StepsPane run={run} />}
        {tab === 'tasks' && <TasksPane run={run} />}
        {tab === 'files' && <FilesPane run={run} tally={tally} />}
        {tab === 'agents' && <AgentsPane run={run} tally={tally} />}
      </div>
      {(ctx || run.runId) && (
        <footer className="hp-foot">
          {ctx && (
            <span className="hp-ctx">
              <span className="hp-ring" style={{ '--p': Math.min(1, ctx.used / ctx.size) } as React.CSSProperties} />
              {C.context(Math.round((ctx.used / ctx.size) * 100), fmtTokens(ctx.used), fmtTokens(ctx.size))}
            </span>
          )}
          {run.runId && (
            <button type="button" className="hp-link" onClick={openRun}>
              {C.openRun}
              <Icon name="external" size={13} />
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
