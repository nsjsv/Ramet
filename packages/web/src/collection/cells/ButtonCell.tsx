/* ---------- 按钮属性的格子：点一下以这一行为「事件所在的行」跑那条规则 ----------
 * 规则在属性配置里（cfg.rule，挂在这个集合上，triggers/sources/button.ts）；没设置 = 虚线、点不了，去属性设置里配。
 * 集合 id 取关联上下文（relation-ctx.ts：集合内容区与行页面属性区都提供）；没有上下文（版本预览）= 只读展示。
 * 能不能点由服务端判（只读成员 403 → Toast 说原因）。按下不冒泡：表格的选区 / 卡片的打开都不该被它触发。 */
import { useState } from 'react'
import type { CollectionProp, CollectionRow } from '@ramet/shared/collection-model'
import { request } from '../../api'
import { COPY } from '../../copy'
import { toast } from '../../ui/toast'
import { useRelationCtx } from '../relation-ctx'

const B = COPY.ai.rule.button

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

export function ButtonCell({ prop, row }: { prop: CollectionProp; row: CollectionRow }) {
  const ctx = useRelationCtx()
  const [busy, setBusy] = useState(false)
  const rule = prop.cfg.rule
  const label = prop.cfg.label || prop.name || B.fallback

  async function press(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    if (!ctx || !rule || busy) return
    setBusy(true)
    try {
      const out = await request<{ name: string }>(`/api/automations/${rule}/press`, { method: 'POST', body: JSON.stringify({ page: ctx.cid, row: row.id }) })
      toast(B.press(out.name))
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : B.pressFailed, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={'cl-btn' + (rule ? '' : ' is-unset') + (busy ? ' is-busy' : '')}
      disabled={!ctx || !rule}
      data-tip={rule ? undefined : COPY.collection.prop.buttonUnset}
      onMouseDown={stop}
      onDoubleClick={stop}
      onClick={(e) => void press(e)}
    >
      {label}
    </button>
  )
}
