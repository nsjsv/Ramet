import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'
import AgentCommands from './AgentCommands'
import TermPane from './TermPane'
import { errMessage } from './labels'
import { terminalApi, type TermInfo, type TermList } from './terminal-api'

const C = COPY.project.terminal

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; list: TermList }

/* ---------- 终端分页：多标签的终端 + 下面只读的「agent 跑的命令」----------
 * 终端是 agent 所在机器上的 shell（pty 在 connector 上，这里只是屏幕）。出现条件和文件 / 改动一样：machine 范围的使用权；
 * 打开 = 一次明确的点击（别人的机器上每次打开都留痕给主人，所以不自动开）。标签 = 我在这台机器上开着的终端，
 * 刷新页面后从服务端列表恢复，每个标签挂载时按 seq 回放最近的输出。机器主人额外看到「这台机器上的其他终端」：只能关，不能输入。 */
export default function TerminalTab({
  pageId,
  agent,
  agentLabel,
  machine,
  owner,
  active,
  enabled,
  supported,
  tick,
  runIds,
}: {
  pageId: string
  agent: string
  agentLabel: string
  /** 机器名 / 主人用户名（面板头取到的；还没取到 = 空） */
  machine: string
  owner: string | null
  /** 这个分页此刻显示着 */
  active: boolean
  /** 面板头取到了 = 机器在线、connector 够新、授权有效 */
  enabled: boolean
  /** connector 声明了 terminal 能力（node-pty 装上了） */
  supported: boolean
  /** 点刷新 / 一轮结束：重拉终端列表 */
  tick: number
  /** 本页最近几轮的过程页 id：下面「agent 跑的命令」列它们的命令 */
  runIds: readonly string[]
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const usable = enabled && supported

  const load = useCallback(() => {
    let cancelled = false
    terminalApi.list(pageId, agent).then(
      (list) => {
        if (cancelled) return
        setState({ status: 'ok', list })
        setSelected((cur) => (cur && list.ptys.some((p) => p.ptyId === cur && p.mine) ? cur : (list.ptys.find((p) => p.mine)?.ptyId ?? null)))
      },
      (err: unknown) => !cancelled && setState({ status: 'error', message: errMessage(err) }),
    )
    return () => {
      cancelled = true
    }
  }, [pageId, agent])

  // 第一次显示时才取（没看过终端分页不请求）；之后只在刷新信号来时重取
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (active) setShown(true)
  }, [active])
  useEffect(() => (usable && shown ? load() : undefined), [usable, shown, tick, load])

  async function openOne(): Promise<void> {
    setOpening(true)
    setProblem(null)
    try {
      // 先给个常规尺寸；终端挂载后 fit 到真实尺寸再同步给 pty
      const { pty } = await terminalApi.open(pageId, agent, 100, 28)
      setState((s) => (s.status === 'ok' ? { status: 'ok', list: { ...s.list, ptys: [...s.list.ptys, pty] } } : s))
      setSelected(pty.ptyId)
    } catch (err) {
      setProblem(C.openFailed(errMessage(err)))
    } finally {
      setOpening(false)
    }
  }

  async function closeOne(ptyId: string): Promise<void> {
    setProblem(null)
    try {
      await terminalApi.close(pageId, agent, ptyId)
    } catch (err) {
      // 404 = 已经不在了（被主人关了 / 闲置回收），当作关成功
      if (!(err instanceof ApiError && err.status === 404)) {
        setProblem(errMessage(err))
        return
      }
    }
    load()
  }

  const list = state.status === 'ok' ? state.list : null
  const mine = list?.ptys.filter((p) => p.mine) ?? []
  const others = list?.isOwner ? list.ptys.filter((p) => !p.mine) : []
  // 我不是这台机器的主人：终端是他授权的，要让用户读懂这意味着什么
  const guestOf = list && !list.isOwner ? owner : null

  return (
    <div className="term-tab">
      {!supported && <p className="project-note is-warn">{C.unsupported}</p>}
      {usable && (
        <div className="term-top">
          <div className="term-tabs" role="tablist" aria-label={COPY.project.tabs.terminal}>
            {mine.map((p, i) => (
              <TermTabButton
                key={p.ptyId}
                info={p}
                index={i + 1}
                on={p.ptyId === selected}
                onSelect={() => setSelected(p.ptyId)}
                onClose={() => void closeOne(p.ptyId)}
              />
            ))}
            <button type="button" className="project-icon-btn term-new" title={C.newTitle} aria-label={C.newTitle} disabled={opening} onClick={() => void openOne()}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {problem && <p className="project-note is-error">{problem}</p>}
          {state.status === 'error' && <p className="project-note is-error">{C.loadFailed(state.message)}</p>}
          {state.status === 'loading' && <p className="project-note">{COPY.project.connecting}</p>}
          {state.status === 'ok' && mine.length === 0 && (
            <div className="term-empty">
              <p className="project-note">
                {C.empty} {C.lead(machine || COPY.project.connecting)} {guestOf ? C.guestNote(guestOf) : C.ownerNote}
              </p>
              <button type="button" className="project-chip-btn" disabled={opening} onClick={() => void openOne()}>
                {opening ? C.opening : C.new}
              </button>
            </div>
          )}
        </div>
      )}
      {usable && mine.length > 0 && (
        <div className="term-screens">
          {mine.map((p) => (
            <TermPane key={p.ptyId} pageId={pageId} agent={agent} info={p} visible={active && p.ptyId === selected} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <section className="term-others" aria-label={C.others}>
          <h4 className="project-round-title">{C.others}</h4>
          <p className="project-fineprint">{C.othersNote}</p>
          <ul>
            {others.map((p) => (
              <li key={p.ptyId}>
                <span className="term-other-who">{C.othersOwner(p.owner || '?')}</span>
                <span className="term-other-root" title={p.root}><bdi>{p.root}</bdi></span>
                <span className="term-other-state">{p.alive ? C.alive : C.exited(p.exitCode)}</span>
                <button type="button" className="project-chip-btn" onClick={() => void closeOne(p.ptyId)}>
                  {C.closeOther}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="term-agent" aria-label={C.agentCommands}>
        <h4 className="project-round-title">{C.agentCommands}</h4>
        <AgentCommands pageId={pageId} agent={agent} agentLabel={agentLabel} runIds={runIds} />
      </section>
    </div>
  )
}

function TermTabButton({
  info,
  index,
  on,
  onSelect,
  onClose,
}: {
  info: TermInfo
  index: number
  on: boolean
  onSelect: () => void
  onClose: () => void
}) {
  return (
    <span className={'term-tab-btn' + (on ? ' is-on' : '') + (info.alive ? '' : ' is-exited')}>
      <button type="button" role="tab" aria-selected={on} title={info.root} onClick={onSelect}>
        {C.tabName(index)}
        {info.alive ? '' : C.tabExited}
      </button>
      <button type="button" className="term-tab-close" title={C.closeTab} aria-label={`${C.closeTab}：${C.tabName(index)}`} onClick={onClose}>
        <Icon name="x" size={12} />
      </button>
    </span>
  )
}
