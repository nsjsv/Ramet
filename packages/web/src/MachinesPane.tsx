import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, type Page, type Space, type User } from './api'
import { subscribeControl } from './control'
import { COPY } from './copy'
import { Card, ConfirmButton, Segmented } from './form-kit'
import MachineGrantWizard from './MachineGrantWizard'
import { GrantsPanel, RequestsPanel, UsagePanel } from './MachinePanels'
import {
  machineApi,
  type MachineGrant,
  type MachineRequest,
  type MachineScope,
  type MachineSummary,
} from './machine-api'
import { clockLabel, leftLabel, scopesLabel } from './machine-format'

/* ---------- 设置 → 机器（按空间）----------
 * 机器归接入它的人（connector 的主人）：别人默认完全用不了，要用得由主人走授权流程（MachineGrantWizard）。
 *   我的机器：展开后有 授权 / 申请 / 使用记录 三块（只有主人拿得到这些数据）。
 *   别人的机器：只显示机器名、主人、在线；我已有授权就显示范围与到期（可放弃），没有就能申请使用。
 *   这里不请求、不显示别人机器上的 agent 列表或目录。
 * 授权 / 申请变化时服务端经 control:global 广播 'agents'（不是 'changed'）；订阅同一条连接，收到就整体重拉。 */

const C = COPY.machines
const SCOPES: readonly MachineScope[] = ['agent', 'machine']

type Panel = 'grants' | 'requests' | 'usage'

export function MachinesPane({
  space,
  user,
  pages,
  onNavigate,
}: {
  space: Space
  user: User
  /** 侧栏页面列表（使用记录里把页面 id 显示成标题）；没到就显示「打开页面」 */
  pages: readonly Page[] | null
  /** 点使用记录里的页面链接：关掉设置弹窗 */
  onNavigate: () => void
}) {
  const [list, setList] = useState<MachineSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 每次重拉加一：我的机器据此重拉自己的授权 / 申请（它们归各行自己持有） */
  const [rev, setRev] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const autoOpened = useRef(false)

  const refresh = useCallback(() => {
    machineApi
      .list(space.id)
      .then((rows) => {
        setList(rows)
        setError(null)
        // 第一次拿到列表时，有我的机器就默认展开第一台
        if (!autoOpened.current) {
          autoOpened.current = true
          setOpenId(rows.find((m) => m.mine)?.id ?? null)
        }
      })
      .catch((err: unknown) => {
        console.error(err)
        setError(C.loadFailed)
      })
    setRev((r) => r + 1)
  }, [space.id])

  useEffect(() => {
    autoOpened.current = false
    setList(null)
    refresh()
  }, [refresh])
  // 授权 / 申请 / 机器上下线都广播 'agents'；(重)连上的 'sync' 补拉断线期间错过的。'changed'（页面写库）无关
  useEffect(
    () =>
      subscribeControl((ev) => {
        if (ev === 'agents' || ev === 'sync') refresh()
      }),
    [refresh],
  )

  const canRequest = space.my_role !== 'viewer'
  // 我的在前，其余保持服务端顺序
  const sorted = list ? [...list.filter((m) => m.mine), ...list.filter((m) => !m.mine)] : null

  return (
    <>
      {error && <div className="modal-error">{error}</div>}
      <p className="machine-intro">{C.intro}</p>
      <Card title={C.listTitle(sorted?.length ?? 0)}>
        {sorted === null && <p className="set-empty">{COPY.loading}</p>}
        {sorted?.length === 0 && <p className="set-empty">{C.empty}</p>}
        {sorted?.map((m) =>
          m.status === 'pending' ? (
            // 我接入的、还在等空间所有者批准：谁都用不了，也没有授权 / 申请可管（别人的 pending 服务端根本不返回）
            <div className="machine" key={m.id}>
              <MachineHead machine={m} sub={`${C.pending} · ${C.pendingDesc}`} />
            </div>
          ) : m.mine ? (
            <MineMachine
              key={m.id}
              machine={m}
              open={openId === m.id}
              onToggle={() => setOpenId((cur) => (cur === m.id ? null : m.id))}
              rev={rev}
              space={space}
              user={user}
              pages={pages}
              onNavigate={onNavigate}
              onChanged={refresh}
            />
          ) : (
            <OtherMachine key={m.id} machine={m} canRequest={canRequest} onChanged={refresh} />
          ),
        )}
      </Card>
    </>
  )
}

/** 机器行左侧：在线点 + 名字 + 次行 */
function MachineHead({ machine, sub, children }: { machine: MachineSummary; sub: string; children?: ReactNode }) {
  return (
    <div className="set-line machine-head">
      <span className={'connector-dot' + (machine.online ? ' on' : '')} title={machine.online ? C.online : C.offline} />
      <div className="set-line-main">
        <span className="set-line-name" title={machine.name}>
          {machine.name}
          {machine.mine && <span className="role-badge is-owner">{C.mine}</span>}
        </span>
        <span className="set-line-sub machine-wrap">{sub}</span>
      </div>
      {children}
    </div>
  )
}

