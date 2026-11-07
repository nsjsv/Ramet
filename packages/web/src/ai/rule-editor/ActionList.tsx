/* ---------- 规则编辑器：动作列表（按序执行；增删、上下移，每个动作一张卡片） ----------
 * 服务端的「第 N 个动作：…」错误挂到对应的卡片上（rule-model.ts 的 errorIndex），顶部同时有整句。 */
import { useState } from 'react'
import { COPY } from '../../copy'
import { Icon } from '../../icons'
import { Popover } from '../../ui/popover'
import type { ActionType } from '../automation-api'
import { ActionForm, type ActionFormCtx } from './action-forms'
import { ACTION_TYPES, MAX_ACTIONS, moveItem, newAction, type ActionDraft } from './rule-model'

const R = COPY.ai.rule

export function ActionList({
  drafts,
  onChange,
  ctx,
  error,
}: {
  drafts: readonly ActionDraft[]
  onChange: (d: ActionDraft[]) => void
  ctx: ActionFormCtx
  /** 服务端指名的那个动作出的错：[第几个（0 起）, 原因] */
  error: [number, string] | null
}) {
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const full = drafts.length >= MAX_ACTIONS
  const add = (type: ActionType): void => {
    setMenu(null)
    onChange([...drafts, newAction(type, ctx.source)])
  }
  return (
    <div className="rule-actions">
      <ol className="rule-action-list">
        {drafts.map((d, i) => (
          <li key={d.uid} className={'rule-action' + (error?.[0] === i ? ' is-error' : '')}>
            <div className="rule-action-head">
              <span className="rule-action-n">{i + 1}</span>
              <span className="rule-action-label">{R.actionLabel[d.type]}</span>
              <span className="rule-action-desc">{R.actionDesc[d.type]}</span>
              <span className="rule-action-tools">
                <button type="button" className="rule-icon-btn" data-tip={R.up} aria-label={R.up} disabled={i === 0} onClick={() => onChange(moveItem(drafts, i, -1))}>
                  <Icon name="arrow-up" size={12} />
                </button>
                <button
                  type="button"
                  className="rule-icon-btn"
                  data-tip={R.down}
                  aria-label={R.down}
                  disabled={i === drafts.length - 1}
                  onClick={() => onChange(moveItem(drafts, i, 1))}
                >
                  <Icon name="arrow-down" size={12} />
                </button>
                <button type="button" className="rule-icon-btn is-danger" data-tip={R.removeAction} aria-label={R.removeAction} onClick={() => onChange(drafts.filter((x) => x !== d))}>
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </div>
            <div className="rule-action-body">
              <ActionForm draft={d} onChange={(next) => onChange(drafts.map((x) => (x === d ? next : x)))} ctx={ctx} />
            </div>
            {error?.[0] === i && (
              <div className="rule-action-error" role="alert">
                {error[1]}
              </div>
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="rule-add"
        disabled={full}
        aria-expanded={menu !== null}
        data-tip={full ? R.maxActions(MAX_ACTIONS) : undefined}
        onClick={(e) => setMenu(menu ? null : e.currentTarget)}
      >
        <Icon name="plus" size={14} />
        {R.add}
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} className="rule-add-pop">
          <div className="cl-menu">
            {ACTION_TYPES.map((t) => (
              <button key={t} type="button" className="pop-row rule-add-row" onClick={() => add(t)}>
                <span className="rule-add-label">{R.actionLabel[t]}</span>
                <span className="rule-add-desc">{R.actionDesc[t]}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}
