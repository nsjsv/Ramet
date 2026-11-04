// ---------- 公式编辑：属性设置里的摘要与入口（FormulaField），编辑弹窗（FormulaEditor） ----------
// 弹窗里写显示形（[名字]）：输 [ 补全属性名、输字母补全函数名，实时校验（整份定义一起编译：循环引用、引用了有误的公式都算进来），
// 第一行预览，侧栏函数说明。草稿只在这里，「保存」才经 toStored 换成存储形写进 cfg.expr，「取消」/ Esc 丢掉。
// 点遮罩不关：写到一半的公式误点一下就没了。
// 弹窗从列菜单（弹层）里打开：遮罩登记进弹层栈（usePopoverLayer），否则点一下弹窗，下面的弹层就关了、连带卸载这里。
// 按键不往外冒（React 事件沿组件树冒泡，会冒到表格 / 看板的键盘处理）；Esc 在这里处理：补全开着先收补全，否则取消。
// 补全浮层贴在输入框下面，不跟着光标：textarea 里量光标坐标要另造一份镜像排版，换来的只是挪近几十像素。
// 出错区段标红：输入框后面垫一层同字体、同折行的文字，只给那一段上底色，输入框本身透明底；滚动跟着输入框。
// 预览只是看一眼：拿视图已加载的第一行，按草稿替换后的定义用 shared 的 fillFormulas 算（与格子同一份求值），不另发请求。
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import {
  checkFormula,
  complete,
  FORMULA_MAX,
  FORMULA_TYPE_LABEL,
  rowValue,
  toDisplay,
  toStored,
  withFormula,
  type CollectionProp,
  type CollectionSchema,
  type CollectionView,
  type PropType,
  type Suggestion,
} from '@ramet/shared/collection-model'
import { fillFormulas } from '@ramet/shared/collection-query'
import Modal from '../ui/Modal'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { FormulaCell, formulaBroken } from './cells/FormulaCell'
import { useCollection } from './collection-store'
import { applySuggestion, docGroups, insertText, markParts, previewRow, stepIndex, summary, type Edit } from './formula-editor-model'
import { usePopoverLayer } from '../ui/popover'
import { TYPE_ICON } from './prop-meta'
import { useRelationCtx } from './relation-ctx'
import { setPropCfg } from './schema-ops'

const C = COPY.collection
const F = C.formula

type Props = {
  doc: Y.Doc
  schema: CollectionSchema
  prop: CollectionProp
  /** 在哪个视图里打开的：预览取它已加载的第一行；没有 = 不预览 */
  view?: CollectionView
}

/** 属性设置里的公式：摘要（显示形，截断）+ 出错原因 +「编辑公式」 */
export function FormulaField({ doc, schema, prop, view }: Props) {
  const [open, setOpen] = useState(false)
  const display = toDisplay(prop.cfg.expr ?? '', schema)
  return (
    <>
      <button type="button" className="cl-fx-sum" data-tip={display || undefined} onClick={() => setOpen(true)}>
        {display.trim() ? <code>{summary(display)}</code> : <span className="cl-text is-dim">{F.none}</span>}
      </button>
      {formulaBroken(prop) && <div className="cl-hint is-error">{prop.formulaError?.message}</div>}
      <button type="button" className="pop-row" onClick={() => setOpen(true)}>
        <Icon name="sigma" size={14} />
        {F.edit}
      </button>
      {open && <FormulaEditor doc={doc} schema={schema} prop={prop} view={view} onClose={() => setOpen(false)} />}
    </>
  )
}

const noSubscribe = (): (() => void) => () => undefined

