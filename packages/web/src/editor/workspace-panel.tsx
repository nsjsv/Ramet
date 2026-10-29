import { useEffect, useRef, useState } from 'react'
import { api, type DirListing } from '../api'
import { COPY } from '../copy'
import { Icon } from '../icons'

/* ---------- 工作目录面板（挂在 ChipMenu 里）----------
 * 列的是执行端的真实目录（本机 agent 是中心机器，connector agent 是 connector 机器），数据来自
 * GET /agent-dirs。前端不拼路径：分隔符与路径语义只有执行端权威（connector 可能跑在 Windows）。
 * 只管浏览与挑目录：落库和预备会话由调用方 onApply 决定（本组件只负责把失败就地显示出来）。
 * 开合由外面的 ChipMenu 管（Esc / 点外面），本组件只在「用这个目录」成功后请求关闭。 */

interface Props {
  pageId: string
  agent: string
  /** 生效工作目录，作为起始位置（还没问过是空串，服务端按执行端默认回一个） */
  cwd: string
  /** 提交：调用方落库并按新目录预备会话；抛错则不关面板、就地显示原因 */
  onApply: (cwd: string) => Promise<void>
  onClose: () => void
}

const T = COPY.cwd

export function WorkspacePanel({ pageId, agent, cwd, onApply, onClose }: Props) {
  const [path, setPath] = useState(cwd)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 请求序号：连点目录时慢响应不能盖住后一次的结果
  const seq = useRef(0)

  function load(next: string): void {
    const mine = ++seq.current
    setBusy(true)
    setError(null)
    api
      .listAgentDirs(pageId, next ? { agent, path: next } : { agent })
      .then((l) => {
        if (mine !== seq.current) return
        setListing(l)
        setPath(l.path)
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(err instanceof Error ? err.message : T.listFailed)
      })
      .finally(() => {
        if (mine === seq.current) setBusy(false)
      })
  }

  // 打开即列当前工作目录。换 agent 就是换机器（另一份目录树），由宿主关掉面板，不在这里重列
  useEffect(() => {
    load(cwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function apply(value: string): void {
    setBusy(true)
    setError(null)
    onApply(value)
      .then(onClose)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : T.applyFailed)
        setBusy(false)
      })
  }

  return (
    <>
      <input
        className="ws-path"
        value={path}
        spellCheck={false}
        placeholder={T.path}
        aria-label={T.title}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) load(path.trim())
        }}
      />
      {error && <div className="ws-error">{error}</div>}
      <div className="ws-list">
        {listing?.parent != null && (
          <button type="button" className="ws-row" role="menuitem" onClick={() => load(listing.parent!)}>
            <Icon name="arrow-up" size={14} /> {T.up}
          </button>
        )}
        {listing?.dirs.map((d) => (
          <button key={d.path} type="button" className="ws-row" role="menuitem" title={d.path} onClick={() => load(d.path)}>
            <Icon name="folder" size={14} />
            <span className="ws-name">{d.name}</span>
          </button>
        ))}
        {listing && listing.dirs.length === 0 && <div className="ws-empty">{T.empty}</div>}
        {listing?.truncated && <div className="ws-empty">{T.truncated}</div>}
      </div>
      <div className="ws-acts">
        <button type="button" className="ws-apply" onClick={() => apply(path.trim())} disabled={busy || !path.trim()}>
          {T.apply}
        </button>
        <button type="button" className="btn-agent-option" onClick={() => apply('')} disabled={busy}>
          {T.reset}
        </button>
      </div>
    </>
  )
}
