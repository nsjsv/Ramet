/* ---------- 规则编辑器（AI 页「自动」分页的新建 / 编辑弹窗）----------
 * 名字 + 触发（按来源从 triggers.tsx 的注册表取表单；没登记的来源只显示服务端的说明）+ 动作列表。内置规则的名字只读。
 * 新建时能在可新建的来源（CREATABLE，或调用方给的 sources）之间切换：换来源只重置触发的草稿，填好的动作留着；建好之后来源不能改。
 * 从合集的闪电按钮打开时带 scopePage：规则挂在那个合集上（合集的触发固定是它，定时的也挂上去），保存时一起发。
 * 收到外部请求：服务端在新建 / 换地址的响应里给一次完整地址，编辑器切到显示地址的面板（HookReveal），点「我记下了」才关（新建）或回到表单（换地址）。
 * 新建 = POST /api/me/automations；编辑只发改了的字段（rule-model.ts 的 changedFields）：没动时间表就不发 config，
 * 免得服务端按此刻重排下次触发。校验以服务端为准，400 的原因显示在顶部，指名了第几个动作的同时挂到那张卡片上。
 * 点遮罩不关（填到一半误点一下不该丢），Esc / 取消 / 关闭照常。 */
import { useMemo, useState } from 'react'
import type { Page, Space } from '../../api'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { Segmented } from '../../ui/form-kit'
import Modal from '../../ui/Modal'
import { automationApi, type AutomationView, type RuleSource } from '../automation-api'
import { ActionList } from './ActionList'
import { actionOf, changedFields, draftOf, errorIndex, newAction, ruleSpace, varsFor, type ActionDraft } from './rule-model'
import { CREATABLE, isFail, triggerLabel, triggerSpec } from './triggers'
import { HookReveal } from './WebhookTrigger'

const R = COPY.ai.rule

const message = (err: unknown): string => (err instanceof Error && err.message ? err.message : R.saveFailed)

