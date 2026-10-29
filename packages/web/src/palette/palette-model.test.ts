import { describe, expect, it, vi } from 'vitest'
import { filterPalette, paletteItems, type PaletteActions, type PaletteCtx } from './palette-model'

const act = (): PaletteActions => ({
  openHud: vi.fn(),
  closeHud: vi.fn(),
  stop: vi.fn(),
  toggleProject: vi.fn(),
  quickOpen: vi.fn(),
  toggleView: vi.fn(),
  switchAgent: vi.fn(),
  compact: vi.fn(),
  newPage: vi.fn(),
  go: vi.fn(),
  settings: vi.fn(),
})

const base: PaletteCtx = {
  pageId: 'p1',
  canWrite: true,
  run: null,
  hud: { available: false, open: false },
  project: { available: false, open: false },
  chatMode: false,
  agents: [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ],
  currentAgent: 'claude',
  canCompact: false,
  pages: [
    { id: 'a', title: '开发计划' },
    { id: 'b', title: '周报' },
  ],
  spaceId: 's1',
  mod: '⌘',
}

const ids = (ctx: PaletteCtx) => paletteItems(ctx, act()).map((i) => i.id)

describe('只列此刻做得了的', () => {
  it('没有在跑的一轮、没有机器：没有这页的事 / 停止 / 工作台 / 项目面板；能换别的 agent', () => {
    const got = ids(base)
    expect(got).not.toContain('run')
    expect(got).not.toContain('stop')
    expect(got).not.toContain('hud-open')
    expect(got).not.toContain('project')
    expect(got).toContain('agent:codex')
    expect(got).not.toContain('agent:claude')
    expect(got).toContain('view')
  })
  it('在跑：这页的事在最前，有停止与打开工作台；等你批准时语气是 warn', () => {
    const items = paletteItems({ ...base, run: { agentLabel: 'Claude', now: '读取 a.ts', asking: true }, hud: { available: true, open: false } }, act())
    expect(items[0]).toMatchObject({ id: 'run', group: 'run', tone: 'warn' })
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(['stop', 'hud-open']))
  })
  it('只读：没有停止 / 换 agent / 压缩；不在页面上：没有视图切换', () => {
    const ro = ids({ ...base, canWrite: false, canCompact: true, run: { agentLabel: 'Claude', now: '', asking: false } })
    expect(ro).not.toContain('stop')
    expect(ro).not.toContain('agent:codex')
    expect(ro).not.toContain('compact')
    expect(ids({ ...base, pageId: null, chatMode: null })).not.toContain('view')
  })
  it('有机器：项目面板与找文件带快捷键', () => {
    const items = paletteItems({ ...base, project: { available: true, open: false } }, act())
    expect(items.find((i) => i.id === 'project')?.keys).toBe('⌘E')
    expect(items.find((i) => i.id === 'quick-open')?.keys).toBe('⌘P')
  })
})

describe('过滤与分组', () => {
  it('空查询按原顺序分三组；有查询按匹配度排、带高亮下标', () => {
    const items = paletteItems({ ...base, run: { agentLabel: 'Claude', now: '', asking: false } }, act())
    expect(filterPalette(items, '').map((g) => g.group)).toEqual(['run', 'cmd', 'page'])
    const hits = filterPalette(items, '周报')
    expect(hits).toEqual([{ group: 'page', hits: [expect.objectContaining({ id: 'page:b', indices: [0, 1] })] }])
    expect(filterPalette(items, 'zzzz')).toEqual([])
  })
  it('执行：页面跳过去', () => {
    const a = act()
    paletteItems(base, a).find((i) => i.id === 'page:a')!.run()
    expect(a.go).toHaveBeenCalledWith('/page/a')
  })
})
