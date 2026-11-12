// ---------- 不挂在页面上的一次运行（新会话 → 一轮 → 收下文字 → 丢掉会话） ----------
// 给没有对话页的入口用（评论里叫空间 AI）：一轮的文字直接交回调用方，不写回复块、不留过程页、不留会话历史。
// 凭证由调用方签好（谁叫的、范围多大、是不是只读都在凭证上），驱动照常按它认会话主体、拉起 MCP。
// 交回的文字是最后一次调工具之后说的那一段（「我先读一下页面」这类过程话不算回答）；最后一段是空的才退回前面那段。
// 驱动本身不知道评论；停止由调用方的 signal 交给 cancel。

import type { PageTool } from '../../../page-read.js'
import type { PromptBlock } from '../../types.js'
import type { AssistantDriver } from './driver.js'

export type OnceResult = { text: string; stopReason: string }

export async function runOnce(
  driver: AssistantDriver,
  run: { url: string; token: string; blocks: PromptBlock[]; signal?: AbortSignal },
): Promise<OnceResult> {
  const tool: PageTool = { mcp: { url: run.url, token: run.token } }
  const { sessionId } = await driver.newSession('', [tool])
  let text = ''
  let before = ''
  const off = driver.on((ev) => {
    if (ev.type === 'text' && ev.sessionId === sessionId) text += ev.delta
    else if (ev.type === 'tool' && ev.sessionId === sessionId && ev.status === 'in_progress' && text.trim()) {
      before = text
      text = ''
    }
  })
  const stop = (): void => driver.cancel(sessionId)
  run.signal?.addEventListener('abort', stop, { once: true })
  try {
    if (run.signal?.aborted) return { text: '', stopReason: 'cancelled' }
    const { stopReason } = await driver.prompt(sessionId, run.blocks)
    return { text: text.trim() ? text : before, stopReason }
  } finally {
    run.signal?.removeEventListener('abort', stop)
    off()
    await driver.forget(sessionId).catch((err: unknown) => console.error(`[assistant] 一次性会话 ${sessionId} 没删掉：${err instanceof Error ? err.message : String(err)}`))
  }
}
