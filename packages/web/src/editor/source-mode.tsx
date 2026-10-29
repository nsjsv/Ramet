/* ---------- 源码模式：按需加载的源码编辑器 ----------
 * 何时显示由编辑方式决定（editor/edit-mode.tsx；Editor.tsx 判定过程页 / 对话视图 / 编辑器就绪）。
 * 编辑器本体 source-editor.tsx 经 React.lazy 成独立 chunk（CodeMirror 只在进入源码模式时下载）。写回 / 回流语义见
 * source-sync.ts：停顿约 1 秒、失焦、退出 / 换页时按顶层块三方合并写回，别人的改动回流进源码。
 * 编辑器渲染在正文原位（.editor-root 隐藏、它顶上），反链等后续区块仍在它下面。 */

import { Suspense, lazy } from 'react'
import type { SourceEditorProps } from './source-editor'

const SourceEditor = lazy(() => import('./source-editor'))

export function SourcePane(props: SourceEditorProps) {
  return (
    <Suspense fallback={null}>
      <SourceEditor {...props} />
    </Suspense>
  )
}
