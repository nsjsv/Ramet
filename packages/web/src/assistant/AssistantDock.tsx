/* ---------- 右下角的 Genet：入口按钮 + 浮窗 ----------
 * 登录后的应用里都有（公开页不在登录壳里，自然没有）；当前页本身就是 Genet 页、或在 AI 页的 Genet 分页（/ai）时不显示
 * （那里已经是完整的 Genet 对话），开着的浮窗走到那里就收起，没发出去的字带过去。
 * 点开时先问服务端要 Genet 页（第一次唤起才建，进了回收站会新建一个），再挂对话；关掉就卸载，第二个编辑器会话与它的连接一起拆掉。
 * 窄屏铺满整屏；「在页面里打开」= 进 AI 页的 Genet 分页，没发出去的字跟着带过去。 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import type { Page } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { useAgentEvents } from '../editor/agent-bar'
import { carryToChat, focusComposer, takeComposerText } from '../editor/composer-bridge'
import { pageView } from '../editor/page-views'
import { useProjectShell, useProjectTarget } from '../project/project-state'
import AssistantChat from './AssistantChat'
import { assistantApi } from './assistant-api'
import { isAssistantPage, rememberAssistantPage } from './identity'
import { positionMark } from './position'

const C = COPY.assistant
/** 输入框要等 Genet 页的编辑器起来才建，最多等这么多帧去聚焦它（约 3 秒） */
const FOCUS_FRAMES = 180

type Win = { pageId: string | null; error: string | null }