/** 第一行按草稿算出来的样子（草稿有误时不预览） */
function Preview({ schema, prop, expr, view }: { schema: CollectionSchema; prop: CollectionProp; expr: string | null; view?: CollectionView }) {
  const relation = useRelationCtx()
  const handle = useCollection(relation?.cid ?? null)
  const row = useSyncExternalStore(handle?.subscribe ?? noSubscribe, () => (handle && view ? previewRow(handle, schema, view) : undefined))
  const shown = useMemo(() => {
    if (expr === null || !row || !handle) return null
    const next = withFormula(schema, prop.id, expr)
    const p = next.props.find((x) => x.id === prop.id)
    return p ? { prop: p, row: fillFormulas([row], next, handle.queryCtx())[0]! } : null
  }, [expr, row, handle, schema, prop.id])
  return (
    <div className="cl-fx-preview">
      <span className="cl-fx-label">{row ? `${F.preview} · ${F.previewOf(row.title || COPY.untitled)}` : F.preview}</span>
      <span className="cl-fx-value">
        {!row ? (
          <span className="cl-text is-dim">{F.noRow}</span>
        ) : !shown ? (
          <span className="cl-text is-dim">—</span>
        ) : rowValue(shown.row, shown.prop) === undefined ? (
          <span className="cl-text is-dim">{F.previewEmpty}</span>
        ) : (
          <FormulaCell prop={shown.prop} row={shown.row} />
        )}
      </span>
    </div>
  )
}

/** 侧栏：函数说明，按类分组、可检索；点一条把「函数名(」插到光标处 */
function FunctionDocs({ onInsert }: { onInsert: (name: string) => void }) {
  const [query, setQuery] = useState('')
  const groups = docGroups(query)
  return (
    <aside className="cl-fx-docs">
      <input className="cl-input" value={query} placeholder={F.searchFn} onChange={(e) => setQuery(e.target.value)} />
      <div className="cl-fx-doclist">
        {groups.map((g) => (
          <section key={g.group}>
            <div className="pop-section">{F.groups[g.group]}</div>
            {g.items.map((item) => (
              <button
                key={item.name}
                type="button"
                className="cl-fx-doc"
                data-tip={F.insert}
                // 不抢输入框的焦点：插入位置是它的光标
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onInsert(item.name)}
              >
                <code className="cl-fx-sig">{item.signature}</code>
                <span className="cl-fx-desc">{item.desc}</span>
                <code className="cl-fx-example">{item.example}</code>
              </button>
            ))}
          </section>
        ))}
        {groups.length === 0 && <div className="cl-hint">{F.noFn}</div>}
      </div>
    </aside>
  )
}

/** 一个补全候选：属性画类型图标与类型名，函数画签名 */
function SuggestionRow({ s, on, onPick, onHover }: { s: Suggestion; on: boolean; onPick: () => void; onHover: () => void }) {
  const type = s.kind === 'prop' ? (s.detail as PropType) : null
  return (
    <li
      role="option"
      aria-selected={on}
      className={'cl-fx-sug' + (on ? ' is-on' : '')}
      // mousedown 就接受并拦默认：不让输入框先失焦把列表收掉
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      onMouseEnter={onHover}
    >
      <Icon name={type ? (TYPE_ICON[type] ?? 'text') : 'sigma'} size={14} />
      <span className="cl-fx-sug-label">{s.label || (type ? C.types[type] : '')}</span>
      <span className="cl-fx-sug-detail">{type ? (C.types[type] ?? type) : s.detail}</span>
    </li>
  )
}

