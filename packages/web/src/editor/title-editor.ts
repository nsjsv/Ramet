import { EditorState, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { keymap } from '@milkdown/kit/prose/keymap'
import { yCursorPlugin, ySyncPlugin } from 'y-prosemirror'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { titleSchema } from '../title-schema'

/* ---------- 标题协作编辑器 ----------
 * 页面 Yjs 文档的独立 'title' fragment（正文是 'prosemirror' fragment，见 @milkdown/plugin-collab
 * bindDoc），绑一个最小 ProseMirror 实例（schema 在 title-schema.ts，快照面板同用）：
 * - prose 模块一律走 @milkdown/kit/prose/*（与正文同一份 prosemirror 单例，勿直接 import 'prosemirror-*'）；
 * - yCursorPlugin 用默认 'cursor' 字段：渲染端 createDecorations 硬编码读 aw.cursor，自定义字段
 *   只影响写入，会导致标题协作光标不渲染；本地光标由插件在 focus 时写 awareness。 */

export function createTitleView(
  place: HTMLElement,
  provider: HocuspocusProvider,
  readOnly: boolean,
  onEnter: () => void,
): EditorView {
  const view = new EditorView(place, {
    state: EditorState.create({
      schema: titleSchema,
      plugins: [
        ySyncPlugin(provider.document.getXmlFragment('title')),
        ...(provider.awareness ? [yCursorPlugin(provider.awareness)] : []),
        keymap({
          // 标题不换行：Enter 把焦点与光标送进正文开头（onEnter 见组件内 focusBodyFromTitle，
          // 正文编辑器异步 create() 还没建好时回调内部什么也不做，焦点留在标题）
          Enter: () => {
            onEnter()
            return true
          },
        }),
      ],
    }),
    // viewer 只锁输入，与正文 readOnly 分支同语义
    editable: () => !readOnly,
    // 拆掉之后不再接受派发：y-prosemirror 1.3.7 的 yCursorPlugin 把 awareness 广播延迟（timeout 0）派发、守卫失效，
    // 连接比标题视图活得久时（集合页与正文里的集合块共用一条连接），迟到的派发会打进已拆的视图（matchesNode of null）
    dispatchTransaction(this: EditorView, tr: Transaction) {
      if (!this.isDestroyed) this.updateState(this.state.apply(tr))
    },
  })
  return view
}
