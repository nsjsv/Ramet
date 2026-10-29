import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* ---------- 弹窗外壳（设置 / 回收站共用）----------
 * 挂到 document.body（portal），不留在打开它的组件 DOM 里：入口在侧栏，而 .sidebar 是 position:absolute + z-index:20
 * 的层叠上下文，弹窗写多大的 z-index 都只在侧栏内部比较，与侧栏同级的宽度拖拽手柄（z 25）会压在遮罩上面，
 * 弹窗开着鼠标还能拖侧栏宽度。portal 之后遮罩（z 50）在根层叠上下文里，盖住整个应用。
 * React 事件仍沿组件树冒泡，只有 DOM 位置变了。
 * 关闭：Esc；在遮罩上按下并且在遮罩上松开才关，从弹窗里拖选文字拖到外面松手不误关；
 * 不在 pointerdown 就关：遮罩当场消失，随后的 click 会落到下面的侧栏 / 正文上（点穿）。
 * 弹窗里可以再开弹窗（设置 → 机器 → 授权流程）：Esc 只关最上面那一个（openModals 是打开顺序栈）。 */

/** 当前开着的弹窗，后开的在后；Esc 只交给栈顶 */
const openModals: object[] = []

export default function Modal({
  onClose,
  className,
  label,
  overlayCloses = true,
  children,
}: {
  onClose: () => void
  /** false = 点遮罩不关（多步填写的弹窗：误点一下不该丢掉填到一半的内容；Esc / 关闭按钮照常） */
  overlayCloses?: boolean
  /** 加在 .modal 上的修饰类（尺寸 / 布局） */
  className?: string
  /** 无障碍名（屏幕阅读器读的弹窗标题） */
  label: string
  children: ReactNode
}) {
  const close = useRef(onClose)
  close.current = onClose
  /** 这一次点击是不是在遮罩本身上按下的 */
  const downOnOverlay = useRef(false)

  useEffect(() => {
    const me = {}
    openModals.push(me)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && openModals[openModals.length - 1] === me) close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      openModals.splice(openModals.indexOf(me), 1)
    }
  }, [])

  return createPortal(
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (overlayCloses && downOnOverlay.current && e.target === e.currentTarget) onClose()
        downOnOverlay.current = false
      }}
    >
      <div className={'modal' + (className ? ` ${className}` : '')} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  )
}
