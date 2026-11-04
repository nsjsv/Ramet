/* ---------- Toast（取代 window.alert）----------
 * 底部居中（右下角是发版提示；窄屏改到顶部，见 mobile.css）；新的在下，最多 3 条；出错的 6 秒、其余 3.5 秒，悬停暂停，带关闭叉。
 * 不抢焦点：alert 会打断正在打的字，Toast 只是报一声。渲染在 layer-host 的独立根里，纯 DOM 代码也能调。
 * 入场 / 退场只动 opacity / transform；别的条目进出时剩下的条目用 FLIP 滑到新位置，不跳。 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { COPY } from '../copy'
import { Icon } from '../icons'
import { easeOut, motionMs } from '../motion'
import { mountLayer, useShield } from './layer-host'
import { createToastStore, type ToastItem, type ToastKind } from './toast-store'

const store = createToastStore(() => motionMs('--d-1'))
let mounted = false

/** 启动时先把（空的）列表挂上：它是 aria-live 区域，读屏只播报「已在页面上的」区域里新增的内容，
 *  和第一条 Toast 一起插进来的话，第一条不会被读出来。重复调用无害 */
export function installToasts(): void {
  if (mounted) return
  mounted = true
  mountLayer(<ToastStack />)
}

/** 出一条 Toast */
export function toast(message: string, o: { kind?: ToastKind; duration?: number } = {}): void {
  installToasts()
  store.push(message, o.kind ?? 'info', o.duration)
}

/** 失败提示：有服务端 / 抛出的具体原因就报原因，否则报 fallback */
export function toastError(err: unknown, fallback: string): void {
  toast(err instanceof Error && err.message ? err.message : fallback, { kind: 'error' })
}

const FLIP_ID = 'ui-toast-flip'

function ToastStack() {
  const items = useSyncExternalStore(store.subscribe, store.snapshot)
  const box = useRef<HTMLDivElement | null>(null)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  // 点 Toast（关闭叉、悬停）不算点在页面上：下面开着的菜单 / 弹层不该因此收起
  useShield(el)
  /** 上一次提交后各条目在视口里的纵坐标（桌面列表贴底、窄屏贴顶，两种都按视口算） */
  const lastY = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ms = motionMs('--d-2')
    const top = el.getBoundingClientRect().top
    const next = new Map<string, number>()
    for (const child of el.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.id) continue
      // 条目自己用 offsetTop（不含 transform）：入场 / 上一轮 FLIP 演到一半也量得准；列表本身不做动画
      const y = top + child.offsetTop
      next.set(child.dataset.id, y)
      const prev = lastY.current.get(child.dataset.id)
      if (prev === undefined || !ms || Math.abs(prev - y) < 0.5) continue
      for (const a of child.getAnimations()) if (a.id === FLIP_ID) a.cancel()
      child.animate([{ transform: `translateY(${prev - y}px)` }, { transform: 'none' }], {
        id: FLIP_ID,
        duration: ms,
        easing: easeOut(),
        composite: 'add',
      })
    }
    lastY.current = next
  }, [items])

  return (
    <div
      ref={(node) => {
        box.current = node
        setEl(node)
      }}
      className="ui-toasts"
      aria-live="polite"
    >
      {items.map((t) => (
        <Toast key={t.id} t={t} />
      ))}
    </div>
  )
}

function Toast({ t }: { t: ToastItem }) {
  return (
    <div
      data-id={t.id}
      className={`ui-toast is-${t.kind}` + (t.leaving ? ' is-leaving' : '')}
      role={t.kind === 'error' ? 'alert' : undefined}
      onPointerEnter={() => store.pause(t.id)}
      onPointerLeave={() => store.resume(t.id)}
    >
      <span className="ui-toast-text">{t.message}</span>
      <button
        type="button"
        className="ui-toast-close"
        aria-label={COPY.dialog.close}
        data-tip={COPY.dialog.close}
        onClick={() => store.dismiss(t.id)}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