export default function RuleEditor({
  rule,
  source: newSource = 'timer',
  sources = CREATABLE,
  scopePage = null,
  initialName = '',
  initialConfig,
  timeZone,
  pages,
  spaces,
  onClose,
  onSaved,
}: {
  /** null = 新建 */
  rule: AutomationView | null
  /** 新建时的来源 */
  source?: RuleSource
  /** 新建时能选的来源（缺省 = 能在 AI 页建的全部） */
  sources?: readonly RuleSource[]
  /** 挂在哪一页上（从合集 / 按钮打开的） */
  scopePage?: { id: string; title: string } | null
  /** 新建时预填的名字与触发配置（按钮：名字与按钮上的字先填成按钮现在的字） */
  initialName?: string
  initialConfig?: unknown
  /** 新规则按它计时（用户上报过的时区）；已有规则用它自己记下的 */
  timeZone: string
  pages: readonly Page[]
  spaces: readonly Space[]
  onClose: () => void
  onSaved: (rule: AutomationView) => void
}) {
  const [source, setSource] = useState(rule?.source ?? newSource)
  const spec = triggerSpec(source)
  const scope = scopePage ?? rule?.scopePage ?? null
  // 新的触发草稿：从合集打开的「合集里有变化」先填上这个合集
  const freshDraft = (s: string): unknown => {
    const spec = triggerSpec(s)
    if (spec && initialConfig !== undefined && s === newSource) return spec.draftOf(initialConfig, now)
    const d = spec?.initial(now) ?? null
    return s === 'collection' && scope && d && typeof d === 'object' ? { ...d, collection: scope.id } : d
  }
  const [now] = useState(() => new Date())
  const [name, setName] = useState(rule?.name ?? initialName)
  const [trigger, setTrigger] = useState<unknown>(() => (spec ? (rule ? spec.draftOf(rule.config, now) : freshDraft(source)) : null))
  const [drafts, setDrafts] = useState<ActionDraft[]>(() => (rule ? rule.actions.map(draftOf) : [newAction('genet', source)]))
  // 打开时的样子（经同一套草稿往返），保存时据此判断改了什么
  const [baseline] = useState(() => ({
    name: rule?.name ?? '',
    config: spec && rule ? JSON.stringify(spec.configOf(spec.draftOf(rule.config, now))) : '',
    actions: JSON.stringify(drafts.map(actionOf)),
  }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 只显示一次的地址；created = 刚建好（点「我记下了」交给列表），否则是换了地址（回到表单）
  const [reveal, setReveal] = useState<{ hookPath: string; rule: AutomationView; created: boolean } | null>(null)

  const personal = spaces.find((s) => s.is_personal)?.id ?? null
  const spaceId = ruleSpace(drafts, scope?.id ?? null, pages, personal)
  const ctx = useMemo(
    () => ({ pages, source, vars: varsFor(source), space: { id: spaceId, name: spaces.find((s) => s.id === spaceId)?.name ?? '' } }),
    [pages, source, spaceId, spaces],
  )
  const failedAt = error ? errorIndex(error) : null
  const zone = rule?.timeZone ?? timeZone
  // 内置规则（评论找我 / 正文 @我）不能改名：服务端拒，这里只读
  const builtin = Boolean(rule?.builtin)
  const title = rule ? R.titleEdit(rule.name) : R.titleNew

  async function save(): Promise<void> {
    if (busy) return
    if (!name.trim()) return setError(R.noName)
    if (drafts.length === 0) return setError(R.noActions)
    const config = spec ? spec.configOf(trigger) : undefined
    if (isFail(config)) return setError(config.error)
    const actions = drafts.map(actionOf)
    setBusy(true)
    setError(null)
    try {
      if (!rule) {
        // 新建的来源只会是 newSource 或 CREATABLE 里的一个
        const made = await automationApi.create({
          name: name.trim(),
          source: source as RuleSource,
          config,
          actions,
          ...(scopePage ? { scopePage: scopePage.id } : {}),
        })
        if (!made.hookPath) return onSaved(made.automation)
        setReveal({ hookPath: made.hookPath, rule: made.automation, created: true })
        setBusy(false)
        return
      }
      const patch = changedFields(baseline, { name, config, actions })
      if (Object.keys(patch).length === 0) return onClose()
      onSaved(await automationApi.update(rule.id, patch))
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} overlayCloses={false} className="rule-editor" label={title}>
      <header className="rule-editor-head">
        <span className="rule-editor-ic">
          <Icon name="bolt" size={18} />
        </span>
        <h2 className="modal-title">{title}</h2>
        <button type="button" className="modal-close" onClick={onClose} data-tip={R.close} aria-label={R.close}>
          <Icon name="x" size={16} />
        </button>
      </header>
      {error && (
        <div className="ai-error rule-editor-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {reveal ? (
        <div className="rule-editor-body">
          <HookReveal hookPath={reveal.hookPath} />
        </div>
      ) : (
        <div className="rule-editor-body">
          <label className="rule-field">
            <span>{R.name}</span>
            <input
              className="admin-field rule-text"
              value={name}
              placeholder={R.namePlaceholder}
              maxLength={40}
              readOnly={builtin}
              onChange={(e) => setName(e.target.value)}
            />
            {builtin && <span className="rule-muted">{R.nameFixed}</span>}
          </label>
          <section className="rule-section">
            <h3 className="rule-section-title">{R.trigger}</h3>
            {!rule && sources.length > 1 && (
              <Segmented<RuleSource>
                value={source as RuleSource}
                options={sources.map((s) => ({ value: s, label: R.sourcePick[s] ?? s }))}
                onChange={(s) => {
                  setSource(s)
                  setTrigger(freshDraft(s))
                  setError(null)
                }}
                label={R.trigger}
              />
            )}
            {spec ? (
              <spec.Form
                draft={trigger}
                onChange={setTrigger}
                timeZone={zone}
                spaces={spaces}
                pages={pages}
                ruleId={rule?.id ?? null}
                scopePage={scope}
                onReveal={(hookPath, fresh) => {
                  setTrigger(spec.draftOf(fresh.config, now))
                  setReveal({ hookPath, rule: fresh, created: false })
                }}
              />
            ) : (
              <p className="rule-muted">{R.triggerFixed(rule ? triggerLabel(rule) : source)}</p>
            )}
          </section>
          <section className="rule-section">
            <h3 className="rule-section-title">
              {R.actions}
              <span className="rule-muted">{R.actionsHint}</span>
            </h3>
            <ActionList drafts={drafts} onChange={setDrafts} ctx={ctx} error={failedAt !== null && error ? [failedAt, error] : null} />
          </section>
        </div>
      )}
      <footer className="rule-editor-foot">
        {reveal ? (
          <button type="button" className="admin-btn primary" onClick={() => (reveal.created ? onSaved(reveal.rule) : setReveal(null))}>
            {R.webhook.done}
          </button>
        ) : (
          <>
            <button type="button" className="admin-btn" onClick={onClose}>
              {R.cancel}
            </button>
            <button type="button" className="admin-btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? R.saving : R.save}
            </button>
          </>
        )}
      </footer>
    </Modal>
  )
}
