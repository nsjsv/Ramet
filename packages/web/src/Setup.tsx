import { useState, type FormEvent } from 'react'
import { api, type User } from './api'

/** 首次部署（users 空表）的初始化页：建 admin + 收编存量页面，成功即登录进主应用 */
export default function Setup({
  onSuccess,
  onUnavailable,
}: {
  onSuccess: (user: User) => void
  onUnavailable: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const valid = username.trim().length > 0 && password.length >= 8 && password === confirm

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    // 与后端同一套规则：用户名非空 + 密码 ≥8 位；确认密码一致只在前端校验
    if (password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // 后端 201 已发会话 cookie，直接 setUser 进主应用，无需再登录
      const user = await api.setupAdmin(username.trim(), password)
      onSuccess(user)
    } catch (err) {
      // request() 只会对 setup 接口抛网络 TypeError 或 4xx Error；403 = 系统已被抢先初始化过（并发/另一标签页）
      if (err instanceof Error && err.message === 'setup already completed') {
        onUnavailable() // 初始化已不再需要，翻回登录页，不留打不通的初始化页
        return
      }
      setError(
        err instanceof TypeError
          ? '无法连接服务器'
          : '初始化失败，请检查输入后重试',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1 className="login-logo">Ramet</h1>
        <p className="login-subtitle">首次使用，创建管理员账号</p>
        <label className="login-field">
          <span>用户名</span>
          <input
            className="login-input"
            autoFocus
            autoComplete="username"
            maxLength={50}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>密码（至少 8 位）</span>
          <input
            className="login-input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>确认密码</span>
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
          {submitting ? '创建中…' : '创建管理员'}
        </button>
      </form>
    </div>
  )
}
