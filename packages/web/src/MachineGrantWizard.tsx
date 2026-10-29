import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import { api, ApiError, type Space, type SpaceMember, type User } from './api'
import { Avatar } from './Avatar'
import { copyText } from './clipboard'
import { subscribeControl } from './control'
import { COPY } from './copy'
import { Card } from './form-kit'
import { Icon } from './icons'
import { machineApi, type GrantCreated, type MachineScope, type MachineSummary } from './machine-api'
import { clockLabel, mmss, scopesLabel } from './machine-format'
import Modal from './Modal'

/* ---------- 授权流程（设置 → 机器 → 授权给某人）----------
 * 故意做得麻烦：选人 + 勾范围，读懂后果，手输对方用户名与机器名并重输密码，再到机器上本地确认。
 * 前两步只是前端状态；第 3 步提交才打服务端（POST grants，服务端会再核对一遍密码 / 用户名 / 机器名）。
 * 第 4 步拿到一次性确认命令（关掉就再也看不到，要重新授权）并轮询：列表里那条变成 active 即已在机器上确认。
 * 全屏式多步弹窗，叠在设置弹窗上面（Modal 的 Esc 只关最上面一个）。 */

const C = COPY.machines.wizard
const SCOPES: readonly MachineScope[] = ['agent', 'machine']
const POLL_MS = 3000
const DAYS_MIN = 1
const DAYS_MAX = 30

type Phase = 'waiting' | 'active' | 'expired' | 'revoked'

/** 确认项必须手敲：粘贴（含拖入文字）一律挡掉 */
const noPaste = (e: ClipboardEvent) => e.preventDefault()

