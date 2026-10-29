// 块手柄 / 触屏手柄 / 块菜单的装配
import { editorViewCtx, type Editor } from '@milkdown/kit/core'
import type { EditorView } from '@milkdown/kit/prose/view'
import { iconSvg } from '../icons'
import { blockHandle, BlockHandleProvider, setBlockHandleProvider, setBlockHandleViewHooks } from './block-handle'
import { attachBlockMenu } from './block-menu'
import { setPageDropBridge } from './page-drop'
import { isTouchEditor, setupTouchBlockHandles, type TouchBlockSetup } from './block-touch'
import { blockSelectKey } from './block-select'

export function configBlock(instance: Editor, getPageId: () => string | undefined): BlockHandleProvider | TouchBlockSetup {
  const getView = (): EditorView | undefined => {
    let view: EditorView | undefined
    instance.action((ctx) => {
      view = ctx.get(editorViewCtx)
    })
    return view
  }

  // 跨页搬块的桥（page-drop.ts）：侧栏树拖放借用正打开的源编辑器（无 schema / 视图）。
  // 卸载、换页时在 EditorPage effect cleanup 置 null（旧桥会把块搬出旧页面）
  setPageDropBridge({ getPageId, getView })

  // 触屏（手机 / 平板）没有 hover 也没有 HTML5 DnD，桌面手柄链路整体失效，换成 decoration
  // 常显手柄 + tap 菜单 + 长按拖拽（editor/block-touch.ts）。不挂 blockHandle：桌面的
  // hover 定位与 HTML5 dragstart 在触屏全失效。销毁挂在 touch 插件自己的 view 工厂上
  if (isTouchEditor()) {
    const touch = setupTouchBlockHandles(getView, getPageId)
    instance.use(touch.plugin)
    return touch
  }

  const content = document.createElement('div')
  content.className = 'block-handle'
  content.innerHTML = iconSvg('handle', 14, 16)
  // getPageId：dragstart 给侧栏树拖放登记源（page-drop.ts markBlockDrag）
  const provider = new BlockHandleProvider({ content, getPageId })

  // 块手柄点击菜单：click 只在未拖拽时触发（浏览器拖拽后自动抑制 click）。
  // getView 惰性取正文视图，active 快照经结构化类型穿进 block-menu
  const menu = attachBlockMenu({
    handle: content,
    getView,
    getActive: () => provider.active ?? null,
    getPageId,
    // 当前块选区（多块时菜单「删除」作用于整个选区）。键定义在 Editor.tsx，只能闭包传进来
    getRange: () => {
      const view = getView()
      const sel = view && !view.isDestroyed ? blockSelectKey.getState(view.state) : null
      return sel && sel.active ? { from: sel.from, to: sel.to } : null
    },
  })

  // 插件视图重建钩子（collab 初始化会销毁重建插件视图）：click 菜单 destroy 摘过 click，
  // 重建必须补挂（同函数引用重复 add 会自动去重）。手柄 DOM 挂接、拖拽事件、移出编辑器的
  // hide 链路全在 blockHandle 插件的 view 工厂里（见 block-handle.ts）
  setBlockHandleProvider(provider)
  setBlockHandleViewHooks({
    onView: () => menu.bind(),
    onViewDestroy: () => menu.destroy(),
  })
  instance.use(blockHandle)
  return provider
}
