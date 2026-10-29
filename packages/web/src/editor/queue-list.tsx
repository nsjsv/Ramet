/* ---------- 排队区（运行中排队发送，服务端 agents/send-queue.ts）----------
 * 输入卡上方列出这一页排着的消息（谁排的、摘要、图片张数）。排的人自己有「撤回」（文字 / 图片回到输入框）和「立即发送」
 * （停下当前这一轮后马上发）；别人的只能看。上一轮没正常结束（出错 / 手动停止）时排着的不会自动发，这里提示一句。 */
import { api, ApiError, type QueueItem } from '../api'
import { Icon } from '../icons'
import { selfId } from '../people'
import { setAgentRunError } from './agent-bar'

const C = {
  title: '排在这一轮后面',
  paused: '上一轮没正常结束，排着的没自动发：可以点「立即发送」',
  continue: '（文档里最后一条消息，结束后继续）',
  images: (n: number) => `${n} 张图`,
  by: (name: string) => `${name} 排的`,
  withdraw: '撤回',
  now: '立即发送',
  failed: '操作失败',
}

export function QueueList({
  pageId,
  items,
  paused,
  onWithdraw,
}: {
  pageId: string
  items: QueueItem[]
  paused: boolean
  /** 撤回成功：文字 / 图片地址交给输入卡 */
  onWithdraw: (text: string, images: string[]) => void
}) {
  if (items.length === 0) return null
  const me = selfId()
  const fail = (err: unknown): void => {
    // 404 = 已经发出 / 撤回了（排队区随广播更新），不打扰
    if (err instanceof ApiError && err.status === 404) return
    setAgentRunError(err instanceof Error ? err.message : C.failed)
  }
  return (
    <div className="chat-queue" role="list" aria-label={C.title}>
      {paused && <div className="chat-queue-paused">{C.paused}</div>}
      {items.map((q) => {
        const mine = q.userId === me
        const text = q.kind === 'continue' ? C.continue : q.text
        return (
          <div key={q.id} className="chat-queue-item" role="listitem">
            <Icon name="clock" size={13} />
            <span className="chat-queue-text" title={text}>
              {text}
              {q.images > 0 && <span className="chat-queue-meta"> · {C.images(q.images)}</span>}
              {!mine && <span className="chat-queue-meta"> · {C.by(q.username)}</span>}
            </span>
            {mine && (
              <span className="chat-queue-acts">
                <button type="button" onClick={() => void api.withdrawQueued(pageId, q.id).then((r) => onWithdraw(r.text, r.images), fail)}>
                  {C.withdraw}
                </button>
                <button type="button" className="is-primary" onClick={() => void api.sendQueuedNow(pageId, q.id).catch(fail)}>
                  {C.now}
                </button>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