export default function MachineGrantWizard({
  machine,
  space,
  user,
  presetUserId,
  askedScopes,
  onClose,
  onChanged,
}: {
  machine: MachineSummary
  space: Space
  user: User
  /** 从使用申请「去授权」进来：预选这个人（范围仍然要自己勾） */
  presetUserId?: string
  /** 对方申请的范围，只在第 1 步提示，不替他勾 */
  askedScopes?: MachineScope[]
  onClose: () => void
  /** 授权有了变化（建成 / 生效）：外层重拉列表 */
  onChanged: () => void
}) {
  const [step, setStep] = useState(1)
  const [members, setMembers] = useState<SpaceMember[] | null>(null)
  const [membersError, setMembersError] = useState(false)
  const [userId, setUserId] = useState(presetUserId ?? '')
  const [picked, setPicked] = useState<Record<MachineScope, boolean>>({ agent: false, machine: false })
  const [days, setDays] = useState('7')
  const [ack, setAck] = useState(false)
  const [typedUser, setTypedUser] = useState('')
  const [typedMachine, setTypedMachine] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<GrantCreated | null>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState<boolean | null>(null)
  // 外层每次重画都会给新的 onChanged；轮询的 effect 不该因此重启
  const changed = useRef(onChanged)
  changed.current = onChanged

  // 候选人 = 空间 owner / member，排除自己（只读成员、其他空间的人都不行；服务端同样会拒）
  useEffect(() => {
    let alive = true
    api
      .listSpaceMembers(space.id)
      .then((rows) => alive && setMembers(rows.filter((m) => m.role !== 'viewer' && m.user_id !== user.id)))
      .catch(() => alive && setMembersError(true))
    return () => {
      alive = false
    }
  }, [space.id, user.id])

  const grantee = members?.find((m) => m.user_id === userId) ?? null
  const scopes = SCOPES.filter((s) => picked[s])
  const daysNum = Number(days)
  const daysOk = days.trim() !== '' && Number.isInteger(daysNum) && daysNum >= DAYS_MIN && daysNum <= DAYS_MAX
  const step1Ok = grantee !== null && scopes.length > 0 && daysOk
  const typedOk = grantee !== null && typedUser === grantee.username && typedMachine === machine.name && password !== ''

  // 第 4 步：每秒走倒计时；每 3 秒（以及中心广播 agents 时）查一次这条授权是不是已经在机器上确认
  const grantId = created?.grantId
  useEffect(() => {
    if (!grantId || phase !== 'waiting') return
    let stop = false
    let busy = false
    const check = async () => {
      if (busy) return
      busy = true
      try {
        const row = (await machineApi.listGrants(machine.id)).find((g) => g.id === grantId)
        if (stop || !row) return
        if (row.status === 'active') {
          setPhase('active')
          changed.current()
        } else if (row.status === 'expired' || row.status === 'revoked') {
          setPhase(row.status)
          changed.current()
        }
      } catch {
        // 网络抖动：下一轮再查
      } finally {
        busy = false
      }
    }
    const poll = window.setInterval(() => void check(), POLL_MS)
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    const off = subscribeControl((ev) => {
      if (ev === 'agents' || ev === 'sync') void check()
    })
    return () => {
      stop = true
      window.clearInterval(poll)
      window.clearInterval(tick)
      off()
    }
  }, [grantId, phase, machine.id])

  function toggle(scope: MachineScope) {
    setPicked((prev) => ({ ...prev, [scope]: !prev[scope] }))
  }

  async function submit() {
    if (submitting || !typedOk || !grantee) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await machineApi.createGrant(machine.id, {
        password,
        username: typedUser,
        machineName: typedMachine,
        scopes,
        days: daysNum,
        userId: grantee.user_id,
      })
      setCreated(res)
      setNow(Date.now())
      setPhase('waiting')
      setStep(4)
      changed.current()
    } catch (err) {
      // 密码错 / 被限速 / 校验没过：message 就是服务端的人话；错过一次的密码不留在框里
      setError(err instanceof ApiError ? err.message : err instanceof TypeError ? C.offline : COPY.retry)
    } finally {
      setPassword('')
      setSubmitting(false)
    }
  }

  function go(next: number) {
    setError(null)
    setStep(next)
  }

  const onForm = (e: FormEvent) => {
    e.preventDefault()
    if (step === 1 && step1Ok) go(2)
    else if (step === 2 && ack) go(3)
    else if (step === 3) void submit()
  }

  const confirmLeft = created ? new Date(created.confirmExpiresAt).getTime() - now : 0

  return (
    <Modal onClose={onClose} overlayCloses={false} className="machine-wizard" label={C.title(machine.name)}>
      <header className="mw-head">
        <div className="mw-titles">
          <h2 className="modal-title">{C.title(machine.name)}</h2>
          <p className="mw-step">
            {C.step(step)} · {C.steps[step - 1]}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} title={C.close}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="mw-bar" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= step ? 'is-on' : ''} />
        ))}
      </div>

      <form className="mw-form" onSubmit={onForm}>
        <div className="mw-body">
          {step === 1 && (
            <>
              <Card title={C.who}>
                {members === null && <p className="set-empty">{membersError ? C.membersFailed : COPY.loading}</p>}
                {members?.length === 0 && <p className="set-empty">{C.noCandidates}</p>}
                {members?.map((m) => (
                  <button
                    key={m.user_id}
                    type="button"
                    role="radio"
                    aria-checked={m.user_id === userId}
                    className={'set-pick' + (m.user_id === userId ? ' is-on' : '')}
                    onClick={() => setUserId(m.user_id)}
                  >
                    <Avatar person={{ id: m.user_id, username: m.username, avatar: m.avatar }} size={24} />
                    <span className="set-pick-label">{m.username}</span>
                    <span className="set-pick-check">{m.user_id === userId && <Icon name="check" size={14} />}</span>
                  </button>
                ))}
              </Card>
              <p className="mw-muted">{C.whoDesc}</p>
              <Card title={C.scopes}>
                {SCOPES.map((s) => (
                  <label key={s} className="machine-check">
                    <input type="checkbox" checked={picked[s]} onChange={() => toggle(s)} />
                    <span>{COPY.machines.scope[s]}</span>
                  </label>
                ))}
              </Card>
              {askedScopes && askedScopes.length > 0 && <p className="mw-muted">{C.asked(scopesLabel(askedScopes))}</p>}
              <label className="set-field">
                <span>{C.days}</span>
                <input
                  className="admin-field mw-days"
                  type="number"
                  min={DAYS_MIN}
                  max={DAYS_MAX}
                  step={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
                <span className={daysOk ? 'mw-muted' : 'mw-bad'}>{daysOk ? C.daysHint : C.daysInvalid}</span>
              </label>
            </>
          )}

          {step === 2 && grantee && (
            <>
              <div className="mw-warn" role="alert">
                <div className="mw-warn-title">
                  <Icon name="callout-warning" size={16} /> {C.warnTitle}
                </div>
                <ul>
                  {picked.agent && <li>{C.warnAgent}</li>}
                  {picked.machine && <li>{C.warnMachine}</li>}
                  <li>{C.warnWho}</li>
                  <li>{C.warnTime(daysNum)}</li>
                  <li>{C.warnLog}</li>
                </ul>
              </div>
              <dl className="mw-sum">
                <dt>{C.sumWho}</dt>
                <dd>{grantee.username}</dd>
                <dt>{C.sumScope}</dt>
                <dd>{scopes.map((s) => COPY.machines.scope[s]).join('；')}</dd>
                <dt>{C.sumDays}</dt>
                <dd>{C.daysUnit(daysNum)}</dd>
              </dl>
              <label className="machine-check mw-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>{C.ack}</span>
              </label>
            </>
          )}

          {step === 3 && grantee && (
            <>
              <p className="mw-lead">{C.typeTitle}</p>
              <label className="set-field">
                <span>{C.typeUser(grantee.username)}</span>
                <input
                  className="admin-field"
                  value={typedUser}
                  onChange={(e) => setTypedUser(e.target.value)}
                  onPaste={noPaste}
                  onDrop={(e) => e.preventDefault()}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                />
                {typedUser !== '' && typedUser !== grantee.username && <span className="mw-bad">{C.mismatch}</span>}
              </label>
              <label className="set-field">
                <span>{C.typeMachine(machine.name)}</span>
                <input
                  className="admin-field"
                  value={typedMachine}
                  onChange={(e) => setTypedMachine(e.target.value)}
                  onPaste={noPaste}
                  onDrop={(e) => e.preventDefault()}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                />
                {typedMachine !== '' && typedMachine !== machine.name && <span className="mw-bad">{C.mismatch}</span>}
              </label>
              <label className="set-field">
                <span>{C.password}</span>
                <input
                  className="admin-field"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
            </>
          )}

          {step === 4 && created && (
            <>
              {phase === 'active' ? (
                <div className="mw-ok">
                  <div className="mw-ok-title">
                    <Icon name="check" size={16} /> {C.active}
                  </div>
                  <p>{C.activeDesc(grantee?.username ?? '', COPY.machines.expireAt(clockLabel(created.expiresAt)))}</p>
                </div>
              ) : phase === 'waiting' ? (
                <>
                  <p className="mw-lead">{C.confirmTitle}</p>
                  <p className="mw-muted">{C.confirmDesc}</p>
                  <div className="mw-code">
                    <code>{created.command}</code>
                    <button
                      type="button"
                      className="admin-btn"
                      onClick={() => void copyText(created.command).then(setCopied)}
                    >
                      <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? C.copied : C.copy}
                    </button>
                  </div>
                  {copied === false && <p className="mw-bad">{C.copyFailed}</p>}
                  <p className={confirmLeft > 0 ? 'mw-muted' : 'mw-bad'}>
                    {confirmLeft > 0 ? C.confirmLeft(mmss(confirmLeft)) : C.confirmExpired}
                  </p>
                  <p className="mw-muted">{C.waiting}</p>
                  <p className="mw-muted">{C.closeHint}</p>
                </>
              ) : (
                <div className="modal-error">{C.ended[phase]}</div>
              )}
            </>
          )}

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="mw-foot">
          {step === 1 && (
            <>
              <button type="button" className="admin-btn" onClick={onClose}>
                {C.cancel}
              </button>
              <button type="submit" className="admin-btn primary" disabled={!step1Ok}>
                {C.next}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button type="button" className="admin-btn" onClick={() => go(1)}>
                {C.back}
              </button>
              <button type="submit" className="admin-btn primary" disabled={!ack}>
                {C.next}
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button type="button" className="admin-btn" onClick={() => go(2)} disabled={submitting}>
                {C.back}
              </button>
              <button type="submit" className="admin-btn primary" disabled={!typedOk || submitting}>
                {submitting ? C.submitting : C.submit}
              </button>
            </>
          )}
          {step === 4 && (
            <button type="button" className="admin-btn primary" onClick={onClose}>
              {phase === 'waiting' ? C.close : C.done}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  )
}
