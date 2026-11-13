/* ---------- 空间 AI 页的「对话」栏：我和这个空间的空间 AI 的直接对话 ----------
 * 对话页在我自己的私人区，只有我看得到（服务端 agents/space-ai-chat.ts）：进来时 POST /api/spaces/:id/ai/chat 拿页（没有就建），
 * 对话本身和 Genet 浮窗同一套（AssistantChat）。只读成员、空间 AI 没开时不建页，各给一句说明；没开时 owner 多一个「去启用」。 */
import { useEffect, useState } from 'react'
import { ApiError, request, type Page, type Space } from '../api'
import { COPY } from '../copy'
import { openSettings } from '../settings-bus'
import AssistantChat from './AssistantChat'

const C = COPY.spaceAi.hub

type ChatState = { kind: 'loading' } | { kind: 'ready'; pageId: string } | { kind: 'off' } | { kind: 'viewer' } | { kind: 'error'; message: string }

export default function SpaceAiChat({
  space,
  aiName,
  pages,
  username,
  onChanged,
}: {
  space: Space
  aiName: string
  pages: Page[] | null
  username: string
  onChanged: () => void
}) {
  const [state, setState] = useState<ChatState>({ kind: 'loading' })
  const enabled = space.ai?.enabled === true
  useEffect(() => {
    if (space.my_role === 'viewer') return setState({ kind: 'viewer' })
    if (!enabled) return setState({ kind: 'off' })
    let alive = true
    setState({ kind: 'loading' })
    request<{ pageId: string; created: boolean }>(`/api/spaces/${encodeURIComponent(space.id)}/ai/chat`, { method: 'POST' }).then(
      (res) => {
        if (!alive) return
        setState({ kind: 'ready', pageId: res.pageId })
        // 新建的页要进页面列表与空间列表（ai.chat），这一页上才认得出空间 AI
        if (res.created) onChanged()
      },
      (err: unknown) => {
        if (!alive) return
        if (err instanceof ApiError && err.code === 'off') setState({ kind: 'off' })
        else if (err instanceof ApiError && err.code === 'viewer') setState({ kind: 'viewer' })
        else setState({ kind: 'error', message: err instanceof Error && err.message ? err.message : C.failed })
      },
    )
    return () => {
      alive = false
    }
  }, [space.id, space.my_role, enabled, onChanged])

  if (state.kind === 'ready') {
    return (
      <div className="ai-chat space-ai-chat">
        <p className="space-ai-private">{C.privateNote}</p>
        <AssistantChat key={state.pageId} pageId={state.pageId} pages={pages} username={username} onPagesChanged={onChanged} spaceAi={{ emptyHint: C.empty(aiName) }} />
      </div>
    )
  }
  return (
    <div className="ai-chat space-ai-chat">
      <div className="space-ai-state">
        {state.kind === 'loading' && <p>{COPY.loading}</p>}
        {state.kind === 'viewer' && <p>{C.viewer}</p>}
        {state.kind === 'error' && <p>{state.message}</p>}
        {state.kind === 'off' && (
          <>
            <p>{C.off}</p>
            {space.my_role === 'owner' ? (
              <button type="button" className="admin-btn primary" onClick={() => openSettings('space', space.id)}>
                {C.enable}
              </button>
            ) : (
              <p className="space-ai-hint">{C.askOwner}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
