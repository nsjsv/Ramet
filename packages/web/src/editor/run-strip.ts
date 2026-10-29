// ---------- 运行条：胶囊 + 计划卡 + 审批卡 + 步骤托盘（纯 DOM，widget 里没有 React root） ----------
// 一个实例 = 一条正在跑的回复的「过程」部分，摆在回复块的抬头之下、正文之上（正文在 live-reply.ts）。
//   - 胶囊：定宽；转圈 · 现在在做什么（key 变了才上下滑）· 步数与用时 · 展开箭头 · 停止。
//     停止钮是胶囊里的独立按钮，不在 role=button 的区域里，文字再长也不移动它，键盘激活不会触发展开
//   - 计划卡：agent 报了计划清单（ACP plan）才有，紧跟胶囊（plan-card.ts）
//   - 带队（/带队）：这一轮有 team 原语才有，紧跟计划卡（team/team-mount.tsx 挂一个 React root）：计划轮是可编辑的计划卡，
//     执行轮是任务列表 + 实时甘特；组员干活时组长还没开口，胶囊上显示组员的进展
//   - 审批卡：钉在计划卡（没有计划则胶囊）下、托盘上，不进滚动区、不倒计时；只展示队首，摘除的唯一信号是
//     permission_resolved。ExitPlanMode 的审批因此正好落在它要批的计划下面
//   - 托盘：run-tray.ts，高度封顶，新步骤在下
// 本模块不管正文、不管收尾动画（run-land.ts）。
import { isTerminal, toolCount, type RunState, type TeamState } from '@ramet/shared/run-model'
import { api } from '../api'
import { COPY } from '../copy'
import { easeOut, flip, followersAfter, motionMs, reducedMotion } from '../motion'
import { setAgentRunError, type AgentState, type LiveRun, type PermissionReq } from './agent-bar'
import { iconSvg } from '../icons'
import { askTitle, buildAskCard } from './ask-card'
import { entryObject, entryVerb, fmtDuration } from './run-format'
import { rememberFailReasonIfAbsent } from './fail-reason'
import { buildContinueButton, buildRetryButton, failText, setContinueRest } from './reply-fail'
import { createPlanCard } from './plan-card'
import { createTray } from './run-tray'
import { teamNow } from '../team/team-model'
import { mountTeam, type TeamMount } from '../team/team-mount'

/** 胶囊上显示的思考尾巴长度 */
const THOUGHT_TAIL = 40

