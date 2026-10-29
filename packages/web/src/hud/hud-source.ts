/* ---------- 跑完的一轮：按过程页 id 拉 record（GET /api/runs/:id）----------
 * 只在打开面板看某一轮时拉，按过程页 id 缓存（过程页的 record 收尾后不再变）；拉失败的不缓存，下次再试。 */
import { useEffect, useState } from 'react'
import { api, type RunRecord } from '../api'

const cache = new Map<string, RunRecord>()
const inflight = new Map<string, Promise<RunRecord>>()

function load(runId: string): Promise<RunRecord> {
  let p = inflight.get(runId)
  if (!p) {
    p = api.getRun(runId).then((d) => {
      cache.set(runId, d.record)
      return d.record
    })
    p.finally(() => inflight.delete(runId)).catch(() => undefined)
    inflight.set(runId, p)
  }
  return p
}

export function useRunRecord(runId: string | null): { record: RunRecord | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; record: RunRecord | null; failed: boolean }>(() => ({
    id: runId,
    record: runId ? (cache.get(runId) ?? null) : null,
    failed: false,
  }))
  useEffect(() => {
    if (!runId) return setState({ id: null, record: null, failed: false })
    const hit = cache.get(runId)
    if (hit) return setState({ id: runId, record: hit, failed: false })
    let alive = true
    setState({ id: runId, record: null, failed: false })
    load(runId).then(
      (record) => alive && setState({ id: runId, record, failed: false }),
      () => alive && setState({ id: runId, record: null, failed: true }),
    )
    return () => {
      alive = false
    }
  }, [runId])
  return state.id === runId ? { record: state.record, failed: state.failed } : { record: null, failed: false }
}
