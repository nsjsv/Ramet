import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from './api'
import { COPY } from './copy'
import { copyText } from './clipboard'
import { Icon } from './icons'

interface Me {
  id: string
  username: string
  role: 'admin' | 'user'
}

/** GET /api/admin/users 的行（后端永不回传 password） */
interface AdminUser {
  id: string
  username: string
  role: 'admin' | 'user'
  created_at: string
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
}

/** 错误响应转提示文案：401/403 一律提示无权限，其余用后端 {error} 或状态码兜底 */
async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) return '无权限：该操作仅 admin 可用'
  let detail = ''
  try {
    const body = (await res.json()) as { error?: string }
    if (typeof body.error === 'string') detail = body.error
  } catch {
    // 无 JSON body，走状态码兜底
  }
  return detail || `请求失败（${res.status}）`
}

function formatTime(raw: string): string {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString()
}

/** api.ts 抛的 Error 已带后端 {error} 文案；非 Error（网络断等）走调用方兜底 */
function apiError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export default function Admin() {
  const navigate = useNavigate()
  const [me, setMe] = useState<Me | null>(null)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 建号/重置接口返回的一次性临时密码（含场景标题）：仅在本次页面停留期展示，关闭/刷新后不再可见
  const [tempPassword, setTempPassword] = useState<{ title: string; password: string } | null>(null)

  const loadUsers = useCallback(async () => {
    try {
      const res = await request('/api/admin/users')
      if (!res.ok) {
        setError(await errorMessage(res))
        return
      }
      setUsers((await res.json()) as AdminUser[])
    } catch {
      setError('网络错误，用户列表加载失败')
    }
  }, [])

  // 自包含取角色：不引外部 context。非 admin（含未登录）一律送回主页。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await request('/api/auth/me')
        const data = res.ok ? ((await res.json()) as Me) : null
        if (cancelled) return
        if (!data || data.role !== 'admin') {
          navigate('/', { replace: true })
          return
        }
        setMe(data)
        void loadUsers()
      } catch {
        if (!cancelled) navigate('/', { replace: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [navigate, loadUsers])

  async function removeUser(user: AdminUser) {
    setError(null)
    // 先问服务端这次删号会转交 / 删除多少（只有数量），确认框里的数字就是实际会发生的
    let impact
    try {
      impact = await api.adminDeleteImpact(user.id)
    } catch (err) {
      setError(apiError(err, COPY.adminUsers.impactFailed))
      return
    }
    if (!window.confirm(COPY.adminUsers.confirmDelete(user.username, impact))) return
    try {
      const res = await request(`/api/admin/users/${user.id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError(await errorMessage(res))
        return
      }
      void loadUsers()
    } catch {
      setError('网络错误，删除失败')
    }
  }

  // 重置密码：服务端生成临时密码，不收手输密码；确认文案明示现有登录全部失效
  async function resetPassword(user: AdminUser) {
    if (!window.confirm(`重置「${user.username}」的密码？将生成临时密码，该用户现有登录全部失效。`)) return
    setError(null)
    try {
      // 请求体为空：契约与建号对齐，不收手输密码
      const res = await request(`/api/admin/users/${user.id}/password`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        setError(await errorMessage(res))
        return
      }
      // password 只在这次响应里出现，与建号共用一次性展示，关闭/刷新后不再可见
      const { password } = (await res.json()) as { password: string }
      setTempPassword({ title: '密码重置成功', password })
    } catch {
      setError('网络错误，重置失败')
    }
  }

  return (
    <div className="admin-page" data-flip>
      <h1 className="admin-title">用户管理</h1>
      <p className="admin-sub">{users === null ? '加载中…' : `共 ${users.length} 个账号`}</p>
      {error && (
        <div className="admin-banner" role="alert">
          <span>{error}</span>
          <button className="admin-banner-close" title="关闭" onClick={() => setError(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {tempPassword && (
        <TempPasswordBanner
          title={tempPassword.title}
          password={tempPassword.password}
          onClose={() => setTempPassword(null)}
        />
      )}
      <CreateUserForm
        onCreated={(password) => {
          setTempPassword({ title: '用户创建成功', password })
          void loadUsers()
        }}
      />
      {users !== null &&
        (users.length === 0 ? (
          <p className="admin-empty">还没有用户</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>创建时间</th>
                <th className="admin-col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td>
                      <span className={'admin-role' + (user.role === 'admin' ? ' is-admin' : '')}>
                        {user.role === 'admin' ? '管理员' : '普通用户'}
                      </span>
                    </td>
                    <td className="admin-time">{formatTime(user.created_at)}</td>
                    <td className="admin-col-actions">
                      <span className="admin-row-actions">
                        <button className="admin-btn" onClick={() => void resetPassword(user)}>
                          重置密码
                        </button>
                        <button
                          className="admin-btn danger"
                          disabled={user.id === me?.id}
                          title={user.id === me?.id ? '不能删除自己' : undefined}
                          onClick={() => void removeUser(user)}
                        >
                          删除
                        </button>
                      </span>
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  )
}

/** 建号/重置成功后的一次性临时密码：带复制按钮，文案提醒立即交接；关闭/刷新后不再可见 */
function TempPasswordBanner({ title, password, onClose }: { title: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (await copyText(password)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
    // 失败：不阻断，用户可手选复制
  }

  return (
    <div className="admin-banner is-temp" role="status">
      <span>
        {title}。临时密码：<code className="admin-temp-code">{password}</code>
        ——仅显示这一次，请立即交给该用户，下次登录时会要求设置新密码。
      </span>
      <span className="admin-banner-actions">
        <button className="admin-btn" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
        <button className="admin-banner-close is-temp" title="关闭" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  )
}

/** 顶部建号表单：用户名 + 角色下拉（默认普通用户）；初始密码由服务端生成，重名 409 给出提示 */
function CreateUserForm({ onCreated }: { onCreated: (tempPassword: string) => void }) {
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const name = username.trim()
    if (!name) {
      setError('请填写用户名')
      return
    }
    if (name.length > 50) {
      setError('用户名最多 50 个字符')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username: name, role }),
      })
      if (res.status === 409) {
        setError('用户名已存在')
        return
      }
      if (!res.ok) {
        setError(await errorMessage(res))
        return
      }
      // password 只在这次响应里出现，交给父组件一次性展示
      const { password } = (await res.json()) as { password: string }
      setUsername('')
      setRole('user')
      onCreated(password)
    } catch {
      setError('网络错误，创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="admin-form" onSubmit={(e) => void submit(e)}>
      <input
        className="admin-field grow"
        placeholder="用户名（最多 50 字符）"
        maxLength={50}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <select
        className="admin-field"
        value={role}
        onChange={(e) => setRole(e.currentTarget.value === 'admin' ? 'admin' : 'user')}
      >
        <option value="user">普通用户</option>
        <option value="admin">管理员</option>
      </select>
      <button className="admin-btn primary" type="submit" disabled={busy}>
        {busy ? '创建中…' : '创建'}
      </button>
      {error && <p className="admin-form-error">{error}</p>}
    </form>
  )
}
