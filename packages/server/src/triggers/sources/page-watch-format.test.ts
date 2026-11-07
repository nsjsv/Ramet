/* ---------- 盯页面的配置与改动摘要（纯函数） ---------- */
import { describe, expect, it } from 'vitest'
import type { SummaryState } from '../../updates.js'
import { describeWatch, parseWatchConfig, watchSummary, WATCH_PAGES_MAX, type WatchedPage } from './page-watch-format.js'

const ID = '0b6f5a52-1c1e-4a39-9a43-1f2d3c4b5a69'

function state(title: string, blocks: string[], props: Record<string, unknown> = {}): SummaryState {
  return { title, blocks, props, schema: null }
}

function page(base: SummaryState, now: SummaryState | null, more: Partial<WatchedPage> = {}): WatchedPage {
  return { title: now?.title ?? base.title, trashed: false, fresh: false, base, now, editors: ['bob'], propName: () => undefined, ...more }
}

describe('parseWatchConfig / describeWatch', () => {
  it('缺省含子页、10 分钟；page: 前缀去掉；不合法的给人话', () => {
    expect(parseWatchConfig({ page: `page:${ID}` })).toEqual({ page: ID, subtree: true, quiet: 10 })
    expect(parseWatchConfig({ page: ID, subtree: false, quiet: 30 })).toEqual({ page: ID, subtree: false, quiet: 30 })
    expect(parseWatchConfig({})).toEqual({ error: '要盯哪一页？（page 填页面 id）' })
    expect(parseWatchConfig({ page: ID, quiet: 0 })).toHaveProperty('error')
    expect(parseWatchConfig({ page: ID, quiet: 1.5 })).toHaveProperty('error')
    expect(parseWatchConfig({ page: ID, subtree: 'yes' })).toHaveProperty('error')
  })

  it('一句话：页名 + 范围 + 时长；看不到的页不写标题', () => {
    expect(describeWatch({ page: ID }, '预算')).toBe('《预算》及子页 · 别人改完 10 分钟后')
    expect(describeWatch({ page: ID, subtree: false, quiet: 5 }, '')).toBe('《无标题》 · 别人改完 5 分钟后')
    expect(describeWatch({ page: ID }, null)).toBe('（看不到的页）及子页 · 别人改完 10 分钟后')
  })
})

describe('watchSummary', () => {
  it('每页一段：谁改的、改成 / 新增 / 删掉 / 标题；属性只写名字', () => {
    const out = watchSummary([
      page(state('预算', ['总额 2 万', '负责人 alice', '旧的备注']), state('预算 v2', ['总额 3 万', '负责人 alice', '风险：汇率']), { editors: ['bob', 'carol'] }),
      page(state('一行', [], { p1: 'a', p2: 1 }), state('一行', [], { p1: 'b', p2: 2 }), { propName: (id) => (id === 'p1' ? '状态' : undefined) }),
    ])
    expect(out?.text).toBe(
      ['《预算 v2》 · bob、carol', '· 改成：总额 3 万', '· 改成：风险：汇率', '· 标题改成：预算 v2', '《一行》 · bob', '· 属性：状态、某个属性'].join('\n'),
    )
    expect(out?.changed).toEqual([0, 1])
  })

  it('新页标「新页」不重复写标题；进了回收站只写一行；读得见的都没变的页不写，全没变 = null', () => {
    const out = watchSummary([
      page(state('', ['']), state('周报', ['本周完成 3 件']), { fresh: true }),
      page(state('旧页', ['x']), null, { trashed: true, title: '旧页' }),
      page(state('没变', ['a']), state('没变', ['a'])),
    ])
    expect(out?.text).toBe(['《周报》（新页） · bob', '· 新增：本周完成 3 件', '《旧页》（进了回收站） · bob'].join('\n'))
    expect(out?.changed).toEqual([0, 1])
    expect(watchSummary([page(state('没变', ['a']), state('没变', ['a']))])).toBeNull()
    // 新建了但什么都没写
    expect(watchSummary([page(state('', []), state('', ['']), { fresh: true })])).toBeNull()
    // 本来就是空页（不是这阵新建的）：照常写标题改了
    expect(watchSummary([page(state('', []), state('计划', ['a']))])?.text).toBe(['《计划》 · bob', '· 新增：a', '· 标题改成：计划'].join('\n'))
  })

  it('页数超上限写「还有 N 页也改了」', () => {
    const many = Array.from({ length: WATCH_PAGES_MAX + 2 }, (_, i) => page(state(`p${i}`, ['a']), state(`p${i}`, ['b'])))
    const text = watchSummary(many)!.text
    expect(text.split('\n').filter((l) => l.startsWith('《')).length).toBe(WATCH_PAGES_MAX)
    expect(text.endsWith('还有 2 页也改了')).toBe(true)
  })
})