export interface RunStrip {
  el: HTMLElement
  /** 胶囊（收尾动画的起点） */
  pill: HTMLElement
  tray: HTMLElement
  /** 每帧 / 每次事件：run 快照 + 页面级 agent 状态（审批队列、错误信息） */
  sync(run: LiveRun, agent: AgentState): void
  /** 只刷新计时（1s 一次，不重画别的） */
  tickMeta(run: LiveRun): void
  /** 卸载带队卡的 React root（运行条销毁时） */
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

/** 胶囊上「现在在做什么」：key 变了才播上下滑动，同一件事只换字（思考的尾巴实时长） */
export function nowOf(state: RunState): { key: string; text: string } {
  const team = state.team
  // 带队执行轮组员先干、干完组长才开口，组长还没有动静的这段，胶囊显示组员的进展
  if (team?.status === 'running' && state.entries.length === 0 && !state.text.trim()) {
    const n = teamNow(team)
    const text = n.phase === 'run' ? COPY.team.now.run(n.running, n.done, n.total) : n.phase === 'review' ? COPY.team.now.review : COPY.team.now.prepare
    return { key: 'team', text }
  }
  const last = state.entries[state.entries.length - 1]
  if (last?.k === 'thought' && last.end === undefined) {
    const tail = last.text.replace(/\s+/g, ' ').trim().slice(-THOUGHT_TAIL)
    return { key: `h${last.t ?? 0}`, text: tail ? `${COPY.run.thinking} · ${tail}` : COPY.run.thinking }
  }
  const live = [...state.entries].reverse().find((e) => e.k === 'tool' && !isTerminal(e.status))
  if (live?.k === 'tool') return { key: `t${live.id}`, text: `${entryVerb(live)} ${entryObject(live)}`.trim() }
  if (state.text.trim() && (last === undefined || (state.textSlot ?? 0) >= state.entries.length)) {
    return { key: 'reply', text: COPY.run.replying }
  }
  return { key: 'wait', text: state.text.trim() ? COPY.run.replying : COPY.run.thinking }
}

export function createRunStrip(opts: {
  pageId: string
  replyId: string
  canStop: boolean
  canAnswer: boolean
  /** @ 点名链停在这一家后还剩几个（失败时每次同步读一次；0 = 不出「继续剩下的」） */
  rest: () => number
}): RunStrip {
  const strip = el('div', 'run-strip')
  strip.contentEditable = 'false'
  strip.dataset.open = 'true'

  const pill = el('div', 'pill')
  // 「继续剩下的」：只在失败且点名链还有后面的人时显示（hidden 由 sync 按文档里的链进度更新）
  const continueBtn = buildContinueButton(opts.pageId, 0)
  const main = el('div', 'pill-main')
  main.setAttribute('role', 'button')
  main.setAttribute('aria-expanded', 'true')
  main.setAttribute('aria-label', COPY.run.toggle)
  main.tabIndex = 0
  const now = el('span', 'now')
  let nowText = el('span', 'now-text')
  now.append(nowText)
  const meta = el('span', 'meta')
  const chev = el('span', 'chev')
  chev.innerHTML = iconSvg('caret', 16)
  main.append(el('span', 'spin'), now, meta, chev)
  pill.append(main)
  if (opts.canStop) {
    const stop = el('button', 'stop')
    stop.type = 'button'
    stop.textContent = COPY.run.stop
    stop.setAttribute('aria-label', COPY.run.stop)
    stop.addEventListener('click', (event) => {
      event.stopPropagation()
      void api.stopPage(opts.pageId).catch((err: unknown) => {
        setAgentRunError(err instanceof Error ? `${COPY.run.stopFailed}：${err.message}` : COPY.run.stopFailed)
      })
    })
    pill.append(stop, buildRetryButton(opts.pageId, opts.replyId)) // 重试只在 is-failed 时显示（CSS）
    pill.append(continueBtn)
  }
  const plan = createPlanCard({ open: true })
  const tray = createTray(
    opts.canStop
      ? {
          onKillCommand: (terminalId) => {
            void api.stopCommand(opts.pageId, terminalId).catch((err: unknown) => {
              setAgentRunError(err instanceof Error ? `${COPY.run.stopCommandFailed}：${err.message}` : COPY.run.stopCommandFailed)
            })
          },
        }
      : {},
  )
  strip.append(pill, plan.el, tray.el)

  let open = true
  let endedAt = 0
  let nowKey = ''
  let askKey = ''
  let askEl: HTMLElement | null = null
  let currentTeam: TeamState | undefined
  let teamMount: TeamMount | null = null
  let teamSig = ''

  const toggle = (): void => {
    open = !open
    // 托盘出现 / 消失会带动下面所有内容：量好位置再平移补位
    flip(followersAfter(pill), () => {
      strip.dataset.open = String(open)
      main.setAttribute('aria-expanded', String(open))
    })
  }
  main.addEventListener('click', toggle)
  main.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })

  function setNow(next: { key: string; text: string }): void {
    if (next.key === nowKey) {
      if (nowText.textContent !== next.text) nowText.textContent = next.text
      return
    }
    const first = nowKey === ''
    nowKey = next.key
    const old = nowText
    old.classList.add('is-leaving')
    nowText = el('span', 'now-text')
    nowText.textContent = next.text
    now.append(nowText)
    const ms = motionMs('--d-2')
    if (first || reducedMotion() || !ms) {
      old.remove()
      return
    }
    const ease = { duration: ms, easing: easeOut() }
    nowText.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], ease)
    old.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], ease).finished.finally(() => old.remove())
  }

  function metaText(run: LiveRun): string {
    if (run.outcome && !endedAt) endedAt = Date.now()
    const ms = (endedAt || Date.now()) - run.startedAt
    const steps = toolCount(run.state)
    return steps ? `${COPY.run.steps(steps)} · ${fmtDuration(ms)}` : fmtDuration(ms)
  }

  function syncAsk(req: PermissionReq | undefined): void {
    const key = req ? `${req.agentId}:${req.requestId}` : ''
    if (key === askKey) return
    askKey = key
    const prev = askEl
    const next = req ? buildAskCard(opts.pageId, req, currentTeam) : null
    askEl = next
    pill.classList.toggle('is-ask', Boolean(next))
    // 卡片出现 / 摘除都会带动下面的内容：平移补位
    const swap = (): void =>
      flip(followersAfter(pill), () => {
        prev?.remove()
        // 计划卡没有内容时它是 hidden 的，审批卡落在胶囊下，位置一样；有带队卡时落在它下面（审批多半是组员的，紧挨着团队进度）
        if (next) (teamMount ? teamMount.el : plan.el).after(next)
      })
    // 答完（只摘不换）：卡片先缩小平移进当前步骤行再淡掉，然后补位。
    // 托盘收着 / 看不见、减弱动效时直接补位；缩进途中来了新审批也不冲突（新卡片插在计划卡 / 胶囊后、旧卡片之前）
    const rows = prev && !next ? [...tray.el.querySelectorAll<HTMLElement>('.tray-list > .trow')] : []
    const row = rows.filter((r) => r.classList.contains('is-now')).at(-1) ?? rows.at(-1)
    const ms = motionMs('--d-3') * 0.8
    if (!prev || !row || row.offsetParent === null || !ms) return swap()
    const a = prev.getBoundingClientRect()
    const t = row.getBoundingClientRect()
    if (!a.width || !a.height) return swap()
    prev.style.transformOrigin = 'top left'
    prev.style.pointerEvents = 'none'
    const tuck = prev.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate(${t.left - a.left}px, ${t.top - a.top}px) scale(${t.width / a.width}, ${t.height / a.height})`, opacity: 0 },
      ],
      { duration: ms, easing: easeOut(), fill: 'forwards' },
    )
    void tuck.finished.then(swap, swap)
  }

  /** 计划清单：整份替换。条数变了（出现 / 多一条 / 清空）会带动下面的内容，平移补位；只是状态变了高度不变，直接换 */
  let planCount = 0
  let lastPlan: RunState['plan']
  function syncPlan(entries: RunState['plan']): void {
    if (entries === lastPlan) return // reducer 只在收到 plan 事件时换这个数组，同一个引用 = 没变
    lastPlan = entries
    const count = entries?.length ?? 0
    if (count === planCount) return plan.set(entries)
    planCount = count
    flip(followersAfter(pill), () => plan.set(entries))
  }

  /** 带队卡：有 team 原语才挂（计划轮是计划卡，执行轮是进度卡）；props 没变不重画（team 是原地改的，用 JSON 比） */
  function syncTeam(run: LiveRun): void {
    const team = run.state.team
    currentTeam = team
    if (!team) return
    const props = { pageId: opts.pageId, team, startedAt: run.startedAt, ended: Boolean(run.outcome), canAct: opts.canStop }
    const sig = `${JSON.stringify(team)}|${props.ended}`
    if (sig === teamSig) return
    teamSig = sig
    if (teamMount) return teamMount.set(props)
    teamMount = mountTeam(props)
    plan.el.after(teamMount.el)
  }

  return {
    el: strip,
    pill,
    tray: tray.el,
    dispose() {
      teamMount?.dispose()
      teamMount = null
    },
    sync(run, agent) {
      const state = run.state
      const ended = Boolean(run.outcome)
      syncTeam(run)
      // 结束后的审批（后台审批比一轮活得久）归底部弹条；viewer 不渲染（同原弹条）
      const head = ended || !opts.canAnswer ? undefined : agent.permissions[0]
      syncAsk(head)
      syncPlan(state.plan)
      const failed = run.outcome === 'error'
      if (failed) rememberFailReasonIfAbsent(opts.replyId, agent.message) // 具体原因由 error 事件先到并已记下
      strip.classList.toggle('is-done', ended)
      strip.classList.toggle('is-failed', failed)
      pill.classList.toggle('is-failed', failed)
      if (failed) setContinueRest(continueBtn, opts.rest())
      const text = ended
        ? run.outcome === 'end'
          ? COPY.run.done
          : run.outcome === 'cancelled'
            ? COPY.run.stopped
            : failText(opts.replyId)
        : askEl && head
          ? head.form
            ? COPY.ask.answering(askTitle(head))
            : COPY.run.waiting(askTitle(head))
          : null
      setNow(text !== null ? { key: ended ? 'end' : `ask:${askKey}`, text } : nowOf(state))
      meta.textContent = metaText(run)
      tray.sync(state, !ended)
    },
    tickMeta(run) {
      if (!run.outcome) meta.textContent = metaText(run)
    },
  }
}
