/* ---------- 带队的计划卡：组长出的草稿计划，发起人改完点「开工」才开始 ----------
 * 来源快照（回复块的 team 属性 / 运行中的 RunState.team）只是计划轮那一刻的草稿，开工 / 改 / 取消之后以计划视图 store 为准
 * （GET /team/:planId 拉一次，加页面 SSE 的 team_plan 事件，见 team-store.ts）。store 里还没有时先画快照，只读。
 * 谁能改见 team-model.ts 的 canEditPlan，服务端对每个写操作再判一次；谁能开工见 startBlocker。
 * 改一项存一项（PATCH）：负责人下拉只列我能用的 agent，换负责人时旧目录作废。 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { TEAM_LIMITS, type TeamPlanView, type TeamState, type TeamTask } from '@ramet/shared/run-model'
import { ApiError } from '../api'
import { COPY } from '../copy'
import { agentStateFor, subscribeAgentEvents } from '../editor/agent-bar'
import { Icon } from '../icons'
import { flip, followersAfter } from '../motion'
import { selfId } from '../people'
import { AssigneeChip, CwdChip, EditableLine, baseName } from './PlanControls'
import { agentLabel } from './team-agents'
import { planStore, teamApi, type PlanPatch } from './team-api'
import { assigneeLabel, canEditPlan, depNumbers, startBlocker } from './team-model'
import { startTeamPlan } from './team-send'

const T = COPY.team
const P = T.plan

/** 点了开工之后最多这么久还没见计划离开草稿，就放开按钮 */
const START_WAIT_MS = 15_000

const noopSubscribe = (): (() => void) => () => {}

/** 页面上有没有 agent 在生成（开工会 409 busy，提前说明）。snapshotOnly（过程页 / 公开页）不订阅，那里的 pageId 是过程页 */
function usePageBusy(pageId: string, enabled: boolean): boolean {
  const subscribe = useCallback((cb: () => void) => (enabled ? subscribeAgentEvents(pageId, () => cb()) : noopSubscribe()), [pageId, enabled])
  const busy = () => enabled && agentStateFor(pageId).status === 'running'
  return useSyncExternalStore(subscribe, busy, busy)
}

const messageOf = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

/** 计划里一段较长的说明：默认压成三行，点一下展开 */
function Detail({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={'team-detail' + (open ? ' is-open' : '')}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        setOpen((v) => !v)
      }}
    >
      {text}
    </div>
  )
}

