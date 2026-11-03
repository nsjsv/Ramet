/* ---------- 乐观改值的回声（collection-store.ts 用） ----------
 * 乐观写已经按旧行 / 新行把窗口计数增减过一次；服务端随后发来的同一改动（投影器的增量，带 prev）再按 prev 套一次，
 * 计数就重复增减了。所以记下每一格依次写过、服务端还没回声的值：增量到了，prev 里对上的键改写成「窗口里现在的值」
 * （旧行 = 新行，计数不再动）。连着改同一格（多选连点几个选项）时服务端可能分几批回声，每批对上的是中间某一次：
 * 行里这个键保持最后一次乐观写的值，不闪回中间态。 */
import type { RowsDelta, RowUpdate } from '@ramet/shared/collection-model'
import type { RowSet } from './collection-api'
import { withValues } from './relation-write'

/** 乐观改值的回声多久内认（投影器约 100ms 去抖，留足网络余量） */
export const ECHO_TTL = 10_000

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : null)

export type Echoes = {
  /** 登记一行乐观写下的值（null = 清空） */
  record: (rowId: string, values: RowSet) => void
  /** 写失败（随后以服务端为准重取）：不再等这一行的回声 */
  drop: (rowId: string) => void
  /** 服务端增量里自己乐观套过的改动改写掉 */
  absorb: (delta: RowsDelta) => RowsDelta
}

export function createEchoes(): Echoes {
  /** 行 id → 属性 id → 依次写过、服务端还没回声的值 */
  const echoes = new Map<string, { values: Record<string, unknown[]>; at: number }>()

  function absorbOne(u: RowUpdate, now: number): RowUpdate {
    const echo = echoes.get(u.row.id)
    if (!echo || !u.prev) return u
    if (now - echo.at > ECHO_TTL) {
      echoes.delete(u.row.id)
      return u
    }
    const prev = { ...u.prev }
    /** 还有没回声的写：行里保持最后一次乐观写的值（关联连 computed 里那份旧的也去掉，同乐观写） */
    const held: RowSet = {}
    for (const [key, written] of Object.entries(echo.values)) {
      if (!Object.hasOwn(prev, key)) continue
      const hit = written.findIndex((value) => sameValue(own(u.row.props, key), value))
      if (hit < 0) continue
      const pending = written.slice(hit + 1)
      const shown = pending.length > 0 ? pending[pending.length - 1] : own(u.row.props, key)
      if (pending.length > 0) {
        held[key] = shown as RowSet[string]
        echo.values[key] = pending
      } else delete echo.values[key]
      prev[key] = shown
    }
    if (Object.keys(echo.values).length === 0) echoes.delete(u.row.id)
    return { row: Object.keys(held).length > 0 ? withValues(u.row, held).row : u.row, prev }
  }

  return {
    record: (rowId, values) => {
      const echo = echoes.get(rowId) ?? { values: {}, at: 0 }
      for (const [key, value] of Object.entries(values)) echo.values[key] = [...(echo.values[key] ?? []), value]
      echo.at = Date.now()
      echoes.set(rowId, echo)
    },
    drop: (rowId) => void echoes.delete(rowId),
    absorb: (delta) => {
      if (echoes.size === 0 || delta.reset) return delta
      const now = Date.now()
      return { ...delta, up: delta.up.map((u) => absorbOne(u, now)) }
    },
  }
}
