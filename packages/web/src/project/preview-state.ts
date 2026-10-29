import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribePreviews } from '../control'
import { previewApi, type PreviewList } from './preview-api'

/** 一个页面上共享中的预览。进页面取一次，之后服务端广播「这一页的预览变了」（共享 / 停止 / 授权收回）才重取，不轮询。
 *  pageId 为空（或 enabled=false）= 不取、不订阅 */
export function usePagePreviews(pageId: string | undefined, enabled = true): { data: PreviewList | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<PreviewList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(() => {
    if (!pageId) return
    const mine = ++seq.current
    previewApi.list(pageId).then(
      (list) => {
        if (mine !== seq.current) return // 换页 / 又有新的请求了：丢掉晚到的
        setData(list)
        setError(null)
      },
      (err: unknown) => mine === seq.current && setError(err instanceof Error ? err.message : String(err)),
    )
  }, [pageId])

  useEffect(() => {
    setData(null)
    setError(null)
    if (!pageId || !enabled) return
    reload()
    const off = subscribePreviews((changed) => {
      if (changed === null || changed === pageId) reload()
    })
    return () => {
      seq.current += 1
      off()
    }
  }, [pageId, enabled, reload])

  return { data, error, reload }
}
