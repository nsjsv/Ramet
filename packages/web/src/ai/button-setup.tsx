/* ---------- 设置按钮（正文按钮块的「设置」、合集按钮列的属性设置共用）----------
 * 按钮指着一条挂在这一页 / 合集上的「点按钮」规则：没有 / 找不到（删了、复制过来的）→ 新建一条（名字与按钮上的字先填成按钮现在的字）；
 * 是自己的 → 编辑它；是别人的 → 说明是谁的、列出要做的事，可以「换成我自己的设置」（新建一条，原来那条留在他那里）。
 * 保存后把规则 id 与按钮上的字交回调用方写进节点 / 属性。挂在命令式浮层上（ui/layer-host.tsx 的 mountLayer）：
 * 编辑器的节点视图不是 React 组件，这里也不依赖路由。从编辑器按需加载。 */
import { useEffect, useState } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { useCollectionPages, useCollectionSpaces } from '../collection/collection-store'
import { mountLayer } from '../ui/layer-host'
import Modal from '../ui/Modal'
import { automationApi, type AutomationView } from './automation-api'
import { browserZone } from './AutomationList'
import { buttonDraftOf } from './rule-editor/ButtonTrigger'
import RuleEditor from './rule-editor/RuleEditor'

const B = COPY.ai.rule.button

export type ButtonSetupInput = {
  /** 按钮所在的页（合集按钮列 = 合集） */
  pageId: string
  ruleId: string
  label: string
  onSaved: (ruleId: string, label: string) => void
}

export function openButtonSetup(input: ButtonSetupInput): void {
  const close = mountLayer(<ButtonSetup {...input} onClose={() => close()} />)
}

type State = { kind: 'loading' } | { kind: 'edit'; rule: AutomationView | null } | { kind: 'others'; rule: AutomationView }

function ButtonSetup({ pageId, ruleId, label, onSaved, onClose }: ButtonSetupInput & { onClose: () => void }) {
  const pages = useCollectionPages()
  const spaces = useCollectionSpaces()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [zone] = useState(browserZone)

  useEffect(() => {
    if (!ruleId) return setState({ kind: 'edit', rule: null })
    let live = true
    automationApi.scoped(pageId).then(
      (list) => {
        if (!live) return
        const found = list.find((r) => r.id === ruleId)
        setState(!found ? { kind: 'edit', rule: null } : found.mine === false ? { kind: 'others', rule: found } : { kind: 'edit', rule: found })
      },
      () => live && setState({ kind: 'edit', rule: null }),
    )
    return () => {
      live = false
    }
  }, [pageId, ruleId])

  if (state.kind === 'loading') return null
  if (state.kind === 'others') {
    const r = state.rule
    return (
      <Modal onClose={onClose} className="rule-editor" label={B.othersTitle(r.ownerName ?? '')}>
        <header className="rule-editor-head">
          <span className="rule-editor-ic">
            <Icon name="bolt" size={18} />
          </span>
          <h2 className="modal-title">{B.othersTitle(r.ownerName ?? '')}</h2>
          <button type="button" className="modal-close" onClick={onClose} data-tip={B.close} aria-label={B.close}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="rule-editor-body">
          <p className="rule-muted">{r.triggerText}</p>
          <ol className="ai-rule-actions">
            {r.actionsText.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
          <p className="rule-muted">{B.othersNote}</p>
        </div>
        <footer className="rule-editor-foot">
          <button type="button" className="admin-btn" onClick={onClose}>
            {B.close}
          </button>
          <button type="button" className="admin-btn primary" onClick={() => setState({ kind: 'edit', rule: null })}>
            {B.replace}
          </button>
        </footer>
      </Modal>
    )
  }
  const fallback = label.trim() || B.fallback
  return (
    <RuleEditor
      rule={state.rule}
      source="button"
      sources={['button']}
      scopePage={{ id: pageId, title: '' }}
      initialName={fallback}
      initialConfig={{ label: fallback }}
      timeZone={zone}
      pages={pages ?? []}
      spaces={spaces ?? []}
      onClose={onClose}
      onSaved={(saved) => {
        onSaved(saved.id, buttonDraftOf(saved.config).label || fallback)
        onClose()
      }}
    />
  )
}
