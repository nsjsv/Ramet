/* ---------- Genet 页的任务状态：派出去的任务页链接后面挂「运行中 / 等你批准 / 已完成 / 失败」 ----------
 * 任务页 = Genet 页下面的普通页面（过程页也挂在它下面，按 kind 排除）。状态只来自服务端（GET /api/pages/run-status），前端不推断。
 * 问哪些页：对话里提到的页面（页面提及 chip：Genet 写的任务链接落块时就是它，@ramet/shared/markdown-blocks）里是任务页的。那个端点要在服务端读文档，
 * 所以定时只问还没到终态的（还不知道 / 运行中 / 等你批准 / 还没回复），对话开着、页面看得见才问；
 * 收件箱信号（control 的 inbox：有审批、回合开始或结束）一来全部重问一次，做完的任务又被接着跑也认得出来。
 * 画在哪：对话气泡是静态 DOM（chat-view.tsx 的 buildBubble），状态标插在链接后面，状态变了就地改字，气泡不重建；
 * AI 页的任务分页（ai/TaskList.tsx）列的是 Genet 页下面的全部任务页，经 usePollStatuses / useStatuses 读同一份状态表。 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Page } from '../api'
import { COPY } from '../copy'
import { subscribeControl } from '../control'
import { assistantApi, RUN_STATUS_MAX, type TaskStatus } from './assistant-api'

/** 有任务没到终态时多久问一次 */
const POLL_MS = 4000
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'failed'])
const MARK = 'task-mark'

/** 文档里提到的页面（页面提及 chip，按出现顺序去重） */
export function mentionedPages(doc: PMNode): string[] {
  const out = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== 'page_mention') return
    const id: unknown = node.attrs.pageId
    if (typeof id === 'string' && id) out.add(id)
  })
  return [...out]
}

/** 任务页 = Genet 页下面的普通页面（过程页也挂在它下面，是 run） */
const isTaskOf = (page: Page, parentId: string): boolean => page.parent_id === parentId && page.kind === 'doc'

/** 提到的页里哪些是这一页的任务页；超过一次能问的数目时留最近提到的 */
export function tasksIn(mentioned: readonly string[], pages: readonly Page[] | null, parentId: string): string[] {
  if (!pages) return []
  const kids = new Set(pages.filter((p) => isTaskOf(p, parentId)).map((p) => p.id))
  return mentioned.filter((id) => kids.has(id)).slice(-RUN_STATUS_MAX)
}

/** 这一页下面的全部任务页，新的在上（created_at 是服务端同一格式的时间串，按字符串比即按时间比） */
export function taskPages(pages: readonly Page[] | null, parentId: string): Page[] {
  if (!pages) return []
  return pages.filter((p) => isTaskOf(p, parentId)).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
}

/** 定时要问的：还不知道的、没到终态的 */
export function idsToPoll(ids: readonly string[], known: ReadonlyMap<string, TaskStatus>): string[] {
  return ids.filter((id) => {
    const status = known.get(id)
    return status === undefined || !TERMINAL.has(status)
  })
}

/** 状态标的字；还没回复（idle）不标：手建在 Genet 页下的普通子页也是这样，标了是假信息，派出去的任务一开跑就是「运行中」 */
export function statusLabel(status: TaskStatus | undefined): string | null {
  return status && status !== 'idle' ? COPY.assistant.status[status] : null
}

// 所有对话与任务分页共用一份（同一个任务页在浮窗、全页、任务列表里是同一个状态）；version 每变一次加一，给 React 订阅用
const statuses = new Map<string, TaskStatus>()
const listeners = new Set<() => void>()
let version = 0

function putStatuses(next: Record<string, TaskStatus>): void {
  let changed = false
  for (const [id, status] of Object.entries(next)) {
    if (statuses.get(id) === status) continue
    statuses.set(id, status)
    changed = true
  }
  if (!changed) return
  version++
  listeners.forEach((l) => l())
}

