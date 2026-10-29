import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, SPACE_ROLE_LABELS, type InvitePreview } from './api'

/** 邀请落地页（路由 /join/:token，挂在登录后的 Routes 里）：
 * 展示谁邀请你加入哪个空间、什么角色，点接受才入空间；链接失效 / 已撤销时预览 404，显示「邀请已失效」；
 * 未登录打开时预览 401，现有 handler 接管回登录页，token 已由 Root 记入 sessionStorage，登录后跳回本页 */
export default function Join({ onChanged }: { onChanged: () => void }) {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setPreview(null)
    setInvalid(false)
    api
      .invitePreview(token)
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
  }, [token])

  async function accept() {
    if (!token || accepting) return
    setAccepting(true)
    setError(null)
    try {
      const { space_id } = await api.acceptInvite(token)
      onChanged()
      navigate(`/?space=${space_id}`)
    } catch (err) {
      console.error(err)
      setError('接受失败，请刷新重试')
      setAccepting(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card join-card">
        <h1 className="login-logo">Ramet</h1>
        {invalid && (
          <>
            <p className="join-line">邀请已失效或已被撤销</p>
            <button className="login-submit" onClick={() => navigate('/')}>
              返回首页
            </button>
          </>
        )}
        {!invalid && !preview && <p className="login-subtitle">加载中…</p>}
        {preview && (
          <>
            <p className="join-line">
              <b>{preview.created_by_username}</b> 邀请你加入「<b>{preview.space_name}</b>」
              <br />
              角色：{SPACE_ROLE_LABELS[preview.role]}
            </p>
            {error && <div className="login-error">{error}</div>}
            <button className="login-submit" disabled={accepting} onClick={() => void accept()}>
              {accepting ? '加入中…' : '接受邀请'}
            </button>
            <button type="button" className="login-secondary" onClick={() => navigate('/')}>
              暂不加入
            </button>
          </>
        )}
      </div>
    </div>
  )
}