export default function AssistantDock({ pages, username, onPagesChanged }: { pages: Page[] | null; username: string; onPagesChanged: () => void }) {
  const navigate = useNavigate()
  const routeId = useMatch('/page/:id')?.params.id
  // 唤起的 POST 回来时看的是那一刻的路由页（中途可能换了页）
  const routeRef = useRef(routeId)
  routeRef.current = routeId
  // 与编辑器、工作台共用这一页的事件流（引用计数，不多开连接）：首帧的 choice 说明它是不是 Genet 页
  const routeState = useAgentEvents(routeId)
  const onHub = useMatch('/ai') !== null
  const onAssistant = onHub || (routeId ? isAssistantPage(routeId, routeState) : false)
  const [win, setWin] = useState<Win | null>(null)
  // 每次打开记一个号：关掉之后才回来的 POST 结果不该再打开窗口、也不该把预放的 chip 留给下一次
  const seq = useRef(0)
  const shell = useProjectShell()
  const projectTarget = useProjectTarget(routeId)
  const projectOn = shell.open && projectTarget !== null
  // 项目面板开着时它占着右边，入口和浮窗挪到它左边（同右上角工作台）
  const style = { '--assistant-right': `${projectOn ? shell.width + 20 : 20}px` } as CSSProperties

  const close = (): void => {
    seq.current++
    setWin(null)
  }

  // 消息默认关于眼前这一页：跟着路由走（窗口开着换了页，之后发的就关于新的那页），记在每条消息的 ctx 上，不进输入框。
  // 头部的眼睛点掉 = 这一页不带（只记这一页，换到别的页照常带；刷新后恢复）
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const pageTitle = pages?.find((p) => p.id === routeId)?.title ?? ''
  const here = routeId && !onAssistant ? { id: routeId, title: pageTitle.trim() || COPY.blankPage } : null
  const focus = here && !hidden.has(here.id) ? here : null
  const toggleHere = (): void => {
    if (!here) return
    setHidden((prev) => {
      const next = new Set(prev)
      if (!next.delete(here.id)) next.add(here.id)
      return next
    })
  }

  const summon = (): void => {
    const n = ++seq.current
    // 唤起这一刻正文里选中的字（之后用户在窗口里打字，正文的选区不再是「当前位置」）
    const mark = routeId ? positionMark(routeId, pageView(routeId)) : ''
    setWin({ pageId: null, error: null })
    assistantApi.page().then(
      (pageId) => {
        if (seq.current !== n) return
        rememberAssistantPage(pageId)
        // 当前页就是 Genet 页、只是唤起时还认不出来（事件流首帧没到）：这页已经是完整的对话，不再挂第二个
        // （同一页两个对话并存，收起时取字会取走页面输入框里的字，输入框桥的登记也会被浮窗卸载时摘掉）
        if (pageId === routeRef.current) {
          close()
          focusComposer(pageId)
          return
        }
        // 每次打开只放一次：挂载前交给输入框当初始内容，用户删了不会再加回来
        carryToChat(pageId, pageId === routeId ? '' : mark)
        setWin({ pageId, error: null })
      },
      (err: unknown) => {
        if (seq.current === n) setWin({ pageId: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  const expand = (): void => {
    const pageId = win?.pageId
    if (!pageId) return
    carryToChat(pageId, takeComposerText(pageId))
    close()
    navigate('/ai')
  }

  // 走到 Genet 对话本身（AI 页的 Genet 分页、Genet 页）：浮窗收起，两个对话框不争同一页的输入框。
  // 没发出去的字先带过去：窗口开着时下面照常渲染它，这一刻浮窗的输入框还在；layout effect 在绘制前就收起，不闪一帧
  const openPageId = win?.pageId ?? null
  useLayoutEffect(() => {
    if (!onAssistant) return
    if (openPageId) carryToChat(openPageId, takeComposerText(openPageId))
    close()
  }, [onAssistant])

  // 窗口一出来就把焦点放进来（Esc 才关得掉）；对话建好后再放进输入框（输入框要等编辑器的 schema，晚几帧才有）
  const winRef = useRef<HTMLElement>(null)
  const shown = win !== null
  useEffect(() => {
    if (shown) winRef.current?.focus({ preventScroll: true })
  }, [shown])
  useEffect(() => {
    if (!openPageId) return
    let frames = 0
    let raf = 0
    const tick = (): void => {
      if (focusComposer(openPageId)) return
      if (++frames < FOCUS_FRAMES) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [openPageId])

  if (!win) {
    if (onAssistant) return null
    return (
      <button
        type="button"
        className="assistant-fab"
        style={style}
        data-tip={C.openTip}
        aria-label={C.open}
        // 不抢正文的焦点：唤起时要读它的选区
        onMouseDown={(e) => e.preventDefault()}
        onClick={summon}
      >
        <Icon name="genet" size={20} />
      </button>
    )
  }
  return (
    <section
      ref={winRef}
      className="assistant-window"
      style={style}
      tabIndex={-1}
      role="dialog"
      aria-label={C.title}
      onKeyDown={(e) => {
        // 菜单 / 提示列表自己处理过的 Esc（已 preventDefault）不关窗口
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        close()
      }}
    >
      <header className="assistant-head">
        <Icon name="genet" size={16} />
        <span className="assistant-title">
          {C.title}
          {here && (
            <span className={`assistant-focus${focus ? '' : ' is-off'}`}>
              <button
                type="button"
                className="assistant-focus-eye"
                // 不抢输入框的焦点：点完接着打字
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleHere}
                data-tip={focus ? C.hidePage : C.showPage}
                aria-label={focus ? C.hidePage : C.showPage}
                aria-pressed={!focus}
              >
                <Icon name={focus ? 'eye' : 'eye-off'} size={13} />
              </button>
              <span className="assistant-focus-text">{here.title}</span>
            </span>
          )}
        </span>
        <button type="button" className="assistant-head-btn" onClick={expand} disabled={!win.pageId} data-tip={C.expand} aria-label={C.expand}>
          <Icon name="external" size={15} />
        </button>
        <button type="button" className="assistant-head-btn" onClick={close} data-tip={C.close} aria-label={C.close}>
          <Icon name="x" size={15} />
        </button>
      </header>
      {win.pageId ? (
        <AssistantChat key={win.pageId} pageId={win.pageId} pages={pages} username={username} onPagesChanged={onPagesChanged} focus={focus} />
      ) : (
        <div className="assistant-status">
          {win.error ? (
            <>
              <span>{C.loadFailed(win.error)}</span>
              <button type="button" className="assistant-guide-btn" onClick={summon}>
                {C.retry}
              </button>
            </>
          ) : (
            C.loading
          )}
        </div>
      )}
    </section>
  )
}
