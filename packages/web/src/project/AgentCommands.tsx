import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { COPY } from '../copy'
import { useAgentEvents, setAgentRunError } from '../editor/agent-bar'
import { toolViewHtml } from '../editor/run-view'
import { agentCommandsOf, mergeCommands, rememberCommands, type AgentCommand } from './agent-commands'

const C = COPY.project.terminal

/** 过程页 id → 那一轮的 agent 与命令：record 归档后不再变，换页回来不再取 */
const archive = new Map<string, { agent: string; commands: AgentCommand[] }>()
const ARCHIVE_MAX = 50

async function archivedRun(runId: string): Promise<{ agent: string; commands: AgentCommand[] } | null> {
  const hit = archive.get(runId)
  if (hit) return hit
  try {
    const { record } = await api.getRun(runId)
    const got = { agent: record.agent, commands: agentCommandsOf(record.replyId, record.entries) }
    archive.set(runId, got)
    if (archive.size > ARCHIVE_MAX) archive.delete(archive.keys().next().value!)
    return got
  } catch {
    // 过程页刚被删 / 没权限：这一轮不列，不缓存（下次再试）
    return null
  }
}

/* ---------- 终端分页下方的「agent 跑的命令」：只读，与人的终端并列 ----------
 * 每条显示命令行、agent、状态 / 退出码，点开看实时输出。输出复用步骤展开的同一个渲染器（run-view，内容全经转义）。
 * ACP 终端里还在跑的命令可以单独停止（只停这条，不停整轮）。 */
export default function AgentCommands({
  pageId,
  agent,
  agentLabel,
  runIds,
}: {
  pageId: string
  /** 面板的 agent：只列它跑的轮次（同一页换过 agent 的话，别的机器上跑的命令不归这个面板） */
  agent: string
  agentLabel: string
  /** 本页最近几轮的过程页 id（旧 → 新，见 recentRunPages） */
  runIds: readonly string[]
}) {
  const { run } = useAgentEvents(pageId)
  const [seen, setSeen] = useState<AgentCommand[]>([])
  // null = 归档的还在取（先不说「没跑过命令」）
  const [archived, setArchived] = useState<AgentCommand[] | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  // run 的 state 是原地更新的（version 变）：每次都重新抽一遍并进已记住的
  const live = useMemo(() => (run ? agentCommandsOf(run.replyId, run.state.entries) : []), [run, run?.version])
  useEffect(() => {
    if (live.length > 0) setSeen((prev) => rememberCommands(prev, live))
  }, [live])

  // 页面列表每次重拉都是新数组：按 id 串比，过程页真变了（一轮归档 / 删了一轮）才重取
  const runKey = runIds.join(',')
  useEffect(() => {
    let cancelled = false
    const ids = runKey ? runKey.split(',') : []
    void Promise.all(ids.map(archivedRun)).then((runs) => {
      if (!cancelled) setArchived(runs.flatMap((r) => (r && r.agent === agent ? r.commands : [])))
    })
    return () => {
      cancelled = true
    }
  }, [runKey, agent])

  const all = mergeCommands(archived ?? [], seen)
  if (all.length === 0) return archived === null ? null : <p className="project-note">{C.noCommands}</p>
  const shown = [...all].reverse()
  const toggle = (key: string): void => setOpen((s) => {
    const next = new Set(s)
    if (!next.delete(key)) next.add(key)
    return next
  })

  return (
    <ul className="term-cmds">
      {shown.map((c) => {
        const expanded = open.has(c.key)
        return (
          <li key={c.key} className={`term-cmd is-${c.state}`}>
            <div className="term-cmd-head">
              <button type="button" className="term-cmd-main" aria-expanded={expanded} onClick={() => toggle(c.key)}>
                <span className="term-cmd-prompt">$</span>
                <span className="term-cmd-line" title={c.command}>{c.command || C.unnamedCommand}</span>
              </button>
              <span className="term-cmd-state">{stateText(c)}</span>
              {c.state === 'running' && c.terminalId && (
                <button
                  type="button"
                  className="project-chip-btn"
                  onClick={() => {
                    void api.stopCommand(pageId, c.terminalId!).catch((err: unknown) => {
                      setAgentRunError(err instanceof Error ? `${COPY.run.stopCommandFailed}：${err.message}` : COPY.run.stopCommandFailed)
                    })
                  }}
                >
                  {COPY.run.stopCommand}
                </button>
              )}
            </div>
            <div className="term-cmd-meta">{agentLabel}</div>
            {/* 输出由 run-view 渲染（命令 + 输出 + 退出码，内容全部转义），只读 */}
            {expanded && <div className="term-cmd-body run-card" dangerouslySetInnerHTML={{ __html: toolViewHtml(c.entry) }} />}
          </li>
        )
      })}
    </ul>
  )
}

function stateText(c: AgentCommand): string {
  if (c.state === 'running') return C.running
  if (c.signal) return COPY.run.killedBy(c.signal)
  if (c.exitCode) return COPY.run.exitCode(c.exitCode)
  return c.state === 'failed' ? COPY.run.stepFailed : C.finished
}