export function PlanCard({ pageId, team, canAct, snapshotOnly }: { pageId: string; team: TeamState; canAct: boolean; snapshotOnly: boolean }) {
  const planId = team.planId
  const entry = useSyncExternalStore(planStore.subscribe, () => planStore.get(planId), () => planStore.get(planId))
  useEffect(() => {
    if (!snapshotOnly) planStore.ensure(pageId, planId)
  }, [pageId, planId, snapshotOnly])

  const view: TeamPlanView | null = snapshotOnly ? null : entry.view
  const shown: TeamState = view ?? team
  const status = shown.status
  const editable = view !== null && canEditPlan(view, selfId(), canAct)
  const pageBusy = usePageBusy(pageId, !snapshotOnly)

  const [open, setOpen] = useState(status === 'draft')
  const ref = useRef<HTMLDivElement>(null)
  // 计划被用掉了（开工 / 取消 / 做完）就收成一行
  const wasDraft = useRef(status === 'draft')
  useEffect(() => {
    if (wasDraft.current && status !== 'draft') setOpen(false)
    wasDraft.current = status === 'draft'
  }, [status])
  const toggle = (): void => {
    const el = ref.current
    if (!el) return setOpen((v) => !v)
    flip(followersAfter(el), () => flushSync(() => setOpen((v) => !v)))
  }

  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 存失败了：输入框里还留着没存上的字，换个 key 让它们重建、回到服务端的值
  const [rev, setRev] = useState(0)
  // 202 之后的失败（并发的第二次开工、组长机器刚好掉线）只以 SSE error 回到回复块的失败条，这里收不到，
  // 所以计划一直没离开草稿时要放开按钮，不能永远停在「开工中…」
  useEffect(() => {
    if (!starting) return
    const timer = window.setTimeout(() => setStarting(false), START_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [starting])

  /** 存一项改动，失败抛出（调用方决定显示在哪）。409 / 404 说明计划已经变了，顺手重拉 */
  async function patch(body: PlanPatch): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      planStore.put(await teamApi.patch(pageId, planId, body))
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void planStore.refresh(pageId, planId)
      throw err
    } finally {
      setBusy(false)
    }
  }
  const save = (body: PlanPatch): void => {
    patch(body).catch((err: unknown) => {
      setError(`${P.saveFailed}：${messageOf(err, '')}`)
      setRev((n) => n + 1)
    })
  }

  async function start(): Promise<void> {
    setStarting(true)
    setError(null)
    try {
      await startTeamPlan(pageId, planId)
      void planStore.refresh(pageId, planId) // SSE 的 team_plan 应该已经到了；没到也以服务端为准
    } catch (err) {
      setError(messageOf(err, P.startFailed))
      setStarting(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!window.confirm(P.confirmCancel)) return
    setBusy(true)
    setError(null)
    try {
      planStore.put(await teamApi.cancel(pageId, planId))
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) void planStore.refresh(pageId, planId)
      setError(`${P.cancelFailed}：${messageOf(err, '')}`)
    } finally {
      setBusy(false)
    }
  }

  const blocker = startBlocker(view, pageBusy)
  const spaceCwd = (task: TeamTask): string => agentStateFor(pageId).cwds[task.assignee] ?? ''
  const waiting = !snapshotOnly && view === null
  const note = snapshotOnly
    ? P.snapshotNote
    : waiting
      ? entry.state === 'missing' || entry.state === 'failed'
        ? T.loadFailed
        : T.loading
      : null

  return (
    <div ref={ref} className={`team-card is-plan is-${status}`} data-open={open} role="group" aria-label={`${T.title} · ${P.cardTitle}`}>
      <button type="button" className="team-head" aria-expanded={open} aria-label={T.toggle} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        <Icon name="users" size={14} />
        <span className="team-head-title">{P.cardTitle}</span>
        {!open && (
          <span className="team-head-name" title={shown.title}>
            {shown.title}
          </span>
        )}
        <span className="team-head-sum">{T.taskCount(shown.tasks.length)}</span>
        <span className={`team-state is-${status}`}>{snapshotOnly ? P.snapshotState : T.planStatus[status]}</span>
        <Icon name="caret" size={14} className="team-chev" />
      </button>
      {open && (
        <div className="team-body">
          {editable ? (
            <EditableLine key={`title:${rev}`} className="team-plan-title" value={shown.title} max={TEAM_LIMITS.title} label={P.titleLabel} onCommit={(title) => save({ title })} />
          ) : (
            <div className="team-plan-title is-static">{shown.title}</div>
          )}
          {shown.goal && <Detail text={shown.goal} />}
          <ol className="team-tasks">
            {shown.tasks.map((task, i) => {
              const bad = editable && task.usable === false
              const after = depNumbers(task, shown)
              return (
                <li key={task.id} className={'team-task is-plan' + (bad ? ' is-bad' : '')}>
                  <span className="team-no">{i + 1}</span>
                  <div className="team-task-main">
                    {editable ? (
                      <EditableLine
                        key={`${task.id}:${rev}`}
                        className="team-task-edit"
                        value={task.title}
                        max={TEAM_LIMITS.title}
                        label={P.taskTitleLabel(i + 1)}
                        onCommit={(title) => save({ tasks: [{ id: task.id, title }] })}
                      />
                    ) : (
                      <div className="team-task-title">{task.title}</div>
                    )}
                    {task.detail && <Detail text={task.detail} />}
                    <div className="team-task-meta">
                      {editable ? (
                        <>
                          <AssigneeChip
                            label={assigneeLabel(task, agentLabel)}
                            assignee={task.assignee}
                            usable={task.usable !== false}
                            disabled={busy || starting}
                            onPick={(assignee) => save({ tasks: [{ id: task.id, assignee }] })}
                          />
                          <CwdChip
                            pageId={pageId}
                            agent={task.assignee}
                            cwd={task.cwd ?? ''}
                            startAt={spaceCwd(task)}
                            disabled={busy || starting || task.usable === false}
                            onApply={(cwd) => patch({ tasks: [{ id: task.id, cwd: cwd || null }] })}
                          />
                        </>
                      ) : (
                        <>
                          <span className="team-who" title={task.assignee}>
                            {assigneeLabel(task, agentLabel)}
                          </span>
                          {task.cwd && (
                            <span className="team-who" title={T.task.cwdTip(task.cwd)}>
                              <Icon name="folder" size={12} /> {baseName(task.cwd)}
                            </span>
                          )}
                        </>
                      )}
                      {after.length > 0 && <span className="team-dep">{T.task.after(after)}</span>}
                      {bad && <span className="team-warn">{T.task.unusable}</span>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
          <div className="team-foot">
            {editable ? (
              <>
                <div className={'team-foot-hint' + (blocker ? ' is-warn' : '')}>{blocker ? P.blocker[blocker] : P.hintMine}</div>
                <div className="team-acts">
                  <button type="button" className="team-btn is-primary" disabled={blocker !== null || busy || starting} onClick={() => void start()}>
                    {starting ? P.starting : P.start}
                  </button>
                  <button type="button" className="team-btn" disabled={busy || starting} onClick={() => void cancel()}>
                    {P.cancel}
                  </button>
                </div>
              </>
            ) : (
              <div className="team-foot-hint">
                {note ?? (status === 'draft' ? P.hintOther(view?.initiator ?? '') : P.after[status as Exclude<TeamState['status'], 'draft'>])}
              </div>
            )}
            {error && (
              <div className="team-error" role="alert">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
