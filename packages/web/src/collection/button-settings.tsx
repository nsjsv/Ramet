/* ---------- 按钮属性的设置（属性编辑器里）：按钮上的字 + 要做的事 ----------
 * 都在那条「点按钮」规则里（按钮上的字 = 规则的 label），这里只开设置弹窗（ai/button-setup.tsx，按需加载），
 * 保存后把规则 id 与字写进属性配置（cfg.rule / cfg.label），格子据此画按钮、点了跑哪条。 */
import type * as Y from 'yjs'
import type { CollectionProp } from '@ramet/shared/collection-model'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { useRelationCtx } from './relation-ctx'
import { setPropCfg } from './schema-ops'

const C = COPY.collection

export function ButtonSettings({ doc, prop }: { doc: Y.Doc; prop: CollectionProp }) {
  const ctx = useRelationCtx()
  if (!ctx) return null
  const open = (): void => {
    void import('../ai/button-setup').then(({ openButtonSetup }) =>
      openButtonSetup({
        pageId: ctx.cid,
        ruleId: prop.cfg.rule ?? '',
        label: prop.cfg.label || prop.name,
        onSaved: (rule, label) => setPropCfg(doc, prop.id, { rule, label }),
      }),
    )
  }
  return (
    <button type="button" className="pop-row cl-add" onClick={open}>
      <Icon name="bolt" size={14} />
      {prop.cfg.rule ? C.prop.buttonEdit : C.prop.buttonSetup}
    </button>
  )
}
