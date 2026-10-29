// ---------- 进出过程页的变形（run-door） ----------
// 进门：点回复右上角的用量胶囊，胶囊变形成过程页标题，其余交叉淡化；过程页从顶部开始。
// 出门：过程页头的返回链接 / 步骤「引用」，标题变形回父页里同一条回复抬头停靠的岛（.island.is-docked[data-run=<过程页>]），
//   胶囊停在进门时点它的屏幕高度；没有进门记录（直接打开过的过程页）就放在可视区中间偏上。
// 新页面是异步建的（IDB / ws 同步后才建编辑器）：View Transitions 的更新回调里等目标出现（最多 WAIT_MS），
// 等不到就照常结束（只剩交叉淡化）；落位在那之后继续等一会儿，用户先动了滚轮 / 触摸 / 键盘就放弃。
// 面包屑、浏览器前进后退、新标签页打开不经过这里。不支持 startViewTransition / 减弱动效时直接跳，落位照做。
import { reducedMotion } from '../motion'

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<unknown> } }

const DOOR = 'run-door'
/** 变形最多等新页面这么久（这期间画面停在旧页） */
const WAIT_MS = 800
/** 进门：过程页头（run 记录要单独拉）迟迟不来，过了这个点只要标题在就先变形 */
const HEAD_GRACE_MS = 600
/** 变形结束后落位还能再等这么久 */
const LATE_MS = 5000

/** 进门记录：出门时把胶囊放回这个屏幕高度（只记最近一次） */
let door: { runId: string; parentId: string; y: number } | null = null

const shown = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.offsetParent !== null

/** 轮询 find() 直到给出元素、超时或 abort() 为真。用 setTimeout：VT 等回调期间渲染挂起，不靠 rAF */
function waitFor(find: () => HTMLElement | null, ms: number, abort: () => boolean): Promise<HTMLElement | null> {
  const end = performance.now() + ms
  return new Promise((resolve) => {
    const tick = (): void => {
      if (abort()) return resolve(null)
      const el = find()
      if (el || performance.now() >= end) return resolve(el)
      window.setTimeout(tick, 16)
    }
    tick()
  })
}

/** 用户自己动了（滚轮 / 触摸 / 按键）就别再替他落位 */
function watchUser(): { moved: () => boolean; stop: () => void } {
  let moved = false
  const on = (): void => {
    moved = true
  }
  const events = ['wheel', 'touchmove', 'keydown'] as const
  for (const e of events) window.addEventListener(e, on, { passive: true, capture: true })
  return {
    moved: () => moved,
    stop: () => {
      for (const e of events) window.removeEventListener(e, on, { capture: true })
    },
  }
}

/** 带变形的跳转：from 与目标同名 run-door；find 找新页面里的目标，place 把它摆到位 */
function morphTo(from: HTMLElement | null, go: () => void, find: () => HTMLElement | null, place: (el: HTMLElement) => void): void {
  const user = watchUser()
  const late = (ms: number): void => {
    void waitFor(find, ms, user.moved).then((el) => {
      user.stop()
      if (el) place(el)
    })
  }
  const start = (document as ViewTransitionDoc).startViewTransition?.bind(document)
  if (!start || reducedMotion() || !from) {
    go()
    return late(WAIT_MS + LATE_MS)
  }
  from.style.viewTransitionName = DOOR
  // 变形期间收起胶囊的悬停提示：它是胶囊自己的 ::after，会被一起拍进快照、跟着放大（run.css）
  document.documentElement.dataset.runDoor = ''
  let to: HTMLElement | null = null
  const clear = (): void => {
    from.style.viewTransitionName = ''
    if (to) to.style.viewTransitionName = ''
    delete document.documentElement.dataset.runDoor
  }
  try {
    const transition = start(async () => {
      from.style.viewTransitionName = '' // 旧画面已拍好；旧编辑器异步销毁期间别和新目标撞名
      go()
      to = await waitFor(find, WAIT_MS, user.moved)
      if (!to) return
      place(to)
      to.style.viewTransitionName = DOOR
    })
    void transition.finished.finally(() => {
      clear()
      if (to) user.stop()
      else late(LATE_MS)
    })
  } catch {
    clear()
    go()
    late(WAIT_MS + LATE_MS)
  }
}

/** 进门：chip = 被点的用量胶囊；ready = 新编辑器已属于这个过程页；title = 页面标题容器 */
export function enterRun(o: {
  runId: string
  parentId: string
  chip: HTMLElement | null
  go: () => void
  ready: () => boolean
  title: () => HTMLElement | null
}): void {
  if (o.chip) door = { runId: o.runId, parentId: o.parentId, y: o.chip.getBoundingClientRect().top }
  const t0 = performance.now()
  const find = (): HTMLElement | null => {
    if (!o.ready()) return null
    const title = o.title()
    if (!shown(title) || !title.querySelector('.ProseMirror')) return null
    // 过程页头（摘要行）也到了再拍，免得变形完它才挤进来；记录拉得慢就不等它
    const head = title.closest('.editor-page')?.querySelector('.run-page-summary')
    return head || performance.now() - t0 > HEAD_GRACE_MS ? title : null
  }
  const place = (title: HTMLElement): void => {
    const scroller = title.closest<HTMLElement>('.main')
    if (scroller) scroller.scrollTop = 0
  }
  morphTo(o.chip, o.go, find, place)
}

/** 出门：from = 过程页标题容器；ready = 新编辑器已属于父页 */
export function leaveRun(o: { runId: string; parentId: string; from: HTMLElement | null; go: () => void; ready: () => boolean }): void {
  const find = (): HTMLElement | null => {
    if (!o.ready()) return null
    for (const el of document.querySelectorAll<HTMLElement>('.island.is-docked[data-run]')) {
      if (el.dataset.run === o.runId && shown(el)) return el
    }
    return null
  }
  const place = (chip: HTMLElement): void => {
    const scroller = chip.closest<HTMLElement>('.main')
    if (!scroller) return
    const box = scroller.getBoundingClientRect()
    const y = door && door.runId === o.runId && door.parentId === o.parentId ? door.y : box.top + box.height * 0.35
    scroller.scrollTop += chip.getBoundingClientRect().top - y
  }
  morphTo(o.from, o.go, find, place)
}
