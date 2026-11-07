/* ---------- AI 页的任务分页（/ai/tasks）：Genet 派出去的任务页 ----------
 * 任务页 = Genet 页下面的普通页面（assistant/task-status.ts 的 taskPages），新的在上。状态与对话里任务链接后面的状态标是同一份
 * （usePollStatuses / useStatuses）：同样的轮询节奏、收件箱信号重问、到了终态不再问；一次最多问 50 个，超出的只给最近 50 个问。 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Page } from '../api'
import { COPY } from '../copy'
import { relativeTime } from '../UpdatesFeed'
import { RUN_STATUS_MAX } from '../assistant/assistant-api'
import { statusLabel, taskPages, usePollStatuses, useStatuses } from '../assistant/task-status'
import { GenetStatus, type GenetPage } from './genet-page'

const C = COPY.ai.tasks

export default function TaskList({ genet, retry, pages }: { genet: GenetPage; retry: () => void; pages: Page[] | null }) {
  const navigate = useNavigate()
  const parentId = genet?.pageId ?? null
  const list = useMemo(() => (parentId ? taskPages(pages, parentId) : []), [pages, parentId])
  const polled = useMemo(() => list.slice(0, RUN_STATUS_MAX).map((p) => p.id), [list])
  usePollStatuses(polled)
  const statuses = useStatuses()

  return (
    <div className="ai-tasks" data-flip>
      <p className="ai-sub">{C.sub}</p>
      {!parentId ? (
        <GenetStatus genet={genet} retry={retry} />
      ) : pages === null ? null : list.length === 0 ? (
        <p className="ai-empty">{C.empty}</p>
      ) : (
        <ul className="ai-task-list">
          {list.map((p) => {
            const status = statuses.get(p.id)
            const label = statusLabel(status)
            return (
              <li key={p.id}>
                <button type="button" className="ai-task" onClick={() => navigate(`/page/${p.id}`)}>
                  <span className="ai-task-title">{p.title.trim() || COPY.untitled}</span>
                  {label && (
                    <span className="task-mark" data-status={status}>
                      {label}
                    </span>
                  )}
                  <span className="ai-task-time">{relativeTime(p.created_at)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
