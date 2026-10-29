import { useCallback, useEffect, useLayoutEffect, useState, type PointerEvent, type ReactNode } from 'react'
import { ApiError } from '../api'
import { COPY } from '../copy'
import { agentStateFor, subscribeAgentEvents } from '../editor/agent-bar'
import { Icon } from '../icons'
import ChangesTab from './ChangesTab'
import FilesTab from './FilesTab'
import PreviewTab from './PreviewTab'
import QuickOpen from './QuickOpen'
import RoundTab from './RoundTab'
import TerminalTab from './TerminalTab'
import { errMessage } from './labels'
import { inTerminal, isQuickOpenKey, PROJECT_TOGGLE_LABEL } from './project-keys'
import { projectApi, type ProjectInfo, type StatusResult } from './project-api'
import { PROJECT_TABS, onQuickOpenRequest, setProjectOpen, setProjectTab, setProjectWidth, useProjectShell, type ProjectTab } from './project-state'

const C = COPY.project

/* ---------- 项目面板本体（按需加载）----------
 * 外壳（ProjectDock.tsx）只管出现条件与 ⌘E；面板第一次打开才下载这里：面板头、五个分页、找文件。 */

/** error 带 HTTP 状态：409 是机器的状态（离线 / connector 太旧，横幅用提示色），其余是真出错 */
type InfoState = { status: 'loading' } | { status: 'error'; message: string; http: number } | { status: 'ok'; info: ProjectInfo }

export default function ProjectPanel({
  pageId,
  agent,
  label,
  canWrite,
  runIds,
}: {
  pageId: string
  agent: string
  label: string
  canWrite: boolean
  runIds: readonly string[]
}) {
  const { tab, width } = useProjectShell()
  const [info, setInfo] = useState<InfoState>({ status: 'loading' })
  const [branch, setBranch] = useState<Pick<StatusResult, 'branch' | 'detached' | 'ahead' | 'behind'> | null>(null)
  const [tick, setTick] = useState(0)
  // 随手 AI 写过文件的次数：只让改动分页刷新（文件查看器自己已经拿到了新内容，不必再读一遍，主人的审计里也不该多一条读文件）
  const [writes, setWrites] = useState(0)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [quick, setQuick] = useState(false)
  const [seen, setSeen] = useState<ReadonlySet<ProjectTab>>(() => new Set([tab]))

  // 宽度走 CSS 变量（拖动期间直接写，不让整个面板每帧重渲）
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--project-w', `${width}px`)
  }, [width])

  // 面板头：打开时取一次（取一次就是一条使用记录，别人的机器上每次打开面板都会留痕给主人看），之后分支由改动分页顺带更新；
  // 机器离线 / connector 太旧 / 取失败时，点刷新会再取一次
  const loadInfo = useCallback(() => {
    let cancelled = false
    projectApi.info(pageId, agent).then(
      (data) => !cancelled && setInfo({ status: 'ok', info: data }),
      (err: unknown) =>
        !cancelled && setInfo({ status: 'error', message: errMessage(err), http: err instanceof ApiError ? err.status : 0 }),
    )
    return () => {
      cancelled = true
    }
  }, [pageId, agent])
  useEffect(() => loadInfo(), [loadInfo])

  // 本页的一轮结束了：agent 可能改了文件，给可见的分页一个刷新信号
  useEffect(() => {
    let prev = agentStateFor(pageId).status
    return subscribeAgentEvents(pageId, (s) => {
      if (prev === 'running' && s.status !== 'running') setTick((t) => t + 1)
      prev = s.status
    })
  }, [pageId])

  // ⌘P 找文件（面板开着才接管，盖掉浏览器的「打印」）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (inTerminal(e)) return
      if (!isQuickOpenKey(e)) return
      e.preventDefault()
      setQuick(true)
    }
    window.addEventListener('keydown', onKey)
    // 命令面板的「找文件」
    const off = onQuickOpenRequest(() => setQuick(true))
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [])

  // 看过的分页一直挂着（切走只是隐藏，树的展开态、看到一半的文件都还在），没看过的不挂也不请求
  useEffect(() => setSeen((s) => (s.has(tab) ? s : new Set(s).add(tab))), [tab])
  const show = setProjectTab

  // 面板头取到了 = 机器在线、connector 够新、授权有效（离线 / 太旧 / 没授权服务端都是 409 / 403）
  const ready = info.status === 'ok'
  const refresh = (): void => {
    setTick((t) => t + 1)
    if (!ready) loadInfo()
  }

  function startResize(e: PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: globalThis.PointerEvent): void => {
      document.documentElement.style.setProperty('--project-w', `${Math.min(760, Math.max(320, startW + startX - ev.clientX))}px`)
    }
    const up = (ev: globalThis.PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setProjectWidth(startW + startX - ev.clientX, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const tabBody = (id: ProjectTab, body: ReactNode) =>
    seen.has(id) ? (
      <div className="project-body" role="tabpanel" hidden={tab !== id} data-tab={id}>
        {body}
      </div>
    ) : null

  return (
    <aside className="project-panel" aria-label={COPY.project.toggle}>
      <div className="project-resizer" role="separator" aria-orientation="vertical" aria-label={C.resize} onPointerDown={startResize} />
      <Head info={info} label={label} branch={branch} onRefresh={refresh} />
      <Banner info={info} />
      <div className="project-tabs" role="tablist" aria-label={C.tabsLabel}>
        {PROJECT_TABS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => show(id)}>
            {C.tabs[id]}
          </button>
        ))}
      </div>
      {tabBody('round', <RoundTab pageId={pageId} canStop={canWrite} />)}
      {/* 机器不可用时（离线 / 太旧 / 没取到）文件与改动不挂：横幅已经说明了原因，别在下面留一个永远转圈的树 */}
      {tabBody(
        'files',
        !ready && info.status !== 'loading' ? null : <FilesTab
          pageId={pageId}
          agent={agent}
          active={tab === 'files'}
          enabled={ready}
          tick={tick}
          openPath={openPath}
          onOpen={setOpenPath}
          canWrite={canWrite}
          onWritten={() => setWrites((n) => n + 1)}
        />,
      )}
      {tabBody(
        'changes',
        !ready && info.status !== 'loading' ? null : <ChangesTab
          pageId={pageId}
          agent={agent}
          active={tab === 'changes'}
          enabled={ready}
          tick={tick + writes}
          diffPath={diffPath}
          onDiff={setDiffPath}
          onOpenFile={(path) => {
            setOpenPath(path)
            show('files')
          }}
          onStatus={(s) => setBranch({ branch: s.branch, detached: s.detached, ahead: s.ahead, behind: s.behind })}
        />,
      )}
      {/* 终端：机器不可用时只剩下面只读的「agent 跑的命令」（那是页面事件流里已有的数据，不请求机器） */}
      {tabBody(
        'terminal',
        <TerminalTab
          pageId={pageId}
          agent={agent}
          agentLabel={label.split(' · ').pop() ?? label}
          machine={info.status === 'ok' ? info.info.machine.name : (label.split(' · ')[0] ?? '')}
          owner={info.status === 'ok' ? info.info.machine.owner : null}
          active={tab === 'terminal'}
          enabled={ready}
          supported={info.status !== 'ok' || info.info.caps.includes('terminal')}
          tick={tick}
          runIds={runIds}
        />,
      )}
      {/* 预览：把机器上的开发服务器（127.0.0.1:端口）经 connector 转发过来看；共享的预览对本页所有读者可见 */}
      {tabBody(
        'preview',
        <PreviewTab
          pageId={pageId}
          agent={agent}
          machine={info.status === 'ok' ? info.info.machine.name : (label.split(' · ')[0] ?? '')}
          enabled={ready}
          supported={info.status !== 'ok' || info.info.caps.includes('preview')}
          active={tab === 'preview'}
        />,
      )}
      {quick && ready && (
        <QuickOpen
          pageId={pageId}
          agent={agent}
          onClose={() => setQuick(false)}
          onPick={(path) => {
            setQuick(false)
            setOpenPath(path)
            show('files')
          }}
        />
      )}
    </aside>
  )
}

