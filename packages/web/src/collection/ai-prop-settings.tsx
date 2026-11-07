/* ---------- AI 属性的设置（属性编辑器里）：要求、填充、自动更新 ----------
 * 要求写进属性配置（cfg.prompt，失焦写）。「填空白的行 / 全部重新生成」= POST /api/collections/:id/ai-props/:prop/fill，服务端后台逐行填，
 * 值经集合增量回来。「行新增 / 改了之后自动更新」= 两条挂在这个集合上的规则（新增了一行、属性改了），动作是「填 AI 属性（事件所在的行）」，
 * 以打开它的人的身份、用他的模型连接；规则 id 记在 cfg.rules，关掉就删（别人建的删不掉就留着，开关只管自己这次建的）。 */
import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import type { CollectionProp } from '@ramet/shared/collection-model'
import { request } from '../api'
import { COPY } from '../copy'
import { Checkbox } from '../ui/Checkbox'
import { toast } from '../ui/toast'
import { useRelationCtx } from './relation-ctx'
import { setPropCfg } from './schema-ops'

const A = COPY.collection.prop.ai

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback)

export function AiPropSettings({ doc, prop }: { doc: Y.Doc; prop: CollectionProp }) {
  const ctx = useRelationCtx()
  const value = prop.cfg.prompt ?? ''
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const rules = prop.cfg.rules ?? []
  if (!ctx) return null
  const cid = ctx.cid

  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== value) setPropCfg(doc, prop.id, { prompt: draft.trim() })
  }

  async function fill(scope: 'empty' | 'all'): Promise<void> {
    commit()
    try {
      // 要求刚改：等它经协同到服务端（服务端按集合文档里的要求填）
      await new Promise((r) => setTimeout(r, 200))
      const out = await request<{ count: number }>(`/api/collections/${cid}/ai-props/${prop.id}/fill`, { method: 'POST', body: JSON.stringify({ scope }) })
      toast(out.count > 0 ? A.started(out.count) : A.nothing)
    } catch (err) {
      toast(message(err, A.failed), { kind: 'error' })
    }
  }

  async function setAuto(on: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    const { automationApi } = await import('../ai/automation-api')
    try {
      for (const id of rules) await automationApi.remove(id).catch(() => undefined)
      if (!on) return setPropCfg(doc, prop.id, { rules: [] })
      const action = [{ type: 'ai_prop' as const, collection: cid, prop: prop.id, row: 'event' }]
      const made: string[] = []
      for (const on of ['added', 'edited'] as const) {
        const out = await automationApi.create({
          name: `${A.ruleName}${prop.name}`.slice(0, 40),
          source: 'collection',
          config: { collection: cid, on, props: [], filter: { all: [] } },
          actions: action,
        })
        made.push(out.automation.id)
      }
      setPropCfg(doc, prop.id, { rules: made })
    } catch (err) {
      toast(message(err, A.autoFailed), { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cl-ai-prop">
      <label className="cl-field cl-field-col">
        <span>{A.prompt}</span>
        <textarea
          className="cl-input cl-ai-prompt"
          value={draft}
          rows={3}
          maxLength={2000}
          placeholder={A.placeholder}
          onFocus={() => setEditing(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </label>
      <button type="button" className="pop-row cl-add" onClick={() => void fill('empty')}>
        {A.fillEmpty}
      </button>
      <button type="button" className="pop-row cl-add" onClick={() => void fill('all')}>
        {A.fillAll}
      </button>
      <Checkbox
        className="cl-field"
        label={A.auto}
        tip={A.autoTip}
        checked={rules.length > 0}
        disabled={busy}
        onChange={() => void setAuto(rules.length === 0)}
      />
    </div>
  )
}
