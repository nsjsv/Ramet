import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type User } from './api'
import { AgentBadgeView } from './agent-marks'
import { Avatar } from './Avatar'
import { COPY } from './copy'
import { refreshAgents, setDefaultAgent, useAgents, useDefaultAgent } from './default-agent'
import { agentBadge } from './editor/ai-block'
import { setEditMode, useEditMode, type EditMode } from './editor/edit-mode'
import { keyCaps, MARKDOWN_RULES, SHORTCUT_GROUPS } from './editor/shortcuts'
import { uploadFile } from './editor/media'
import { Card, Row, Segmented } from './form-kit'
import { Icon } from './icons'
import { PASSWORD_MIN, passwordError } from './password'
import { setDefaultViewMode, useDefaultViewMode } from './view-mode'

// 设置弹窗的个人分页 + 连接器分页。状态来源：默认 Agent = default-agent.ts，编辑方式 = editor/edit-mode.tsx，
// 新页面打开方式 = view-mode.ts（偏好单源，顶栏快捷开关读同一份），密码规则 = password.ts（与强制改密页同一处）。
// 空间分页在 SpaceSettings.tsx。

/** 账户：头像 + 修改密码 + 登出 */
export function AccountPane({
  user,
  onLogout,
  onAvatarChange,
}: {
  user: User
  onLogout: () => void
  onAvatarChange: (avatar: string | null) => void
}) {
  return (
    <>
      <ProfileCard user={user} onAvatarChange={onAvatarChange} />
      <PasswordCard />
      <Card title="登录">
        <Row label="退出登录" desc={`当前账号：${user.username}`}>
          <button className="admin-btn" onClick={onLogout}>
            <Icon name="log-out" size={14} /> 登出
          </button>
        </Row>
      </Card>
    </>
  )
}

/** 头像：上传走通用文件上传（POST /api/files，10MB 上限同附件），再 PUT 设成自己的头像；
 *  显示用服务端的 160px 方图派生（people.ts），原图不裁剪 */
function ProfileCard({ user, onAvatarChange }: { user: User; onAvatarChange: (avatar: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const avatar = user.avatar ?? null

  async function apply(next: () => Promise<string | null>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { avatar: saved } = await api.setAvatar(await next())
      onAvatarChange(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像更新失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="set-profile">
        <Avatar person={{ id: user.id, username: user.username, avatar }} size={52} />
        <div className="set-profile-text">
          <b>{user.username}</b>
          <span>{user.role === 'admin' ? '管理员' : '成员'} · 头像会显示在对话气泡与侧栏</span>
        </div>
        <div className="set-profile-acts">
          <button className="admin-btn" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? '处理中…' : avatar ? '更换头像' : '上传头像'}
          </button>
          {avatar && (
            <button className="admin-btn" disabled={busy} onClick={() => void apply(async () => null)}>
              移除
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // 同一张图再选一次也要触发
            if (!file) return
            if (!file.type.startsWith('image/')) {
              setError('请选择图片文件')
              return
            }
            void apply(async () => (await uploadFile(file)).id)
          }}
        />
      </div>
      {error && <div className="modal-error set-pad">{error}</div>}
    </Card>
  )
}

function PasswordCard() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
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
    setDone(false)
    try {
      await api.changePassword(password)
      setPassword('')
      setConfirm('')
      setDone(true)
    } catch (err) {
      setError(err instanceof TypeError ? '无法连接服务器' : '修改失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card title="修改密码">
      <form className="set-form" onSubmit={(e) => void submit(e)}>
        <label className="set-field">
          <span>新密码（至少 {PASSWORD_MIN} 位）</span>
          <input
            className="admin-field"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="set-field">
          <span>确认新密码</span>
          <input
            className="admin-field"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <div className="set-form-foot">
          {error && <span className="set-form-msg is-error">{error}</span>}
          {done && <span className="set-form-msg is-ok">密码已更新</span>}
          <button className="admin-btn primary" type="submit" disabled={submitting || !valid}>
            {submitting ? '提交中…' : '修改密码'}
          </button>
        </div>
      </form>
    </Card>
  )
}

/** 编辑器偏好：编辑方式（与顶栏 ⋮ 菜单同一状态）+ 新页面默认打开方式 */
export function EditorPane() {
  const mode = useEditMode()
  const chatDefault = useDefaultViewMode()
  const C = COPY.editMode
  return (
    <Card title="编辑">
      <Row label={C.label} desc="所见即所得：输入前缀当场成型；源码：编辑 Markdown 原文，记号全部显示（顶栏 ⋮ 菜单里是同一个设置）">
        <Segmented<EditMode>
          label={C.label}
          value={mode}
          options={[
            { value: 'rich', label: C.rich },
            { value: 'source', label: C.source },
          ]}
          onChange={setEditMode}
        />
      </Row>
      <Row label="新页面默认打开方式" desc="页面自己切换过模式后，按它自己的记忆，不再跟随这里">
        <Segmented
          label="新页面默认打开方式"
          value={chatDefault ? 'chat' : 'doc'}
          options={[
            { value: 'doc', label: '文档' },
            { value: 'chat', label: '聊天' },
          ]}
          onChange={(v) => setDefaultViewMode(v === 'chat')}
        />
      </Row>
    </Card>
  )
}

/** 快捷键：表在 editor/shortcuts.ts（与绑定同源），这里只排版 */
export function ShortcutsPane() {
  const keys = (key: string) => (
    <span className="kbd-combo" key={key}>
      {keyCaps(key).map((cap, i) => (
        <kbd key={i}>{cap}</kbd>
      ))}
    </span>
  )
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <Card key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <Row key={row.label} label={row.label}>
              <span className="kbd-list">{row.keys.map(keys)}</span>
            </Row>
          ))}
        </Card>
      ))}
      <Card title="Markdown 输入">
        {MARKDOWN_RULES.map((rule) => (
          <Row key={rule.input} label={rule.label}>
            <code className="kbd-md">{rule.input}</code>
          </Row>
        ))}
      </Card>
    </>
  )
}

/** 默认 Agent：选中项即聊天输入框旁显示的 agent（default-agent.ts 全局单值） */
export function AgentPane() {
  const { agents, loaded } = useAgents()
  const current = useDefaultAgent()
  // 面板是「我现在有什么可用」的现场：打开就重拉一次，不靠上一次的缓存
  useEffect(refreshAgents, [])
  return (
    <Card title={agents.length > 0 ? `可用 Agent（${agents.length}）` : '可用 Agent'}>
      {agents.length === 0 && (
        <p className="set-empty">
          {loaded ? '没有可用 agent：还没连 connector（见「连接器」），或别人接入的机器还没授权给你（见「机器」）。' : 'agent 列表加载中…'}
        </p>
      )}
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={a.id === current}
          className={'set-pick' + (a.id === current ? ' is-on' : '')}
          onClick={() => setDefaultAgent(a.id)}
        >
          <AgentBadgeView badge={agentBadge(a.id)} className="agent-mark-row" />
          <span className="set-pick-label">{a.label}</span>
          {a.id.startsWith('c:') && <span className="set-pick-tag">connector</span>}
          <span className="set-pick-check">{a.id === current && <Icon name="check" size={14} />}</span>
        </button>
      ))}
    </Card>
  )
}
