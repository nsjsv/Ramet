/* ---------- 右上角工作台：挂在 App 外壳（TopBar 之下）----------
 * 只管当前页：页上有在飞的一轮就在右上角浮它的岛；点岛或点回复抬头停靠的岛，展开面板。
 * 项目面板开着时面板改挂进「本轮」分页（HudEmbedded），这里只留岛。数据：在飞的一轮来自 agent-bar 的 store
 * （不另开连接），跑完的一轮按过程页 id 拉 record（hud-source.ts）。
 * 键盘：面板开着时 Esc 收起；岛是审批条时，焦点不在可编辑区域按 1–9 选第 n 个。没有全局开关键（⌘J 是随手 AI）。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMatch } from 'react-router-dom'
import { runTally } from '@ramet/shared/run-model'
import { api } from '../api'
import { useAgentEvents, setAgentRunError, type AgentState, type PermissionReq } from '../editor/agent-bar'
import { answerOption } from '../editor/ask-card'
import { nowOf } from '../editor/run-strip'
import { COPY } from '../copy'
import { setProjectTab, useProjectShell, useProjectTarget } from '../project/project-state'
import { HUD_COPY as C } from './hud-copy'
import { askBarOf, hudFromLive, hudFromRecord, islandOf, type HudRun, type HudTab } from './hud-model'
import { HudPanel } from './HudPanel'
import { useRunRecord } from './hud-source'
import { closeHud, openHud, resetHudFor, useHud, type HudTarget } from './hud-store'
import { createIsland, type Island } from './island'
import { dockIsland } from './island-flight'
import { makeRoom } from './make-room'

/** 每秒走一次表（只在有在飞的一轮时） */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

/** 面板看的这一轮：target 是 null 或正好是在飞的那一块就读 store，否则拉 record */
function useHudRun(agent: AgentState, target: HudTarget | null, now: number): { run: HudRun | null; failed: boolean } {
  const live = agent.run
  const useLive = live !== null && (!target || target.replyId === live.replyId)
  const { record, failed } = useRunRecord(useLive ? null : (target?.runId ?? null))
  return useMemo(() => {
    if (useLive && live) return { run: hudFromLive(live, now), failed: false }
    if (target?.runId && record) return { run: hudFromRecord(target.runId, record), failed: false }
    return { run: null, failed }
  }, [useLive, live, live?.version, now, target?.runId, record, failed]) // live 原地改，按 version 重算
}

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

/** 岛上审批条的第 i 个按钮对应的应答（提问快选带答案；审批按 agent 的选项） */
function answerFromIsland(pageId: string, req: PermissionReq, i: number, el: HTMLElement): void {
  const btn = askBarOf(req).buttons?.[i]
  if (!btn) return
  const buttons = el.querySelectorAll<HTMLButtonElement>('[data-ans]')
  if (!btn.content) return answerOption(pageId, req, btn.optionId, buttons)
  for (const b of buttons) b.disabled = true
  void api.respondPermission(pageId, req.agentId, req.requestId, btn.optionId, btn.content).catch((err: unknown) => {
    for (const b of buttons) b.disabled = false
    setAgentRunError(err instanceof Error ? err.message : COPY.ask.failed)
  })
}

