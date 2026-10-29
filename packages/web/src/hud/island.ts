/* ---------- 岛：右上角浮着的那条（float）与回复抬头停靠的那条（dock）共用一个 DOM 构建器 ----------
 * 纯 DOM（停靠的岛是 ProseMirror decoration，浮的岛挂在 React 的 ref 里）。两种长得一样，飞行才接得上。
 *   float：头像 + 状态环（运行中转圈 / 等你琥珀 / 完成绿勾）+ 现在在做什么 + 用时 · 任务圆环 a/b · 改动 n +x −y · 协作头像叠放；
 *          底边一条计划进度细线。等你时整条变成审批条：说的是什么 + 选项按钮（或「回答」）。
 *   dock：✓ 总览 用时 · 步骤 N · 任务 a/b · 改动 n +x −y · 协作 n。
 * 每一段是一个按钮（data-tab），点哪段开面板的哪一页。形状（有哪些段 / 是否审批条）变了才重建，数字与文字就地更新。 */
import { iconSvg } from '../icons'
import { agentBadge } from '../editor/agent-badge'
import { escapeHtml, fmtDuration } from '../editor/run-format'
import { HUD_COPY as C } from './hud-copy'
import type { AskBar, HudTab, IslandView } from './hud-model'

export type IslandMode = 'float' | 'dock'

export interface IslandHandlers {
  /** 点了某一段；el = 被点的岛（停靠的岛据此起飞） */
  tab(tab: HudTab, el: HTMLElement): void
  /** 审批条上的第 i 个按钮 */
  answer?(i: number): void
}

export interface Island {
  el: HTMLElement
  /** now = 浮的岛「现在在做什么」；ask = 审批条（浮的岛才有）；current = 面板正开着的那一页（高亮对应段） */
  paint(view: IslandView, extra?: { now?: string; ask?: AskBar | null; current?: HudTab | null }): void
}

const esc = escapeHtml

function markHtml(agentId: string): string {
  const b = agentBadge(agentId)
  return b.kind === 'mark'
    ? `<span class="agent-mark" style="--agent-mark: var(--mark-${esc(b.key)})"></span>`
    : `<span class="hud-av-text">${esc(b.text)}</span>`
}

function avatarHtml(view: IslandView): string {
  const ring = view.phase === 'live' ? ' is-live' : view.phase === 'ask' ? ' is-ask' : view.phase === 'end' ? ' is-done' : ''
  const badge = view.phase === 'end' ? `<span class="hud-av-badge">${iconSvg('check', 8)}</span>` : ''
  return `<span class="hud-av${ring}">${markHtml(view.agent)}${badge}</span>`
}

const seg = (tab: HudTab, body: string, cls = ''): string =>
  `<button class="il-seg${cls}" type="button" data-tab="${tab}" title="${esc(C.tip[tab])}">${body}</button>`

function delta(add: number, del: number): string {
  return `<span class="il-delta"><span class="add">+${add}</span>${del ? ` <span class="del">−${del}</span>` : ''}</span>`
}

function floatHtml(view: IslandView, ask: AskBar | null): string {
  if (ask) {
    const head = `${ask.kind === 'question' ? C.ask.question : C.ask.approve} <span class="il-q">${esc(ask.title)}</span>`
    const acts = ask.buttons
      ? ask.buttons
          .map((b, i) => `<button class="il-mini${i ? '' : ' is-primary'}" type="button" data-ans="${i}">${esc(b.label)}${i < 9 ? ` <kbd>${i + 1}</kbd>` : ''}</button>`)
          .join('')
      : `<button class="il-mini is-primary" type="button" data-tab="overview">${esc(C.ask.answer)}</button>`
    return `<button class="il-seg il-agent" type="button" data-tab="overview">${avatarHtml(view)}<span class="il-asktext">${head}</span></button><span class="il-acts">${acts}</span>`
  }
  let h = seg('overview', `${avatarHtml(view)}<span class="il-now" data-f="now"></span><span class="il-time" data-f="time"></span>`, ' il-agent')
  if (view.plan) h += seg('tasks', `<span class="il-ring" data-f="ring"></span><span data-f="plan"></span>`)
  if (view.files) h += seg('files', `${iconSvg('file', 14)}<b data-f="files"></b><span data-f="delta"></span>`, ' il-files')
  if (view.agents) h += seg('agents', `<span class="il-stack" data-f="stack"></span>`, ' il-agents')
  return `${h}<span class="il-bar" data-f="bar"></span>`
}

