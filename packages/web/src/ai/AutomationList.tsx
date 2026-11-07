/* ---------- AI 页的「自动」分页（/ai/automations）：我的规则 ----------
 * 规则 = 触发 + 一串动作（定时器也是规则，Genet 设的也在这里）。按来源分组列出：触发与动作的说明、下次触发 / 暂停原因、
 * 最近一次的结果（多个动作时逐个标出完成 / 失败 / 没跑），开关、编辑（RuleEditor）、删除。
 * 内置规则（评论找我 / 正文 @我，每人一条、默认开）单独一组排在最前：标「内置」、没有删除；还不能生效时（dormant：
 * 没配模型连接 / 还没有 Genet 页）整行灰着，写明原因并给补救按钮。设置里改了模型连接就重拉，配好后马上不灰。
 * 时间与说明一律显示服务端给的人话（triggerText / nextText / actionsText），不在前端重写规则。
 * 数据只是 GET /api/me/automations 的结果：增删改与每次触发的结局都会发 control:global 的 'inbox' 信号（不带内容），收到就去抖重拉；
 * (重)连上的 'sync' 补拉断线期间错过的。开关乐观更新，失败回滚并显示服务端的原因。 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Page, Space } from '../api'
import { useCachedLoad } from '../cached-load'
import { COPY } from '../copy'
import { subscribeControl } from '../control'
import { Icon } from '../icons'
import { subscribeAiSettings } from '../quick-api'
import { openSettings } from '../settings-bus'
import { relativeTime } from '../UpdatesFeed'
import { confirmDialog } from '../ui/dialog'
import { Switch } from '../ui/form-kit'
import { automationApi, type AutomationView } from './automation-api'
import RuleEditor from './rule-editor/RuleEditor'
import { dormantFix, finishedOnce, groupRules } from './rule-editor/rule-model'
import { CREATABLE, triggerLabel } from './rule-editor/triggers'

const C = COPY.ai.automations
const R = COPY.ai.rule
const REFRESH_DEBOUNCE_MS = 200

type Loaded = { automations: AutomationView[]; timeZone: string }

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ''
  }
}

/** 触发说明下面那一行：还不能生效 / 下次几点（盯页面：约几点汇报）/ 暂停了 / 已触发 */
function stateLine(r: AutomationView, zone: string): { text: string; warn: boolean } {
  if (r.enabled && r.dormant) return { text: r.dormant.text, warn: false }
  if (r.enabled) {
    if (!r.nextText) return { text: '', warn: false }
    const when = r.nextText + (r.timeZone !== zone ? C.inZone(r.timeZone) : '')
    return { text: r.source === 'page_watch' ? C.collecting(when) : C.next(when), warn: false }
  }
  if (r.pausedReason) return { text: C.autoPaused(r.pausedReason), warn: true }
  return { text: finishedOnce(r) ? C.finished : C.paused, warn: false }
}

const actionLabel = (type: string): string => (R.actionLabel as Record<string, string | undefined>)[type] ?? type

/** 最近一次：结局一句 + 多个动作时逐个的小标（悬停看原因） */
function LastResult({ rule: r }: { rule: AutomationView }) {
  const { last } = r
  if (!last) return <span>{C.never}</span>
  // 自动暂停的原因里已经写了最近一次失败的原因，不再重复
  const reason = r.pausedReason && last.reason && r.pausedReason.includes(last.reason) ? '' : last.reason
  return (
    <>
      <span className="ai-timer-last" data-status={last.status}>
        {C.lastLine(C.last[last.status], reason, relativeTime(last.at))}
      </span>
      {r.actions.length > 1 && last.results.length > 0 && (
        <span className="ai-rule-results">
          {last.results.map((x, i) => (
            <span key={i} className="ai-rule-result" data-status={x.status} data-tip={C.resultTip(i, actionLabel(x.type), C.result[x.status], x.reason)}>
              {i + 1}
            </span>
          ))}
        </span>
      )}
    </>
  )
}

