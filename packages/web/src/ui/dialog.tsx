/* ---------- 确认框 / 输入框（取代 window.confirm / window.prompt）----------
 * Promise 式命令 API，React 组件和纯 DOM 代码都能直接 await；渲染在 layer-host 的独立根里。
 * 原生 confirm 会冻结 JS，期间协同更新、列表刷新都进不来；这里是异步的，框开着时文档可能被别人改了：
 * 调用方 await 之后按 id 重新取目标，别拿 await 之前的对象直接写。
 * 外壳是 Modal（Esc 栈、遮罩按下并松开才关），遮罩再登记进 popover 的弹层栈：从集合弹层（列菜单、视图标签…）
 * 里发起的确认，点确认框不能被下面的弹层当成外点把自己关掉。 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { COPY } from '../copy'
import { mountLayer, useKeyOwner, useShield } from './layer-host'
import Modal from './Modal'
import { usePopoverLayer } from './popover'

const C = COPY.dialog

export interface ConfirmOptions {
  title?: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 删除类：确认按钮红底 */
  danger?: boolean
}

export interface PromptOptions {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  /** 返回错误文字 = 不合法（显示在输入框下方，不关框）；null = 通过 */
  validate?: (value: string) => string | null
}

/** 确认：确认 → true；取消 / Esc / 点遮罩 → false */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return openDialog<boolean>((done) => <ConfirmView o={o} done={done} />)
}

/** 输入：提交 → 输入的原文（不 trim）；取消 → null */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return openDialog<string | null>((done) => <PromptView o={o} done={done} />)
}

/** 挂一个对话框，done(结果) 时摘掉并兑现。焦点还给打开前的元素（编辑器里发起的，光标回原处，同原生 confirm） */
function openDialog<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
  return new Promise<T>((resolve) => {
    let settled = false
    const unmount = mountLayer(
      render((v) => {
        if (settled) return
        settled = true
        unmount()
        resolve(v)
        // 等框从 DOM 上摘掉再还：同步还的话，触发关闭的这次 Enter 后续的 keypress / beforeinput 会落进编辑器；
        // 调用方 await 之后自己挪了焦点（跳页、聚焦新输入框）就不抢
        window.setTimeout(() => {
          const now = document.activeElement
          if (before?.isConnected && (!now || now === document.body)) before.focus({ preventScroll: true })
        })
      }),
    )
  })
}

/** 两种框共用：Modal 外壳 + 弹层栈登记 + 键盘（Enter 确认、Esc 取消、Tab 不出框） */
function Shell({
  label,
  cancelRef,
  onCancel,
  onEnter,
  children,
}: {
  label: string
  cancelRef: RefObject<HTMLButtonElement>
  onCancel: () => void
  onEnter: () => void
  children: ReactNode
}) {
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null)
  usePopoverLayer(overlay)
  useShield(overlay)
  const box = useRef<HTMLDivElement>(null)

  // 按键由 layer-host 的守卫在 window 捕获阶段截下交到这里：页面级快捷键（表格选区的 Enter / Delete、⌘K、
  // 查找栏和外层弹层的 Esc）一个都收不到，同原生 confirm
  useKeyOwner((e) => {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && !e.repeat && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      if (e.target === cancelRef.current) onCancel()
      else onEnter()
    } else if (e.key === 'Tab' && box.current) {
      trapTab(e, box.current)
    }
  })

  return (
    <Modal label={label} className="ui-dialog" overlayRef={setOverlay} onClose={onCancel}>
      {/* tabIndex -1：点到框里的文字时焦点落在框上（不掉到 body） */}
      <div ref={box} className="ui-dialog-box" tabIndex={-1}>
        {children}
      </div>
    </Modal>
  )
}

function trapTab(e: KeyboardEvent, box: HTMLElement): void {
  const items = [...box.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === box)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

function ConfirmView({ o, done }: { o: ConfirmOptions; done: (v: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => ok.current?.focus(), [])
  const label = o.title ?? (typeof o.message === 'string' ? o.message : C.confirmTitle)
  return (
    <Shell label={label} cancelRef={cancel} onCancel={() => done(false)} onEnter={() => done(true)}>
      {o.title && <h2 className="modal-title ui-dialog-title">{o.title}</h2>}
      <div className="ui-dialog-message">{o.message}</div>
      <div className="ui-dialog-foot">
        <button ref={cancel} type="button" className="admin-btn" onClick={() => done(false)}>
          {o.cancelLabel ?? C.cancel}
        </button>
        <button
          ref={ok}
          type="button"
          className={'admin-btn ' + (o.danger ? 'danger is-solid' : 'primary')}
          onClick={() => done(true)}
        >
          {o.confirmLabel ?? (o.danger ? C.remove : C.ok)}
        </button>
      </div>
    </Shell>
  )
}

function PromptView({ o, done }: { o: PromptOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(o.initial ?? '')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const errorId = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = (): void => {
    const err = o.validate?.(value) ?? null
    if (err === null) return done(value)
    setError(err)
    input.current?.focus()
  }

  return (
    <Shell label={o.title} cancelRef={cancel} onCancel={() => done(null)} onEnter={submit}>
      <h2 className="modal-title ui-dialog-title">{o.title}</h2>
      <label className="ui-dialog-field">
        {o.label && <span className="ui-dialog-label">{o.label}</span>}
        <input
          ref={input}
          className="admin-field ui-dialog-input"
          value={value}
          placeholder={o.placeholder}
          // 没有可见标签时用标题当读屏名称（placeholder 不算可靠的名称）
          aria-label={o.label ? undefined : o.title}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
        />
      </label>
      {error !== null && (
        <div id={errorId} className="modal-error ui-dialog-error" role="alert">
          {error}
        </div>
      )}
      <div className="ui-dialog-foot">
        <button ref={cancel} type="button" className="admin-btn" onClick={() => done(null)}>
          {C.cancel}
        </button>
        <button type="button" className="admin-btn primary" onClick={submit}>
          {o.confirmLabel ?? C.ok}
        </button>
      </div>
    </Shell>
  )
}
