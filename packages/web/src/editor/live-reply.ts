// 正在跑的一条回复：实时正文 + 运行条（文档模式 AI 块与聊天气泡共用同一个控制器）。
// 纯 DOM（widget 里没有 React root，同 buildBubble）。一个实例 = 一条正在跑的回复，自己订阅
// agent-bar 的模块级 store；宿主只负责把 `strip`（抬头之下）与 `body`（strip 之后）摆进 DOM、收尾时调 `land`。
//   - strip：运行条（胶囊 + 审批卡 + 托盘，run-strip.ts），高度封顶，所以正文位置与步骤数无关
//   - body：当前那段话的实时 markdown（live-markdown.ts），按帧匀速吐字，末尾一个呼吸的光标
//   - 换段（说明条目多了一条）：旧正文缩小飞进托盘，新段从空开始
//   - 收尾：run-land.ts；失败（outcome = error）不飞，交给 reply-fail.ts 的失败条接上
// 动画只动 transform/opacity，起点或终点不在视野内就不飞；prefers-reduced-motion 直接切换。
import type { Schema } from '@milkdown/kit/prose/model'
import { reducedMotion, motionMs, easeOut } from '../motion'
import { agentStateFor, registerApprovalHost, subscribeAgentEvents, type LiveRun } from './agent-bar'
import { LiveMarkdown } from './live-markdown'
import { landStrip } from './run-land'
import { createRunStrip } from './run-strip'

export interface LiveReply {
  body: HTMLElement
  strip: HTMLElement
  /** 收尾：运行条收回、用量标签就位（标签不在 / 不可见就只淡出），动画结束后 resolve */
  land(chip: HTMLElement | null): Promise<void>
  dispose(): void
}

const inView = (r: DOMRect): boolean => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight

export function createLiveReply(opts: { pageId: string; replyId: string; schema: Schema; canStop: boolean; rest: () => number }): LiveReply {
  const md = new LiveMarkdown(opts.schema)
  const body = md.el
  const view = createRunStrip({ pageId: opts.pageId, replyId: opts.replyId, canStop: opts.canStop, canAnswer: opts.canStop, rest: opts.rest })

  let run: LiveRun | null = null
  let shown = 0
  let says = -1
  let raf = 0
  let disposed = false
  let unhost: (() => void) | null = null

  function schedule(): void {
    if (!raf && !disposed) raf = requestAnimationFrame(frame)
  }

  /** 换段动画：先截旧正文的幽灵，正文换成新的一段后再起飞，旧正文缩小上飞，落进托盘 */
  function capturePush(): (() => void) | null {
    const ms = motionMs('--d-3')
    if (reducedMotion() || !ms || body.childElementCount === 0) return null
    const from = body.getBoundingClientRect()
    if (!inView(from)) return null
    const ghost = body.cloneNode(true) as HTMLElement
    const cs = getComputedStyle(body)
    ghost.classList.add('run-ghost')
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color })
    return () => {
      const target = (view.tray.offsetParent ? view.tray : view.pill).getBoundingClientRect()
      if (!inView(target)) return
      document.body.append(ghost)
      const scale = Math.max(0.06, Math.min(1, 30 / Math.max(1, from.height)))
      ghost
        .animate(
          [
            { transform: 'none', opacity: 0.85 },
            { transform: `translate(${target.left + 28 - from.left}px, ${target.bottom - 24 - from.top}px) scale(${scale})`, opacity: 0 },
          ],
          { duration: ms, easing: easeOut() },
        )
        .finished.finally(() => ghost.remove())
    }
  }

  function frame(): void {
    raf = 0
    if (disposed || !run) return
    const state = run.state
    const sayCount = state.entries.reduce((n, e) => n + (e.k === 'say' ? 1 : 0), 0)
    let launch: (() => void) | null = null
    if (says < 0) {
      shown = state.text.length // 中途接上（刷新/切模式）：已到的字直接显示，不补播
    } else if (sayCount > says) {
      launch = capturePush()
      shown = 0
      md.reset()
    }
    says = sayCount
    const target = state.text
    if (shown < target.length) shown = Math.min(target.length, shown + Math.max(2, Math.ceil((target.length - shown) / 9)))
    else shown = target.length
    md.render(target.slice(0, shown))
    body.classList.toggle('is-streaming', !run.outcome && body.childElementCount > 0)
    launch?.()
    view.sync(run, agentStateFor(opts.pageId))
    // 审批卡归这条运行（结束后的后台审批回到底部弹条）
    const hosting = !run.outcome
    if (hosting && !unhost) unhost = registerApprovalHost()
    else if (!hosting && unhost) {
      unhost()
      unhost = null
    }
    if (shown < target.length && !document.hidden) schedule()
  }

  const timer = window.setInterval(() => {
    if (run) view.tickMeta(run)
  }, 1000)

  const adopt = (next: LiveRun | null): void => {
    if (next?.replyId !== opts.replyId) return
    run = next
    schedule()
  }
  adopt(agentStateFor(opts.pageId).run)
  const off = subscribeAgentEvents(opts.pageId, (st) => adopt(st.run))
  const onVisible = (): void => {
    if (!document.hidden) schedule()
  }
  document.addEventListener('visibilitychange', onVisible)

  return {
    body,
    strip: view.el,
    land(chip) {
      window.clearInterval(timer)
      // 失败不飞向用量标签：运行条原地摘掉，同一位置由失败条（reply-fail.ts）接上，所以条不会「失败后消失」
      if (run?.outcome === 'error') return Promise.resolve()
      return landStrip({ strip: view.el, pill: view.pill, tray: view.tray, chip })
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      off()
      view.dispose()
      unhost?.()
      unhost = null
    },
  }
}
