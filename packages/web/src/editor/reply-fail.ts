// ---------- 失败条：一轮没跑完时，回复块里（抬头之下、正文之上）的红色胶囊 + 重试 ----------
// 两处共用同一个外观（CSS 的 .pill.is-failed），所以运行中失败、块收尾、刷新前后看起来一致：
//   - 运行中失败：run-strip.ts 把自己的胶囊切成 is-failed（带原因）
//   - 已收尾的 o:error 块（含刷新后）：本文件的 buildFailStrip，挂在没有实时视图接管的 o:error 块里
// 重试与「重新生成」是同一个动作（agent-bar.tsx 的 regenerateReply）；@ 点名链停在这里时多一个「继续剩下的」。
import { decodeStats } from '@ramet/shared/reply-stats'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { continueRest, regenerateReply } from './agent-bar'
import { failReasonOf } from './fail-reason'

/** 失败胶囊上的文案：固定句 +（有则）原因（原因暂存见 fail-reason.ts；刷新后没有，只显示固定文案） */
export function failText(replyId: string): string {
  const reason = failReasonOf(replyId)
  return reason ? `${COPY.run.failed} · ${reason}` : COPY.run.failed
}

/** 重试按钮（运行条与失败条共用） */
export function buildRetryButton(pageId: string, replyId: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'retry'
  btn.innerHTML = `${iconSvg('retry', 13)}<span>${COPY.run.retry}</span>`
  btn.setAttribute('aria-label', COPY.run.retry)
  btn.addEventListener('mousedown', (event) => event.preventDefault()) // 不抢编辑器焦点
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    regenerateReply(pageId, replyId)
  })
  return btn
}

/** 「继续剩下的 N 个」：@ 点名链在这一家失败后停住了，跳过它接着轮后面的（普通 continue，服务端自己选下一家）。
 *  rest 是此刻还剩几个（失败胶囊上随文档变化更新，见 run-strip.ts）。运行条与失败条共用 */
export function buildContinueButton(pageId: string, rest: number): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'retry continue'
  btn.addEventListener('mousedown', (event) => event.preventDefault()) // 不抢编辑器焦点
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    continueRest(pageId)
  })
  setContinueRest(btn, rest)
  return btn
}

/** 刷新「继续剩下的」按钮：0 个就藏起来 */
export function setContinueRest(btn: HTMLElement, rest: number): void {
  btn.hidden = rest <= 0
  btn.textContent = COPY.run.continueRest(rest)
  btn.setAttribute('aria-label', btn.textContent)
}

/** 这块回复是不是失败收尾的（stats 的结果位 = error） */
export function isFailedReply(stats: unknown): boolean {
  return decodeStats(stats).o === 'error'
}

/** 已收尾的失败块里的失败条；viewer（canRetry = false）只显示不带按钮。rest = @ 点名链还剩几个（>0 才出「继续剩下的」） */
export function buildFailStrip(opts: { pageId: string; replyId: string; canRetry: boolean; rest: number }): HTMLElement {
  const strip = document.createElement('div')
  strip.className = 'run-strip is-failed'
  strip.contentEditable = 'false'
  const pill = document.createElement('div')
  pill.className = 'pill is-failed'
  const main = document.createElement('div')
  main.className = 'pill-main'
  const now = document.createElement('span')
  now.className = 'now'
  const text = document.createElement('span')
  text.className = 'now-text'
  text.textContent = failText(opts.replyId)
  text.title = text.textContent
  now.append(text)
  const dot = document.createElement('span')
  dot.className = 'spin'
  main.append(dot, now)
  pill.append(main)
  if (opts.canRetry) {
    pill.append(buildRetryButton(opts.pageId, opts.replyId))
    if (opts.rest > 0) pill.append(buildContinueButton(opts.pageId, opts.rest))
  }
  strip.append(pill)
  return strip
}
