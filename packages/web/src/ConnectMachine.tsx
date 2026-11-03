import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, type ConnectPreview, type Space } from './api'
import { COPY } from './copy'
import { Icon } from './icons'

type Done = { kind: 'approved' | 'pending'; space: string } | { kind: 'rejected' }

/** 成功页停留几秒再关：直接关掉会让人以为没点上 / 出错了 */
const CLOSE_AFTER_SEC = 4

/** 机器接入确认页（路由 /connect/:code，登录后由 Root 单独渲染，不进主应用外壳；connector start 在终端打印这条链接）：
 * - 展示机器自报的信息与校验码，选空间（默认上次打开的空间），确认后 token 经机器自己的连接下发，浏览器不经手
 * - 链接一次性：确认 / 拒绝 / 过期 / 机器上的命令退出都会作废，之后预览 404，显示「链接已失效」
 * - 确认成功后先停在成功页倒数几秒再尝试关掉标签页；浏览器不让关（这页经登录跳转来的，历史不止一条）就提示手动关
 * - 未登录打开时预览 401，回登录页；路径已由 Root 记入 sessionStorage，登录后跳回本页 */
export default function ConnectMachine({ selectedSpaceId }: { selectedSpaceId: string | null }) {
  const C = COPY.connect
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<ConnectPreview | null>(null)
  const [spaces, setSpaces] = useState<Space[] | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const [closeIn, setCloseIn] = useState(CLOSE_AFTER_SEC)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    setPreview(null)
    setInvalid(false)
    api
      .connectPreview(code)
      .then((p) => {
        if (!cancelled) setPreview(p)
      })
      .catch((err: unknown) => {
        // 401 时 Root 已切去登录页（本组件随即卸载）；其余按失效处理
        if (!cancelled) {
          console.error(err)
          setInvalid(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [code])

  useEffect(() => {
    let cancelled = false
    api
      .listSpaces()
      .then((list) => {
        if (!cancelled) setSpaces(list)
      })
      .catch((err: unknown) => {
        console.error(err)
        if (!cancelled) setSpaces([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 成功后倒数；到 0 调 window.close()，能关的话页面就没了，关不掉就停在 0 显示手动关闭的提示
  const succeeded = done !== null && done.kind !== 'rejected'
  useEffect(() => {
    if (!succeeded) return
    if (closeIn <= 0) {
      window.close()
      return
    }
    const timer = window.setTimeout(() => setCloseIn((n) => n - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [succeeded, closeIn])

  // 只读成员不能接入机器：只列我是所有者 / 成员的空间
  const eligible = useMemo(() => (spaces ?? []).filter((s) => s.my_role === 'owner' || s.my_role === 'member'), [spaces])
  // 默认选中上次打开的空间；它不能接入时退到个人空间 / 第一个能接入的。用户手动选过就不再改
  useEffect(() => {
    setSpaceId((cur) => {
      if (cur && eligible.some((s) => s.id === cur)) return cur
      const pick = eligible.find((s) => s.id === selectedSpaceId) ?? eligible.find((s) => s.is_personal) ?? eligible[0]
      return pick?.id ?? null
    })
  }, [eligible, selectedSpaceId])
  const space = eligible.find((s) => s.id === spaceId) ?? null

  async function confirm() {
    if (!code || !space || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.confirmConnect(code, space.id)
      setDone({ kind: res.status, space: space.name })
    } catch (err) {
      // 404 说明链接在这期间作废了（机器上的命令退出 / 过期 / 已被确认）
      if (err instanceof ApiError && err.status === 404 && err.code === 'pair link not found') setInvalid(true)
      else setError(err instanceof ApiError && err.status === 403 ? err.message : C.failed)
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.rejectConnect(code)
      setDone({ kind: 'rejected' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setInvalid(true)
      else setError(C.rejectFailed)
    } finally {
      setBusy(false)
    }
  }

  const home = (
    <button className="login-submit" onClick={() => navigate('/')}>
      {C.home}
    </button>
  )

  return (
    <div className="login-page">
      <div className="login-card join-card connect-card">
        <h1 className="login-logo">{C.title}</h1>
        {done && done.kind !== 'rejected' ? (
          <div className="connect-done">
            <span className="connect-done-mark">
              <Icon name="check" size={28} />
            </span>
            <p className="connect-done-title">{done.kind === 'approved' ? C.approvedTitle : C.pendingTitle}</p>
            <p className="join-line">{done.kind === 'approved' ? C.approved(done.space) : C.pending(done.space)}</p>
            <p className="connect-warn">{closeIn > 0 ? C.closing(closeIn) : C.closeManually}</p>
          </div>
        ) : done ? (
          <>
            <p className="join-line">{C.rejected}</p>
            {home}
          </>
        ) : invalid ? (
          <>
            <p className="join-line">{C.invalid}</p>
            {home}
          </>
        ) : !preview || spaces === null ? (
          <p className="login-subtitle">{C.loading}</p>
        ) : (
          <>
            <p className="login-subtitle">{C.lead}</p>
            <dl className="connect-facts">
              <dt>{C.code}</dt>
              <dd className="connect-code">{preview.code}</dd>
              <dt>{C.name}</dt>
              <dd>{preview.name}</dd>
              {preview.defaultCwd && (
                <>
                  <dt>{C.dir}</dt>
                  <dd className="connect-mono">{preview.defaultCwd}</dd>
                </>
              )}
              <dt>{C.agents}</dt>
              <dd>{preview.agents.length ? preview.agents.map((a) => a.label).join('、') : C.noAgents}</dd>
              <dt>{C.expires}</dt>
              <dd>{new Date(preview.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</dd>
            </dl>
            <p className="connect-warn">{C.warn}</p>
            {eligible.length === 0 ? (
              <p className="login-error">{C.noSpace}</p>
            ) : (
              <label className="login-field">
                {C.space}
                <select className="login-input" value={spaceId ?? ''} onChange={(e) => setSpaceId(e.target.value)}>
                  {eligible.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {space?.my_role === 'member' && <p className="connect-warn">{C.memberNote}</p>}
            {error && <div className="login-error">{error}</div>}
            <button className="login-submit" disabled={busy || !space} onClick={() => void confirm()}>
              {busy ? C.confirming : C.confirm}
            </button>
            <button type="button" className="login-secondary" disabled={busy} onClick={() => void reject()}>
              {C.reject}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
