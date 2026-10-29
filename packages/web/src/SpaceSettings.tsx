import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, SPACE_ROLE_LABELS, type Space, type SpaceInvite, type SpaceMember, type User } from './api'
import { ApiError } from './api'
import { Avatar } from './Avatar'
import { copyText } from './clipboard'
import { COPY } from './copy'
import { Card, ConfirmButton, Row } from './form-kit'
import { Icon } from './icons'

/** 空间分页（设置弹窗内，卡片式）：
 * - 所有成员（含只读成员）可看成员列表
 * - owner：改成员角色、按用户名添加成员、移除成员、生成 / 撤销邀请链接、改名（行内编辑）、删空间
 * - member/viewer：退出空间（自己移除自己）
 * 危险动作用行内两步确认（form-kit.tsx ConfirmButton），不弹 window.confirm。
 * 外壳（遮罩 / 导航 / 标题）在 SettingsModal，这里只管内容与权限。 */
export default function SpaceSettings({
  space,
  user,
  onClose,
  onChanged,
  onSpaceGone,
}: {
  space: Space
  user: User
  /** 退出空间 / 删空间成功后要关掉整个设置弹窗 */
  onClose: () => void
  onChanged: () => void
  /** 空间被删除或自己退出后回调：Sidebar 负责跳离该空间的页面并刷新 */
  onSpaceGone: (spaceId: string) => void
}) {
  // my_role 没有 'admin'（全局 admin 也只看自己参与的空间）；管理动作只归 owner
  const canManage = space.my_role === 'owner'
  // owner 不可退自己的空间（服务端也会 400）
  const canLeave = space.my_role === 'member' || space.my_role === 'viewer'

  const [members, setMembers] = useState<SpaceMember[] | null>(null)
  const [invites, setInvites] = useState<SpaceInvite[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.listSpaceMembers(space.id).then(setMembers).catch(console.error)
    if (canManage) api.listSpaceInvites(space.id).then(setInvites).catch(console.error)
  }, [space.id, canManage])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function removeMember(m: SpaceMember) {
    setError(null)
    try {
      await api.removeSpaceMember(space.id, m.user_id)
      refresh()
      onChanged()
    } catch (err) {
      console.error(err)
      setError('移除失败')
    }
  }

  async function changeRole(m: SpaceMember, role: 'member' | 'viewer') {
    setError(null)
    try {
      await api.setSpaceMemberRole(space.id, m.user_id, role)
      refresh()
      onChanged()
    } catch (err) {
      console.error(err)
      setError(COPY.members.roleFailed)
      refresh() // 下拉框回到服务端的真值
    }
  }

  async function leave() {
    setError(null)
    try {
      await api.removeSpaceMember(space.id, user.id)
      onClose()
      onSpaceGone(space.id) // 选中空间消失后 Shell 会回落到个人空间
    } catch (err) {
      console.error(err)
      setError('退出失败')
    }
  }

  async function destroy() {
    setError(null)
    try {
      await api.deleteSpace(space.id)
      onClose()
      onSpaceGone(space.id)
    } catch (err) {
      console.error(err)
      setError('删除失败')
    }
  }

  return (
    <>
      {error && <div className="modal-error">{error}</div>}

      <Card title="空间">
        <NameRow space={space} canRename={canManage} onRenamed={onChanged} onError={setError} />
        <Row label="我的角色" desc={space.is_personal ? '个人空间：只有你自己' : undefined}>
          <span className={'role-badge' + (space.my_role === 'owner' ? ' is-owner' : '')}>{SPACE_ROLE_LABELS[space.my_role]}</span>
        </Row>
      </Card>

      <Card title={members ? `成员（${members.length}）` : '成员'}>
        {members === null && <p className="set-empty">加载中…</p>}
        {members?.map((m) => (
          <div className="set-line" key={m.user_id}>
            <Avatar person={{ id: m.user_id, username: m.username, avatar: m.avatar }} size={28} />
            <div className="set-line-main">
              <span className="set-line-name" title={m.username}>
                {m.username}
                {m.user_id === user.id && <span className="member-me">（我）</span>}
              </span>
            </div>
            {/* owner 管理别人：角色直接在下拉里改（member ⇄ viewer）；owner 自己与其他人只是徽标 */}
            {canManage && m.role !== 'owner' && m.user_id !== user.id ? (
              <>
                <select
                  className="member-role-select"
                  aria-label={COPY.members.role}
                  value={m.role}
                  onChange={(e) => void changeRole(m, e.target.value as 'member' | 'viewer')}
                >
                  <option value="member">{SPACE_ROLE_LABELS.member}</option>
                  <option value="viewer">{SPACE_ROLE_LABELS.viewer}</option>
                </select>
                <ConfirmButton confirmLabel="确认移除" onConfirm={() => void removeMember(m)} title={`将「${m.username}」移出空间`}>
                  移除
                </ConfirmButton>
              </>
            ) : (
              <span className={'role-badge' + (m.role === 'owner' ? ' is-owner' : '')}>{SPACE_ROLE_LABELS[m.role]}</span>
            )}
          </div>
        ))}
        {space.my_role === 'viewer' && <p className="set-empty">{COPY.members.readOnlyHint}</p>}
        {canManage && (
          <AddMember
            space={space}
            onAdded={(name) => {
              setNotice(COPY.members.added(name))
              refresh()
              onChanged()
            }}
            onError={setError}
          />
        )}
        {notice && <p className="set-empty is-ok">{notice}</p>}
      </Card>

      {canManage && <InviteCard space={space} invites={invites} onChanged={refresh} onError={setError} />}

      {(canLeave || (canManage && !space.is_personal)) && (
        <Card title="危险操作" danger>
          {canLeave && (
            <Row label="退出空间" desc="之后需要重新被邀请才能访问">
              <ConfirmButton confirmLabel="确认退出" onConfirm={() => void leave()}>
                退出空间
              </ConfirmButton>
            </Row>
          )}
          {canManage && !space.is_personal && (
            <Row label="删除空间" desc="空间内全部页面与协作数据将一并删除，不可恢复">
              <ConfirmButton confirmLabel="再点一次永久删除" onConfirm={() => void destroy()}>
                删除空间
              </ConfirmButton>
            </Row>
          )}
        </Card>
      )}
    </>
  )
}

