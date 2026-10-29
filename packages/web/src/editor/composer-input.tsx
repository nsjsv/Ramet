/* ---------- 对话输入框（提及画成 chip）----------
 * 一个迷你 ProseMirror：只有段落和四种提及 chip（页面 / 块引用 / agent / 成员）。chip 的节点 spec 借主编辑器 schema 里的
 * 同一份（toDOM / parseDOM 一致：框里、气泡里、文档里画法相同，复制粘贴往返不丢 attrs）。
 * 对外是记号文字口径（`@[标题](page:<id>)` 这类），发送（appendUserMessage）、文档 ⇄ 对话带草稿、气泡引用插入都靠它：
 * 出，draftToComposerText 把 chip 写回记号；进，mentionUpgradePlugin 把任何来路的记号（setText / 粘贴 / 手打）升成 chip。
 * 这里只管编辑，@ 菜单、发送等语义在宿主（chat-view.tsx），经 onKeyDown / onChange 接进来。 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { baseKeymap, splitBlock } from '@milkdown/kit/prose/commands'
import { history, redo, undo } from '@milkdown/kit/prose/history'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Schema, type Node as PMNode, type NodeSpec } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { draftToComposerText } from './composer-bridge'
import { mentionUpgradePlugin, upgradeMentions } from './mention-upgrade'

/** 框里允许的 chip（主 schema 里没注册的就不带，记号原样留着，发送时照常升级） */
const CHIPS = ['page_mention', 'block_ref', 'agent_mention', 'user_mention']
/** chip 在 caret() 文字里的占位：一个字符对应 chip 的 nodeSize，下标与文档位置一一对应 */
const CHIP_CHAR = '￼'
/** 宿主写入（setText / replace）不算键入，不开 @ 会话 */
const PROGRAMMATIC = 'composer-programmatic'

let cached: Schema | null = null

/** 框的 schema：段落加主编辑器里的提及节点。spec 不随编辑器实例变，建一次就够 */
function composerSchema(main: Schema): Schema {
  if (cached) return cached
  const nodes: Record<string, NodeSpec> = {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  }
  for (const name of CHIPS) {
    const type = main.nodes[name]
    if (type) nodes[name] = type.spec
  }
  cached = new Schema({ nodes })
  return cached
}

/** 记号文字转段落（每行一段），chip 由调用方在同一事务里 upgradeMentions */
function paragraphsOf(schema: Schema, text: string): PMNode[] {
  return text.split('\n').map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null))
}

const isEmpty = (doc: PMNode): boolean => doc.childCount === 1 && doc.firstChild!.content.size === 0

export interface ComposerInputHandle {
  /** 记号口径的全文：段落按行，chip 写成 `@[…](…)` */
  text(): string
  /** 整框换成这段记号文字，光标落末尾 */
  setText(text: string): void
  /** 光标所在段落的文字（chip 记一个占位字符）、光标在其中的下标、段落内容起点（文档位置），给 mentionQuery 用 */
  caret(): { text: string; cursor: number; base: number } | null
  /** 把 [from, to) 换成一段记号文字（同一事务升成 chip），光标落在它后面 */
  replace(from: number, to: number, text: string): void
  focus(): void
  dom(): HTMLElement | null
}

interface Props {
  /** 主编辑器的 schema（借 chip 的 spec），编辑器还没起来时是 undefined，等 tick 再来 */
  getSchema: () => Schema | undefined
  tick: number
  /** 建框时的初始内容（记号文字） */
  initial: string
  placeholder: string
  /** 内容或光标变了：text 是记号全文，typed 表示这次是键入（不是粘贴 / 拖放 / 删字 / 宿主写入 / 挪光标） */
  onChange: (text: string, typed: boolean) => void
  /** 键位先给宿主（@ 菜单 / Enter 发送），返回 true 表示宿主处理了。输入法组字中不问 */
  onKeyDown: (event: KeyboardEvent) => boolean
  onBlur: () => void
  /** 粘贴 / 拖入了图片文件时交给宿主上传成附件，不给就照常当文字处理 */
  onFiles?: (files: File[]) => void
}

/** 剪贴板 / 拖放里的图片文件 */
function imageFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((f) => f.type.startsWith('image/')) : []
}

