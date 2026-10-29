import { useEffect, useState, type FormEvent } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { errMessage } from './labels'
import { previewApi, previewLabel, type PreviewItem } from './preview-api'
import { usePagePreviews } from './preview-state'
import PreviewRow from './PreviewRow'

const C = COPY.project.preview

type Viewing = { id: string; url: string; label: string; nonce: number }

/* ---------- 预览分页：共享本机的开发服务器端口 + 在面板里看 ----------
 * 流量走 connector 的 WSS（中心只转发）；预览在独立的预览源里（与 Ramet 不同源），iframe 的页面脚本碰不到 Ramet 的登录态。
 * 出现条件同文件 / 终端：machine 范围的使用权。共享的预览对本页所有读者可见（没有 machine 授权的人从顶栏的「预览」按钮进）。
 * 同一个浏览器同时只能看一个预览（预览会话 cookie 同名，后开的替换先开的）。 */
export default function PreviewTab({
  pageId,
  agent,
  machine,
  enabled,
  supported,
  active,
}: {
  pageId: string
  agent: string
  /** 机器名 */
  machine: string
  /** 面板头取到了 = 机器在线、connector 够新、授权有效 */
  enabled: boolean
  /** connector 声明了 preview 能力 */
  supported: boolean
  /** 这个分页此刻显示着（没看过不取列表） */
  active: boolean
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (active) setShown(true)
  }, [active])
  const { data, error, reload } = usePagePreviews(pageId, shown)
  const [port, setPort] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Viewing | null>(null)
  const usable = enabled && supported

  // 正在看的预览被停掉了（别人停的 / 授权收回）：关掉小窗
  useEffect(() => {
    if (viewing && data && !data.previews.some((p) => p.id === viewing.id)) setViewing(null)
  }, [data, viewing])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setProblem(C.badPort)
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await previewApi.share(pageId, agent, n, path.trim())
      setPort('')
      reload()
    } catch (err) {
      setProblem(C.shareFailed(errMessage(err)))
    } finally {
      setBusy(false)
    }
  }

  async function view(p: PreviewItem): Promise<void> {
    setProblem(null)
    try {
      const { url } = await previewApi.ticket(pageId, p.id)
      setViewing({ id: p.id, url, label: previewLabel(p), nonce: Date.now() })
    } catch (err) {
      setProblem(C.openFailed(errMessage(err)))
    }
  }

  async function reloadView(): Promise<void> {
    if (!viewing) return
    try {
      // 会话还在，重新取一张票据只是为了让 iframe 重新走一遍进入流程
      const { url } = await previewApi.ticket(pageId, viewing.id)
      setViewing({ ...viewing, url, nonce: Date.now() })
    } catch (err) {
      setProblem(C.openFailed(errMessage(err)))
    }
  }

  async function stop(p: PreviewItem): Promise<void> {
    setProblem(null)
    try {
      await previewApi.stop(pageId, p.id)
      if (viewing?.id === p.id) setViewing(null)
    } catch (err) {
      setProblem(C.stopFailed(errMessage(err)))
    } finally {
      reload()
    }
  }

  return (
    <div className="preview-tab">
      {!supported && <p className="project-note is-warn">{C.unsupported}</p>}
      {data && !data.enabled && <p className="project-note is-warn">{C.disabled}</p>}
      {usable && data?.enabled !== false && (
        <form className="preview-form" onSubmit={(e) => void submit(e)}>
          <h4 className="project-round-title">{C.title}</h4>
          <p className="project-fineprint">{C.lead(machine || COPY.project.connecting)}</p>
          <div className="preview-fields">
            <label>
              <span>{C.portLabel}</span>
              <input
                type="number"
                inputMode="numeric"
                min={1024}
                max={65535}
                value={port}
                placeholder={C.portPlaceholder}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label>
              <span>{C.pathLabel}</span>
              <input type="text" value={path} placeholder={C.pathPlaceholder} onChange={(e) => setPath(e.target.value)} />
            </label>
            <button type="submit" className="project-chip-btn" disabled={busy || !port}>
              {busy ? C.sharing : C.share}
            </button>
          </div>
          <p className="project-fineprint">{C.note}</p>
        </form>
      )}
      {problem && <p className="project-note is-error">{problem}</p>}
      {error && <p className="project-note is-error">{COPY.project.loadFailed(error)}</p>}
      {!data && !error && shown && <p className="project-note">{C.loading}</p>}
      {data && data.enabled && (
        <section className="preview-list-wrap" aria-label={C.listTitle}>
          {data.previews.length === 0 ? (
            <p className="project-note">{C.empty}</p>
          ) : (
            <ul className="preview-list">
              {data.previews.map((p) => (
                <PreviewRow key={p.id} item={p} on={viewing?.id === p.id} onView={() => void view(p)} onStop={() => void stop(p)} pageId={pageId} onError={(m) => setProblem(C.openFailed(m))} />
              ))}
            </ul>
          )}
        </section>
      )}
      {viewing && (
        <section className="preview-view" aria-label={C.frameTitle}>
          <header>
            <span className="preview-view-title">{C.viewing(viewing.label)}</span>
            <button type="button" className="project-icon-btn" title={C.reload} aria-label={C.reload} onClick={() => void reloadView()}>
              <Icon name="refresh" size={14} />
            </button>
            <button type="button" className="project-icon-btn" title={C.closeView} aria-label={C.closeView} onClick={() => setViewing(null)}>
              <Icon name="x" size={14} />
            </button>
          </header>
          {/* 预览源与 Ramet 不同源，allow-same-origin 只是让它和它自己同源（它的 localStorage / fetch 才能用）；不给 top-navigation 等多余权限 */}
          <iframe
            key={viewing.nonce}
            title={C.frameTitle}
            src={viewing.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
          <p className="project-fineprint">{C.sameBrowser}</p>
        </section>
      )}
    </div>
  )
}
