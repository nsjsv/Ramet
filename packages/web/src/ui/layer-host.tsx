/* ---------- 命令式浮层的宿主（确认框 / 输入框 / Toast）----------
 * 调用方不一定是 React 组件：ProseMirror 插件、纯 DOM 模块（row-actions.ts、editor/upload.ts…）也要能弹确认、出 Toast，
 * 所以不靠哪个组件树里挂 <Host>：第一次用到时在 body 上建一个 div、单独 createRoot，之后所有浮层都渲染在这棵树里，
 * App 与公开页都不用挂任何东西。
 * 这棵树没有路由 / 其他 context：塞进来的内容只能是不依赖 context 的元素（文字、普通标签、ui/ 里的组件）。 */
import { Fragment, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

export interface Layer {
  id: number
  node: ReactNode
}

/** 浮层清单（按加入顺序）：纯数据，与 DOM 无关 */
export function createLayerStore() {
  let layers: readonly Layer[] = []
  let seq = 0
  const subs = new Set<() => void>()
  const set = (next: readonly Layer[]): void => {
    layers = next
    for (const fn of subs) fn()
  }
  return {
    /** 加一层，返回摘掉它的函数（重复调用无害） */
    add(node: ReactNode): () => void {
      const id = ++seq
      set([...layers, { id, node }])
      return () => {
        if (layers.some((l) => l.id === id)) set(layers.filter((l) => l.id !== id))
      }
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    snapshot: (): readonly Layer[] => layers,
  }
}

const store = createLayerStore()
let mounted = false

function Host() {
  const layers = useSyncExternalStore(store.subscribe, store.snapshot)
  return (
    <>
      {layers.map((l) => (
        <Fragment key={l.id}>{l.node}</Fragment>
      ))}
    </>
  )
}

/* ---------- 浮层守卫：对话框 / Toast 开着时，页面上别的监听收不到它们的按键和按下 ----------
 * 页面上不少监听挂在 window / document 的捕获阶段（查找栏的 Esc 与 Ctrl+F、表格的选区快捷键与外点、各弹层的外点关闭），
 * 同一节点同一阶段按注册先后执行：对话框打开时才注册的监听排在它们后面，截不住。所以启动时最先装一对 window 捕获监听，
 * 按键交给栈顶对话框（同原生 confirm：框开着时页面什么键都收不到；打字等默认行为不受影响），
 * 按在对话框遮罩、Toast 上的 mousedown 就地截下（点确认框不该让发起它的菜单 / 选区先收起来）。 */

/** 按键的接收方（后开的在后，只交给栈顶） */
const keyOwners: Array<(e: KeyboardEvent) => void> = []
/** 吃掉 mousedown 的浮层元素 */
const shields = new Set<HTMLElement>()
let guarded = false

/** main.tsx 启动第一件事就调（必须排在所有 window 捕获监听之前）；重复调用无害 */
export function installLayerGuards(): void {
  if (guarded) return
  guarded = true
  window.addEventListener(
    'keydown',
    (e) => {
      const owner = keyOwners[keyOwners.length - 1]
      if (!owner) return
      e.stopImmediatePropagation()
      owner(e)
    },
    true,
  )
  window.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target
      if (t instanceof Node && [...shields].some((el) => el.contains(t))) e.stopImmediatePropagation()
    },
    true,
  )
}

/** 挂载期间独占按键（对话框用）；handler 每次渲染可以换，取最新的 */
export function useKeyOwner(handler: (e: KeyboardEvent) => void): void {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    const owner = (e: KeyboardEvent): void => latest.current(e)
    keyOwners.push(owner)
    return () => {
      const i = keyOwners.indexOf(owner)
      if (i >= 0) keyOwners.splice(i, 1)
    }
  }, [])
}

/** 挂载期间按在 el 里的 mousedown 不往页面上传（只截 mousedown：遮罩「按下并松开才关」靠 pointerdown / click） */
export function useShield(el: HTMLElement | null): void {
  useEffect(() => {
    if (!el) return
    shields.add(el)
    return () => {
      shields.delete(el)
    }
  }, [el])
}

/** 挂一层浮层（首次调用时建宿主），返回摘掉它的函数 */
export function mountLayer(node: ReactNode): () => void {
  installLayerGuards()
  if (!mounted) {
    mounted = true
    const el = document.createElement('div')
    el.className = 'ui-layer-host'
    document.body.append(el)
    createRoot(el).render(<Host />)
  }
  return store.add(node)
}
