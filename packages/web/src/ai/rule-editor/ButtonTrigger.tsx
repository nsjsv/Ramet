/* ---------- 规则编辑器：「点按钮」的触发表单 ----------
 * 只有按钮上的字（1–40 字）。按钮规则只从按钮上建（正文按钮块的「设置」、合集按钮列的属性设置），
 * 所以在「新建规则」里不出现（triggers.tsx 的 hidden）；AI 页里编辑已有的按钮规则时也只改这一项。 */
import { COPY } from '../../copy'
import type { TriggerFormProps } from './triggers'

const B = COPY.ai.rule.button

export type ButtonDraft = { label: string }

export function buttonDraftOf(config: unknown): ButtonDraft {
  const label = (config as { label?: unknown } | null)?.label
  return { label: typeof label === 'string' ? label : '' }
}

export function ButtonTrigger({ draft, onChange }: TriggerFormProps<ButtonDraft>) {
  return (
    <div className="rule-event">
      <label className="rule-field">
        <span>{B.label}</span>
        <input
          className="admin-field rule-text"
          value={draft.label}
          maxLength={40}
          placeholder={B.labelPlaceholder}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </label>
      <p className="rule-muted">{B.note}</p>
    </div>
  )
}
