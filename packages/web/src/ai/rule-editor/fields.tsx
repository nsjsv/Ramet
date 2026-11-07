/* ---------- 规则编辑器的小控件：带变量提示的文字框、选页、选 agent、选成员、「属性 → 值」 ----------
 * 选页用页面列表（App 拉的 /api/pages：我是成员的全部空间）现筛，不另发请求；页面能不能用由服务端保存时按主人身份现判。
 * agent 用 /api/agents 的目录（useAgents），用不了的置灰并写原因；规则里记着、但目录里已经没有的 agent 照样显示，免得一打开就被换掉。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Page } from '../../api'
import { isAssistantPage } from '../../assistant/identity'
import { Avatar } from '../../Avatar'
import { COPY } from '../../copy'
import { useAgents } from '../../default-agent'
import { Icon } from '../../icons'
import { PageIcon } from '../../PageIcon'
import { selfId, spaceMembers, subscribePeople, type Person } from '../../people'
import { Popover } from '../../ui/popover'
import { Select } from '../../ui/Select'
import { insertVar, pageChoices, type Pair, type PagePurpose } from './rule-model'

const NOT_GENET = { choice: null, lock: '' }

const R = COPY.ai.rule

/** 文字框 + 下面一排变量 chip：点 chip 在光标处插 {{变量}} */
export function VarText({
  value,
  onChange,
  vars,
  multiline = false,
  placeholder,
  label,
  mono = false,
}: {
  value: string
  onChange: (v: string) => void
  vars: readonly string[]
  multiline?: boolean
  placeholder?: string
  label: string
  /** 等宽（webhook 的请求体） */
  mono?: boolean
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const caret = useRef<number | null>(null)
  // 插完变量把光标放回变量后面（受控组件重渲染后才能设）
  useEffect(() => {
    const el = ref.current
    if (el && caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })
  const insert = (name: string): void => {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const next = insertVar(value, start, end, name)
    caret.current = next.caret
    onChange(next.text)
    el?.focus()
  }
  const common = {
    ref,
    value,
    placeholder,
    'aria-label': label,
    className: 'admin-field rule-text' + (mono ? ' is-mono' : ''),
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  }
  return (
    <div className="rule-var-field">
      {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
      {vars.length > 0 && (
        <div className="rule-vars">
          <span className="rule-muted">{R.vars}</span>
          {vars.map((v) => (
            <button
              key={v}
              type="button"
              className="rule-var"
              data-tip={v === R.varRow ? R.varRowTip : R.varTip(v)}
              // 别把文字框的焦点与选区抢走：插入要知道光标在哪
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(v)}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一页的父级标题（同名页靠它分辨）；顶层页给空串 */
function parentTitle(pages: readonly Page[], page: Page): string {
  const parent = page.parent_id ? pages.find((p) => p.id === page.parent_id) : undefined
  return parent ? parent.title.trim() || COPY.untitled : ''
}

/** 选一页：按钮显示当前选中的页，点开弹层筛选 */
export function PageField({
  value,
  onChange,
  pages,
  purpose,
  label,
  clearable = false,
  emptyLabel = R.pagePick,
}: {
  value: string
  onChange: (id: string) => void
  pages: readonly Page[]
  purpose: PagePurpose
  label: string
  clearable?: boolean
  emptyLabel?: string
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Genet 页上只跑 Genet：叫 agent 不该列它（这次打开以来进过 Genet 对话才认得出；认不出时照样列着，到点由服务端判这一页能不能用那个 agent）
  const choices = useMemo(() => pageChoices(pages, purpose).filter((p) => purpose !== 'doc' || !isAssistantPage(p.id, NOT_GENET)), [pages, purpose])
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => choices.filter((p) => !q || (p.title || COPY.untitled).toLowerCase().includes(q)).slice(0, 80), [choices, q])
  useEffect(() => setActive(0), [query])
  const current = value ? pages.find((p) => p.id === value) : undefined
  const close = (): void => {
    setAnchor(null)
    setQuery('')
  }
  const pick = (id: string): void => {
    close()
    if (id !== value) onChange(id)
  }
  return (
    <>
      <button type="button" className={'rule-page' + (value ? '' : ' is-empty')} aria-label={label} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        {current ? <PageIcon icon={current.icon} size="sm" placeholder /> : <Icon name="file" size={14} />}
        <span className="rule-page-title">{current ? current.title.trim() || COPY.untitled : value ? R.pageGone : emptyLabel}</span>
        <Icon name="caret" size={12} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} className="rule-page-pop">
          <div className="cl-picker">
            <input
              autoFocus
              className="cl-picker-q"
              value={query}
              placeholder={R.pageSearch}
              aria-label={R.pageSearch}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (shown.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const hit = shown[active]
                  if (hit) pick(hit.id)
                }
              }}
            />
            <div className="cl-picker-list">
              {clearable && value && (
                <button type="button" className="pop-row cl-picker-clear" onClick={() => pick('')}>
                  {R.pageClear}
                </button>
              )}
              {shown.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  className={'pop-row cl-picker-row' + (i === active ? ' is-active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(p.id)}
                >
                  {p.icon ? <PageIcon icon={p.icon} /> : <Icon name={p.kind === 'collection' ? 'table' : 'file'} size={16} />}
                  <span className="rule-page-row">{p.title.trim() || COPY.untitled}</span>
                  {parentTitle(pages, p) && <span className="cl-picker-note">{parentTitle(pages, p)}</span>}
                  {p.id === value && <Icon name="check" size={14} className="cl-picker-check" />}
                </button>
              ))}
              {shown.length === 0 && <div className="cl-picker-empty">{R.pageNone}</div>}
            </div>
          </div>
        </Popover>
      )}
    </>
  )
}

/** 选 agent（不含 Genet：叫 Genet 是另一个动作） */
export function AgentField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { agents } = useAgents()
  const options = agents.map((a) => ({ value: a.id, label: a.label || a.id, disabled: Boolean(a.unavailable), ...(a.unavailable ? { tip: a.unavailable } : {}) }))
  if (value && !agents.some((a) => a.id === value)) options.unshift({ value, label: R.agentGone(value), disabled: false })
  return <Select value={value || null} options={options} onChange={onChange} label={R.agent} placeholder={R.agentPick} className="admin-field rule-select" />
}

/** 选几位空间成员（多选，自己不列：发给自己选「我」） */
export function MemberField({ spaceId, spaceName, value, onChange }: { spaceId: string | null; spaceName: string; value: readonly string[]; onChange: (ids: string[]) => void }) {
  // spaceMembers 每次给一个新数组，不能直接当 useSyncExternalStore 的快照；成员到了 / 换了空间时重读
  const [members, setMembers] = useState<Person[] | null>(() => (spaceId ? spaceMembers(spaceId) : null))
  useEffect(() => {
    if (!spaceId) return setMembers(null)
    const read = (): void => setMembers(spaceMembers(spaceId))
    read()
    return subscribePeople(read)
  }, [spaceId])
  const me = selfId()
  const others = (members ?? []).filter((m) => m.id !== me)
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="rule-members">
      {spaceName && <span className="rule-muted">{R.membersSpace(spaceName)}</span>}
      {members === null && <span className="rule-muted">{R.membersLoading}</span>}
      {members !== null && others.length === 0 && <span className="rule-muted">{R.membersNone}</span>}
      <div className="rule-member-list">
        {others.map((m) => (
          <button key={m.id} type="button" className={'rule-member' + (value.includes(m.id) ? ' is-on' : '')} aria-pressed={value.includes(m.id)} onClick={() => toggle(m.id)}>
            <Avatar person={m} size={18} />
            <span>{m.username}</span>
            {value.includes(m.id) && <Icon name="check" size={12} />}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 「属性 → 值」一行一对 */
export function PairsField({ pairs, onChange, vars, label }: { pairs: readonly Pair[]; onChange: (p: Pair[]) => void; vars: readonly string[]; label: string }) {
  const set = (i: number, patch: Partial<Pair>): void => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="rule-pairs" role="group" aria-label={label}>
      {pairs.map((p, i) => (
        <div key={i} className="rule-pair">
          <input className="admin-field rule-pair-key" value={p.key} placeholder={R.propKey} aria-label={R.propKey} onChange={(e) => set(i, { key: e.target.value })} />
          <div className="rule-pair-value">
            <VarText value={p.value} onChange={(value) => set(i, { value })} vars={i === pairs.length - 1 ? vars : []} placeholder={R.propValue} label={R.propValue} />
          </div>
          <button type="button" className="rule-icon-btn" data-tip={R.propRemove} aria-label={R.propRemove} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="rule-link-btn" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
        <Icon name="plus" size={12} />
        {R.propAdd}
      </button>
      <p className="rule-muted">{R.propsHint}</p>
    </div>
  )
}
