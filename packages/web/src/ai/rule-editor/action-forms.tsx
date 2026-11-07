/* ---------- 规则编辑器：每种动作一张表单 ----------
 * 只编辑草稿（rule-model.ts 的 ActionDraft），保存时才转成 JSON；页面 / agent / 属性名对不对由服务端保存时现判，原因显示回这张卡片上。 */
import type { ReactNode } from 'react'
import type { Page } from '../../api'
import { COPY } from '../../copy'
import { Segmented } from '../../ui/form-kit'
import { AgentField, MemberField, PageField, PairsField, VarText } from './fields'
import { EVENT_ROW, hasEventRow, type ActionDraft } from './rule-model'

const R = COPY.ai.rule

export type ActionFormCtx = {
  pages: readonly Page[]
  /** 规则的来源：定时、评论、正文提及没有「事件所在的行」（rule-model.ts 的 hasEventRow） */
  source: string
  /** 文字里能插的变量 */
  vars: readonly string[]
  /** 规则所在空间（发通知能选它的成员） */
  space: { id: string | null; name: string }
}

type Props<T extends ActionDraft['type']> = { draft: Extract<ActionDraft, { type: T }>; onChange: (d: ActionDraft) => void; ctx: ActionFormCtx }

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rule-field">
      <span>{label}</span>
      {children}
      {hint && <span className="rule-muted">{hint}</span>}
    </div>
  )
}

function GenetForm({ draft, onChange, ctx }: Props<'genet'>) {
  return (
    <Field label={R.instruction}>
      <VarText multiline value={draft.instruction} onChange={(instruction) => onChange({ ...draft, instruction })} vars={ctx.vars} placeholder={R.genetPlaceholder} label={R.instruction} />
    </Field>
  )
}

function AgentForm({ draft, onChange, ctx }: Props<'agent'>) {
  return (
    <>
      <div className="rule-row2">
        <Field label={R.page}>
          <PageField value={draft.page} onChange={(page) => onChange({ ...draft, page })} pages={ctx.pages} purpose="doc" label={R.page} />
        </Field>
        <Field label={R.agent}>
          <AgentField value={draft.agent} onChange={(agent) => onChange({ ...draft, agent })} />
        </Field>
      </div>
      <Field label={R.instruction}>
        <VarText multiline value={draft.instruction} onChange={(instruction) => onChange({ ...draft, instruction })} vars={ctx.vars} placeholder={R.agentPlaceholder} label={R.instruction} />
      </Field>
    </>
  )
}

function SetPropsForm({ draft, onChange, ctx }: Props<'set_props'>) {
  // 事件不带合集行的来源（定时、评论、正文提及）：只能指定一行（定时规则服务端也会拒 'event'）
  const canEvent = hasEventRow(ctx.source)
  const mode = canEvent && draft.row === EVENT_ROW ? 'event' : 'pick'
  return (
    <>
      <Field label={R.row}>
        {canEvent && (
          <Segmented<'event' | 'pick'>
            value={mode}
            label={R.row}
            options={[
              { value: 'event', label: R.eventRow },
              { value: 'pick', label: R.pickRow },
            ]}
            onChange={(m) => onChange({ ...draft, row: m === 'event' ? EVENT_ROW : '' })}
          />
        )}
        {mode === 'pick' && <PageField value={draft.row === EVENT_ROW ? '' : draft.row} onChange={(row) => onChange({ ...draft, row })} pages={ctx.pages} purpose="row" label={R.row} />}
      </Field>
      <Field label={R.props}>
        <PairsField pairs={draft.pairs} onChange={(pairs) => onChange({ ...draft, pairs })} vars={ctx.vars} label={R.props} />
      </Field>
    </>
  )
}

