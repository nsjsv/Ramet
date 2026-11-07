/* ---------- AI 页里的 Genet 页 id：Genet 与任务两个分页共用一份 ----------
 * 第一次要用时才问服务端（POST /api/me/assistant：没有、或进了回收站就新建，同浮窗），只看 Skill / 记忆不会建出 Genet 页。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { COPY } from '../copy'
import { assistantApi } from '../assistant/assistant-api'
import { rememberAssistantPage } from '../assistant/identity'

/** null = 还没问；pageId 与 error 都是 null = 正在问 */
export type GenetPage = { pageId: string | null; error: string | null } | null

export function useGenetPage(needed: boolean): { genet: GenetPage; retry: () => void } {
  const [genet, setGenet] = useState<GenetPage>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const retry = useCallback(() => {
    setGenet({ pageId: null, error: null })
    assistantApi.page().then(
      (pageId) => {
        if (!alive.current) return
        // 对话首帧就认得出这是 Genet 页（SSE 的 choice 到之前），同浮窗
        rememberAssistantPage(pageId)
        setGenet({ pageId, error: null })
      },
      (err: unknown) => {
        if (alive.current) setGenet({ pageId: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
  }, [])
  useEffect(() => {
    if (needed && genet === null) retry()
  }, [needed, genet, retry])
  return { genet, retry }
}

/** 正在问 / 没问到 Genet 页时的占位（文案同浮窗） */
export function GenetStatus({ genet, retry }: { genet: GenetPage; retry: () => void }) {
  return (
    <div className="assistant-status">
      {genet?.error ? (
        <>
          <span>{COPY.assistant.loadFailed(genet.error)}</span>
          <button type="button" className="assistant-guide-btn" onClick={retry}>
            {COPY.assistant.retry}
          </button>
        </>
      ) : (
        COPY.assistant.loading
      )}
    </div>
  )
}