export function FormulaEditor({
  doc,
  schema,
  prop,
  view,
  onSave,
  onClose,
}: Props & {
  /** 「保存」时怎么写（给存储形）；缺省写进这个属性的 cfg.expr。新建公式用它连同表达式一起建属性 */
  onSave?: (expr: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(() => toDisplay(prop.cfg.expr ?? '', schema))
  const [caret, setCaret] = useState(draft.length)
  const [focused, setFocused] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null)
  usePopoverLayer(overlay)
  const input = useRef<HTMLTextAreaElement>(null)
  const back = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  /** 下一次渲染后把光标放到这里（换掉草稿后 React 会把光标挪到末尾） */
  const pending = useRef<number | null>(draft.length)

  const blank = draft.trim() === ''
  const check = useMemo(() => (blank ? null : checkFormula(draft, schema, prop.id)), [blank, draft, schema, prop.id])
  const stored = useMemo(() => (blank ? ({ ok: true, expr: '' } as const) : toStored(draft, schema)), [blank, draft, schema])
  const suggestions = useMemo(
    () => (dismissed || !focused ? [] : complete(draft, caret, schema, prop.id)),
    [dismissed, focused, draft, caret, schema, prop.id],
  )
  const pick = Math.max(0, Math.min(active, suggestions.length - 1))
  const parts = check && !check.ok ? markParts(draft, check.error.at) : null

  useLayoutEffect(() => {
    const el = input.current
    if (!el || pending.current === null) return
    el.focus()
    el.setSelectionRange(pending.current, pending.current)
    pending.current = null
  })
  useLayoutEffect(() => {
    list.current?.children[pick]?.scrollIntoView({ block: 'nearest' })
  }, [pick, suggestions])

  const apply = (edit: Edit): void => {
    setDraft(edit.text)
    setCaret(edit.caret)
    setActive(0)
    pending.current = edit.caret
  }
  const insertFunction = (name: string): void => {
    const el = input.current
    apply(insertText(draft, el?.selectionStart ?? draft.length, el?.selectionEnd ?? draft.length, `${name}(`))
    setDismissed(true)
  }
  const save = (): void => {
    if (!stored.ok) return
    if (onSave) onSave(stored.expr)
    else setPropCfg(doc, prop.id, { expr: stored.expr })
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法还在组字（Safari 确认候选的那一下 Enter 已经 isComposing = false，只能看 keyCode 229）：不当补全 / 保存的按键
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    const mod = e.metaKey || e.ctrlKey
    if (suggestions.length > 0 && !mod && !e.altKey) {
      const s = suggestions[pick]
      const handled =
        e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape' || ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && s !== undefined)
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setActive(stepIndex(pick, e.key === 'ArrowDown' ? 1 : -1, suggestions.length))
        else if (e.key === 'Escape') setDismissed(true)
        else if (s) apply(applySuggestion(draft, s))
        return
      }
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  const name = prop.name || C.types.formula
  return (
    <Modal onClose={onClose} overlayCloses={false} className="cl-fx-modal" label={F.title(name)} overlayRef={setOverlay}>
      <div
        className="cl-fx"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            onClose()
          }
        }}
      >
        <header className="cl-fx-head">
          <Icon name="sigma" size={16} />
          <h2 className="modal-title">{F.title(name)}</h2>
          <button type="button" className="modal-close" data-tip={F.close} aria-label={F.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="cl-fx-body">
          <div className="cl-fx-main">
            <div className="cl-fx-input">
              <div ref={back} className="cl-fx-back" aria-hidden="true">
                {parts ? (
                  <>
                    {parts.before}
                    <mark>{parts.mark}</mark>
                    {parts.after}
                  </>
                ) : (
                  draft
                )}
                {/* 末尾是换行时 textarea 会多出一行，垫层也要有 */}
                {'\u200b'}
              </div>
              <textarea
                ref={input}
                className="cl-fx-text"
                value={draft}
                rows={5}
                maxLength={FORMULA_MAX}
                placeholder={F.placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                aria-invalid={!!check && !check.ok}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setCaret(e.target.selectionStart)
                  setDismissed(false)
                  setActive(0)
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onScroll={(e) => {
                  if (back.current) back.current.scrollTop = e.currentTarget.scrollTop
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={onKeyDown}
              />
              {suggestions.length > 0 && (
                <ul ref={list} className="cl-fx-suggest" role="listbox">
                  {suggestions.map((s, i) => (
                    <SuggestionRow
                      key={`${s.kind}:${s.insert}:${i}`}
                      s={s}
                      on={i === pick}
                      onPick={() => apply(applySuggestion(draft, s))}
                      onHover={() => setActive(i)}
                    />
                  ))}
                </ul>
              )}
            </div>
            {blank ? (
              <div className="cl-fx-status">{F.emptyHint}</div>
            ) : check?.ok ? (
              <div className="cl-fx-status is-ok">{F.resultType(FORMULA_TYPE_LABEL[check.type])}</div>
            ) : (
              <div className="cl-fx-status is-error" role="alert">
                {check?.error.message}
              </div>
            )}
            <Preview schema={schema} prop={prop} expr={check?.ok ? check.expr : null} view={view} />
          </div>
          <FunctionDocs onInsert={insertFunction} />
        </div>
        <footer className="cl-fx-foot">
          <span className="cl-fx-keys">{F.keys}</span>
          <button type="button" className="admin-btn" onClick={onClose}>
            {F.cancel}
          </button>
          <button type="button" className="admin-btn primary" disabled={!stored.ok} data-tip={stored.ok ? undefined : F.cantSave} onClick={save}>
            {F.save}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
