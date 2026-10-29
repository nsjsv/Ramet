// 历史版本列表（文档页 VersionHistory 与集合页 CollectionHistory 共用）。
// 只管列表本身：首屏一页 + 自动选中最新、续拉更早一页、时钟跳转定位、手动存版。选中后怎么解码、怎么预览归各组件。
// 版本永不删除，列表是分页窗口：服务端每页多给一条（tail），作为最旧展示行的对比基线。

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { api, HISTORY_PAGE, type PageSnapshot, type PageSnapshotDetail } from './api'

/** 选中一条（prev = 列表里它的上一版，即更旧一条；没有 = undefined） */
export type SelectSnapshot = (meta: PageSnapshot, prev?: PageSnapshot) => Promise<void> | void

type Options = {
  /** 每次重拉列表前（换页 / select 换了）调用：组件在这里作废在途选中、清缓存 */
  onReset?: () => void
  /** 更新面板时钟跳转的目标快照 id；选中后经 onJumped 复位 */
  jumpToId?: string | null
  onJumped?: () => void
}

export type SnapshotList = {
  snapshots: PageSnapshot[] | null
  /** 已取回但未展示的更旧一条（有 = 还能续拉） */
  tail: PageSnapshot | null
  prevOf: (i: number) => PageSnapshot | undefined
  loadingMore: boolean
  loadMore: () => Promise<void>
  saving: boolean
  saveManual: () => Promise<void>
  error: string | null
  setError: (error: string | null) => void
}

/** 快照详情 → 临时 Y.Doc（data = 那个版本全量状态的 base64） */
export function snapshotDoc(detail: PageSnapshotDetail): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(atob(detail.data), (ch) => ch.charCodeAt(0)))
  return doc
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function useSnapshotList(pageId: string, select: SelectSnapshot, opts: Options = {}): SnapshotList {
  const { jumpToId, onJumped } = opts
  const [snapshots, setSnapshots] = useState<PageSnapshot[] | null>(null)
  const [tail, setTail] = useState<PageSnapshot | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onResetRef = useRef(opts.onReset)
  useEffect(() => {
    onResetRef.current = opts.onReset
  })

  // 打开/换页时拉列表并自动选中最新一条
  useEffect(() => {
    let cancelled = false
    onResetRef.current?.()
    setSnapshots(null)
    setTail(null)
    setError(null)
    api
      // 多取一条：末条留作最旧展示行的对比基线（列表是分页窗口，边界那行的上一版不在窗口里）
      .listSnapshots(pageId, { limit: HISTORY_PAGE + 1 })
      .then((rows) => {
        if (cancelled) return
        setSnapshots(rows.slice(0, HISTORY_PAGE))
        setTail(rows[HISTORY_PAGE] ?? null)
        if (rows[0]) void select(rows[0], rows[1])
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err))
      })
    return () => {
      cancelled = true
    }
  }, [pageId, select])

  // 上一版（对比基线）：列表下一条；列表最旧一行用服务端多给的那条（它在展示窗口之外）
  const prevOf = useCallback(
    (i: number): PageSnapshot | undefined => snapshots?.[i + 1] ?? (i + 1 === snapshots?.length ? tail ?? undefined : undefined),
    [snapshots, tail],
  )

  // 时钟跳转定位：jumpToId 在已拉取列表里就直接选中；不在（更新流水可以翻得比历史列表更深）就以它为中心拉一段窗口
  // 替换列表，再选中。找不到也要复位，免得挂着一次永不生效的跳转。列表未到（null）时不动作，拉取完成后 snapshots
  // 变化会重跑本 effect 补定位。本 effect 后于默认选中执行，select 令牌保证跳转目标覆盖 rows[0] 的选中；
  // 复位在发起选中后立即做，不等详情返回。
  useEffect(() => {
    if (!jumpToId || !snapshots) return
    const idx = snapshots.findIndex((s) => s.id === jumpToId)
    if (idx !== -1) {
      void select(snapshots[idx]!, prevOf(idx))
      onJumped?.()
      return
    }
    let cancelled = false
    // 响应 = 更晚一段 + 目标及其更旧一段，两段在目标处分界（目标是后段首条）。后段打满 limit 说明还有更旧的，
    // 末条留作基线不展示；没打满说明已到链首，全部展示（最旧一版本来就没有上一版，对比退化成空 doc 是对的）。
    api
      .listSnapshots(pageId, { limit: HISTORY_PAGE + 1, around: jumpToId })
      .then((rows) => {
        if (cancelled) return
        const i = rows.findIndex((r) => r.id === jumpToId)
        if (i === -1) {
          setError('找不到该版本')
          onJumped?.()
          return
        }
        const newer = rows.slice(0, i)
        const older = rows.slice(i)
        const saturated = older.length === HISTORY_PAGE + 1
        setSnapshots([...newer, ...(saturated ? older.slice(0, -1) : older)])
        setTail(saturated ? older[older.length - 1]! : null)
        void select(rows[i]!, rows[i + 1] ?? undefined)
        onJumped?.()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(message(err))
        onJumped?.()
      })
    return () => {
      cancelled = true
    }
  }, [jumpToId, snapshots, pageId, prevOf, select, onJumped])

  // 续拉更早一页：游标取最旧展示行的 created_at，tail（外一条）会被服务端一并带回，成为新段首行
  const loadMore = async (): Promise<void> => {
    if (!snapshots || snapshots.length === 0) return
    setLoadingMore(true)
    try {
      const rows = await api.listSnapshots(pageId, {
        limit: HISTORY_PAGE + 1,
        before: snapshots[snapshots.length - 1]!.created_at,
      })
      setSnapshots([...snapshots, ...rows.slice(0, HISTORY_PAGE)])
      setTail(rows[HISTORY_PAGE] ?? null)
    } catch (err) {
      setError(message(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const saveManual = async (): Promise<void> => {
    setSaving(true)
    try {
      const created = await api.createSnapshot(pageId)
      const rows = await api.listSnapshots(pageId, { limit: HISTORY_PAGE + 1 })
      setSnapshots(rows.slice(0, HISTORY_PAGE))
      setTail(rows[HISTORY_PAGE] ?? null)
      const idx = rows.findIndex((r) => r.id === created.id)
      await select(rows[idx] ?? created, rows[idx + 1])
    } catch (err) {
      setError(message(err))
    } finally {
      setSaving(false)
    }
  }

  return { snapshots, tail, prevOf, loadingMore, loadMore, saving, saveManual, error, setError }
}