function Head({
  info,
  label,
  branch,
  onRefresh,
}: {
  info: InfoState
  /** 目录里的 agent 名「机器 · Agent」：面板头还没取到（或取失败）时，机器名从这里来 */
  label: string
  branch: Pick<StatusResult, 'branch' | 'detached' | 'ahead' | 'behind'> | null
  onRefresh: () => void
}) {
  const head = info.status === 'ok' ? info.info : null
  const b = branch ?? (head ? { branch: head.branch, detached: head.detached, ahead: head.ahead, behind: head.behind } : null)
  const branchText = b?.branch ?? (b?.detached ? C.detached : head?.repo ? C.noBranch : '')
  return (
    <header className="project-head">
      <div className="project-head-main">
        <span className={'project-dot' + (head ? ' is-on' : '')} title={head ? C.online : info.status === 'loading' ? C.connecting : C.offline} />
        <span className="project-machine">{head?.machine.name ?? (label.split(' · ')[0] || C.connecting)}</span>
        {branchText && (
          <span className="project-branch" title={branchText}>
            {branchText}
            {b?.ahead ? ` ↑${b.ahead}` : ''}
            {b?.behind ? ` ↓${b.behind}` : ''}
          </span>
        )}
        <span className="project-head-gap" />
        <button type="button" className="project-icon-btn" onClick={onRefresh} title={C.refresh} aria-label={C.refresh}>
          <Icon name="refresh" size={14} />
        </button>
        <button type="button" className="project-icon-btn" onClick={() => setProjectOpen(false)} title={`${C.close}（${PROJECT_TOGGLE_LABEL}）`} aria-label={C.close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {head && head.root && (
        <div className="project-root" title={C.rootTitle(head.root)}>
          <bdi>{head.root}</bdi>
        </div>
      )}
    </header>
  )
}

function Banner({ info }: { info: InfoState }) {
  if (info.status === 'loading') return null
  // 409 = 机器的状态（不在线 / connector 太旧）：提示色，文案是服务端的人话；其余（403 授权没了等）是红色
  if (info.status === 'error') return <p className={'project-banner ' + (info.http === 409 ? 'is-warn' : 'is-error')}>{info.message}</p>
  return info.info.error ? <p className="project-banner is-warn">{C.rootProblem(info.info.error)}</p> : null
}