/** 一条规则。others = 别人的规则（合集上列出来的）：写明是谁的，没有开关 / 编辑 / 删除；hideScope = 已经在挂靠页上了，不再写「挂在…」 */
export function RuleRow({
  rule: r,
  zone,
  busy,
  onToggle,
  onEdit,
  onRemove,
  hideScope = false,
}: {
  rule: AutomationView
  zone: string
  busy: boolean
  onToggle: (on: boolean) => void
  onEdit: () => void
  onRemove: () => void
  hideScope?: boolean
}) {
  const others = r.mine === false
  const navigate = useNavigate()
  const state = stateLine(r, zone)
  const scope = r.scopePage
  const dormant = r.enabled && r.dormant ? r.dormant : null
  const fix = dormantFix(dormant)
  return (
    <li className={'ai-timer ai-rule' + (r.enabled && !dormant ? '' : ' is-off') + (dormant ? ' is-dormant' : '')}>
      <div className="ai-timer-main">
        <div className="ai-timer-head">
          <span className="ai-timer-name">{r.name}</span>
          {r.builtin && (
            <span className="ai-rule-tag" data-tip={C.builtinTip}>
              {C.builtinTag}
            </span>
          )}
          {others && (
            <span className="ai-rule-tag" data-tip={C.here.ownerTip}>
              {C.here.owner(r.ownerName ?? '')}
            </span>
          )}
          <span className="ai-timer-when">{triggerLabel(r)}</span>
        </div>
        {state.text && (
          <div className={'ai-timer-state' + (state.warn ? ' is-warn' : '') + (dormant ? ' is-dormant' : '')}>
            {state.text}
            {fix && (
              <button className="ai-timer-link ai-rule-fix" type="button" onClick={() => (fix === 'settings' ? openSettings('quick') : navigate('/ai'))}>
                {fix === 'settings' ? C.fixSettings : C.fixGenet}
              </button>
            )}
          </div>
        )}
        {r.actionsText.length > 0 && (
          <ol className="ai-rule-actions">
            {r.actionsText.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        )}
        <div className="ai-timer-meta">
          {scope && !hideScope && (
            <>
              <button className="ai-timer-link" type="button" onClick={() => navigate(`/page/${scope.id}`)}>
                {C.scope(scope.title.trim() || COPY.untitled)}
              </button>
              <span aria-hidden="true">·</span>
            </>
          )}
          <LastResult rule={r} />
        </div>
      </div>
      {!others && !finishedOnce(r) && <Switch checked={r.enabled} onChange={(on) => !busy && onToggle(on)} label={C.toggle(r.name)} />}
      {!others && (
        <button className="ai-timer-del ai-rule-edit" type="button" data-tip={C.edit} aria-label={C.edit} disabled={busy} onClick={onEdit}>
          <Icon name="edit" size={14} />
        </button>
      )}
      {others ? null : r.builtin ? (
        // 内置规则不能删：留出删除按钮的位置，开关与别的组对齐
        <span className="ai-rule-del-gap" aria-hidden="true" />
      ) : (
        <button className="ai-timer-del" type="button" data-tip={C.remove} aria-label={C.remove} disabled={busy} onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      )}
    </li>
  )
}

export default function AutomationList({ pages, spaces }: { pages: Page[] | null; spaces: Space[] | null }) {
  const loaded = useCachedLoad<Loaded>('automations', () => automationApi.list())
  const { data, reload, set } = loaded
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{ rule: AutomationView | null } | null>(null)
  const [zone] = useState(browserZone)
  // 操作是异步的：回来时要在最新的列表上改（期间信号重拉过、别的行也改过），不能用发起那一刻的闭包
  const latest = useRef(data)
  latest.current = data

  useEffect(() => setError(loaded.error ? message(loaded.error, C.loadFailed) : null), [loaded.error])

  // Genet 设了 / 改了规则、某条规则触发了：'inbox' 信号；(重)连上的 'sync' 补拉。去抖合并
  useEffect(() => {
    let timer: number | undefined
    const off = subscribeControl((ev) => {
      if (ev !== 'inbox' && ev !== 'sync') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void reload(), REFRESH_DEBOUNCE_MS)
    })
    // 设置里加了 / 删了模型连接：内置规则的「还不能生效」跟着变（服务端按此刻的连接算）
    const offSettings = subscribeAiSettings(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void reload(), REFRESH_DEBOUNCE_MS)
    })
    return () => {
      window.clearTimeout(timer)
      off()
      offSettings()
    }
  }, [reload])

  const mark = (id: string, on: boolean): void =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // 只改这一条，别的行以手上最新的列表为准（期间信号重拉过的不被盖回去）
  const patch = (id: string, fn: (r: AutomationView) => AutomationView | null): void => {
    const cur = latest.current
    if (!cur) return
    const next = { ...cur, automations: cur.automations.flatMap((r) => (r.id === id ? (fn(r) ?? []) : [r])) }
    latest.current = next
    set(next)
  }

  async function toggle(r: AutomationView, on: boolean) {
    setError(null)
    mark(r.id, true)
    patch(r.id, (x) => ({ ...x, enabled: on }))
    try {
      const fresh = await automationApi.update(r.id, { enabled: on })
      patch(r.id, () => fresh)
    } catch (err) {
      patch(r.id, (x) => ({ ...x, enabled: r.enabled }))
      setError(message(err, C.toggleFailed))
      void reload()
    } finally {
      mark(r.id, false)
    }
  }

  async function remove(r: AutomationView) {
    if (!(await confirmDialog({ message: C.confirmRemove(r.name), danger: true, confirmLabel: C.remove }))) return
    setError(null)
    mark(r.id, true)
    try {
      await automationApi.remove(r.id)
      patch(r.id, () => null)
    } catch (err) {
      setError(message(err, C.removeFailed))
      void reload() // 404 多半是已经删掉了：以服务端为准
    } finally {
      mark(r.id, false)
    }
  }

  function saved(fresh: AutomationView) {
    const cur = latest.current
    if (cur) {
      const has = cur.automations.some((r) => r.id === fresh.id)
      const next = { ...cur, automations: has ? cur.automations.map((r) => (r.id === fresh.id ? fresh : r)) : [fresh, ...cur.automations] }
      latest.current = next
      set(next)
    }
    setEditing(null)
    void reload()
  }

  const rules = data?.automations ?? null
  return (
    <div className="ai-tasks ai-timers" data-flip>
      <div className="ai-rule-top">
        <p className="ai-sub">{C.sub}</p>
        {CREATABLE.length > 0 && (
          <button type="button" className="admin-btn primary ai-rule-new" onClick={() => setEditing({ rule: null })}>
            <Icon name="plus" size={14} />
            {C.create}
          </button>
        )}
      </div>
      {error && (
        <div className="ai-error" role="alert">
          <span>{error}</span>
          <button className="ai-error-close" type="button" data-tip={C.closeError} aria-label={C.closeError} onClick={() => setError(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {rules !== null && rules.length === 0 && (
        <div className="ai-empty-card">
          <b>{C.empty}</b>
          <span>{C.emptyHint}</span>
        </div>
      )}
      {rules &&
        groupRules(rules).map(({ group, rules: list }) => (
          <section key={group} className="ai-rule-group">
            <h2 className="ai-rule-group-title">
              {C.group[group]}
              <span className="ai-rule-count">{list.length}</span>
            </h2>
            <ul className="ai-timer-list">
              {list.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  zone={zone}
                  busy={busy.has(r.id)}
                  onToggle={(on) => void toggle(r, on)}
                  onEdit={() => setEditing({ rule: r })}
                  onRemove={() => void remove(r)}
                />
              ))}
            </ul>
          </section>
        ))}
      {editing && (
        <RuleEditor
          rule={editing.rule}
          timeZone={data?.timeZone ?? zone}
          pages={pages ?? []}
          spaces={spaces ?? []}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </div>
  )
}
