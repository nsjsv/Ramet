/* ---------- `/记住 <内容>`：Ramet 自己的命令，不发给 agent、不产生 agent 运行 ----------
 * 输入卡（chat-view.tsx 的 send）与文档模式的 `>> /记住 …` 草稿（doc-send.ts 的 sendLast）共用这里：
 * 识别 → 直接 POST /api/spaces/:id/memories（与记忆面板同一个接口，权限 / 上限判定都在服务端）。 */

import { COPY } from '../copy'
import { memoryApi } from './memory-api'

const C = COPY.memory.command

/** 命令本身（斜杠菜单起草稿用这个，parseRemember 认这个） */
export const REMEMBER_COMMAND = '/记住'

/** 是不是 `/记住 …`：是 → 返回要记的内容（可能是空串：只敲了命令）；不是 → null。「/记住」后面必须是空白或结尾（`/记住了` 不算） */
export function parseRemember(text: string): string | null {
  const m = /^\/记住(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? (m[1] ?? '').trim() : null
}

export type RememberResult = { ok: true } | { ok: false; message: string }

/** 执行命令：content 为空给用法；没有空间 / 服务端拒绝（只读 403、超限 413 …）给人话 */
export async function remember(spaceId: string | undefined | null, content: string): Promise<RememberResult> {
  if (!content) return { ok: false, message: C.usage }
  if (!spaceId) return { ok: false, message: C.noSpace }
  try {
    await memoryApi.add(spaceId, content)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : C.failed }
  }
}

/* 文档模式没有 pages 列表可传：编辑器会话把「这页在哪个空间」登记在这里（页面卸载时注销），sendLast 据此找空间 */
const spaceLookups = new Map<string, () => string | undefined>()

export function bindPageSpace(pageId: string, get: () => string | undefined): () => void {
  spaceLookups.set(pageId, get)
  return () => {
    if (spaceLookups.get(pageId) === get) spaceLookups.delete(pageId)
  }
}

export const spaceOfPage = (pageId: string): string | undefined => spaceLookups.get(pageId)?.()
