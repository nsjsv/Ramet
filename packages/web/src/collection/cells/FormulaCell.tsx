// ---------- 公式格：按编译出的输出类型显示；公式有误时整列显示「公式有误」，悬停看原因 ----------
// 值两端各算（shared 的 fillFormulas，写进 row.computed），这里只经 rowValue 读，不另算。
// 还没写的公式（empty）整列留空，不报错：刚建的公式属性不该满屏「公式有误」。
import { formulaNumberText, rowValue, type CollectionProp, type CollectionRow } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { formulaText } from '../value-text'

const F = COPY.collection.formula

/** 这一列公式有误要不要显示出来（还没写不算） */
export function formulaBroken(prop: CollectionProp): boolean {
  return prop.type === 'formula' && !prop.output && prop.formulaError?.code !== 'empty'
}

export function FormulaCell({ prop, row }: { prop: CollectionProp; row: CollectionRow }) {
  if (!prop.output) {
    return formulaBroken(prop) ? (
      <span className="cl-text is-dim cl-formula-bad" data-tip={prop.formulaError?.message}>
        {F.bad}
      </span>
    ) : null
  }
  const value = rowValue(row, prop)
  if (value === undefined) return null
  switch (prop.output) {
    case 'number':
      return typeof value === 'number' ? <span className="cl-text is-num">{formulaNumberText(value)}</span> : null
    case 'boolean':
      return <span className={'check-box is-static' + (value === true ? ' is-on' : '')} role="checkbox" aria-checked={value === true} aria-readonly="true" />
    default:
      return <span className="cl-text">{formulaText(prop.output, value)}</span>
  }
}