export default function HudLayer({ canStop }: { canStop: (pageId: string) => boolean }) {
  const pageId = useMatch('/page/:id')?.params.id
  const agent = useAgentEvents(pageId)
  const hud = useHud()
  const shell = useProjectShell()
  const projectTarget = useProjectTarget(pageId)
  const projectOn = shell.open && projectTarget !== null
  const liveRun = agent.run && !agent.run.outcome ? agent.run : null
  const now = useClock(liveRun !== null)
  const { run, failed } = useHudRun(agent, hud.target, now)
  const ask = run?.live ? agent.permissions[0] : undefined
  const island = useRef<Island | null>(null)
  /** 浮岛现在画的是哪一条回复：它被摘掉时飞回这条回复抬头的停靠位 */
  const shownReply = useRef<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  // 岛只建一次，它的点击处理读这里的最新值（不能闭包住第一次渲染时的 hud / 审批）
  const latest = useRef({ hud, permissions: agent.permissions })
  latest.current = { hud, permissions: agent.permissions }

  useEffect(() => resetHudFor(pageId), [pageId])
  // 项目面板开着时，面板在它的「本轮」分页里：点岛 / 点停靠的岛要把项目面板切过去，不然看不见
  useEffect(() => {
    if (hud.open && projectOn) setProjectTab('round')
  }, [hud.open, hud.tab, hud.target, projectOn])

  // 岛：在飞的一轮，或面板正开着（看的可能是抬起来的老一轮）
  const showIsland = run !== null && (run.live || hud.open)
  // 在飞的一轮 store 原地改数组：按 version 重算，不按引用
  const tally = useMemo(() => (run ? runTally(run, run.ms) : null), [run?.replyId, run?.runId, run?.version])
  useLayoutEffect(() => {
    const node = host.current
    if (!node || !showIsland || !run || !tally || !pageId) {
      // 一轮跑完（面板没开）/ 关了抬起来看的老一轮：先飞回停靠位再摘
      if (island.current && shownReply.current) dockIsland(island.current.el, shownReply.current)
      island.current = null
      shownReply.current = null
      node?.replaceChildren()
      return
    }
    shownReply.current = run.replyId
    if (!island.current) {
      island.current = createIsland('float', {
        tab: (tab: HudTab) => {
          const h = latest.current.hud
          if (h.open && h.tab === tab) closeHud()
          else openHud(tab, h.target)
        },
        answer: (i) => {
          const req = latest.current.permissions[0]
          if (req && island.current) answerFromIsland(pageId, req, i, island.current.el)
        },
      })
      node.replaceChildren(island.current.el)
    }
    island.current.paint(islandOf(run, tally, ask !== undefined), {
      now: run.live && agent.run ? nowOf(agent.run.state).text : C.status[run.outcome ?? 'end'],
      ask: ask ? askBarOf(ask) : null,
      current: hud.open ? hud.tab : null,
    })
  })

  // 抬起来看的那一轮：回复抬头的停靠岛先藏起来（同一时刻只有一份）
  const liftedReply = hud.open ? (hud.target?.replyId ?? (run && !run.live ? run.replyId : null)) : null
  useEffect(() => {
    if (!liftedReply) return
    const style = document.createElement('style')
    style.textContent = `.island.is-docked[data-reply="${CSS.escape(liftedReply)}"] { visibility: hidden; }`
    document.head.append(style)
    return () => style.remove()
  }, [liftedReply])

  // 让位：面板挡住正文列时正文左移（项目面板开着时面板在「本轮」分页里，不浮）
  const floating = hud.open && !projectOn && run !== null
  useLayoutEffect(() => {
    if (!floating) return
    return makeRoom(document.querySelector<HTMLElement>('.hud .hud-panel'))
  }, [floating, pageId])

  // Esc 收起；审批条的数字键
  useEffect(() => {
    if (!pageId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape' && hud.open && !projectOn) {
        e.preventDefault()
        closeHud()
        return
      }
      const req = agent.permissions[0]
      if (!req || !run?.live || editable(e.target) || !/^[1-9]$/.test(e.key) || !island.current) return
      const i = Number(e.key) - 1
      if (!askBarOf(req).buttons?.[i]) return
      e.preventDefault()
      answerFromIsland(pageId, req, i, island.current.el)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageId, hud.open, projectOn, agent.permissions, run?.live])

  if (!pageId) return null
  const right = projectOn ? shell.width + 14 : 14
  return (
    <div
      className="hud"
      style={{ right }}
      data-open={hud.open && !projectOn ? 'true' : undefined}
      // 手机上面板是底部抽屉，点遮罩（.hud 的 ::before，事件落在 .hud 自己身上）收起
      onClick={(e) => e.target === e.currentTarget && closeHud()}
    >
      <div className="hud-islands" ref={host} />
      {hud.open && !projectOn && (
        <HudPanel pageId={pageId} run={run} failed={failed} ask={ask} tab={hud.tab} embedded={false} canStop={canStop(pageId)} onClose={closeHud} />
      )}
    </div>
  )
}

/** 项目面板「本轮」分页里的工作台：同一个面板的嵌入模式。没打开过面板就看在飞的那一轮 */
export function HudEmbedded({ pageId, canStop }: { pageId: string; canStop: boolean }) {
  const agent = useAgentEvents(pageId)
  const hud = useHud()
  const now = useClock(agent.run !== null && !agent.run.outcome)
  const target = hud.target?.pageId === pageId ? hud.target : null
  const { run, failed } = useHudRun(agent, target, now)
  if (!run && !target) return <p className="project-note">{agent.status === 'running' ? COPY.project.round.running : `${COPY.project.round.idle} ${COPY.project.round.hint}`}</p>
  return (
    <HudPanel
      pageId={pageId}
      run={run}
      failed={failed}
      ask={run?.live ? agent.permissions[0] : undefined}
      tab={hud.tab}
      embedded
      canStop={canStop}
      onClose={closeHud}
    />
  )
}

