import { useEffect, useRef, useState } from 'react'
import type { ITheme, Terminal } from '@xterm/xterm'
import { COPY } from '../copy'
import { diagnosticsEnabled } from '../debug-log'
import { isQuickKey, QUICK_KEY_LABEL } from '../editor/quick-keys'
import { Icon } from '../icons'
import TermAsk from './TermAsk'
import type { TermInfo } from './terminal-api'
import { LatencySamples, spread } from './term-latency'
import { TermSession, type SessionStatus } from './terminal-session'
import { TermTypeAhead } from './typeahead-view'

const C = COPY.project.terminal
const Q = COPY.quick

/** 留给 ⌘J 的终端最近输出（原始字节，含控制序列；发给模型前才剥）：只留尾部，够取最后 30 行 */
const TAIL_KEEP_CHARS = 24_000

/** 终端配色跟着界面令牌（深色自动跟随）；令牌是十六进制色，直接交给 xterm */
function termTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return { background: v('--bg-sunk', '#f7f7f5'), foreground: v('--ink', '#1f1e1c'), cursor: v('--accent', '#2f6fe4') }
}

type Banner = { kind: 'info' | 'warn' | 'error'; text: string } | null

/* ---------- 一个终端：xterm 屏幕 + 一条连接（terminal-session.ts，WebSocket）----------
 * xterm 在这个分页第一次出现时才动态加载（别进首屏包）。挂载 = 新建连接（after = -1）：服务端给屏幕快照，先按快照的尺寸
 * 写入、再调整成这里的尺寸（换台设备打开也不错位，shell 收到新尺寸自行重画），命令写一半走开、回来就是离开时的样子。
 * 老 connector 没有快照，照旧回放最近的输出。断线自动按 seq 续传；卸载 = 断开（终端本身仍在 connector 上，7 天内回来都能接上）。
 * 右上角的连接标签人人可见（传输方式 + 往返延迟）；诊断模式下追加往返与回显的 p50 / p95。
 * 屏幕尺寸跟着容器（fit），变了同步给 pty。不是我的终端不会渲染成这个组件（只能在「其他终端」里关闭）。
 * ⌘J（TermAsk.tsx）在 xterm 的键处理之前拦下，不让它变成终端输入；建议的命令只写进这个终端、由用户确认才执行。 */