function CreatePageForm({ draft, onChange, ctx }: Props<'create_page'>) {
  const parent = ctx.pages.find((p) => p.id === draft.parent)
  return (
    <>
      <div className="rule-row2">
        <Field label={R.parent} hint={R.parentHint}>
          <PageField value={draft.parent} onChange={(id) => onChange({ ...draft, parent: id })} pages={ctx.pages} purpose="parent" label={R.parent} />
        </Field>
        <Field label={R.template}>
          <PageField
            value={draft.template}
            onChange={(template) => onChange({ ...draft, template })}
            pages={ctx.pages}
            purpose="template"
            label={R.template}
            clearable
            emptyLabel={R.noTemplate}
          />
        </Field>
      </div>
      <Field label={R.title}>
        <VarText value={draft.title} onChange={(title) => onChange({ ...draft, title })} vars={ctx.vars} label={R.title} />
      </Field>
      {(parent?.kind === 'collection' || draft.pairs.length > 0) && (
        <Field label={R.rowProps}>
          <PairsField pairs={draft.pairs} onChange={(pairs) => onChange({ ...draft, pairs })} vars={ctx.vars} label={R.rowProps} />
        </Field>
      )}
    </>
  )
}

function NotifyForm({ draft, onChange, ctx }: Props<'notify'>) {
  return (
    <>
      <Field label={R.to}>
        <Segmented<'owner' | 'members'>
          value={draft.to}
          label={R.to}
          options={[
            { value: 'owner', label: R.toOwner },
            { value: 'members', label: R.toMembers },
          ]}
          onChange={(to) => onChange({ ...draft, to })}
        />
        {draft.to === 'members' && <MemberField spaceId={ctx.space.id} spaceName={ctx.space.name} value={draft.members} onChange={(members) => onChange({ ...draft, members })} />}
      </Field>
      <Field label={R.text}>
        <VarText multiline value={draft.text} onChange={(text) => onChange({ ...draft, text })} vars={ctx.vars} label={R.text} />
      </Field>
    </>
  )
}

function WebhookForm({ draft, onChange, ctx }: Props<'webhook'>) {
  return (
    <>
      <Field label={R.url}>
        <input className="admin-field rule-text" value={draft.url} placeholder={R.urlPlaceholder} aria-label={R.url} inputMode="url" onChange={(e) => onChange({ ...draft, url: e.target.value })} />
      </Field>
      <Field label={R.body} hint={R.bodyHint}>
        <VarText multiline mono value={draft.body} onChange={(body) => onChange({ ...draft, body })} vars={ctx.vars} label={R.body} />
      </Field>
    </>
  )
}

export function ActionForm({ draft, onChange, ctx }: { draft: ActionDraft; onChange: (d: ActionDraft) => void; ctx: ActionFormCtx }) {
  switch (draft.type) {
    case 'genet':
      return <GenetForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'agent':
      return <AgentForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'set_props':
      return <SetPropsForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'create_page':
      return <CreatePageForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'notify':
      return <NotifyForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'webhook':
      return <WebhookForm draft={draft} onChange={onChange} ctx={ctx} />
    case 'ai_gen':
      return <AiGenForm draft={draft} ctx={ctx} />
    case 'ai_prop':
      return <AiPropForm draft={draft} ctx={ctx} />
  }
}

/** 填 AI 属性：只读（在合集的 AI 属性设置里开关「自动更新」） */
function AiPropForm({ draft, ctx }: { draft: Extract<ActionDraft, { type: 'ai_prop' }>; ctx: Props<'ai_prop'>['ctx'] }) {
  const title = ctx.pages.find((p) => p.id === draft.collection)?.title
  return <p className="rule-muted">{R.aiPropNote(title === undefined ? R.pageGone : title.trim() || COPY.untitled)}</p>
}

/** 刷新 AI 块：只读（在 AI 块上改「自动更新」，块 id 不在这里填） */
function AiGenForm({ draft, ctx }: { draft: Extract<ActionDraft, { type: 'ai_gen' }>; ctx: Props<'ai_gen'>['ctx'] }) {
  const title = ctx.pages.find((p) => p.id === draft.page)?.title
  return <p className="rule-muted">{R.aiGenNote(title === undefined ? R.pageGone : title.trim() || COPY.untitled)}</p>
}
