// ---------- 过程页步骤块的视图（run_step 的 nodeView） ----------
// 一行 = 图标 · 动词 · 文字（只读镜像）· 用时 · 操作（引用 / 收藏 / 展开）；展开 = 下面一张卡片：
//   常规展示（run-view.ts：命令 + 输出 / 读文件 / diff / 思考全文……）+ 卡片底部的「高级」开关；
//   「高级」= 原始调用信息（run-detail.ts 的 toolDetailHtml）+ 这一行可编辑的文字（contentDOM）。
// 步骤文字平时只读，展开「高级」才能改（这份字进下一轮上下文）：contentDOM 挪进「高级」容器，
// 收起时整块 display:none；runStepGuard 再挡住高级关着时落进步骤文字里的编辑（键盘方向键仍可能把光标带进去）。
// 块本身是真块：删 / 拖走编辑器与块手柄，这里只画外壳。详情不在块里：工具的输入输出 / diff / 子代理正文按 `sid`
// 从 runs.record 取（run-store.ts），展开时才画。展开 / 高级状态按块记在模块里，视图被重建也保持。
// 「引用」把这一步当 block_ref 排进所属页面正在写的消息（quote-queue.ts + doc-send.ts 的 quoteIntoDraft）。

import { $prose, $view } from '@milkdown/kit/utils'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import { ySyncPluginKey } from 'y-prosemirror'
import { stepVerb } from '@ramet/shared/run-model'
import { isFavorite, subscribeFavorites, toggleFavorite } from '../favorites-store'
import { iconSvg } from '../icons'
import { COPY } from '../copy'
import { writeViewMode } from '../view-mode'
import { queueQuote } from './quote-queue'
import { toolDetailHtml } from './run-detail'
import { fmtClock, fmtDuration, stepIcon } from './run-format'
import { runStepSchema } from './run-step'
import { entryOfSid, getRunInfo, onRunInfo } from './run-store'
import { advToggleHtml, stepViewHtml } from './run-view'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 展开着的步骤（页 id + 块 id）。模块级：编辑器重建视图（换页回来 / 协同重排）后仍是展开的 */
const openKeys = new Set<string>()
/** 「高级」开着的步骤（同上）：只有这些步骤的文字能改（runStepGuard 读它） */
const advKeys = new Set<string>()

const stepKey = (pageId: string, node: PMNode): string => `${pageId}:${str(node.attrs.id) || str(node.attrs.sid)}`

/** 块里的字（换行是 hardbreak）：行上的只读镜像与思考 / 说明的全文用 */
function stepText(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    out += child.isText ? (child.text ?? '') : child.type.name === 'hardbreak' ? '\n' : child.textContent
  })
  return out
}

/** 非正文的外壳元素：不可编辑，编辑器不管它们的事件与变动 */
function shell<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  el.contentEditable = 'false'
  return el
}

function actButton(act: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'run-step-act'
  b.dataset.act = act
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = icon
  return b
}

/** 高级关着时，挡住落在步骤文字里面的本地编辑（整块删 / 拖、改属性、协同与撤销重做不挡）。
 *  只挂可编辑的编辑器（公开页 / viewer 本来就改不了） */
