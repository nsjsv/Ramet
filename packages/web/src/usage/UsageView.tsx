/* ---------- AI 使用量的界面：设置里的「AI 使用量」分页、空间 AI 卡里 owner 的用量 ----------
 * 形状：头上几块总数（调用 / 输入 / 输出 / 缓存命中）→ 每天一根柱子（单一系列，用强调色，不需要图例；悬停看当天明细）→ 分组表格。
 * 只有 token 与次数，不折算金额（各家价格不一样，模型目录里也没有）。数据打开时取一次，不轮询。 */

import { useEffect, useState } from 'react'
import { COPY } from '../copy'
import { Card } from '../ui/form-kit'
import { usageApi, type MyUsage, type SpaceAiUsage, type UsageDay, type UsageSums } from './usage-api'
import { axisTicks, barHeights, formatTokens, shortDay, sourceLabel, tokensOf } from './usage-model'

const C = COPY.usage

/** 头上的几块总数 */
function UsageTiles({ totals }: { totals: UsageSums }) {
  const tiles: Array<[string, string]> = [
    [C.tiles.calls, totals.calls.toLocaleString('zh-CN')],
    [C.tiles.input, formatTokens(totals.input)],
    [C.tiles.output, formatTokens(totals.output)],
    [C.tiles.cache, formatTokens(totals.cacheRead)],
  ]
  return (
    <div className="usage-tiles">
      {tiles.map(([label, value]) => (
        <div className="usage-tile" key={label}>
          <span className="usage-tile-value">{value}</span>
          <span className="usage-tile-label">{label}</span>
        </div>
      ))}
    </div>
  )
}

/** 每天一根柱子：柱高 = 当天全部 token；整列都是悬停区（比柱子大，矮柱子也好指） */
function UsageBars({ byDay }: { byDay: UsageDay[] }) {
  const heights = barHeights(byDay.map(tokensOf))
  const ticks = axisTicks(byDay.map((d) => d.day))
  return (
    <div className="usage-chart">
      <div className="usage-chart-title">{C.trend}</div>
      <div className="usage-bars" role="list" aria-label={C.chartLabel(byDay.length)}>
        {byDay.map((d, i) => {
          const tip = C.dayTip(shortDay(d.day), d.calls, formatTokens(tokensOf(d)))
          return (
            <div className="usage-bar-col" role="listitem" key={d.day} data-tip={tip} aria-label={tip}>
              {heights[i]! > 0 && <div className="usage-bar" style={{ height: `${heights[i]}%` }} />}
            </div>
          )
        })}
      </div>
      <div className="usage-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.index} style={{ left: `${((t.index + 0.5) / byDay.length) * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 分组表格：名称 / 次数 / token（多的在前，服务端已排好） */
function UsageTable({ title, rows }: { title: string; rows: Array<{ key: string; label: string; sums: UsageSums }> }) {
  if (rows.length === 0) return null
  return (
    <div className="usage-table-wrap">
      <div className="usage-chart-title">{title}</div>
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{C.cols.name}</th>
            <th scope="col">{C.cols.calls}</th>
            <th scope="col">{C.cols.tokens}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>{r.sums.calls.toLocaleString('zh-CN')}</td>
              <td>{formatTokens(tokensOf(r.sums))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 取一次数据：null = 还在取；Error = 失败 */
function useUsage<T>(load: () => Promise<T>, key: string): T | Error | null {
  const [data, setData] = useState<T | Error | null>(null)
  useEffect(() => {
    let alive = true
    setData(null)
    load().then(
      (d) => alive && setData(d),
      (err: unknown) => alive && setData(err instanceof Error ? err : new Error(String(err))),
    )
    return () => {
      alive = false
    }
    // load 每次渲染都是新函数，按 key 取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return data
}

/** 设置里的「AI 使用量」分页 */
export function MyUsagePane() {
  const data = useUsage<MyUsage>(() => usageApi.mine(), 'mine')
  if (data === null) return <div className="set-empty">{C.loading}</div>
  if (data instanceof Error) return <div className="modal-error">{C.failed}</div>
  return (
    <>
      <Card>
        <div className="set-pad set-desc">{C.scope}</div>
        {data.totals.calls === 0 ? (
          <div className="set-empty">{C.empty}</div>
        ) : (
          <div className="usage-body">
            <UsageTiles totals={data.totals} />
            <UsageBars byDay={data.byDay} />
          </div>
        )}
      </Card>
      {data.totals.calls > 0 && (
        <Card>
          <div className="usage-body">
            <UsageTable title={C.bySource} rows={data.bySource.map((s) => ({ key: s.source, label: sourceLabel(s.source), sums: s }))} />
            <UsageTable title={C.byModel} rows={data.byModel.map((s) => ({ key: s.model, label: s.model, sums: s }))} />
          </div>
        </Card>
      )}
    </>
  )
}

/** 空间设置「空间 AI」卡下面，只给 owner：这个空间的空间 AI 花了多少，按成员分 */
export function SpaceAiUsageCard({ spaceId }: { spaceId: string }) {
  const data = useUsage<SpaceAiUsage>(() => usageApi.space(spaceId), spaceId)
  return (
    <Card title={C.space.title}>
      <div className="set-pad set-desc">{C.space.desc}</div>
      {data === null && <div className="set-empty">{C.loading}</div>}
      {data instanceof Error && <div className="set-empty">{C.failed}</div>}
      {data && !(data instanceof Error) &&
        (data.totals.calls === 0 ? (
          <div className="set-empty">{C.empty}</div>
        ) : (
          <div className="usage-body">
            <UsageTiles totals={data.totals} />
            <UsageBars byDay={data.byDay} />
            <UsageTable title={C.byMember} rows={data.byMember.map((m) => ({ key: m.userId ?? `gone:${m.name}`, label: m.name, sums: m }))} />
          </div>
        ))}
    </Card>
  )
}
