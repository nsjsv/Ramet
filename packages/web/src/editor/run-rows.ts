// ---------- 过程页时间线的行渲染（纯 DOM，就地按 key 更新） ----------
// 运行中的托盘用 run-tray.ts 的紧凑行，这里是过程页（run-board.tsx）用的完整行：
// 时刻 · 图标 · 动词+对象 · 用时，点开看 ACP 详情。
import { isTerminal, type RunEntry } from '@ramet/shared/run-model'
import { toolDetailHtml } from './run-detail'
import { detailKey, entryIcon, entryObject, entryVerb, escapeHtml, fmtClock, fmtDuration } from './run-format'

/** 条目的稳定 key（说明会插回较早的位置，不能用下标） */
export function entryKeys(entries: RunEntry[]): string[] {
  const seen = new Map<string, number>()
  return entries.map((e) => {
    const base = e.k === 'tool' ? `t:${e.id}` : `${e.k}:${e.t ?? 0}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}#${n}` : base
  })
}

/** 一行条目的内容（思考/说明一行省略、点开看全文；失败的工具标红带一行摘要；工具点开看完整 ACP 详情） */
export function paintEntryRow(row: HTMLElement, e: RunEntry, full: boolean, running: boolean): void {
  const failed = e.k === 'tool' && e.status === 'failed'
  const live = e.k === 'tool' ? !isTerminal(e.status) && running : e.k === 'thought' && e.end === undefined && running
  const text = entryObject(e)
  const obj = e.k === 'thought' && live ? text.replace(/\s+/g, ' ').slice(-120) : text
  const dur = e.t !== undefined && e.end !== undefined ? fmtDuration(e.end - e.t) : live ? '…' : ''
  // 正在这一行里选字时不动 DOM：重画会打断选区，下次再画
  const sel = window.getSelection()
  if (full && sel && !sel.isCollapsed && sel.anchorNode && row.contains(sel.anchorNode)) return
  // 展开态用全文/ACP 指纹做 sig：等长更新、同长不同内容都不会漏画；思考/说明用长度+尾巴，避免逐帧比长文本
  const objSig = e.k === 'tool' ? obj : `${obj.length}|${obj.slice(-24)}`
  const sig = `${e.k}|${objSig}|${dur}|${failed}|${full}|${live}|${e.truncated ? 1 : 0}|${e.k === 'tool' ? detailKey(e) : ''}`
  if (row.dataset.sig === sig) return
  row.dataset.sig = sig
  row.className = [
    'run-row',
    `k-${e.k}`,
    live ? 'is-running' : '',
    e.k === 'tool' && e.parentId ? 'is-child' : '',
    failed ? 'is-failed' : '',
    'can-expand',
    full ? 'is-full' : '',
    row.classList.contains('is-enter') ? 'is-enter' : '',
  ]
    .filter(Boolean)
    .join(' ')
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-expanded', String(full))
  const note = e.k === 'tool' && e.note ? `<div class="run-row-note">${escapeHtml(e.note)}</div>` : ''
  const detail = full
    ? e.k === 'tool'
      ? toolDetailHtml(e)
      : `<div class="run-detail"><pre class="rd-pre">${escapeHtml(text)}</pre>${e.truncated ? '<div class="rd-trunc">内容超限，已截断</div>' : ''}</div>`
    : ''
  row.innerHTML =
    `<span class="run-row-at">${e.t !== undefined ? fmtClock(e.t) : ''}</span>` +
    `<span class="run-row-ic">${entryIcon(e)}</span>` +
    `<span class="run-row-main"><span class="run-row-verb">${entryVerb(e)}</span>` +
    `<span class="run-row-obj">${escapeHtml(obj)}</span>${note}${detail}</span>` +
    `<span class="run-row-dur">${dur}</span>`
}

/** 展开/收起的点击判据：点在详情里、落在真正可编辑的节点上、或正在选字时不动。
 *  运行条自身 contentEditable=false，但文档模式下它嵌在正文编辑器里，所以用 isContentEditable
 *  看生效的可编辑性，不会被 ProseMirror 祖先的 contenteditable 骗了 */
export function isToggleTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest('.run-detail, .run-card')) return false
  if (target instanceof HTMLElement && target.isContentEditable) return false
  return window.getSelection()?.isCollapsed !== false
}

/** 条目列表（就地按 key 更新；新行入场动画） —— 过程页用 */
export function syncEntryList(list: HTMLElement, rows: Map<string, HTMLElement>, entries: RunEntry[], full: Set<string>, running: boolean): void {
  const keys = entryKeys(entries)
  let prev: Element | null = null
  keys.forEach((key, i) => {
    let row = rows.get(key)
    if (!row) {
      row = document.createElement('div')
      row.className = 'run-row is-enter'
      row.dataset.key = key
      const r = row
      r.addEventListener('animationend', () => r.classList.remove('is-enter'), { once: true })
      rows.set(key, row)
    }
    paintEntryRow(row, entries[i]!, full.has(key), running)
    const next: Element | null = prev ? prev.nextElementSibling : list.firstElementChild
    if (next !== row) list.insertBefore(row, next)
    prev = row
  })
  const live = new Set(keys)
  for (const [key, row] of rows) {
    if (live.has(key)) continue
    row.remove()
    rows.delete(key)
  }
}
