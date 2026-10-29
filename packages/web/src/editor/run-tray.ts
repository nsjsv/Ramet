/* ---------- 运行中的步骤托盘（纯 DOM） ----------
 * 高度封顶（CSS `.tray`），新步骤追加在下、贴底时自动跟随；步骤再多也不会把正文挤出视野。
 * 行是紧凑的一行（图标 · 标题 · 用时/转圈）；点开 = 常规展示（run-view.ts：命令 + 输出 / 读文件 / diff，与过程页同一个渲染器），
 * 工具步骤卡片底部有「高级」，点开才看原始调用信息（run-detail.ts 的 toolDetailHtml）。
 * 条目 key 稳定（entryKeys），就地更新，新行只播入场。 */
import { isTerminal, type RunEntry, type RunInfo, type RunState } from '@ramet/shared/run-model'
import { COPY } from '../copy'
import { easeOut, motionMs } from '../motion'
import { infoHtml, toolDetailHtml } from './run-detail'
import { advToggleHtml, stepViewHtml } from './run-view'
import { detailKey, entryIcon, entryObject, entryVerb, escapeHtml, fmtDuration } from './run-format'
import { entryKeys, isToggleTarget } from './run-rows'
import { isRunningCommand, stepTerminalId } from './step-terminal'

/** 思考 / 说明在行里只留一行：折叠空白后取尾（实时）或头（已结束） */
const LINE_MAX = 160

function titleOf(e: RunEntry, live: boolean): string {
  const text = entryObject(e)
  if (e.k === 'tool') return `${entryVerb(e)} ${text}`.trim()
  const flat = text.replace(/\s+/g, ' ').trim()
  const line = live ? flat.slice(-LINE_MAX) : flat.slice(0, LINE_MAX)
  return line ? `${entryVerb(e)} · ${line}` : entryVerb(e)
}

export interface Tray {
  el: HTMLElement
  /** 按条目就地更新；running = 这一轮还没结束 */
  sync(state: RunState, running: boolean): void
}

export interface TrayOptions {
  /** 给了才在 ACP 终端里还在跑的命令那一行摆「停止这条命令」（没有页面写权限的看不到） */
  onKillCommand?: (terminalId: string) => void
}