export default function TermPane({ pageId, agent, info, visible }: { pageId: string; agent: string; info: TermInfo; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const refit = useRef<() => void>(() => undefined)
  const focus = useRef<() => void>(() => undefined)
  const sendKeys = useRef<(data: string) => void>(() => undefined)
  const tail = useRef('')
  const [ask, setAsk] = useState(false)
  const [status, setStatus] = useState<SessionStatus>('connecting')
  const [banner, setBanner] = useState<Banner>(null)
  /** 往返延迟（浏览器 ↔ 中心 + 中心 ↔ connector）；detail 只在诊断模式下有 */
  const [link, setLink] = useState<{ ms: number; detail: string } | null>(null)

  useEffect(() => {
    let disposed = false
    let cleanup = (): void => undefined
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
      ])
      const el = host.current
      if (disposed || !el) return
      const term: Terminal = new Terminal({
        cursorBlink: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: termTheme(),
        allowProposedApi: true, // 本地回显预测的浮层用 decoration（typeahead-view.ts）
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el)
      const doFit = (): void => {
        // 容器隐藏（分页没显示）时尺寸是 0：fit 会算出 NaN / 1 列，跳过
        if (!el.clientWidth || !el.clientHeight) return
        try {
          fit.fit()
        } catch {
          // 刚挂载、渲染器还没就绪：下一次 resize 再来
        }
      }
      refit.current = doFit
      focus.current = () => term.focus()
      doFit()

      // ⌘J 在 xterm 处理按键之前拦下（三种事件都吞，免得 Ctrl+J 变成换行字符写进 shell）
      term.attachCustomKeyEventHandler((e) => {
        if (!isQuickKey(e)) return true
        if (e.type === 'keydown') {
          e.preventDefault()
          setAsk(true)
        }
        return false
      })

      // 本地回显预测：按键当帧画出来，服务器回显到了再以服务器为准（typeahead.ts）
      const ahead = new TermTypeAhead(term, el)
      const diag = diagnosticsEnabled()
      const rtts = new LatencySamples()
      const session = new TermSession(
        { pageId, agent, ptyId: info.ptyId },
        {
          ready: (_pty, lost, snapshot) => {
            setBanner(null)
            if (snapshot) {
              // 整屏还原：清掉旧内容，按快照的尺寸写入（官方要求，否则折行会错位），写完再调整成容器的尺寸
              ahead.reset()
              term.reset()
              term.resize(snapshot.cols, snapshot.rows)
              tail.current = snapshot.data.slice(-TAIL_KEEP_CHARS)
              ahead.beforeWrite()
              term.write(snapshot.data, () => {
                ahead.afterWrite()
                doFit()
                session.resize(term.cols, term.rows)
              })
              return
            }
            if (lost) term.write(`\x1b[2m${C.lost}\x1b[0m\r\n`)
            session.resize(term.cols, term.rows)
          },
          data: (text) => {
            ahead.beforeWrite()
            term.write(text, () => ahead.afterWrite())
            tail.current = (tail.current + text).slice(-TAIL_KEEP_CHARS)
          },
          exit: (code, reason) => {
            const text = reason === 'exited' ? C.exited(code) : (C.reason[reason] ?? C.exited(code))
            term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`)
            setBanner({ kind: 'info', text })
          },
          failed: (message) => setBanner({ kind: 'error', text: C.streamFailed(message) }),
          status: (s, message) => {
            setStatus(s)
            if (s === 'reconnecting') setBanner({ kind: 'warn', text: message ? `${C.reconnecting}（${message}）` : C.reconnecting })
          },
          inputError: (message) => setBanner({ kind: 'error', text: C.inputFailed(message) }),
          latency: (rttMs, relayMs) => {
            const ms = rttMs + (relayMs ?? 0)
            rtts.add(ms)
            setLink({ ms, detail: diag ? C.linkStats(spread(rtts.values), spread(ahead.echoSamples())) : '' })
          },
        },
      )
      sendKeys.current = (data) => {
        ahead.external()
        session.send(data)
      }
      term.onData((data) => {
        ahead.input(data)
        session.send(data)
      })
      term.onResize(({ cols, rows }) => {
        ahead.reset()
        session.resize(cols, rows)
      })
      term.buffer.onBufferChange(() => ahead.reset())
      session.start()

      const observer = new ResizeObserver(() => doFit())
      observer.observe(el)
      cleanup = () => {
        observer.disconnect()
        ahead.dispose()
        session.dispose()
        term.dispose()
      }
      if (disposed) cleanup()
    })()
    return () => {
      disposed = true
      cleanup()
    }
  }, [pageId, agent, info.ptyId])

  // 切回这个终端：重新量一次尺寸并把光标交给它
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      refit.current()
      focus.current()
    })
    return () => cancelAnimationFrame(id)
  }, [visible])

  // 收起时把光标还给终端；切走这个终端也收起（建议条属于眼前这个终端）
  const closeAsk = (): void => {
    setAsk(false)
    focus.current()
  }
  useEffect(() => {
    if (!visible) setAsk(false)
  }, [visible])

  return (
    <div className="term-pane" hidden={!visible} data-status={status}>
      {banner && <p className={`term-banner is-${banner.kind}`} role="status">{banner.text}</p>}
      <div className="project-term" ref={host} />
      {visible && status !== 'ended' && (
        <span className="term-link" title={C.linkTitle} data-status={status}>
          {status === 'connecting'
            ? C.linkConnecting
            : status === 'reconnecting'
              ? C.linkReconnecting
              : link
                ? C.linkRelay(Math.round(link.ms))
                : C.linkRelayPending}
          {status === 'live' && link?.detail && <span className="term-link-detail">{link.detail}</span>}
        </span>
      )}
      {visible && !ask && (
        <button type="button" className="term-ask-open" title={Q.term.menuTitle} onClick={() => setAsk(true)}>
          <Icon name="sparkle" size={13} />
          <span>{QUICK_KEY_LABEL}</span>
        </button>
      )}
      {visible && ask && (
        <TermAsk shell={info.shell ?? ''} cwd={info.root} getOutput={() => tail.current} send={(data) => sendKeys.current(data)} onClose={closeAsk} />
      )}
    </div>
  )
}
