import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type User } from './api'

export default function Login({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const user = await api.login(username.trim(), password)
      onSuccess(user)
      navigate('/', { replace: true })
    } catch (err) {
      // request() 只会对登录接口抛网络 TypeError 或 4xx Error；4xx 即凭据不对
      setError(err instanceof TypeError ? '无法连接服务器' : '用户名或密码错误')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1 className="login-logo">Ramet</h1>
        <label className="login-field">
          <span>用户名</span>
          <input
            className="login-input"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>密码</span>
          <input
            className="login-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" type="submit" disabled={submitting || !username || !password}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
