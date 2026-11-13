/* ---------- 收件箱（/inbox）----------
 * 汇总各页面里需要你处理的事：审批、待批准的机器接入、使用申请 / 首次使用提醒、做完待你看的回合、在跑的回合、评论与正文里的 @、
 * 没能触发的规则、规则发来的通知。
 * 数据来自 GET /api/inbox（已按权限筛过），这里只渲染，不带来新权限，按钮调的都是已有接口：
 *   - 审批选项 = api.respondPermission（页面里的审批卡同一个接口）；
 *   - 批准 / 拒绝机器接入 = api.approveConnector / rejectConnector（设置 → 连接器同一个接口）；
 *   - 使用申请只展示，「去处理」跳到设置 → 机器，授权必须走那里的完整确认流程；
 *   - 评论 / 正文 @ 的「代回复」只是带 draft=1 跳到页面，草稿在页面的评论框里生成（⌘J 同一个接口），发不发由用户自己定。
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
import { draftReplyHref, splitInbox } from './inbox-model'
import { dropInboxItem, refreshInbox, useInbox } from './inbox-store'
import { confirmDialog } from '../ui/dialog'

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
            onClick={async () => {
              const ok = await confirmDialog({ message: C.pending.confirmReject(item.machine), danger: true, confirmLabel: C.pending.reject })
              if (ok) void run(() => api.rejectConnector(item.connectorId))
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

/** 定时器 / 规则没能触发：点标题去 AI 页的「自动」分页看（那里能重新打开 / 删掉）；「知道了」消掉这一条 */
function TimerFailedRow({ item }: { item: Of<'timer_failed'> }) {
  const navigate = useNavigate()
  const { busy, error, run } = useAct(item)
  const timer = (item.source ?? 'timer') === 'timer'
  return (
    <Row
      icon={timer ? 'clock' : 'bolt'}
      head={timer ? C.timer.head(item.timerName, item.reason) : C.timer.ruleHead(item.timerName, item.reason)}
      sub={timer ? C.timer.when(relativeTime(item.scheduledAt)) : C.timer.happened(relativeTime(item.scheduledAt))}
      onOpen={() => navigate('/ai/automations')}
      error={error}
      actions={
        <button className="inbox-btn" type="button" disabled={busy} onClick={() => void run(() => inboxApi.dismiss(item.key))}>
          {C.timer.ack}
        </button>
      }
    >
      {item.paused && (
        <div className="inbox-hint">
          <span className="inbox-tag">{C.timer.paused}</span> {C.timer.pausedHint}
        </div>
      )}
    </Row>
  )
}

/** 规则发来的通知：有事件所在页就点进去；「知道了」消掉这一条 */
function AutomationRow({ item }: { item: Of<'automation'> }) {
  const navigate = useNavigate()
  const { busy, error, run } = useAct(item)
  const pageId = item.pageId
  return (
    <Row
      icon="bolt"
      head={C.automation.head(item.ruleName, item.text)}
      sub={pageId ? `${C.automation.where(pageName(item.pageTitle))} · ${relativeTime(item.at)}` : relativeTime(item.at)}
      {...(pageId ? { onOpen: () => navigate(`/page/${pageId}`) } : {})}
      error={error}
      actions={
        <button className="inbox-btn" type="button" disabled={busy} onClick={() => void run(() => inboxApi.dismiss(item.key))}>
          {C.automation.ack}
        </button>
      }
    />
  )
}

/** 「代回复」按钮：先在本地摘掉这一条，再跳到页面起草（评论 / 正文 @ 共用）；这一条不能代回复就没有按钮 */
function draftReplyAction(item: Of<'comment'> | Of<'doc_mention'>, navigate: (to: string) => void): ReactNode | undefined {
  const href = draftReplyHref(item)
  if (!href) return undefined
  return (
    <button
      className="inbox-btn"
      type="button"
      data-tip={C.draftReplyTip}
      onClick={() => {
        dropInboxItem(item.key)
        navigate(href)
      }}
    >
      {C.draftReply}
    </button>
  )
}

/** 评论：点进页面并打开那个串（页面里打开串即记为已读），先在本地摘掉；「代回复」打开串并起草回复 */
function CommentRow({ item }: { item: Of<'comment'> }) {
  const navigate = useNavigate()
  const open = (): void => {
    dropInboxItem(item.key)
    navigate(`/page/${item.pageId}?comment=${item.threadId}`)
  }
  return (
    <Row
      icon="comment"
      head={C.comment.head(item.author?.name ?? C.comment.unknown, C.comment.reason[item.reason])}
      sub={`${C.comment.where(pageName(item.pageTitle))} · ${relativeTime(item.at)}`}
      onOpen={open}
      actions={draftReplyAction(item, navigate)}
    >
      {item.excerpt && <div className="inbox-detail-line inbox-excerpt">{item.excerpt}</div>}
    </Row>
  )
}

/** 正文里 @了你：点进页面并定位到那一块（打开那一页即算看过，服务端同「做完待你看」），先在本地摘掉；「代回复」在那一块开评论框起草 */
function DocMentionRow({ item }: { item: Of<'doc_mention'> }) {
  const navigate = useNavigate()
  const open = (): void => {
    dropInboxItem(item.key)
    navigate(`/page/${item.pageId}${item.blockId ? `?block=${encodeURIComponent(item.blockId)}` : ''}`)
  }
  return (
    <Row icon="at" head={C.docMention.head(item.actor.name, pageName(item.pageTitle))} sub={relativeTime(item.at)} onOpen={open} actions={draftReplyAction(item, navigate)}>
      {item.excerpt && <div className="inbox-detail-line inbox-excerpt">{item.excerpt}</div>}
    </Row>
  )
}

/** 分享给你：点进那一页（打开即算看过），先在本地摘掉 */
function ShareRow({ item }: { item: Of<'share'> }) {
  const navigate = useNavigate()
  const open = (): void => {
    dropInboxItem(item.key)
    navigate(`/page/${item.pageId}`)
  }
  return <Row icon="users" head={C.share.head(item.actor?.name ?? null, pageName(item.pageTitle))} sub={`${C.share.level[item.level]} · ${relativeTime(item.at)}`} onOpen={open} />
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
    case 'comment':
      return <CommentRow item={item} />
    case 'timer_failed':
      return <TimerFailedRow item={item} />
    case 'automation':
      return <AutomationRow item={item} />
    case 'doc_mention':
      return <DocMentionRow item={item} />
    case 'share':
      return <ShareRow item={item} />
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