export function createTray(opts: TrayOptions = {}): Tray {
  const el = document.createElement('div')
  el.className = 'tray'
  el.setAttribute('role', 'log')
  const list = document.createElement('div')
  list.className = 'tray-list'
  const info = document.createElement('div')
  info.className = 'run-info'
  el.append(list, info)

  const rows = new Map<string, HTMLElement>()
  const full = new Set<string>()
  /** 「高级」开着的行（只有工具步骤有） */
  const adv = new Set<string>()

  function paintRow(row: HTMLElement, e: RunEntry, open: boolean, running: boolean): void {
    const advOpen = e.k === 'tool' && adv.has(row.dataset.key ?? '')
    const failed = e.k === 'tool' && e.status === 'failed'
    const live = e.k === 'tool' ? !isTerminal(e.status) && running : e.k === 'thought' && e.end === undefined && running
    const title = titleOf(e, live)
    const dur = e.t !== undefined && e.end !== undefined ? fmtDuration(e.end - e.t) : ''
    // 正在这一行里选字时不动 DOM：重画会把选区打断
    const sel = window.getSelection()
    if (open && sel && !sel.isCollapsed && sel.anchorNode && row.contains(sel.anchorNode)) return
    const text = entryObject(e)
    const objSig = e.k === 'tool' ? title : `${title.length}|${title.slice(-24)}`
    const killable = Boolean(opts.onKillCommand) && live && e.k === 'tool' && isRunningCommand(e)
    const sig = `${objSig}|${dur}|${failed}|${open}|${advOpen}|${live}|${killable}|${e.truncated ? 1 : 0}|${e.k === 'tool' ? detailKey(e) : text.length}`
    if (row.dataset.sig === sig) return
    row.dataset.sig = sig
    // 这一行刚从「进行中」变成完成：重画后用时淡入一次。
    // 不用 CSS 选择器触发：整行 innerHTML 重画（展开 / 收起 / 高级）会让 CSS 动画每次重播
    const justDone = row.dataset.live === '1' && !live
    row.dataset.live = live ? '1' : ''
    row.className = ['trow', `k-${e.k}`, live ? 'is-now' : '', failed ? 'is-failed' : '', e.k === 'tool' && e.parentId ? 'is-child' : '', open ? 'is-full' : '']
      .filter(Boolean)
      .join(' ')
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.setAttribute('aria-expanded', String(open))
    const note = e.k === 'tool' && e.note ? `<div class="trow-note">${escapeHtml(e.note)}</div>` : ''
    const advPart = e.k === 'tool' ? advToggleHtml(advOpen) + (advOpen ? `<div class="run-card-adv">${toolDetailHtml(e)}</div>` : '') : ''
    const detail = open ? `<div class="run-card">${stepViewHtml(e, e.k, text)}${advPart}</div>` : ''
    // 停止这条命令：只在 ACP 终端里还在跑的命令那一行，摆在行尾状态格里（.t 会溢出省略，按钮不能放进去）；点它不展开行
    const kill = killable ? `<button type="button" class="trow-kill" data-act="kill-cmd">${escapeHtml(COPY.run.stopCommand)}</button>` : ''
    row.innerHTML =
      `<span class="k">${entryIcon(e)}</span>` +
      `<span class="t">${escapeHtml(title)}${note}</span>` +
      `<span class="st">${kill}${live ? '<span class="spin" aria-hidden="true"></span>' : dur}</span>` +
      detail
    const fade = justDone && dur ? motionMs('--d-2') : 0
    if (fade) row.querySelector('.st')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade, easing: easeOut() })
  }

  const toggle = (row: HTMLElement): void => {
    const key = row.dataset.key
    if (!key) return
    if (full.has(key)) full.delete(key)
    else full.add(key)
    row.classList.toggle('is-full', full.has(key))
    row.setAttribute('aria-expanded', String(full.has(key)))
    // 类名先变，详情内容在下一次 sync 补上 / 摘掉
    row.dataset.sig = ''
    if (last) sync(last.state, last.running)
  }
  list.addEventListener('click', (event) => {
    const killBtn = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-act="kill-cmd"]')
    if (killBtn) {
      const key = killBtn.closest<HTMLElement>('.trow')?.dataset.key
      const entry = last?.state.entries[entryKeys(last.state.entries).indexOf(key ?? '')]
      const terminalId = entry?.k === 'tool' ? stepTerminalId(entry) : null
      if (terminalId) {
        killBtn.disabled = true // 命令一退出这一行就重画；失败由 onKillCommand 的调用方报
        opts.onKillCommand?.(terminalId)
      }
      return
    }
    const advBtn = (event.target as Element | null)?.closest<HTMLElement>('[data-act="adv"]')
    if (advBtn) {
      const row = advBtn.closest<HTMLElement>('.trow')
      const key = row?.dataset.key
      if (!row || !key) return
      if (adv.has(key)) adv.delete(key)
      else adv.add(key)
      row.dataset.sig = ''
      if (last) sync(last.state, last.running)
      return
    }
    if (!isToggleTarget(event.target)) return
    const row = (event.target as HTMLElement).closest<HTMLElement>('.trow')
    if (row) toggle(row)
  })
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const row = (event.target as HTMLElement).closest<HTMLElement>('.trow')
    if (!row || event.target !== row) return
    event.preventDefault() // Space 默认滚页
    toggle(row)
  })

  let infoSig: RunInfo | undefined
  let truncSig = false
  function paintInfo(state: RunState): void {
    // 按引用重算：info 只在 info 事件时换新对象，避免每帧重画。
    // 用量 / 上下文不在这里画：输入卡的圆环和工作台面板已经有了
    if (state.info !== infoSig) {
      infoSig = state.info
      info.innerHTML = infoHtml(state.info)
      truncSig = false
    }
    const trunc = state.truncated ?? false
    if (trunc !== truncSig) {
      truncSig = trunc
      info.querySelector('.rd-trunc.is-run')?.remove()
      if (trunc) {
        const note = document.createElement('div')
        note.className = 'rd-trunc is-run'
        note.textContent = COPY.run.partTruncated
        info.append(note)
      }
    }
  }

  let last: { state: RunState; running: boolean } | null = null
  function sync(state: RunState, running: boolean): void {
    last = { state, running }
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    const keys = entryKeys(state.entries)
    let prev: Element | null = null
    keys.forEach((key, i) => {
      let row = rows.get(key)
      if (!row) {
        row = document.createElement('div')
        row.dataset.key = key
        rows.set(key, row)
      }
      paintRow(row, state.entries[i]!, full.has(key), running)
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
    paintInfo(state)
    if (stick) el.scrollTop = el.scrollHeight
    el.classList.toggle('is-scrolled', el.scrollTop > 1)
  }
  el.addEventListener('scroll', () => el.classList.toggle('is-scrolled', el.scrollTop > 1), { passive: true })

  return { el, sync }
}
