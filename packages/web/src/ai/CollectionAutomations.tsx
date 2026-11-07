/* ---------- 合集上的自动化（合集工具栏的闪电按钮打开的弹窗）----------
 * 列出挂在这个合集上的规则（GET /api/pages/:id/automations：编辑者都看得到）：自己的能开关 / 编辑 / 删，别人的写明是谁的、只读。
 * 「新建自动化」开规则编辑器：来源在「合集里有变化 / 到点」之间选，规则挂在这个合集上。列表行与 AI 页同一个组件（AutomationList 的 RuleRow）。
 * 从集合里按需加载（Toolbar 里 lazy），不进集合的主包。 */
import { useCallback, useEffect, useState } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { useCollectionPages, useCollectionSpaces } from '../collection/collection-store'
import { confirmDialog } from '../ui/dialog'
import Modal from '../ui/Modal'
import { automationApi, type AutomationView, type RuleSource } from './automation-api'
import { browserZone, RuleRow } from './AutomationList'
import RuleEditor from './rule-editor/RuleEditor'

const C = COPY.ai.automations
const HERE_SOURCES: readonly RuleSource[] = ['collection', 'timer']

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export default function CollectionAutomations({ cid, title, onClose }: { cid: string; title: string; onClose: () => void }) {
  const pages = useCollectionPages()
  const spaces = useCollectionSpaces()
  const [rules, setRules] = useState<AutomationView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ rule: AutomationView | null } | null>(null)
  const [zone] = useState(browserZone)

  const load = useCallback(async () => {
    try {
      setRules(await automationApi.scoped(cid))
    } catch (err) {
      setError(message(err, C.loadFailed))
    }
  }, [cid])
  useEffect(() => void load(), [load])

  async function act(r: AutomationView, run: () => Promise<unknown>, fallback: string): Promise<void> {
    setBusy(r.id)
    setError(null)
    try {
      await run()
    } catch (err) {
      setError(message(err, fallback))
    } finally {
      setBusy(null)
      void load()
    }
  }

  async function remove(r: AutomationView): Promise<void> {
    if (!(await confirmDialog({ message: C.confirmRemove(r.name), danger: true, confirmLabel: C.remove }))) return
    await act(r, () => automationApi.remove(r.id), C.removeFailed)
  }

  return (
    <>
      <Modal onClose={onClose} className="rule-editor cl-autos" label={C.here.title}>
        <header className="rule-editor-head">
          <span className="rule-editor-ic">
            <Icon name="bolt" size={18} />
          </span>
          <h2 className="modal-title">{C.here.title}</h2>
          <button type="button" className="modal-close" onClick={onClose} data-tip={COPY.ai.rule.close} aria-label={COPY.ai.rule.close}>
            <Icon name="x" size={16} />
          </button>
        </header>
        {error && (
          <div className="ai-error rule-editor-error" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="rule-editor-body">
          {rules !== null && rules.length === 0 && <p className="rule-muted">{C.here.empty}</p>}
          {rules && rules.length > 0 && (
            <ul className="ai-timer-list">
              {rules.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  zone={zone}
                  busy={busy === r.id}
                  hideScope
                  onToggle={(on) => void act(r, () => automationApi.update(r.id, { enabled: on }), C.toggleFailed)}
                  onEdit={() => setEditing({ rule: r })}
                  onRemove={() => void remove(r)}
                />
              ))}
            </ul>
          )}
        </div>
        <footer className="rule-editor-foot">
          <button type="button" className="admin-btn primary ai-rule-new" onClick={() => setEditing({ rule: null })}>
            <Icon name="plus" size={14} />
            {C.here.create}
          </button>
        </footer>
      </Modal>
      {editing && (
        <RuleEditor
          rule={editing.rule}
          source="collection"
          sources={HERE_SOURCES}
          scopePage={{ id: cid, title }}
          timeZone={zone}
          pages={pages ?? []}
          spaces={spaces ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}
