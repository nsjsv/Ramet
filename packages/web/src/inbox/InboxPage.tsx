/* ---------- 收件箱（/inbox）----------
 * 汇总各页面里需要你处理的事：审批、待批准的机器接入、使用申请 / 首次使用提醒、做完待你看的回合、在跑的回合。
 * 数据来自 GET /api/inbox（已按权限筛过），这里只渲染，不带来新权限，按钮调的都是已有接口：
 *   - 审批选项 = api.respondPermission（页面里的审批卡同一个接口）；
 *   - 批准 / 拒绝机器接入 = api.approveConnector / rejectConnector（设置 → 连接器同一个接口）；
 *   - 使用申请只展示，「去处理」跳到设置 → 机器，授权必须走那里的完整确认流程。
 * 答完 / 批准完先乐观摘除，之后服务端的 'inbox' 信号会重拉校正。 */

import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { COPY } from '../copy'
import { Icon, type IconName } from '../icons'
import { scopesLabel } from '../machine-format'
import { openSettings } from '../settings-bus'
import { relativeTime } from '../UpdatesFeed'
import type { InboxItem } from './inbox-api'
import { inboxApi } from './inbox-api'
import { splitInbox } from './inbox-model'
import { dropInboxItem, refreshInbox, useInbox } from './inbox-store'

const C = COPY.inbox

type Of<T extends InboxItem['type']> = Extract<InboxItem, { type: T }>

const pageName = (title: string): string => title.trim() || COPY.untitled

/** 一行条目的外壳：图标 + 标题 / 副标题 + 正文 + 按钮 */
function Row({
  icon,
  head,
  sub,
  onOpen,
  actions,
  error,
  children,
}: {
  icon: IconName
  head: string
  sub?: string
  /** 整行可点（跳转）；有按钮的行只让标题区可点，免得误触 */
  onOpen?: () => void
  actions?: ReactNode
  error?: string | null
  children?: ReactNode
}) {
  const title = (
    <>
      <span className="inbox-head">{head}</span>
      {sub && <span className="inbox-sub">{sub}</span>}
    </>
  )
  return (
    <li className="inbox-row">
      <span className="inbox-ic">
        <Icon name={icon} size={16} />
      </span>
      <div className="inbox-main">
        {onOpen ? (
          <button className="inbox-title is-link" type="button" onClick={onOpen}>
            {title}
          </button>
        ) : (
          <div className="inbox-title">{title}</div>
        )}
        {children}
        {error && <div className="inbox-error">{error}</div>}
      </div>
      {actions && <div className="inbox-acts">{actions}</div>}
    </li>
  )
}

/** 执行一个操作：成功摘除；失败显示服务端给的人话并重拉校正。404 = 已经被别处处理了，静默摘除 */
function useAct(item: InboxItem) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await fn()
      dropInboxItem(item.key)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        dropInboxItem(item.key)
        void refreshInbox()
        return
      }
      setError(err instanceof Error && err.message ? err.message : C.failed)
      setBusy(false)
      void refreshInbox()
    }
  }
  return { busy, error, run }
}

function ApprovalRow({ item }: { item: Of<'approval'> }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const { busy, error, run } = useAct(item)
  const d = item.detail
  const hasDetail = Boolean(d.command || d.path || d.description)
  return (
    <Row
      icon="bot"
      head={item.title || C.approval.head(item.agentName)}
      sub={`${C.approval.head(item.agentName)} · ${C.approval.where(pageName(item.pageTitle))}`}
      onOpen={() => navigate(`/page/${item.pageId}`)}
      error={error}
      actions={item.options.map((option, i) => (
        <button
          key={option.optionId}
          type="button"
          className={'inbox-btn' + (option.kind?.startsWith('reject') ? ' is-reject' : i === 0 ? ' is-primary' : '')}
          disabled={busy}
          onClick={() => void run(() => api.respondPermission(item.pageId, item.agentId, item.requestId, option.optionId))}
        >
          {option.name}
        </button>
      ))}
    >
      {hasDetail && (
        <>
          <button className="inbox-more" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? C.approval.hide : C.approval.show}
          </button>
          {open && (
            <div className="inbox-detail">
              {d.description && <div className="inbox-detail-line">{d.description}</div>}
              {d.path && (
                <div className="inbox-detail-line">
                  <b>{C.approval.path}</b> <code>{d.path}</code>
                </div>
              )}
              {d.command && <pre className="inbox-code">{d.command}</pre>}
            </div>
          )}
        </>
      )}
    </Row>
  )
}

function PendingRow({ item }: { item: Of<'connector_pending'> }) {
  const { busy, error, run } = useAct(item)
  return (
    <Row
      icon="plug"
      head={C.pending.head(item.owner ?? C.pending.unknownOwner, item.machine)}
      sub={C.pending.sub(item.spaceName, item.agents)}
      error={error}
      actions={
        <>
          <button className="inbox-btn is-primary" type="button" disabled={busy} onClick={() => void run(() => api.approveConnector(item.connectorId))}>
            {C.pending.approve}
          </button>
          <button
            className="inbox-btn is-reject"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(C.pending.confirmReject(item.machine))) void run(() => api.rejectConnector(item.connectorId))
            }}
          >
            {C.pending.reject}
          </button>
        </>
      }
    >
      <div className="inbox-hint">{C.pending.note}</div>
    </Row>
  )
}

