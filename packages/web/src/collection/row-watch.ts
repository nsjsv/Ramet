// ---------- 单行取数：行页面属性区的计算值（反向关联、汇总）与 refs ----------
// 属性区只有定义没有窗口：GET rows/:rowId 取这一行（带 computed）与 refs，之后跟着本集合的增量（含乐观的）换成新的一份；
// reset、依赖的集合有变、关联 / 汇总的定义变了、断线重连都重取。没人看了就丢（再看重新取：一页只有一行，取一次很轻）。
// 取数在途时来了增量：取完再取一次（取回的那份不知道包没包含那次改动），同窗口的口径。
import type { CollectionRefs, CollectionRow, RowsDelta } from '@ramet/shared/collection-model'
import type { RowWithRefs } from './collection-api'

export type RowState = { row: CollectionRow | null; refs: CollectionRefs | null }

const EMPTY_ROW: RowState = { row: null, refs: null }

type Entry = { watchers: number; state: RowState; seq: number; fetching: boolean; dirty: boolean }

export type RowWatch = {
  state: (rowId: string) => RowState
  /** 开始看一行（引用计数，返回退订） */
  watch: (rowId: string) => () => void
  /** 本集合的一条增量：这一行在里面就换成新的一份；reset 重取 */
  apply: (delta: RowsDelta) => void
  refetch: () => void
  /** 这一行单独取的那份；取数在途（可能缺着在途期间的增量）时先给 fallback（窗口里那份），都没有再给它 */
  find: (rowId: string, fallback?: CollectionRow) => CollectionRow | undefined
}

/** fetchRow 缺省（测试里的假传输）= 不取 */
export function createRowWatch(
  fetchRow: ((rowId: string) => Promise<RowWithRefs>) | undefined,
  emit: () => void,
  onRefs: (refs: CollectionRefs) => void,
): RowWatch {
  const entries = new Map<string, Entry>()
  const setState = (e: Entry, state: RowState): void => {
    e.state = state
    emit()
  }

  function load(rowId: string, e: Entry): void {
    if (!fetchRow) return
    const seq = ++e.seq
    e.fetching = true
    e.dirty = false
    fetchRow(rowId).then(
      (data) => {
        if (seq !== e.seq || entries.get(rowId) !== e) return
        e.fetching = false
        onRefs(data.refs)
        setState(e, { row: data.row, refs: data.refs })
        if (e.dirty) load(rowId, e)
      },
      (err: unknown) => {
        if (seq !== e.seq) return
        e.fetching = false
        // 行已不在这个集合（404）或网络错误：属性区退回只显示存储值
        console.error(err)
      },
    )
  }

  const refetch = (): void => entries.forEach((e, rowId) => load(rowId, e))

  return {
    state: (rowId) => entries.get(rowId)?.state ?? EMPTY_ROW,
    watch: (rowId) => {
      let entry = entries.get(rowId)
      if (!entry) {
        entry = { watchers: 0, state: EMPTY_ROW, seq: 0, fetching: false, dirty: false }
        entries.set(rowId, entry)
        load(rowId, entry)
      }
      const e = entry
      e.watchers++
      let done = false
      return () => {
        if (done) return
        done = true
        if (--e.watchers === 0 && entries.get(rowId) === e) entries.delete(rowId)
      }
    },
    apply: (delta) => {
      if (delta.reset) {
        refetch()
        return
      }
      for (const { row } of delta.up) {
        const e = entries.get(row.id)
        if (!e) continue
        if (e.fetching) e.dirty = true
        else setState(e, { ...e.state, row })
      }
    },
    refetch,
    find: (rowId, fallback) => {
      const e = entries.get(rowId)
      const row = e?.state.row ?? undefined
      return row && !e?.fetching ? row : (fallback ?? row)
    },
  }
}
