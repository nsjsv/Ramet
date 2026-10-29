import { useState, type FormEvent } from 'react'
import { api } from './api'
import { PASSWORD_MIN, passwordError } from './password'

/** 强制改密页：临时密码建的号 must_change_password=true，设好新密码前主应用不可达（flag 来自服务端，刷新也绕不过） */
export default function ChangePassword({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const valid = passwordError(password, confirm) === null

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    const invalid = passwordError(password, confirm)
    if (invalid) {
      setError(invalid)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await api.changePassword(password)
      onDone()
    } catch (err) {
      setError(err instanceof TypeError ? '无法连接服务器' : '设置失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1 className="login-logo">Ramet</h1>
        <p className="login-subtitle">首次登录，请设置新密码</p>
        <label className="login-field">
          <span>新密码（至少 {PASSWORD_MIN} 位）</span>
          <input
            className="login-input"
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>确认新密码</span>
          <input
            className="login-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" type="submit" disabled={submitting || !valid}>
          {submitting ? '提交中…' : '设置新密码'}
        </button>
        <button type="button" className="login-secondary" onClick={onLogout}>
          返回登录
        </button>
      </form>
    </div>
  )
}
