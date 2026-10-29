/* ---------- 工作台面板的五个分页：总览 · 步骤 · 任务 · 改动 · 协作 ----------
 * 尽量复用回复里已有的渲染器：步骤 = 运行条托盘（run-tray.ts，同一套行与展开）；任务 = 计划卡（plan-card.ts）；
 * 改动 = 每一处修改的常规展示（run-view.ts 的 toolViewHtml，自带 diff）。数据就是 HudRun + runTally，不另取。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunEntry, RunState, RunTally, TallyFile, ToolEntry } from '@ramet/shared/run-model'
import { agentName } from '../editor/agent-badge'
import { createPlanCard, type PlanCard } from '../editor/plan-card'
import { fmtDuration } from '../editor/run-format'
import { createTray, type Tray } from '../editor/run-tray'
import { toolViewHtml } from '../editor/run-view'
import { HUD_COPY as C } from './hud-copy'
import { highlights, spendParts, type HudRun, type HudTab } from './hud-model'

/** 托盘要的是完整 RunState：跑完的一轮从 record 拼一份（当前那段话不在这里显示） */
function stateOf(run: HudRun): RunState {
  return {
    entries: run.entries,
    text: '',
    textAt: null,
    textEnd: null,
    textSlot: null,
    thoughtChars: 0,
    ...(run.info ? { info: run.info } : {}),
    ...(run.plan.length ? { plan: run.plan } : {}),
    ...(run.team ? { team: run.team } : {}),
  }
}

function Empty({ text }: { text: string }) {
  return <p className="hp-empty">{text}</p>
}