/** 我的机器：授权 / 申请 / 使用记录 */
function MineMachine({
  machine,
  open,
  onToggle,
  rev,
  space,
  user,
  pages,
  onNavigate,
  onChanged,
}: {
  machine: MachineSummary
  open: boolean
  onToggle: () => void
  rev: number
  space: Space
  user: User
  pages: readonly Page[] | null
  onNavigate: () => void
  onChanged: () => void
}) {
  const [grants, setGrants] = useState<MachineGrant[] | null>(null)
  const [requests, setRequests] = useState<MachineRequest[] | null>(null)
  const [panel, setPanel] = useState<Panel>('grants')
  const [wizard, setWizard] = useState<{ userId?: string; asked?: MachineScope[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    Promise.all([machineApi.listGrants(machine.id), machineApi.listRequests(machine.id)])
      .then(([g, r]) => {
        if (!alive) return
        setGrants(g)
        setRequests(r)
      })
      .catch((err: unknown) => console.error(err))
    return () => {
      alive = false
    }
  }, [machine.id, rev])

  const active = grants?.filter((g) => g.status === 'active').length ?? 0
  const waiting = requests?.length ?? 0
  const sub = [
    machine.online ? C.online : C.offline,
    grants === null ? '' : C.summary(active, waiting),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="machine">
      <MachineHead machine={machine} sub={sub}>
        <button type="button" className="admin-btn" aria-expanded={open} onClick={onToggle}>
          {open ? C.collapse : C.manage}
          {!open && waiting > 0 && <span className="machine-dot" aria-hidden="true" />}
        </button>
      </MachineHead>
      {open && (
        <div className="machine-detail">
          <div className="machine-tabs">
            <Segmented
              label={machine.name}
              value={panel}
              options={[
                { value: 'grants', label: C.tabs.grants },
                { value: 'requests', label: waiting > 0 ? `${C.tabs.requests}（${waiting}）` : C.tabs.requests },
                { value: 'usage', label: C.tabs.usage },
              ]}
              onChange={(v) => {
                setError(null)
                setPanel(v)
              }}
            />
          </div>
          {error && <div className="modal-error set-pad">{error}</div>}
          {panel === 'grants' && (
            <GrantsPanel
              machineId={machine.id}
              grants={grants}
              onGrant={() => setWizard({})}
              onChanged={onChanged}
              onError={setError}
            />
          )}
          {panel === 'requests' && (
            <RequestsPanel
              machineId={machine.id}
              requests={requests}
              onGrant={(r) => setWizard({ userId: r.userId, asked: r.scopes })}
              onChanged={onChanged}
              onError={setError}
            />
          )}
          {panel === 'usage' && <UsagePanel machineId={machine.id} pages={pages} onNavigate={onNavigate} />}
        </div>
      )}
      {wizard && (
        <MachineGrantWizard
          machine={machine}
          space={space}
          user={user}
          {...(wizard.userId ? { presetUserId: wizard.userId } : {})}
          {...(wizard.asked ? { askedScopes: wizard.asked } : {})}
          onClose={() => {
            setWizard(null)
            onChanged()
          }}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

/** 别人的机器：看得到名字 / 主人 / 在线；我的授权（可放弃）或申请 */
function OtherMachine({ machine, canRequest, onChanged }: { machine: MachineSummary; canRequest: boolean; onChanged: () => void }) {
  const [applying, setApplying] = useState(false)
  const [picked, setPicked] = useState<Record<MachineScope, boolean>>({ agent: false, machine: false })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grant = machine.grant
  const requestId = machine.requestId
  const chosen = SCOPES.filter((s) => picked[s])

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : C.applyFailed)
    } finally {
      setBusy(false)
      onChanged() // 409（已申请过）/ 404（已处理）这类，刷新后界面就对了
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (busy || chosen.length === 0) return
    await act(async () => {
      await machineApi.requestAccess(machine.id, chosen, note.trim())
      setApplying(false)
      setPicked({ agent: false, machine: false })
      setNote('')
    })
  }

  const sub = [machine.owner ? C.owner(machine.owner) : C.noOwner, machine.online ? C.online : C.offline].join(' · ')

  return (
    <div className="machine">
      <MachineHead machine={machine} sub={sub}>
        {grant ? (
          <ConfirmButton
            confirmLabel={C.giveUpConfirm}
            title={C.giveUpTip}
            disabled={busy}
            onConfirm={() => void act(() => machineApi.revokeGrant(machine.id, grant.id))}
          >
            {C.giveUp}
          </ConfirmButton>
        ) : machine.request ? (
          requestId ? (
            <button
              type="button"
              className="admin-btn"
              disabled={busy}
              onClick={() => void act(() => machineApi.dropRequest(machine.id, requestId))}
            >
              {C.withdraw}
            </button>
          ) : null
        ) : (
          canRequest && (
            <button type="button" className="admin-btn" aria-expanded={applying} onClick={() => setApplying((v) => !v)}>
              {C.apply}
            </button>
          )
        )}
      </MachineHead>
      <div className="machine-state-row">
        {grant ? (
          <span className="machine-state is-ok" title={C.expireAt(clockLabel(grant.expiresAt))}>
            {C.youHave(scopesLabel(grant.scopes), leftLabel(grant.expiresAt))}
          </span>
        ) : machine.request ? (
          <span className="machine-state is-warn">{C.applied}</span>
        ) : (
          <span className="machine-state">{canRequest ? C.noAccess : `${C.noAccess} · ${C.viewerCannot}`}</span>
        )}
      </div>
      {error && <div className="modal-error set-pad">{error}</div>}
      {applying && !grant && !machine.request && (
        <form className="machine-apply" onSubmit={(e) => void send(e)}>
          <div className="machine-apply-title">{C.applyTitle}</div>
          {SCOPES.map((s) => (
            <label key={s} className="machine-check">
              <input type="checkbox" checked={picked[s]} onChange={() => setPicked((p) => ({ ...p, [s]: !p[s] }))} />
              <span>{C.scope[s]}</span>
            </label>
          ))}
          <input
            className="admin-field"
            value={note}
            maxLength={200}
            placeholder={C.applyNote}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="set-form-foot">
            {chosen.length === 0 && <span className="set-form-msg">{C.applyNeedScope}</span>}
            <button type="submit" className="admin-btn primary" disabled={busy || chosen.length === 0}>
              {C.applySend}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
