/* ---------- `/记住 <内容>`：Ramet 自己的命令，不发给 agent、不产生 agent 运行 ----------
 * 输入卡（chat-view.tsx 的 send）与文档模式的 `>> /记住 …` 草稿（doc-send.ts 的 sendLast）共用这里：
 * 识别 → POST /api/pages/:id/memories。记到哪由服务端按页面定（Genet 页和任务页 = 你的个人记忆，别的页 = 那个空间的公共记忆），
 * 权限 / 上限判定也都在服务端；提示按服务端回的去处写。 */

import { COPY } from '../copy'
import { rememberApi, type RememberTarget } from './memory-api'

const C = COPY.memory.command

/** 命令本身（斜杠菜单起草稿用这个，parseRemember 认这个） */
export const REMEMBER_COMMAND = '/记住'

/** 是不是 `/记住 …`：是 → 返回要记的内容（可能是空串：只敲了命令）；不是 → null。「/记住」后面必须是空白或结尾（`/记住了` 不算） */
export function parseRemember(text: string): string | null {
  const m = /^\/记住(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

export type RememberResult = { ok: true; message: string } | { ok: false; message: string }

/** 记成了的提示：记到了哪 */
export const savedMessage = (target: RememberTarget): string => (target === 'personal' ? C.savedPersonal : C.savedSpace(target.space))

/** 执行命令：content 为空给用法；服务端拒绝（只读 403、超限 413 …）给人话 */
export async function remember(pageId: string, content: string): Promise<RememberResult> {
  if (!content) return { ok: false, message: C.usage }
  try {
    return { ok: true, message: savedMessage(await rememberApi.onPage(pageId, content)) }
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : C.failed }
  }
}
