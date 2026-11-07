/* ---------- 对话输入框（提及画成 chip）----------
 * 一个迷你 ProseMirror：只有段落、几种提及 chip（页面 / 块引用 / agent / 成员 / 文件引用）和图片。chip 的节点 spec 借主编辑器 schema 里的
 * 同一份（toDOM / parseDOM 一致：框里、气泡里、文档里画法相同，复制粘贴往返不丢 attrs）。
 * 对外是记号文字口径（`@[标题](page:<id>)` 这类），发送（appendUserMessage）、文档 ⇄ 对话带草稿、气泡引用插入都靠它：
 * 出，draftToComposerText 把 chip 写回记号；进，mentionUpgradePlugin 把任何来路的记号（setText / 粘贴 / 手打）升成 chip。
 * 图片是框自己的节点（带上传态）：粘贴 / 拖入时先以本地预览插在光标 / 落点处，宿主传完再 patchImage 换上正式地址，
 * 所以发出去的消息里图片就在这个位置（记号 `@[图片](image:<id>)`，发送时升回文档的图片节点）。
 * 这里只管编辑，@ 菜单、发送、上传等语义在宿主（chat-view.tsx），经 onKeyDown / onChange / onFiles 接进来。 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { baseKeymap, splitBlock } from '@milkdown/kit/prose/commands'
import { history, redo, undo } from '@milkdown/kit/prose/history'
import { keymap } from '@milkdown/kit/prose/keymap'
import { Fragment, Schema, Slice, type Node as PMNode, type NodeSpec } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { ATT_NODES, attItemsOf, type AttItem } from './att-cards'
import { draftToComposerText } from './composer-bridge'
import { FILE_URL_RE, toDisplay } from './media'
import { mentionUpgradePlugin, upgradeMentions } from './mention-upgrade'

/** 框里允许的 chip（主 schema 里没注册的就不带，记号原样留着，发送时照常升级） */
const CHIPS = ['page_mention', 'block_ref', 'agent_mention', 'user_mention', 'file_mention']
/** chip 在 caret() 文字里的占位：一个字符对应 chip 的 nodeSize，下标与文档位置一一对应 */
const CHIP_CHAR = '￼'
/** 宿主写入（setText / replace）不算键入，不开 @ 会话 */
const PROGRAMMATIC = 'composer-programmatic'

let cached: Schema | null = null

/** 框里的图：src 只在传完后才有（记号只认它，见 draftToComposerText），preview 是本地预览 / display 版，
 *  key 认领上传结果，failed = 上传失败（不随消息发出）。外层 class 与文档里的图同一个 wrapper，样式与悬停联动共用。
 *  parseDOM 只认本站图片（从气泡 / 文档拷来的图能直接贴进来），本地预览贴不回来 */
const IMAGE_SPEC: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false,
  attrs: { src: { default: '' }, preview: { default: '' }, key: { default: '' }, failed: { default: false } },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: (dom) => {
        const src = ((dom as HTMLElement).getAttribute('src') ?? '').replace(/\/display$/, '')
        return FILE_URL_RE.test(src) ? { src } : false
      },
    },
  ],
  toDOM: (node) => {
    const { src, preview, failed } = node.attrs as { src: string; preview: string; failed: boolean }
    const state = failed ? ' is-failed' : src ? '' : ' is-uploading'
    return ['span', { class: `img-wrap${state}` }, ['img', { src: preview || toDisplay(src), alt: '' }]]
  },
}

/** 框的 schema：段落加主编辑器里的提及节点。spec 不随编辑器实例变，建一次就够 */
function composerSchema(main: Schema): Schema {
  if (cached) return cached
  const nodes: Record<string, NodeSpec> = {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    image: IMAGE_SPEC,
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
  /** 整框换成这段记号文字，光标落末尾（框里还在上传的图没有记号，会一起换掉：往里加东西用 append） */
  setText(text: string): void
  /** 在末尾接一段记号文字（换行另起段，同一事务升成 chip），光标落末尾；框里原有的内容（含上传中的图）不动 */
  append(text: string): void
  /** 光标所在段落的文字（chip 记一个占位字符）、光标在其中的下标、段落内容起点（文档位置），给 mentionQuery 用 */
  caret(): { text: string; cursor: number; base: number } | null
  /** 把 [from, to) 换成一段记号文字（同一事务升成 chip），光标落在它后面 */
  replace(from: number, to: number, text: string): void
  /** 插一张上传中的图：at 给了（拖放落点）且落在段落里就插在那儿，否则替换选区；光标落在图后 */
  insertImage(key: string, preview: string, at?: number): void
  /** 上传结束：key 对应的图换上正式地址或标失败。不进撤销栈（撤销不该把图退回上传中） */
  patchImage(key: string, attrs: { src?: string; preview?: string; failed?: boolean }): void
  /** 删掉第 i 个附件（图片 / 文件引用 / 块引用，文档序；托盘卡片的 ×） */
  removeAtt(i: number): void
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
  /** 粘贴 / 拖入了图片文件时交给宿主上传（宿主经 insertImage 插进来；at = 拖放落点），不给就照常当文字处理 */
  onFiles?: (files: File[], at?: number) => void
  /** 附件清单变了（建框时报一次初值） */
  onAtts?: (items: AttItem[]) => void
}

/** 去掉一段内容里的图片节点（不收图的宿主粘贴 HTML 时用） */
function dropImages(frag: Fragment): Fragment {
  const out: PMNode[] = []
  frag.forEach((n) => {
    if (n.type.name !== 'image') out.push(n.isLeaf ? n : n.copy(dropImages(n.content)))
  })
  return Fragment.fromArray(out)
}

/** 剪贴板 / 拖放里的图片文件 */
function imageFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((f) => f.type.startsWith('image/')) : []
}

