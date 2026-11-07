/* ---------- 规则编辑器：「合集里有变化」的触发表单 ----------
 * 选合集（从合集的闪电按钮打开时固定是那个合集）→ 新增了一行 / 属性改了；属性改了可选「只看这些属性」与「改成满足这些条件」。
 * 条件编辑器与视图筛选是同一个（collection/toolbar/FilterMenu.tsx 的 ConditionsEditor），属性定义经 GET schema 取。
 * 能不能编辑那个合集、属性在不在、条件值填没填完，以服务端为准。 */
import { useEffect, useState } from 'react'
import { isComputedProp, TITLE_PROP, type CollectionSchema } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { Segmented } from '../../ui/form-kit'
import { collectionApi } from '../../collection/collection-api'
import { ConditionsEditor } from '../../collection/toolbar/FilterMenu'
import { toggleProp, type CollectionDraft } from './event-config'
import { PageField } from './fields'
import type { TriggerFormProps } from './triggers'

const K = COPY.ai.rule.collection

type Loaded = { id: string; schema: CollectionSchema } | { id: string; error: true } | null

export function CollectionTrigger({ draft, onChange, pages, scopePage }: TriggerFormProps<CollectionDraft>) {
  const [loaded, setLoaded] = useState<Loaded>(null)
  const cid = draft.collection
  useEffect(() => {
    if (!cid || draft.on !== 'edited') return
    let live = true
    collectionApi.schema(cid).then(
      (r) => live && setLoaded({ id: cid, schema: r.schema }),
      () => live && setLoaded({ id: cid, error: true }),
    )
    return () => {
      live = false
    }
  }, [cid, draft.on])
  const schema = loaded && loaded.id === cid && 'schema' in loaded ? loaded.schema : null
  const spaceId = pages.find((p) => p.id === cid)?.space_id ?? null
  // 值不在行里的属性（公式、汇总、按钮、创建时间…）不会「被改」：不列出来
  const props = schema ? [TITLE_PROP, ...schema.props.filter((p) => !isComputedProp(p))] : []

  return (
    <div className="rule-event">
      {!scopePage && (
        <div className="rule-field">
          <span>{K.which}</span>
          <PageField
            value={cid}
            onChange={(collection) => onChange({ ...draft, collection, props: [], conds: [] })}
            pages={pages}
            purpose="collection"
            label={K.which}
          />
        </div>
      )}
      <div className="rule-field">
        <span>{K.on}</span>
        <Segmented<'added' | 'edited'>
          value={draft.on}
          options={(['added', 'edited'] as const).map((on) => ({ value: on, label: K.ons[on] }))}
          onChange={(on) => onChange({ ...draft, on })}
          label={K.on}
        />
      </div>
      {draft.on === 'added' && <p className="rule-muted">{K.addedNote}</p>}
      {draft.on === 'edited' && cid && !schema && <p className="rule-muted">{loaded && 'error' in loaded && loaded.id === cid ? K.loadFailed : K.loading}</p>}
      {draft.on === 'edited' && schema && (
        <>
          <div className="rule-field">
            <span>{K.props}</span>
            <div className="rule-member-list" role="group" aria-label={K.props}>
              <button
                type="button"
                className={'rule-member' + (draft.props.length === 0 ? ' is-on' : '')}
                aria-pressed={draft.props.length === 0}
                onClick={() => onChange({ ...draft, props: [] })}
              >
                <span>{K.anyProp}</span>
                {draft.props.length === 0 && <Icon name="check" size={12} />}
              </button>
              {props.map((p) => {
                const on = draft.props.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={'rule-member' + (on ? ' is-on' : '')}
                    aria-pressed={on}
                    onClick={() => onChange({ ...draft, props: toggleProp(draft.props, p.id) })}
                  >
                    <span>{p.name || COPY.collection.types[p.type]}</span>
                    {on && <Icon name="check" size={12} />}
                  </button>
                )
              })}
            </div>
            <span className="rule-muted">{K.propsHint}</span>
          </div>
          <div className="rule-field">
            <span>{K.conds}</span>
            <div className="cl-menu cl-filter rule-conds">
              <ConditionsEditor schema={schema} conds={draft.conds} spaceId={spaceId} onChange={(conds) => onChange({ ...draft, conds })} />
            </div>
            <span className="rule-muted">{K.condsHint}</span>
          </div>
        </>
      )}
    </div>
  )
}
