/* ---------- 命令面板的条目（纯函数，有单测）----------
 * 三组：这页的事（本页在跑的一轮）/ 命令 / 页面。只列此刻做得了的：
 * 不在页面上就没有视图切换、停止；没有机器就没有项目面板、找文件；只读的人没有停止 / 压缩。
 * 搜索与 ⌘P 找文件共用一个模糊匹配（project/fuzzy.ts）：组内按匹配度排序、命中的字高亮；空搜索按这里的顺序。 */
import type { IconName } from '../icons'
import { fuzzyMatch } from '../project/fuzzy'

export type PaletteGroup = 'run' | 'cmd' | 'page'

export type PaletteItem = {
  id: string
  group: PaletteGroup
  label: string
  /** 第二行说明（这页的事：agent 在做什么 / 等你批准） */
  desc?: string
  tone?: 'live' | 'warn'
  /** 它自己的快捷键（显示用） */
  keys?: string
  icon: IconName | { agent: string }
  run: () => void
}

export type PaletteHit = PaletteItem & { score: number; indices: number[] }

export const PALETTE_COPY = {
  placeholder: '搜索页面、正在跑的 agent，或输入命令…',
  groups: { run: '这页的事', cmd: '命令', page: '页面' } as Record<PaletteGroup, string>,
  empty: '没有匹配的结果',
  foot: { pick: '↑↓ 选择', run: '↵ 执行', toggle: (k: string) => `${k} 开 / 关` },
  run: { asking: '等你批准 / 回答', open: '打开工作台' },
  cmd: {
    hudOpen: '打开工作台',
    hudClose: '收起工作台',
    stop: (agent: string) => `停止 ${agent}`,
    projectOpen: '打开项目面板（文件 / 改动 / 终端 / 预览）',
    projectClose: '收起项目面板',
    quickOpen: '找文件',
    toDoc: '切到文档视图',
    toChat: '切到对话视图',
    switchAgent: (agent: string) => `换成 ${agent} 接着聊`,
    compact: '压缩上下文 /compact',
    newPage: '新建页面',
    inbox: '收件箱',
    memory: '空间的公共记忆',
    skills: 'Skill 库',
    machines: '设置：机器',
    quick: '设置：随手 AI',
  },
}

export type PaletteCtx = {
  /** 当前页面（不在页面上 = null） */
  pageId: string | null
  canWrite: boolean
  /** 本页在跑的一轮 */
  run: { agentLabel: string; now: string; asking: boolean } | null
  /** 工作台此刻有东西可看（有在跑的一轮，或面板开着） */
  hud: { available: boolean; open: boolean }
  project: { available: boolean; open: boolean }
  /** 当前视图（不在页面上 = null） */
  chatMode: boolean | null
  /** 能用的 agent（目录）与本页现在发给谁 */
  agents: ReadonlyArray<{ id: string; label: string }>
  currentAgent: string
  canCompact: boolean
  pages: ReadonlyArray<{ id: string; title: string }>
  /** 当前空间（新建页面放这里；没有空间 = 不给新建） */
  spaceId: string | null
  /** ⌘ 或 Ctrl+ */
  mod: string
}

export type PaletteActions = {
  openHud(): void
  closeHud(): void
  stop(): void
  toggleProject(): void
  quickOpen(): void
  toggleView(): void
  switchAgent(id: string): void
  compact(): void
  newPage(): void
  go(path: string): void
  settings(tab: 'machines' | 'quick'): void
}

export function paletteItems(ctx: PaletteCtx, act: PaletteActions): PaletteItem[] {
  const C = PALETTE_COPY
  const items: PaletteItem[] = []
  const cmd = (id: string, label: string, icon: IconName, run: () => void, keys?: string): void => {
    items.push({ id, group: 'cmd', label, icon, run, ...(keys ? { keys } : {}) })
  }
  if (ctx.run) {
    items.push({
      id: 'run',
      group: 'run',
      label: ctx.run.agentLabel,
      desc: ctx.run.asking ? C.run.asking : ctx.run.now,
      tone: ctx.run.asking ? 'warn' : 'live',
      icon: 'run',
      run: act.openHud,
    })
  }
  if (ctx.hud.available) {
    if (ctx.hud.open) cmd('hud-close', C.cmd.hudClose, 'panel-right', act.closeHud, 'Esc')
    else cmd('hud-open', C.cmd.hudOpen, 'panel-right', act.openHud)
  }
  if (ctx.run && ctx.canWrite) cmd('stop', C.cmd.stop(ctx.run.agentLabel), 'stop', act.stop)
  if (ctx.project.available) {
    cmd('project', ctx.project.open ? C.cmd.projectClose : C.cmd.projectOpen, 'folder', act.toggleProject, `${ctx.mod}E`)
    cmd('quick-open', C.cmd.quickOpen, 'search', act.quickOpen, `${ctx.mod}P`)
  }
  if (ctx.chatMode !== null) cmd('view', ctx.chatMode ? C.cmd.toDoc : C.cmd.toChat, ctx.chatMode ? 'file' : 'say', act.toggleView)
  if (ctx.pageId && ctx.canWrite) {
    for (const a of ctx.agents) if (a.id !== ctx.currentAgent) cmd(`agent:${a.id}`, C.cmd.switchAgent(a.label || a.id), 'bot', () => act.switchAgent(a.id))
    if (ctx.canCompact) cmd('compact', C.cmd.compact, 'sigma', act.compact)
  }
  if (ctx.spaceId) cmd('new-page', C.cmd.newPage, 'plus', act.newPage)
  cmd('inbox', C.cmd.inbox, 'inbox', () => act.go('/inbox'))
  cmd('memory', C.cmd.memory, 'memory', () => act.go('/memory'))
  cmd('skills', C.cmd.skills, 'skill', () => act.go('/skills'))
  cmd('machines', C.cmd.machines, 'plug', () => act.settings('machines'))
  cmd('quick', C.cmd.quick, 'sparkle', () => act.settings('quick'))
  for (const p of ctx.pages) {
    items.push({ id: `page:${p.id}`, group: 'page', label: p.title || '无标题', icon: 'file', run: () => act.go(`/page/${p.id}`) })
  }
  return items
}

const ORDER: readonly PaletteGroup[] = ['run', 'cmd', 'page']

/** 过滤 + 分组：空查询按原顺序；有查询按匹配度排序（同分保持原顺序）。页面组最多 pageLimit 条 */
export function filterPalette(items: readonly PaletteItem[], query: string, pageLimit = 30): Array<{ group: PaletteGroup; hits: PaletteHit[] }> {
  const q = query.trim()
  const out: Array<{ group: PaletteGroup; hits: PaletteHit[] }> = []
  for (const group of ORDER) {
    const hits: PaletteHit[] = []
    items.forEach((it) => {
      if (it.group !== group) return
      const m = fuzzyMatch(q, it.label)
      if (m) hits.push({ ...it, score: m.score, indices: m.indices })
    })
    if (q) hits.sort((a, b) => b.score - a.score)
    const capped = group === 'page' ? hits.slice(0, pageLimit) : hits
    if (capped.length) out.push({ group, hits: capped })
  }
  return out
}
