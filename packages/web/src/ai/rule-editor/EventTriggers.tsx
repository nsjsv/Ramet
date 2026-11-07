/* ---------- 规则编辑器：事件触发的表单（评论找我、正文 @我、盯页面） ----------
 * 评论找我 / 正文 @我只出现在每人一条的内置规则上（不能新建，一人多条只会把同一件事通知好几遍）。
 * 能改的：评论的命中原因（至少一种）、只看哪些空间（不选 = 全部）。谁写的才算「别人」、哪些空间我是成员，由服务端按事件当下判。
 * 盯页面：选一页（普通页或合集）、含不含子页、别人停手多久算改完；能不能看那一页由服务端判。 */
import type { Space } from '../../api'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { Checkbox } from '../../ui/Checkbox'
import { Segmented } from '../../ui/form-kit'
import { COMMENT_REASONS } from '../automation-api'
import { quietChoices, toggleReason, toggleSpace, type CommentDraft, type MentionDraft, type WatchDraft } from './event-config'
import { PageField } from './fields'
import type { TriggerFormProps } from './triggers'

const R = COPY.ai.rule

const spaceName = (s: Space): string => s.name.trim() || (s.is_personal ? R.personalSpace : COPY.untitled)

/** 空间多选：第一项「全部空间」；配置里记着、但我已经不在的空间单独列出来，点一下去掉 */
function SpaceField({ value, onChange, spaces }: { value: readonly string[]; onChange: (ids: string[]) => void; spaces: readonly Space[] }) {
  const gone = value.filter((id) => !spaces.some((s) => s.id === id))
  const all = value.length === 0
  return (
    <div className="rule-field">
      <span>{R.spaces}</span>
      <div className="rule-member-list" role="group" aria-label={R.spaces}>
        <button type="button" className={'rule-member' + (all ? ' is-on' : '')} aria-pressed={all} onClick={() => onChange(toggleSpace(value, null))}>
          <span>{R.allSpaces}</span>
          {all && <Icon name="check" size={12} />}
        </button>
        {spaces.map((s) => {
          const on = value.includes(s.id)
          return (
            <button key={s.id} type="button" className={'rule-member' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => onChange(toggleSpace(value, s.id))}>
              <span>{spaceName(s)}</span>
              {on && <Icon name="check" size={12} />}
            </button>
          )
        })}
        {gone.map((id) => (
          <button key={id} type="button" className="rule-member is-gone" data-tip={R.spaceGoneTip} aria-label={R.spaceGoneTip} onClick={() => onChange(toggleSpace(value, id))}>
            <span>{R.spaceGone}</span>
            <Icon name="x" size={12} />
          </button>
        ))}
      </div>
      <span className="rule-muted">{R.spacesHint}</span>
    </div>
  )
}

export function CommentTrigger({ draft, onChange, spaces }: TriggerFormProps<CommentDraft>) {
  const C = R.comment
  return (
    <div className="rule-event">
      <div className="rule-field">
        <span>{C.reasons}</span>
        <div className="rule-checks" role="group" aria-label={C.reasons}>
          {COMMENT_REASONS.map((r) => (
            <Checkbox
              key={r}
              className="rule-check"
              label={C.reason[r]}
              tip={C.reasonHint[r]}
              checked={draft.reasons.includes(r)}
              onChange={() => onChange({ ...draft, reasons: toggleReason(draft.reasons, r) })}
            />
          ))}
        </div>
        {draft.reasons.length === 0 && <span className="rule-warn">{C.noReason}</span>}
      </div>
      <SpaceField value={draft.spaces} onChange={(ids) => onChange({ ...draft, spaces: ids })} spaces={spaces} />
      <p className="rule-muted">{C.note}</p>
    </div>
  )
}

export function WatchTrigger({ draft, onChange, pages }: TriggerFormProps<WatchDraft>) {
  const W = R.watch
  return (
    <div className="rule-event">
      <div className="rule-field">
        <span>{W.page}</span>
        <PageField value={draft.page} onChange={(page) => onChange({ ...draft, page })} pages={pages} purpose="parent" label={W.page} />
      </div>
      <Checkbox className="rule-check" label={W.subtree} checked={draft.subtree} onChange={() => onChange({ ...draft, subtree: !draft.subtree })} />
      <div className="rule-field">
        <span>{W.quiet}</span>
        <Segmented<string>
          value={String(draft.quiet)}
          options={quietChoices(draft.quiet).map((n) => ({ value: String(n), label: W.minutes(n) }))}
          onChange={(v) => onChange({ ...draft, quiet: Number(v) })}
          label={W.quiet}
        />
      </div>
      <p className="rule-muted">{W.note}</p>
    </div>
  )
}

export function MentionTrigger({ draft, onChange, spaces }: TriggerFormProps<MentionDraft>) {
  return (
    <div className="rule-event">
      <SpaceField value={draft.spaces} onChange={(ids) => onChange({ ...draft, spaces: ids })} spaces={spaces} />
      <p className="rule-muted">{R.mention.note}</p>
    </div>
  )
}