export function OverviewPane({ run, tally, onGoto }: { run: HudRun; tally: RunTally; onGoto: (tab: HudTab) => void }) {
  const done = run.plan.filter((p) => p.status === 'completed').length
  const parts = spendParts(tally)
  const add = tally.files.reduce((n, f) => n + f.add, 0)
  const del = tally.files.reduce((n, f) => n + f.del, 0)
  const tiles: Array<{ tab: HudTab; v: React.ReactNode; s: React.ReactNode }> = [
    { tab: 'steps', v: tally.steps, s: C.tiles.steps(tally.failed) },
    { tab: 'tasks', v: run.plan.length ? <>{done}<small>/{run.plan.length}</small></> : '–', s: C.tiles.tasks(done, run.plan.length) },
    { tab: 'files', v: tally.files.length, s: tally.files.length ? <><span className="add">+{add}</span> <span className="del">−{del}</span></> : C.tiles.files },
    { tab: 'agents', v: tally.agents.length, s: tally.agents.length ? [...new Set(tally.agents.map((a) => (a.kind === 'sub' ? C.agentKind.sub : agentName(a.agent ?? '') || a.label)))].join(' · ') : C.tiles.agents },
  ]
  return (
    <div className="hp-overview">
      <div className="ov-tiles">
        {tiles.map((t) => (
          <button key={t.tab} type="button" className="ov-tile" onClick={() => onGoto(t.tab)}>
            <span className="ov-k">{C.tabs[t.tab]}</span>
            <span className="ov-v">{t.v}</span>
            <span className="ov-s">{t.s}</span>
          </button>
        ))}
      </div>
      {parts.length > 0 && (
        <>
          <div className="ov-sec">{C.spendTitle}</div>
          <div className="ov-bar" role="img" aria-label={parts.map((p) => `${C.spend[p.key]} ${fmtDuration(p.ms)}`).join('，')}>
            {parts.map((p) => (
              <span key={p.key} className={`ov-part is-${p.key}`} style={{ flexGrow: p.pct }} />
            ))}
          </div>
          <ul className="ov-legend">
            {parts.map((p) => (
              <li key={p.key} className={`is-${p.key}`}>
                {C.spend[p.key]} <b>{fmtDuration(p.ms)}</b>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="ov-sec">{C.notesTitle}</div>
      <ul className="ov-notes">
        {highlights(run, tally, agentName).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  )
}

export function StepsPane({ run }: { run: HudRun }) {
  const host = useRef<HTMLDivElement>(null)
  const tray = useRef<Tray | null>(null)
  useEffect(() => {
    const node = host.current
    if (!node) return
    tray.current = createTray()
    tray.current.el.classList.add('is-hud')
    node.replaceChildren(tray.current.el)
    return () => {
      node.replaceChildren()
      tray.current = null
    }
  }, [])
  useEffect(() => {
    tray.current?.sync(stateOf(run), run.live)
  }, [run])
  if (!run.entries.length) return <Empty text={C.empty.steps} />
  return <div ref={host} />
}

export function TasksPane({ run }: { run: HudRun }) {
  const host = useRef<HTMLDivElement>(null)
  const card = useRef<PlanCard | null>(null)
  useEffect(() => {
    const node = host.current
    if (!node) return
    card.current = createPlanCard({ open: true })
    node.replaceChildren(card.current.el)
    return () => {
      node.replaceChildren()
      card.current = null
    }
  }, [])
  useEffect(() => {
    card.current?.set(run.plan)
  }, [run.plan])
  if (!run.plan.length) return <Empty text={C.empty.tasks} />
  return <div ref={host} className="hp-tasks" />
}

/** 改了这个文件的每一步（diff 路径或 locations 对得上） */
function stepsOf(entries: readonly RunEntry[], path: string): ToolEntry[] {
  return entries.filter((e): e is ToolEntry => {
    if (e.k !== 'tool' || e.status === 'failed') return false
    const content = Array.isArray(e.acp?.content) ? (e.acp.content as Array<Record<string, unknown>>) : []
    if (content.some((c) => c?.type === 'diff' && c.path === path)) return true
    const loc = Array.isArray(e.acp?.locations) ? (e.acp.locations[0] as { path?: unknown } | undefined) : undefined
    return (loc?.path ?? e.detail) === path && !content.some((c) => c?.type === 'diff')
  })
}

function FileRow({ file, entries }: { file: TallyFile; entries: readonly RunEntry[] }) {
  const [open, setOpen] = useState(false)
  const steps = useMemo(() => (open ? stepsOf(entries, file.path) : []), [open, entries, file.path])
  const name = file.path.split(/[\\/]/).pop() || file.path
  return (
    <li className={open ? 'hp-file is-open' : 'hp-file'}>
      <button type="button" className="hp-file-row" onClick={() => setOpen(!open)} aria-expanded={open} title={file.path}>
        <span className="hp-file-name">{name}</span>
        <span className="hp-file-dir">{file.path.slice(0, file.path.length - name.length)}</span>
        <span className="add">+{file.add}</span>
        {file.del > 0 && <span className="del">−{file.del}</span>}
      </button>
      {open && (
        <div className="hp-file-diff">
          {/* toolViewHtml 由 run-view 的转义渲染器产出（escapeHtml），与过程页同一来源 */}
          {steps.map((s) => (
            <div key={s.id} dangerouslySetInnerHTML={{ __html: toolViewHtml(s) }} />
          ))}
          {steps.length > 1 && <div className="hp-file-n">{C.fileSteps(steps.length)}</div>}
        </div>
      )}
    </li>
  )
}

export function FilesPane({ run, tally }: { run: HudRun; tally: RunTally }) {
  if (!tally.files.length) return <Empty text={C.empty.files} />
  return (
    <ul className="hp-files">
      {tally.files.map((f) => (
        <FileRow key={f.path} file={f} entries={run.entries} />
      ))}
    </ul>
  )
}

export function AgentsPane({ run, tally }: { run: HudRun; tally: RunTally }) {
  if (!tally.agents.length) return <Empty text={C.empty.agents} />
  return (
    <ul className="hp-agents">
      {tally.agents.map((a) => (
        <li key={a.id} className={`hp-agent is-${a.status}`}>
          <span className="hp-agent-kind">{C.agentKind[a.kind]}</span>
          <span className="hp-agent-who">{a.kind === 'sub' ? agentName(run.agent) : agentName(a.agent ?? '') || a.label}</span>
          <span className="hp-agent-task">{a.label}</span>
          <span className="hp-agent-st">{C.agentState[a.status]}</span>
        </li>
      ))}
    </ul>
  )
}
