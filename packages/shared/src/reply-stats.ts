// ---------- AI 回复块的 `stats` 属性：生命周期 + 本轮摘要 ----------
// 服务端建占位块时写 `o:run`，收尾事务覆盖成终态；前端读它画用量标签，markdown 标记段原样带着它往返。
// 编码是逗号分隔的 `键:值`。未知的项不出现（agent 没报用量就没有 tk，绝不写 0 冒充）。
//   o  结果：run（进行中 / 没收尾就断了）| end | cancelled | error
//   ms 用时（毫秒）  st 工具调用次数
//   tk 总 token  in / out / cr / cw / th  输入 / 输出 / 缓存读 / 缓存写 / 思考
//   cu / cs  上下文 used / size（最后一次 usage_update）
//   fc / fa / fd  改了几个文件 / 加了几行 / 删了几行   ag  协作的 agent 数（子代理 / run_agent / 带队组员）
//            这两组收尾时按 run-tally.ts 算好，回复抬头停靠的岛不拉 record 就能画；旧回复没有就不出这两组

export type ReplyOutcome = 'run' | 'end' | 'cancelled' | 'error'

export type ReplyStats = {
  o?: ReplyOutcome
  ms?: number
  st?: number
  tk?: number
  in?: number
  out?: number
  cr?: number
  cw?: number
  th?: number
  cu?: number
  cs?: number
  fc?: number
  fa?: number
  fd?: number
  ag?: number
}

const NUMBER_KEYS = ['ms', 'st', 'tk', 'in', 'out', 'cr', 'cw', 'th', 'cu', 'cs', 'fc', 'fa', 'fd', 'ag'] as const
const OUTCOMES: ReadonlySet<string> = new Set(['run', 'end', 'cancelled', 'error'])

export function encodeStats(stats: ReplyStats): string {
  const parts: string[] = []
  if (stats.o) parts.push(`o:${stats.o}`)
  for (const key of NUMBER_KEYS) {
    const value = stats[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) parts.push(`${key}:${Math.round(value)}`)
  }
  return parts.join(',')
}

/** 坏输入返回空对象，不抛：属性来自协同文档，任何一端都可能写进奇怪的值 */
export function decodeStats(raw: unknown): ReplyStats {
  const out: ReplyStats = {}
  if (typeof raw !== 'string' || !raw) return out
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':')
    if (i <= 0) continue
    const key = pair.slice(0, i)
    const value = pair.slice(i + 1)
    if (key === 'o') {
      if (OUTCOMES.has(value)) out.o = value as ReplyOutcome
      continue
    }
    if (!(NUMBER_KEYS as readonly string[]).includes(key)) continue
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0) out[key as (typeof NUMBER_KEYS)[number]] = n
  }
  return out
}