function dockHtml(view: IslandView): string {
  const icon = view.phase === 'end' ? 'check' : view.phase === 'cancelled' ? 'stop' : 'x'
  const label = view.phase === 'broken' ? C.status.error : C.tabs.overview
  let h = seg('overview', `<span class="il-ok is-${view.phase}">${iconSvg(icon, 11)}</span>${esc(label)}<span class="dim" data-f="time"></span>`)
  if (view.steps) h += seg('steps', `${esc(C.tabs.steps)}<b>${view.steps}</b>`)
  if (view.plan) h += seg('tasks', `${esc(C.tabs.tasks)}<b>${view.plan.done}</b><span class="dim">/${view.plan.total}</span>`)
  if (view.files) h += seg('files', `${esc(C.tabs.files)}<b>${view.files.n}</b>${delta(view.files.add, view.files.del)}`)
  if (view.agents) h += seg('agents', `${esc(C.tabs.agents)}<b>${view.agents.n}</b>`)
  return h
}

export function createIsland(mode: IslandMode, handlers: IslandHandlers): Island {
  const el = document.createElement('div')
  el.className = mode === 'dock' ? 'island is-docked' : 'island'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', C.label)
  let shape = ''
  let stackKey = ''

  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null
    const ans = t?.closest<HTMLElement>('[data-ans]')
    if (ans) return handlers.answer?.(Number(ans.dataset.ans))
    const tab = t?.closest<HTMLElement>('[data-tab]')?.dataset.tab as HudTab | undefined
    if (tab) handlers.tab(tab, el)
  })

  function put(key: string, html: string): void {
    const node = el.querySelector<HTMLElement>(`[data-f="${key}"]`)
    if (node && node.innerHTML !== html) node.innerHTML = html
  }

  return {
    el,
    paint(view, extra = {}) {
      const ask = mode === 'float' ? (extra.ask ?? null) : null
      const next = [mode, view.phase, ask ? `${ask.kind}|${ask.title}|${ask.buttons?.map((b) => b.label).join('/') ?? ''}` : '', !!view.plan, !!view.files, !!view.agents, view.agent, mode === 'dock' ? JSON.stringify(view) : ''].join('|')
      if (next !== shape) {
        shape = next
        stackKey = ''
        el.innerHTML = mode === 'dock' ? dockHtml(view) : floatHtml(view, ask)
      }
      el.classList.toggle('is-ask', !!ask)
      el.classList.toggle('is-done', view.phase !== 'live' && view.phase !== 'ask')
      put('now', esc(extra.now ?? ''))
      // 老回复没记用时（ms 0）就不出时间
      put('time', view.ms > 0 ? esc(fmtDuration(view.ms)) : '')
      if (view.plan) {
        put('plan', `<b>${view.plan.done}</b><span class="dim">/${view.plan.total}</span>`)
        const p = view.plan.total ? view.plan.done / view.plan.total : 0
        el.querySelector<HTMLElement>('[data-f="ring"]')?.style.setProperty('--p', String(p))
        const bar = view.plan.total ? (view.plan.done + (view.plan.current ? 0.5 : 0)) / view.plan.total : 0
        el.querySelector<HTMLElement>('[data-f="bar"]')?.style.setProperty('--p', String(Math.min(1, bar)))
      }
      if (view.files && mode === 'float') {
        put('files', String(view.files.n))
        put('delta', delta(view.files.add, view.files.del))
      }
      if (view.agents && mode === 'float') {
        const key = `${view.agents.ids.join()}|${view.agents.live}`
        if (key !== stackKey) {
          stackKey = key
          put('stack', view.agents.ids.slice(0, 4).map((id) => `<span class="hud-av is-sm${view.agents!.live ? ' is-live' : ''}">${markHtml(id)}</span>`).join(''))
        }
      }
      for (const b of el.querySelectorAll<HTMLElement>('.il-seg[data-tab]')) b.setAttribute('aria-current', String(extra.current === b.dataset.tab))
    },
  }
}