function RequestRow({ item }: { item: Of<'access_request'> }) {
  return (
    <Row
      icon="users"
      head={C.request.head(item.username, item.machine)}
      sub={C.request.sub(item.spaceName, scopesLabel(item.scopes))}
      actions={
        <button className="inbox-btn is-primary" type="button" onClick={() => openSettings('machines', item.spaceId)}>
          {C.request.handle}
        </button>
      }
    >
      {item.note && <div className="inbox-detail-line">{C.request.note(item.note)}</div>}
      <div className="inbox-hint">{C.request.hint}</div>
    </Row>
  )
}

function FirstUseRow({ item }: { item: Of<'first_use'> }) {
  const { busy, error, run } = useAct(item)
  return (
    <Row
      icon="user"
      head={C.firstUse.head(item.username, item.machine)}
      sub={`${C.firstUse.sub(scopesLabel(item.scopes))} · ${relativeTime(item.at)}`}
      error={error}
      actions={
        <button className="inbox-btn" type="button" disabled={busy} onClick={() => void run(() => inboxApi.dismiss(item.key))}>
          {C.firstUse.ack}
        </button>
      }
    />
  )
}

function DoneRow({ item }: { item: Of<'done'> }) {
  const navigate = useNavigate()
  const name = pageName(item.pageTitle)
  const head = item.outcome === 'error' ? C.done.error(name) : item.outcome === 'cancelled' ? C.done.cancelled(name) : C.done.end(name)
  return (
    <Row
      icon={item.outcome === 'error' ? 'callout-warning' : 'check'}
      head={head}
      sub={`${item.agentName} · ${relativeTime(item.at)}`}
      onOpen={() => navigate(`/page/${item.pageId}`)}
      actions={
        <button className="inbox-btn" type="button" onClick={() => navigate(`/page/${item.runPageId}`)}>
          {C.done.process}
        </button>
      }
    />
  )
}

function RunningRow({ item }: { item: Of<'running'> }) {
  const navigate = useNavigate()
  return (
    <Row
      icon="run"
      head={C.running.head(pageName(item.pageTitle))}
      sub={`${item.agentName} · ${C.running.since(relativeTime(item.at))}`}
      onOpen={() => navigate(`/page/${item.pageId}`)}
    />
  )
}

/** 等你批计划（带队）：点进页面，计划卡就在那条回复里（改完点「开工」）。等你回答（agent 的提问）：点进页面，表单在运行条里 */
function PageTaskRow({ item }: { item: Of<'question'> | Of<'plan'> }) {
  const navigate = useNavigate()
  const name = pageName(item.pageTitle)
  const plan = item.type === 'plan'
  const open = (): void => navigate(`/page/${item.pageId}`)
  return (
    <Row
      icon={plan ? 'users' : 'say'}
      head={plan ? C.plan.head(name) : C.question.head(name)}
      sub={plan ? `${item.title} · ${relativeTime(item.at)}` : item.text}
      onOpen={open}
      actions={
        <button className="inbox-btn is-primary" type="button" onClick={open}>
          {plan ? C.plan.go : C.open}
        </button>
      }
    />
  )
}

function ItemRow({ item }: { item: InboxItem }) {
  switch (item.type) {
    case 'approval':
      return <ApprovalRow item={item} />
    case 'connector_pending':
      return <PendingRow item={item} />
    case 'access_request':
      return <RequestRow item={item} />
    case 'first_use':
      return <FirstUseRow item={item} />
    case 'done':
      return <DoneRow item={item} />
    case 'running':
      return <RunningRow item={item} />
    case 'question':
    case 'plan':
      return <PageTaskRow item={item} />
  }
}

function Group({ title, items }: { title: string; items: InboxItem[] }) {
  if (items.length === 0) return null
  return (
    <section className="inbox-group">
      <h2 className="inbox-group-title">
        {title}
        <span className="inbox-count">{items.length}</span>
      </h2>
      <ul className="inbox-list">
        {items.map((item) => (
          <ItemRow key={item.key} item={item} />
        ))}
      </ul>
    </section>
  )
}

export default function InboxPage() {
  const { items, loaded, failed } = useInbox()
  const groups = splitInbox(items)
  return (
    <div className="inbox-page">
      <h1 className="inbox-title-h">{C.title}</h1>
      <p className="inbox-intro">{C.sub}</p>
      {failed && <div className="inbox-error">{C.loadFailed}</div>}
      {!loaded && <p className="inbox-empty-hint">{C.loading}</p>}
      {loaded && items.length === 0 && !failed && (
        <div className="inbox-empty">
          <b>{C.empty}</b>
          <span>{C.emptyHint}</span>
        </div>
      )}
      <Group title={C.group.attention} items={groups.attention} />
      <Group title={C.group.news} items={groups.news} />
      <Group title={C.group.running} items={groups.running} />
    </div>
  )
}