const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(
  { getSchema, tick, initial, placeholder, onChange, onKeyDown, onBlur, onFiles, onAtts },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 回调每次渲染都是新的，经 ref 取最新的，视图只建一次
  const cb = useRef({ onChange, onKeyDown, onBlur, onFiles, onAtts })
  cb.current = { onChange, onKeyDown, onBlur, onFiles, onAtts }
  // 视图还没建好（主编辑器未就绪）时的内容，建好时灌进去
  const pending = useRef(initial)
  // 占位文字可能随宿主变（浮窗里跟着当前页走）：根属性每次更新都从这里现取
  const hint = useRef(placeholder)
  hint.current = placeholder

  useEffect(() => {
    const host = hostRef.current
    const main = getSchema()
    if (viewRef.current || !host || !main) return
    const schema = composerSchema(main)
    const doc = schema.nodes.doc!.create(null, paragraphsOf(schema, pending.current))
    const state = EditorState.create({
      schema,
      doc,
      // 带着内容建框（浮窗预先放的页面、文档切过来的草稿）时光标落在末尾：PM 缺省落在开头，宿主随后 focus 就停在胶囊前面，
      // 用户得先点一下末尾才能接着打字
      selection: TextSelection.atEnd(doc),
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
        'data-placeholder': hint.current,
        ...(isEmpty(s.doc) ? { 'data-empty': '' } : {}),
      }),
      handleKeyDown: (v, event) => (event.isComposing || v.composing ? false : cb.current.onKeyDown(event)),
      // 图片文件交给宿主上传（它再插回来），没有图片的粘贴 / 拖放照常
      handlePaste: (_v, event) => {
        const files = imageFiles(event.clipboardData)
        if (!files.length || !cb.current.onFiles) return false
        cb.current.onFiles(files)
        return true
      },
      handleDrop: (v, event) => {
        const files = imageFiles(event.dataTransfer)
        if (!files.length || !cb.current.onFiles) return false
        event.preventDefault()
        cb.current.onFiles(files, v.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
        return true
      },
      // 不收图的宿主（评论：正文是纯文字）粘贴 / 拖进来的 HTML 里的图丢掉，不然正文里会多出一串图片记号
      transformPasted: (slice) => (cb.current.onFiles ? slice : new Slice(dropImages(slice.content), slice.openStart, slice.openEnd)),
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
        if (tr.docChanged) cb.current.onAtts?.(attItemsOf(view.state.doc))
      },
    })
    viewRef.current = view
    cb.current.onAtts?.(attItemsOf(view.state.doc))
    return undefined
  }, [getSchema, tick])

  // 占位文字变了：让视图重算一次根属性
  useEffect(() => {
    viewRef.current?.setProps({})
  }, [placeholder])

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
    append(text) {
      const view = viewRef.current
      if (!view) {
        pending.current += text
        return
      }
      const [first = '', ...rest] = text.split('\n')
      const tr = view.state.tr.insertText(first, view.state.doc.content.size - 1)
      if (rest.length) tr.insert(tr.doc.content.size, paragraphsOf(view.state.schema, rest.join('\n')))
      tr.setSelection(TextSelection.atEnd(tr.doc))
      upgradeMentions(tr)
      view.dispatch(tr.setMeta(PROGRAMMATIC, true).scrollIntoView())
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
    insertImage(key, preview, at) {
      const view = viewRef.current
      if (!view) return
      const node = view.state.schema.nodes.image!.create({ key, preview })
      const $at = at === undefined ? null : view.state.doc.resolve(Math.min(at, view.state.doc.content.size))
      const tr = $at?.parent.inlineContent ? view.state.tr.insert($at.pos, node) : view.state.tr.replaceSelectionWith(node, false)
      if ($at?.parent.inlineContent) tr.setSelection(TextSelection.create(tr.doc, $at.pos + node.nodeSize))
      view.dispatch(tr.setMeta(PROGRAMMATIC, true).scrollIntoView())
      view.focus()
    },
    patchImage(key, attrs) {
      const view = viewRef.current
      if (!view) return
      const tr = view.state.tr
      view.state.doc.descendants((n, pos) => {
        if (n.type.name === 'image' && n.attrs.key === key) tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs })
      })
      if (tr.docChanged) view.dispatch(tr.setMeta(PROGRAMMATIC, true).setMeta('addToHistory', false))
    },
    removeAtt(i) {
      const view = viewRef.current
      if (!view) return
      let n = -1
      let hit = null as { pos: number; size: number } | null
      view.state.doc.descendants((node, pos) => {
        if (hit) return false
        if (ATT_NODES.has(node.type.name) && ++n === i) hit = { pos, size: node.nodeSize }
        return undefined
      })
      if (hit) view.dispatch(view.state.tr.delete(hit.pos, hit.pos + hit.size).setMeta(PROGRAMMATIC, true))
    },
    focus: () => viewRef.current?.focus(),
    dom: () => viewRef.current?.dom ?? null,
  }))

  return <div ref={hostRef} className="chat-input-host" />
})

export default ComposerInput
