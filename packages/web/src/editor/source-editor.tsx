// ---------- 源码模式的编辑器组件（React.lazy 的入口：CodeMirror 只在进入源码模式时下载） ----------
// 挂载时经 getEditor（带「属于当前页」门闩）一次性取出正文视图、序列化器、解析器、remark 处理器，建 SourceSession 与
// CodeMirror；卸载（退出源码模式 / 换页 / 切到对话视图）时先写回再拆，写回目标是挂载时取到的那个视图，换页也不会写错页。
// 正文编辑器还没建好（getEditor 拿不到）就什么都不画，等下次挂载。

import { useEffect, useRef } from 'react'
import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx, parserCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyPatches, sourceExtensions, type MdNode } from './source-cm'
import { SourceSession, type SourceHost } from './source-sync'
import { textPatches } from './source-text'

export interface SourceEditorProps {
  getEditor: () => Editor | undefined
  readOnly: boolean
  /** 写回成功（Editor.tsx 用它 bump editorTick，升级出的页面块标题跟随改名） */
  onApplied: () => void
}

interface Captured {
  host: SourceHost
  parseMd: (text: string) => MdNode
}

function capture(editor: Editor | undefined): Captured | null {
  if (!editor) return null
  let out: Captured | null = null
  try {
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      if (view.isDestroyed) return
      const remark = ctx.get(remarkCtx)
      out = {
        host: { view, serialize: ctx.get(serializerCtx), parse: ctx.get(parserCtx) },
        parseMd: (text) => remark.parse(text) as unknown as MdNode,
      }
    })
  } catch {
    return null // 实例销毁中（Context not found）
  }
  return out
}

export default function SourceEditor({ getEditor, readOnly, onApplied }: SourceEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const cmRef = useRef<EditorView | null>(null)
  const appliedRef = useRef(onApplied)
  appliedRef.current = onApplied

  // 一个挂载 = 一次源码会话；中途变的 props 不重建会话
  useEffect(() => {
    const root = rootRef.current
    const got = capture(getEditor())
    if (!root || !got) return
    const session = new SourceSession(got.host, () => appliedRef.current())
    const cm = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: session.open(),
        extensions: sourceExtensions({
          parse: got.parseMd,
          readOnly,
          onLocalEdit: () => session.localEdit(),
          onBlur: () => session.flush(),
        }),
      }),
    })
    cmRef.current = cm
    session.attach({
      getText: () => cm.state.doc.toString(),
      replaceText: (next) => applyPatches(cm, textPatches(cm.state.doc.toString(), next)),
      composing: () => cm.composing,
    })
    if (!readOnly) cm.focus()
    return () => {
      session.destroy()
      cm.destroy()
      cmRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 一个挂载一次会话（调用方按页 key）
  }, [])

  return <div className="source-cm" ref={rootRef} />
}
