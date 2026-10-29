/* ---------- 过程页的 record 登记（步骤块按 sid 取详情用） ----------
 * 步骤块（run-step-view.ts）只有一行字；完整详情在 runs.record。过程页宿主（Editor 的 useRunDetail / 公开页的
 * publicDoc）拿到 record 就登记在这里，块的视图按页 id 读。按页订阅：块先建好、record 后到，到了通知它们重画。 */
import { entrySid, type RunEntry } from '@ramet/shared/run-model'
import type { RunRecord } from '../api'

export type RunInfo = { record: RunRecord; parent: { id: string; title: string } | null }

const infos = new Map<string, RunInfo>()
const listeners = new Map<string, Set<() => void>>()
/** record 不可变：sid → 条目的表按 record 缓存一次 */
const bySid = new WeakMap<RunRecord, Map<string, RunEntry>>()

export function setRunInfo(pageId: string, info: RunInfo): void {
  infos.set(pageId, info)
  listeners.get(pageId)?.forEach((fn) => fn())
}

export function getRunInfo(pageId: string): RunInfo | undefined {
  return infos.get(pageId)
}

export function onRunInfo(pageId: string, fn: () => void): () => void {
  let set = listeners.get(pageId)
  if (!set) listeners.set(pageId, (set = new Set()))
  set.add(fn)
  return () => set.delete(fn)
}

/** 块 sid → record 里的那一条（用户新加的块 sid 为空、或 sid 对不上 = undefined） */
export function entryOfSid(pageId: string, sid: string): RunEntry | undefined {
  const record = infos.get(pageId)?.record
  if (!record || !sid) return undefined
  let table = bySid.get(record)
  if (!table) {
    table = new Map(record.entries.map((e, i) => [entrySid(e, i), e]))
    bySid.set(record, table)
  }
  return table.get(sid)
}