export function runStepGuard(pageId: string) {
  return $prose(
    () =>
      new Plugin({
        filterTransaction(tr) {
          if (!tr.docChanged) return true
          if ((tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) return true
          return tr.steps.every((step, i) => {
            const doc = tr.docs[i]!
            let ok = true
            step.getMap().forEach((from, to) => {
              if (!ok) return
              const $from = doc.resolve(from)
              for (let d = $from.depth; d >= 1; d--) {
                const node = $from.node(d)
                if (node.type.name !== 'run_step') continue
                if (from >= $from.start(d) && to <= $from.end(d)) ok = advKeys.has(stepKey(pageId, node))
                break
              }
            })
            return ok
          })
        },
      }),
  )
}

/** editable = 能写（viewer / 公开页为 false：不出「引用」）；back = 回父页 */
export function runStepView(pageId: string, opts: { editable: boolean; back: (parentId: string) => void }) {
  return $view(runStepSchema.node, () => {
    return (node: PMNode) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'run-step'
      dom.setAttribute('data-run-step', '')
      // 整行（含间隙 / 内边距）都是展开 / 收起的点击区；行里的操作按钮有自己的 data-act，closest 先命中它们
      const row = shell('div', 'run-step-row')
      row.dataset.act = 'toggle'
      const ic = shell('span', 'run-step-ic')
      const verb = shell('span', 'run-step-verb')
      const label = shell('span', 'run-step-label')
      const meta = shell('span', 'run-step-meta')
      const acts = shell('span', 'run-step-acts')
      row.append(ic, verb, label, meta, acts)
      // 卡片与「高级」容器本身不设 contenteditable：里面的 contentDOM 要沿用编辑器的可编辑性
      const card = document.createElement('div')
      card.className = 'run-step-card'
      const view = shell('div', 'run-step-view')
      const advBar = shell('div', 'run-step-advbar')
      const adv = document.createElement('div')
      adv.className = 'run-step-adv'
      const raw = shell('div', 'run-step-raw')
      const textLabel = shell('div', 'run-step-text-label')
      textLabel.textContent = COPY.run.stepText
      const text = document.createElement('div')
      text.className = 'run-step-text'
      adv.append(raw, textLabel, text)
      card.append(view, advBar, adv)
      dom.append(row, card)

      const key = (): string => stepKey(pageId, current)

      const paintDetail = (): void => {
        const k = str(current.attrs.k)
        const entry = entryOfSid(pageId, str(current.attrs.sid))
        view.innerHTML = stepViewHtml(entry, k, stepText(current))
        raw.innerHTML = k === 'tool' && entry?.k === 'tool' ? toolDetailHtml(entry) : ''
        advBar.innerHTML = advToggleHtml(advKeys.has(key()))
      }

      const quote = (): void => {
        const info = getRunInfo(pageId)
        const blockId = str(current.attrs.id)
        if (!info?.parent || !blockId) return
        const line = `${stepVerb(str(current.attrs.k), str(current.attrs.kind))} ${current.textContent.replace(/\s+/g, ' ').trim()}`
        queueQuote(info.parent.id, { pageId, blockId, text: line.trim().slice(0, 160) })
        writeViewMode(info.parent.id, false) // 引用落在文档里正在写的消息上，回去就是文档模式
        opts.back(info.parent.id) // 出门变形回父页（run-door.ts）
      }

      const toggle = (): void => {
        const k = key()
        if (openKeys.has(k)) openKeys.delete(k)
        else openKeys.add(k)
        const now = openKeys.has(k)
        dom.classList.toggle('is-open', now)
        acts.querySelector('[data-act="toggle"]')?.setAttribute('aria-expanded', String(now))
        if (now) paintDetail()
      }

      const toggleAdv = (): void => {
        const k = key()
        if (advKeys.has(k)) advKeys.delete(k)
        else advKeys.add(k)
        dom.classList.toggle('is-adv', advKeys.has(k))
        advBar.innerHTML = advToggleHtml(advKeys.has(k))
      }

      const paint = (): void => {
        const k = str(current.attrs.k)
        const kind = str(current.attrs.kind)
        const status = str(current.attrs.status)
        const parent = str(current.attrs.parent)
        const t: unknown = current.attrs.t
        const end: unknown = current.attrs.end
        dom.setAttribute('data-k', k)
        if (status) dom.setAttribute('data-status', status)
        else dom.removeAttribute('data-status')
        if (parent) dom.setAttribute('data-parent', parent)
        else dom.removeAttribute('data-parent')
        ic.innerHTML = stepIcon(k, kind)
        verb.textContent = stepVerb(k, kind)
        verb.title = typeof t === 'number' ? fmtClock(t) : ''
        // 行上的字：只读镜像（一行，CSS 省略）；能改的那份在「高级」里
        label.textContent = stepText(current).replace(/\s+/g, ' ').trim()
        meta.textContent = typeof t === 'number' && typeof end === 'number' ? fmtDuration(end - t) : ''
        const open = openKeys.has(key())
        dom.classList.toggle('is-open', open)
        dom.classList.toggle('is-adv', advKeys.has(key()))
        // 引用要有写权、所属页面还在、块有 id；每一步都能展开（常规展示 + 高级）
        acts.replaceChildren()
        if (opts.editable && getRunInfo(pageId)?.parent && str(current.attrs.id)) {
          acts.append(actButton('quote', '引用这一步', iconSvg('quote', 14)))
        }
        // 收藏是私人书签，只读也可以
        if (str(current.attrs.id)) {
          const on = isFavorite(pageId, str(current.attrs.id))
          const fav = actButton('fav', on ? COPY.fav.remove : COPY.fav.add, iconSvg(on ? 'star-fill' : 'star', 14))
          fav.classList.toggle('is-on', on)
          acts.append(fav)
        }
        const b = actButton('toggle', '展开 / 收起', iconSvg('chevron', 14))
        b.setAttribute('aria-expanded', String(open))
        acts.append(b)
      }

      // 按在行 / 操作按钮上不改选区与焦点：stopEvent 只让编辑器不管，浏览器默认仍会把原生光标落进行里、
      // 让编辑器拿焦点（行字前出现光标、单行省略失效）
      dom.addEventListener('mousedown', (event) => {
        const hit = (event.target as HTMLElement).closest('[data-act]')
        if (hit && dom.contains(hit)) event.preventDefault()
      })

      dom.addEventListener('click', (event) => {
        const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-act]')
        if (!hit || !dom.contains(hit)) return
        if (hit.dataset.act === 'toggle') toggle()
        else if (hit.dataset.act === 'adv') toggleAdv()
        else if (hit.dataset.act === 'quote') quote()
        else if (hit.dataset.act === 'fav') {
          hit.classList.remove('is-pop')
          void hit.offsetWidth // 重播星标弹一下
          hit.classList.add('is-pop')
          void toggleFavorite(pageId, str(current.attrs.id))
        }
      })

      // record 后到（块先建好）：重画操作按钮；展开着的详情也补上
      const offRun = onRunInfo(pageId, () => {
        paint()
        if (openKeys.has(key())) paintDetail()
      })
      const offFav = subscribeFavorites(paint) // 收藏变了（侧栏取消 / 别处收藏）星标跟着变
      paint()
      if (openKeys.has(key())) paintDetail()

      return {
        dom,
        contentDOM: text,
        update(next: PMNode) {
          if (next.type !== current.type) return false
          const textChanged = stepText(next) !== stepText(current)
          current = next
          paint() // 只重画外壳；工具详情只在展开 / record 到达时画（打字不重画）
          // 思考 / 说明的常规展示就是全文：在「高级」里改了字，上面的全文跟着变
          if (textChanged && openKeys.has(key()) && str(current.attrs.k) !== 'tool') {
            view.innerHTML = stepViewHtml(entryOfSid(pageId, str(current.attrs.sid)), str(current.attrs.k), stepText(current))
          }
          return true
        },
        // 点在外壳（图标 / 按钮 / 详情）上：编辑器别当成正文里的点击
        stopEvent(event: Event) {
          const target = event.target as Node | null
          return Boolean(target) && target !== dom && dom.contains(target) && !text.contains(target)
        },
        ignoreMutation(mutation: { target: Node }) {
          return !text.contains(mutation.target)
        },
        destroy() {
          offRun()
          offFav()
        },
      }
    }
  })
}
