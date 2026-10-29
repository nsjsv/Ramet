import { useEffect, useState, type ReactNode } from 'react'

/* ---------- 弹窗里的小控件（设置 / 回收站共用）----------
 * Card / Row：设置项的卡片与行（左：标题 + 说明，右：控件）；Switch：开关；Segmented：二选一 / 多选一；
 * ConfirmButton：危险动作的行内两步确认（第一下变成「确认…」，3 秒内再点才执行），取代 window.confirm 的系统弹框。
 * 样式在 styles/settings.css（.set-*）。 */

export function Card({ title, children, danger }: { title?: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={'set-card' + (danger ? ' is-danger' : '')}>
      {title && <h3 className="set-card-title">{title}</h3>}
      <div className="set-card-body">{children}</div>
    </section>
  )
}

/** 一行设置：label + 可选说明在左，控件在右。htmlFor 给了就整行文字可点（开关类） */
export function Row({ label, desc, children, htmlFor }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  const text = (
    <>
      <span className="set-label">{label}</span>
      {desc && <span className="set-desc">{desc}</span>}
    </>
  )
  return (
    <div className="set-row">
      {htmlFor ? (
        <label className="set-row-text" htmlFor={htmlFor}>
          {text}
        </label>
      ) : (
        <div className="set-row-text">{text}</div>
      )}
      {children !== undefined && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

export function Switch({ id, checked, onChange, label }: { id?: string; checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={'set-switch' + (checked ? ' is-on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="set-switch-knob" />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div className="set-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          className={'set-seg-btn' + (o.value === value ? ' is-on' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 两步确认：第一下「武装」，按钮变成 confirmLabel（红底），3 秒内再点执行；超时 / 失焦复原 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  disabled,
  className,
  title,
}: {
  children: ReactNode
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      className={(className ?? 'admin-btn danger') + (armed ? ' is-armed' : '')}
      disabled={disabled}
      title={armed ? undefined : title}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