function subscribeStatuses(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 共享状态表的 React 视图：表里有状态变了就重渲染 */
export function useStatuses(): ReadonlyMap<string, TaskStatus> {
  useSyncExternalStore(subscribeStatuses, () => version)
  return statuses
}

/** 定时问这些任务页的状态，结果进共享表：只问还没到终态的，用它的界面（对话 / 任务列表）挂着、页面看得见才问；收件箱信号一来全部重问一次 */
export function usePollStatuses(tasks: readonly string[]): void {
  // 同一组任务页不重建定时器（id 是 uuid，不含逗号）
  const key = tasks.join(',')
  useEffect(() => {
    if (!key) return
    const ids = key.split(',')
    let alive = true
    let timer: number | undefined
    let inflight = false
    const ask = async (list: readonly string[]): Promise<void> => {
      if (inflight || list.length === 0) return
      inflight = true
      try {
        putStatuses(await assistantApi.statuses(list))
      } catch (err) {
        console.warn('任务状态没取到：', err instanceof Error ? err.message : err)
      } finally {
        inflight = false
      }
    }
    const schedule = (): void => {
      if (alive && timer === undefined && idsToPoll(ids, statuses).length > 0) timer = window.setTimeout(loop, POLL_MS)
    }
    const loop = async (): Promise<void> => {
      timer = undefined
      if (!alive) return
      // 页面藏起来时不问，表照走（回到前台的下一拍接着问）
      if (document.visibilityState === 'visible') await ask(idsToPoll(ids, statuses))
      schedule()
    }
    void loop()
    const off = subscribeControl((ev) => {
      if (ev === 'inbox' || ev === 'sync') void ask(ids).then(schedule)
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
      off()
    }
  }, [key])
}

/** 气泡里每颗页面提及 chip 后面放一个状态标（先藏着，paint 决定显不显） */
function attachMarks(root: HTMLElement): void {
  const targets: Array<[HTMLElement, string]> = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-page-mention]')) {
    const id = el.dataset.pageMention
    if (id) targets.push([el, id])
  }
  for (const [el, id] of targets) {
    const next = el.nextElementSibling
    if (next instanceof HTMLElement && next.classList.contains(MARK)) continue
    const mark = document.createElement('span')
    mark.className = MARK
    mark.dataset.task = id
    mark.hidden = true
    el.after(mark)
  }
}

/** 已经画好的气泡（正在跑的那条正文是实时视图，不碰；气泡以外的块归 ProseMirror 管，往里插东西会被它当成内容改动） */
const BUBBLES = '.chat-msg:not(.is-live) > .chat-bubble'

function attachAll(root: HTMLElement): void {
  for (const bubble of root.querySelectorAll<HTMLElement>(BUBBLES)) attachMarks(bubble)
}

function paintMarks(root: HTMLElement, tasks: ReadonlySet<string>): void {
  for (const mark of root.querySelectorAll<HTMLElement>(`.${MARK}[data-task]`)) {
    const id = mark.dataset.task ?? ''
    const status = tasks.has(id) ? statuses.get(id) : undefined
    const label = statusLabel(status)
    mark.hidden = label === null
    mark.textContent = label ?? ''
    if (status) mark.dataset.status = status
    else delete mark.dataset.status
  }
}

export interface TaskMarks {
  /** 对话视图每次更新之后调（气泡此时已在 DOM 里）：重算提到了哪些页，给新出现的气泡挂状态标 */
  sync: (root: HTMLElement, doc: PMNode) => void
}

/** 对话视图（ChatView）用：on = 这一页是 Genet 页；host = 气泡所在的根 */
export function useTaskMarks(pageId: string, on: boolean, pages: Page[] | null, host: RefObject<HTMLElement | null>): TaskMarks {
  const [mentioned, setMentioned] = useState<readonly string[]>([])
  const tasks = useMemo(() => (on ? tasksIn(mentioned, pages, pageId) : []), [on, mentioned, pages, pageId])
  const taskSet = useRef<ReadonlySet<string>>(new Set())
  const enabled = useRef(on)
  enabled.current = on
  const key = tasks.join(',')

  // 任务集合或状态变了：就地重画状态标。刚认出是 Genet 页（SSE 首帧晚于气泡）时已有的气泡还没挂标，先补上
  useEffect(() => {
    taskSet.current = new Set(tasks)
    if (on && host.current) attachAll(host.current)
    const paint = (): void => {
      if (host.current) paintMarks(host.current, taskSet.current)
    }
    paint()
    return subscribeStatuses(paint)
  }, [key, on, host])

  usePollStatuses(tasks)

  const lastDoc = useRef<PMNode | null>(null)
  const sync = useCallback((root: HTMLElement, doc: PMNode) => {
    if (!enabled.current) return
    // 只重画气泡（运行开始 / 收尾）时文档没变，不必重扫
    if (doc !== lastDoc.current) {
      lastDoc.current = doc
      const ids = mentionedPages(doc)
      setMentioned((prev) => (prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids))
    }
    attachAll(root)
    paintMarks(root, taskSet.current)
  }, [])
  return { sync }
}
