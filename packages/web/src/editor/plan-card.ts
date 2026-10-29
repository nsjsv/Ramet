/* ---------- 计划卡：agent 的计划清单（ACP plan）画在回复里，抬头之下、正文之上（纯 DOM） ----------
 * 清单是 agent 写的，这里只画不改：条目文字、顺序、状态、优先级都以它上报的为准，不加建议、不替它排序。
 *   - 运行中：嵌在运行条里（run-strip.ts），胶囊与审批卡之间；agent 每报一份整份清单就原地更新（不重建）
 *   - 收尾后：计划随回复块的 `plan` 属性落盘（服务端 ReplyWriter.finalize），刷新页面仍在；没有实时视图接管的回复块
 *     在同一位置挂一个只含计划卡的静态条（buildPlanStrip），所以运行中、收尾、刷新后看起来是同一张卡
 * 展开 / 收起的唯一状态在 DOM 上（data-open），收尾时全部完成的计划自动折成一行（settlePlanCard）。 */

import { planProgress, type PlanEntry } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { iconSvg } from '../icons'
import { flip, followersAfter } from '../motion'

export interface PlanCard {
  el: HTMLElement
  /** 整份替换；undefined / 空 = 没有计划（卡片整个藏起来） */
  set(entries: readonly PlanEntry[] | undefined): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function itemTip(entry: PlanEntry): string {
  const status = COPY.plan.status[entry.status]
  return entry.priority ? `${status} · ${COPY.plan.priority[entry.priority]}` : status
}

function paintItem(li: HTMLElement, entry: PlanEntry): void {
  li.className = `plan-item is-${entry.status}`
  li.dataset.priority = entry.priority ?? ''
  li.title = itemTip(entry)
  const text = li.querySelector('.plan-text')
  if (text && text.textContent !== entry.content) text.textContent = entry.content
}

function buildItem(): HTMLElement {
  const li = el('li', 'plan-item')
  const mark = el('span', 'plan-mark')
  mark.innerHTML = iconSvg('check', 10)
  li.append(mark, el('span', 'plan-text'))
  return li
}

export function createPlanCard(opts: { open: boolean }): PlanCard {
  const card = el('div', 'plan-card')
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', COPY.plan.title)
  card.dataset.open = String(opts.open)
  card.hidden = true

  const head = el('button', 'plan-head')
  head.type = 'button'
  head.setAttribute('aria-label', COPY.plan.toggle)
  head.setAttribute('aria-expanded', String(opts.open))
  head.addEventListener('mousedown', (event) => event.preventDefault()) // 不抢编辑器 / 输入框的焦点
  const title = el('span', 'plan-title')
  title.textContent = COPY.plan.title
  const count = el('span', 'plan-count')
  const chev = el('span', 'plan-chev')
  chev.innerHTML = iconSvg('caret', 14)
  head.append(title, count, chev)
  head.addEventListener('click', (event) => {
    event.stopPropagation()
    // 展开 / 收起会带动下面所有内容：量好位置再平移补位
    flip(followersAfter(card), () => setOpen(card, card.dataset.open !== 'true'))
  })

  const list = el('ol', 'plan-list')
  card.append(head, list)

  let sig = ''
  return {
    el: card,
    set(entries) {
      const next = entries ?? []
      const nextSig = JSON.stringify(next)
      if (nextSig === sig) return
      sig = nextSig
      card.hidden = next.length === 0
      const { done, total } = planProgress(next)
      count.textContent = COPY.plan.progress(done, total)
      card.dataset.allDone = String(total > 0 && done === total)
      next.forEach((entry, i) => {
        const li = (list.children[i] as HTMLElement | undefined) ?? list.appendChild(buildItem())
        paintItem(li, entry)
      })
      while (list.children.length > next.length) list.lastElementChild?.remove()
    },
  }
}

function setOpen(card: HTMLElement, open: boolean): void {
  card.dataset.open = String(open)
  card.querySelector('.plan-head')?.setAttribute('aria-expanded', String(open))
}

/** 收尾时调：全部完成的计划折成一行（没做完的——中途停了 / 出错了——保持展开，让人看到停在哪） */
export function settlePlanCard(card: HTMLElement): void {
  if (card.dataset.allDone === 'true') setOpen(card, false)
}

/** 运行条收尾时摘出布局：没有计划就整条藏掉；有计划则只收掉胶囊 / 审批 / 托盘，计划卡留在原位 ——
 *  这样紧接着由回复块上的 plan 属性接手（buildPlanStrip）时，同一个位置、同一张卡，不闪不跳 */
export function retireStrip(strip: HTMLElement): void {
  // 带队的团队卡（team/team-mount.tsx）同样留在原位：收成胶囊后由回复块的 team 属性接手
  const card = strip.querySelector<HTMLElement>('.plan-card:not([hidden]), .team-host')
  if (!card) {
    strip.style.display = 'none'
    return
  }
  strip.classList.add('is-retired')
  settlePlanCard(card)
}

/** 没有实时视图接管的回复块里的计划：一个只含计划卡的静态条（外层沿用 .run-strip 的间距与对齐） */
export function buildPlanStrip(entries: readonly PlanEntry[]): HTMLElement {
  const strip = el('div', 'run-strip is-plan')
  strip.contentEditable = 'false'
  const card = createPlanCard({ open: planProgress(entries).done < entries.length })
  card.set(entries)
  strip.append(card.el)
  return strip
}
