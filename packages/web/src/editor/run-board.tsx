// ---------- 过程页的头与尾 ----------
// 步骤是正文编辑器里的块（editor/run-step.ts），这里只画 runs.record 里的事实：
//   头 RunHead = 摘要（谁、结果、用时、步数、token）+ 返回父页的链接；
//   尾 RunFoot = 最终输出。
// 登录态用 useRunDetail 取 record + 父页；公开页的 record 随 publicDoc 一起给。
import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { api, type RunRecord } from '../api'
import { agentBadge, agentName } from './ai-block'
import { fmtDuration, fmtTokens } from './run-format'
import { TeamCard } from '../team/TeamCard'

const OUTCOME: Record<RunRecord['outcome'], string> = { end: '已完成', cancelled: '已停止', error: '出错' }

export type RunDetail = { record: RunRecord; parent: { id: string; title: string } | null }

/** 登录态过程页的 record + 父页；pageId 为空（不是过程页）返回 null。换页时旧页的结果不会被当成新页的 */
export function useRunDetail(pageId: string | null): RunDetail | null {
  const [got, setGot] = useState<{ id: string; detail: RunDetail } | null>(null)
  useEffect(() => {
    if (!pageId) return
    let cancelled = false
    api
      .getRun(pageId)
      .then((d) => {
        if (!cancelled) setGot({ id: pageId, detail: { record: d.record, parent: d.parent } })
      })
      .catch(() => {
        if (!cancelled) setGot(null)
      })
    return () => {
      cancelled = true
    }
  }, [pageId])
  return pageId && got?.id === pageId ? got.detail : null
}

export function RunHead({
  detail,
  replyHref,
  onBack,
}: {
  detail: RunDetail
  replyHref: (parentId: string, replyId: string) => string
  /** 普通左键点返回链接交给它（出门变形，run-door.ts）；修饰键 / 中键仍按 href 走 */
  onBack?: (parentId: string) => void
}) {
  const { record, parent } = detail
  const badge = agentBadge(record.agent)
  const name = agentName(record.agent) || record.agent
  const steps = record.entries.filter((e) => e.k === 'tool').length
  const usage = record.usage ?? record.info?.usage
  return (
    <div className="run-page">
      <div className="run-page-summary">
        <span className="run-page-agent">
          <span
            className={badge.kind === 'mark' ? 'run-page-logo agent-mark' : 'run-page-logo'}
            style={badge.kind === 'mark' ? ({ '--agent-mark': `var(--mark-${badge.key})` } as CSSProperties) : undefined}
          >
            {badge.kind === 'text' ? badge.text : null}
          </span>
          {name}
        </span>
        <span className={`run-page-outcome is-${record.outcome}`}>{OUTCOME[record.outcome]}</span>
        {record.ms !== undefined && <span>{fmtDuration(record.ms)}</span>}
        {steps > 0 && <span>{steps} 步</span>}
        {usage && <span>{fmtTokens(usage.total)} tokens</span>}
      </div>
      {/* 带队的轮次：计划 / 任务进度（只画 record.team 这份快照；过程页上不能开工，也不去拉计划视图） */}
      {record.team && (
        <div className="run-page-team">
          <TeamCard pageId="" team={record.team} canAct={false} snapshotOnly />
        </div>
      )}
      {parent && (
        <Link
          className="run-page-back"
          to={replyHref(parent.id, record.replyId)}
          onClick={(e) => {
            if (!onBack || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
            e.preventDefault()
            onBack(parent.id)
          }}
        >
          来自「{parent.title || '无标题'}」的回复 ›
        </Link>
      )}
    </div>
  )
}

export function RunFoot({ detail }: { detail: RunDetail }) {
  const { record } = detail
  if (!record.output) return null
  return (
    <div className="run-page run-page-foot">
      <div className="run-page-output">
        <div className="run-page-output-label">最终输出</div>
        <pre className="rd-pre">{record.output}</pre>
      </div>
    </div>
  )
}