/** 空间名：owner 行内改名（1–50 字），其他人只读 */
function NameRow({
  space,
  canRename,
  onRenamed,
  onError,
}: {
  space: Space
  canRename: boolean
  onRenamed: () => void
  onError: (msg: string | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (draft === null || saving) return
    const name = draft.trim()
    if (!name || name.length > 50) return onError('空间名称需为 1-50 个字符')
    if (name === space.name) return setDraft(null)
    setSaving(true)
    onError(null)
    try {
      await api.renameSpace(space.id, name)
      setDraft(null)
      onRenamed()
    } catch (err) {
      console.error(err)
      onError('重命名失败')
    } finally {
      setSaving(false)
    }
  }

  if (draft !== null) {
    return (
      <form className="set-row set-rename" onSubmit={(e) => void save(e)}>
        <input
          className="admin-field"
          value={draft}
          maxLength={50}
          autoFocus
          aria-label="空间名称"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Esc 只取消改名，不关整个设置弹窗
            if (e.key === 'Escape') {
              e.stopPropagation()
              e.nativeEvent.stopImmediatePropagation()
              setDraft(null)
            }
          }}
        />
        <button className="admin-btn primary" type="submit" disabled={saving || !draft.trim()}>
          保存
        </button>
        <button className="admin-btn" type="button" onClick={() => setDraft(null)}>
          取消
        </button>
      </form>
    )
  }
  return (
    <Row label="名称" desc={space.name}>
      {canRename && (
        <button className="admin-btn" onClick={() => setDraft(space.name)}>
          <Icon name="edit" size={14} /> 重命名
        </button>
      )}
    </Row>
  )
}

function AddMember({ space, onAdded, onError }: { space: Space; onAdded: (name: string) => void; onError: (msg: string | null) => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<'member' | 'viewer'>('member')

  async function add(e: FormEvent) {
    e.preventDefault()
    const username = name.trim()
    if (!username) return
    onError(null)
    try {
      await api.addSpaceMember(space.id, username, role)
      setName('')
      onAdded(username)
    } catch (err) {
      console.error(err)
      onError(
        err instanceof ApiError && err.status === 404
          ? COPY.members.noSuchUser
          : err instanceof ApiError && err.status === 409
            ? COPY.members.alreadyMember
            : COPY.members.addFailed,
      )
    }
  }

  return (
    <form className="set-line member-add" onSubmit={(e) => void add(e)}>
      <input
        className="admin-field grow"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={COPY.members.usernamePlaceholder}
        aria-label={COPY.members.addTitle}
        autoComplete="off"
      />
      <select className="admin-field" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'viewer')}>
        <option value="member">成员（可编辑）</option>
        <option value="viewer">只读</option>
      </select>
      <button className="admin-btn primary" type="submit" disabled={!name.trim()}>
        {COPY.members.add}
      </button>
    </form>
  )
}

function InviteCard({
  space,
  invites,
  onChanged,
  onError,
}: {
  space: Space
  invites: SpaceInvite[] | null
  onChanged: () => void
  onError: (msg: string | null) => void
}) {
  const [role, setRole] = useState<'member' | 'viewer'>('member')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function create() {
    onError(null)
    setCopied(false)
    try {
      const invite = await api.createInvite(space.id, role)
      setLink(`${location.origin}/join/${invite.token}`)
      onChanged()
    } catch (err) {
      console.error(err)
      onError('生成邀请链接失败')
    }
  }

  async function copy() {
    if (!link) return
    if (await copyText(link)) setCopied(true)
    else onError('复制失败，请手动选中复制')
  }

  async function revoke(invite: SpaceInvite) {
    onError(null)
    try {
      await api.revokeInvite(invite.token)
      if (link === `${location.origin}/join/${invite.token}`) setLink(null)
      onChanged()
    } catch (err) {
      console.error(err)
      onError('撤销失败')
    }
  }

  return (
    <Card title={invites && invites.length > 0 ? `邀请链接（${invites.length} 个有效）` : '邀请链接'}>
      <Row label="生成邀请链接" desc="拿到链接的人登录后即可加入本空间">
        <select className="admin-field" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'viewer')} aria-label="加入后的角色">
          <option value="member">成员（可编辑）</option>
          <option value="viewer">只读</option>
        </select>
        <button className="admin-btn primary" onClick={() => void create()}>
          生成
        </button>
      </Row>
      {link && (
        <div className="set-code">
          <code>{link}</code>
          <button className="admin-btn" onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}
      {invites?.map((invite) => (
        <div className="set-line" key={invite.token}>
          <span className="role-badge">{SPACE_ROLE_LABELS[invite.role]}</span>
          <code className="invite-token" title={`/join/${invite.token}`}>
            /join/{invite.token}
          </code>
          <ConfirmButton confirmLabel="确认撤销" onConfirm={() => void revoke(invite)} title="撤销后链接立即失效">
            撤销
          </ConfirmButton>
        </div>
      ))}
    </Card>
  )
}