const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(
  { getSchema, tick, initial, placeholder, onChange, onKeyDown, onBlur, onFiles },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 回调每次渲染都是新的，经 ref 取最新的，视图只建一次
  const cb = useRef({ onChange, onKeyDown, onBlur, onFiles })
  cb.current = { onChange, onKeyDown, onBlur, onFiles }
  // 视图还没建好（主编辑器未就绪）时的内容，建好时灌进去
  const pending = useRef(initial)

  useEffect(() => {
    const host = hostRef.current
    const main = getSchema()
    if (viewRef.current || !host || !main) return
    const schema = composerSchema(main)
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc!.create(null, paragraphsOf(schema, pending.current)),
      plugins: [
        history(),
        keymap({ 'Shift-Enter': splitBlock, 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo }),
        keymap(baseKeymap),
        mentionUpgradePlugin(),
      ],
    })
    const view: EditorView = new EditorView(host, {
      state,
      attributes: (s) => ({
        class: 'chat-input',
        role: 'textbox',
        'aria-multiline': 'true',
        'data-placeholder': placeholder,
        ...(isEmpty(s.doc) ? { 'data-empty': '' } : {}),
      }),
      handleKeyDown: (v, event) => (event.isComposing || v.composing ? false : cb.current.onKeyDown(event)),
      // 图片不进输入框（输入框是纯文字加 chip），交给宿主当附件，没有图片的粘贴 / 拖放照常
      handlePaste: (_v, event) => {
        const files = imageFiles(event.clipboardData)
        if (!files.length || !cb.current.onFiles) return false
        cb.current.onFiles(files)
        return true
      },
      handleDrop: (_v, event) => {
        const files = imageFiles(event.dataTransfer)
        if (!files.length || !cb.current.onFiles) return false
        event.preventDefault()
        cb.current.onFiles(files)
        return true
      },
      handleDOMEvents: {
        blur: () => {
          cb.current.onBlur()
          return false
        },
      },
      dispatchTransaction(tr: Transaction) {
        const before = view.state
        view.updateState(before.apply(tr))
        if (!tr.docChanged && before.selection.eq(view.state.selection)) return
        const typed =
          tr.docChanged &&
          !tr.getMeta(PROGRAMMATIC) &&
          !tr.getMeta('uiEvent') && // paste / drop / cut
          view.state.doc.content.size > before.doc.content.size
        cb.current.onChange(draftToComposerText(view.state.doc), typed)
      },
    })
    viewRef.current = view
    return undefined
  }, [getSchema, tick, placeholder])

  // 卸载时才拆，换页时 ChatView 整个重挂，草稿走 composer-bridge
  useEffect(
    () => () => {
      viewRef.current?.destroy()
      viewRef.current = null
    },
    [],
  )

  useImperativeHandle(ref, () => ({
    text: () => (viewRef.current ? draftToComposerText(viewRef.current.state.doc) : pending.current),
    setText(text) {
      const view = viewRef.current
      if (!view) {
        pending.current = text
        return
      }
      const { schema, doc } = view.state
      const tr = view.state.tr.replaceWith(0, doc.content.size, paragraphsOf(schema, text))
      tr.setSelection(TextSelection.atEnd(tr.doc))
      upgradeMentions(tr)
      view.dispatch(tr.setMeta(PROGRAMMATIC, true))
    },
    caret() {
      const view = viewRef.current
      if (!view) return null
      const { $head } = view.state.selection
      const block = $head.parent
      return {
        text: block.textBetween(0, block.content.size, '\n', () => CHIP_CHAR),
        cursor: $head.parentOffset,
        base: $head.start(),
      }
    },
    replace(from, to, text) {
      const view = viewRef.current
      if (!view) return
      const tr = view.state.tr.insertText(text, from, to)
      // 先落光标再升 chip：选区随后续步骤映射，升完正好在 chip 之后
      tr.setSelection(TextSelection.create(tr.doc, from + text.length))
      upgradeMentions(tr)
      view.dispatch(tr.setMeta(PROGRAMMATIC, true).scrollIntoView())
    },
    focus: () => viewRef.current?.focus(),
    dom: () => viewRef.current?.dom ?? null,
  }))

  return <div ref={hostRef} className="chat-input-host" />
})

export default ComposerInput
