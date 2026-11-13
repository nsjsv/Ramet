/* ---------- 浮窗里的 Genet 对话：Genet 页的第二个编辑器会话 + 完整的对话视图（空间 AI 页的直接对话也用这一套） ----------
 * 和对话页的聊天模式是同一套：ChatView（消息、步骤、审批卡、@ 提及、附件）+ 兜底的审批弹条。正文编辑器只是 ChatView 的底座
 * （schema 与写入通道），挂在一个藏着的节点上，用对话档（page-session.ts），不装页面外壳。
 * 输入框桥、运行错误、审批宿主都按页面分存，当前页开着聊天模式也互不串。浮窗关掉 = 本组件卸载 = 会话、连接一起拆掉。 */
import { useEffect, useState } from 'react'
import type { Page } from '../api'
import { COPY } from '../copy'
import { AgentPanel, useAgentEvents } from '../editor/agent-bar'
import ChatView from '../editor/chat-view'
import { CHAT_SCROLLER_ATTR } from '../editor/chat-follow'
import { usePageSession } from '../editor/page-session'
import { markPageSeen, openPage } from '../inbox/inbox-store'
import { getAiSettings, subscribeAiSettings } from '../quick-api'
import { openSettings } from '../settings-bus'

const C = COPY.assistant

/** Genet 用用户自己的模型连接（默认设置里的当前连接，输入框旁的 chip 可换）：一个都没有（当前连接为空）就给去设置的引导。
 *  打开时、浏览器窗口回到前台时、设置里改了连接时重查，配好以后不用刷新 */
function ModelGuide() {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    const check = (): void => {
      void getAiSettings(true).then(
        (s) => alive && setMissing(!s.activeConnectionId),
        () => undefined, // 取不到设置不拦：真没有连接时，回复的失败条上有同一句引导
      )
    }
    check()
    const off = subscribeAiSettings(check)
    window.addEventListener('focus', check)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', check)
    }
  }, [])
  if (!missing) return null
  return (
    <div className="assistant-guide" role="status">
      <span>{C.noModel}</span>
      <button type="button" className="assistant-guide-btn" onClick={() => openSettings('quick')}>
        {C.setup}
      </button>
    </div>
  )
}

export default function AssistantChat({
  pageId,
  pages,
  username,
  onPagesChanged,
  focus,
  spaceAi,
}: {
  pageId: string
  pages: Page[] | null
  username: string
  onPagesChanged: () => void
  /** 浮窗：用户正在看的那一页（消息默认关于它）；AI 页里的整页对话没有 */
  focus?: { id: string; title: string } | null
  /** 和空间 AI 的直接对话（空间 AI 页复用这一套）：不给「去配模型连接」的引导（用的是空间 owner 的连接），空对话的提示换成它的 */
  spaceAi?: { emptyHint: string }
}) {
  const session = usePageSession(pageId, { profile: 'chat', username, readOnly: false, pages })
  const agentState = useAgentEvents(pageId)
  // 浮窗开着 = 这页正开着：它上面做完的回合不进收件箱的「做完待你看」
  useEffect(() => {
    markPageSeen(pageId)
    return openPage(pageId)
  }, [pageId])
  return (
    <div className="assistant-scroll" {...{ [CHAT_SCROLLER_ATTR]: '' }}>
      {!spaceAi && <ModelGuide />}
      <div ref={session.rootRef} className="chat-hidden" aria-hidden="true" />
      <ChatView
        pageId={pageId}
        readOnly={false}
        pages={pages}
        onPagesChanged={onPagesChanged}
        getEditor={session.getEditor}
        getDoc={session.getDoc}
        tick={session.tick}
        agentState={agentState}
        emptyHint={spaceAi?.emptyHint ?? C.empty}
        focusPage={focus?.id ?? null}
        placeholder={focus ? C.focusPlaceholder : undefined}
      />
      <AgentPanel pageId={pageId} state={agentState} />
    </div>
  )
}
