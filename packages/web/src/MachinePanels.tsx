import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, type Page } from './api'
import { Avatar } from './Avatar'
import { COPY } from './copy'
import { ConfirmButton } from './form-kit'
import { machineApi, type MachineGrant, type MachineRequest, type MachineUsage } from './machine-api'
import { clockLabel, leftLabel, scopesLabel, usageText } from './machine-format'
import { relativeTime } from './UpdatesFeed'

/* ---------- 我的机器展开后的三块：授权 / 申请 / 使用记录（设置 → 机器，仅主人看得到）----------
 * 数据由 MachinesPane 的 MineMachine 拉好传进来（授权与申请），使用记录自己分页拉（点开才请求）。
 * 动作的失败原因经 onError 回到外层展示（服务端 message 是人话）。 */

const C = COPY.machines

const errText = (err: unknown): string => (err instanceof ApiError ? err.message : C.revokeFailed)

/** 授权列表：生效中 / 待确认在上，已结束的折叠起来 */
export function GrantsPanel({
  machineId,
  grants,
  onGrant,
  onChanged,
  onError,
}: {
  machineId: string
  grants: MachineGrant[] | null
  onGrant: () => void
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const [showEnded, setShowEnded] = useState(false)
  if (grants === null) return <p className="set-empty">{COPY.loading}</p>
  const live = grants.filter((g) => g.status === 'active' || g.status === 'pending')
  const ended = grants.filter((g) => g.status === 'expired' || g.status === 'revoked')

  async function revoke(grant: MachineGrant) {
    onError(null)
    try {
      await machineApi.revokeGrant(machineId, grant.id)
    } catch (err) {
      onError(errText(err))
    }
    onChanged()
  }

  const line = (g: MachineGrant) => {
    const sub =
      g.status === 'active'
        ? [C.expireLeft(clockLabel(g.expiresAt), leftLabel(g.expiresAt)), g.firstUsedAt ? C.firstUsed(relativeTime(g.firstUsedAt)) : ''].filter(Boolean)
        : g.status === 'pending'
          ? [C.pendingHint]
          : g.status === 'revoked' && g.revokedAt
            ? [C.revokedAt(clockLabel(g.revokedAt))]
            : [C.expireAt(clockLabel(g.expiresAt))]
    return (
      <div className="set-line" key={g.id}>
        <Avatar person={{ id: g.userId, username: g.username, avatar: null }} size={24} />
        <div className="set-line-main">
          <span className="set-line-name" title={g.username}>
            {g.username}
            <span className={`machine-badge is-${g.status}`}>{C.status[g.status]}</span>
          </span>
          <span className="set-line-sub" title={sub.join(' · ')}>
            {[scopesLabel(g.scopes), ...sub].join(' · ')}
          </span>
        </div>
        {g.status === 'active' && (
          <ConfirmButton confirmLabel={C.revokeConfirm} title={C.revokeTip} onConfirm={() => void revoke(g)}>
            {C.revoke}
          </ConfirmButton>
        )}
        {g.status === 'pending' && (
          <button type="button" className="admin-btn" onClick={() => void revoke(g)}>
            {C.cancelPending}
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="machine-panel-head">
        <span className="set-desc">{live.length === 0 ? C.noGrants : ''}</span>
        <button type="button" className="admin-btn primary" onClick={onGrant}>
          {C.grantTo}
        </button>
      </div>
      {live.map(line)}
      {ended.length > 0 && (
        <button type="button" className="machine-more" onClick={() => setShowEnded((v) => !v)}>
          {showEnded ? C.hideEnded : C.showEnded(ended.length)}
        </button>
      )}
      {showEnded && ended.map(line)}
    </>
  )
}

/** 使用申请：拒绝（删申请），或「去授权」带着这个人进授权流程 */
export function RequestsPanel({
  machineId,
  requests,
  onGrant,
  onChanged,
  onError,
}: {
  machineId: string
  requests: MachineRequest[] | null
  onGrant: (request: MachineRequest) => void
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  if (requests === null) return <p className="set-empty">{COPY.loading}</p>
  if (requests.length === 0) return <p className="set-empty">{C.noRequests}</p>

  async function reject(request: MachineRequest) {
    onError(null)
    try {
      await machineApi.dropRequest(machineId, request.id)
    } catch (err) {
      // 404 = 对方已撤回 / 已处理：刷新一下就对了，不当错误弹
      if (!(err instanceof ApiError && err.status === 404)) onError(errText(err))
    }
    onChanged()
  }

  return (
    <>
      {requests.map((r) => (
        <div className="set-line" key={r.id}>
          <Avatar person={{ id: r.userId, username: r.username, avatar: null }} size={24} />
          <div className="set-line-main">
            <span className="set-line-name" title={r.username}>
              {r.username}
              <span className="machine-when">{relativeTime(r.createdAt)}</span>
            </span>
            <span className="set-line-sub machine-wrap">
              {C.requestScopes(scopesLabel(r.scopes))}
              {r.note ? ` · ${r.note}` : ''}
            </span>
          </div>
          <button type="button" className="admin-btn" onClick={() => void reject(r)}>
            {C.reject}
          </button>
          <button type="button" className="admin-btn primary" onClick={() => onGrant(r)}>
            {C.grantNow}
          </button>
        </div>
      ))}
    </>
  )
}

const USAGE_PAGE = 30

/** 使用记录：新 → 旧，游标分页（before = 上一页最后一条的 id）。点开这一页才请求 */
export function UsagePanel({
  machineId,
  pages,
  onNavigate,
}: {
  machineId: string
  /** 侧栏的页面列表：用来把页面 id 显示成标题；找不到的（别的空间 / 已删）显示「打开页面」 */
  pages: readonly Page[] | null
  onNavigate: () => void
}) {
  const [items, setItems] = useState<MachineUsage[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const load = useCallback(
    (before?: string) => {
      setBusy(true)
      setError(false)
      machineApi
        .usage(machineId, { limit: USAGE_PAGE, ...(before ? { before } : {}) })
        .then((rows) => {
          setItems((prev) => (before ? [...(prev ?? []), ...rows] : rows))
          setMore(rows.length === USAGE_PAGE)
        })
        .catch((err: unknown) => {
          console.error(err)
          setError(true)
        })
        .finally(() => setBusy(false))
    },
    [machineId],
  )
  useEffect(() => load(), [load])

  const last = items?.[items.length - 1]
  return (
    <>
      <div className="machine-panel-head">
        <span className="set-desc">{C.usageNote}</span>
        <button type="button" className="admin-btn" disabled={busy} onClick={() => load()}>
          {C.reload}
        </button>
      </div>
      {items === null && !error && <p className="set-empty">{COPY.loading}</p>}
      {error && <p className="set-empty machine-bad">{C.usageFailed}</p>}
      {items?.length === 0 && <p className="set-empty">{C.noUsage}</p>}
      {items?.map((u) => {
        const text = usageText(u)
        const title = u.pageId ? pages?.find((p) => p.id === u.pageId)?.title : undefined
        return (
          <div className="set-line machine-use" key={u.id}>
            <Avatar person={{ id: u.userId, username: u.username, avatar: null }} size={24} />
            <div className="set-line-main">
              <span className="machine-wrap">
                <b>{u.username}</b> {text.verb}
                {u.pageId && (
                  <>
                    {' · '}
                    <Link to={`/page/${u.pageId}`} className="machine-link" onClick={onNavigate}>
                      {title === undefined ? C.openPage : title || COPY.untitled}
                    </Link>
                  </>
                )}
              </span>
              {text.detail && <span className="set-line-sub machine-wrap">{text.detail}</span>}
              {text.code && <code className="machine-cmd">{text.code}</code>}
            </div>
            <span className="machine-when" title={clockLabel(u.createdAt)}>
              {relativeTime(u.createdAt)}
            </span>
          </div>
        )
      })}
      {more && last && (
        <button type="button" className="machine-more" disabled={busy} onClick={() => load(last.id)}>
          {C.loadMore}
        </button>
      )}
    </>
  )
}
