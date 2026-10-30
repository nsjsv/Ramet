/* ---------- 编辑器里的文件上传：粘贴 / 拖入 / slash 选文件 → 占位 → 上传 → 换成真节点 ----------
 * 占位是 widget 装饰，不进 Y.Doc：协同端与版本历史看不到半成品，上传失败也不留垃圾节点。
 * 图片占位直接显示本地 blob 预览（与上传后的真图同尺寸，替换时布局不跳）+ 浅色蒙层 + 底部进度条；
 * 非图片、或浏览器解不了的图片（HEIC 等）显示附件卡片同款的文件名 + 百分比卡片。
 *
 * 落点锚定：本地事务按 mapping 映射即可；但远端事务（含 agent 流式回复）是 y-prosemirror
 * 整篇 replace，mapping 会把占位挤到文首 / 文末，所以创建时另存一份 Yjs 相对位置，
 * 远端事务里据此重新求绝对位置。 */

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from 'y-prosemirror'
import { COPY } from '../copy'
import { uploadFile, toDisplay, type FileMeta } from './media'

interface Slot {
  id: number
  pos: number
  /** Yjs 相对位置；没有协同绑定（只读 / 未连上）时为 null，只靠 mapping */
  rel: unknown
  /** 同一落点多个占位的先后：widget side 递增，后续插入按 assoc=1 排到已插节点之后 */
  order: number
  file: File
  /** 图片的本地 blob URL，上传结束后由 settle 回收 */
  preview: string | null
}

type Meta = { add: Slot[] } | { remove: number }

const placeholderKey = new PluginKey<Slot[]>('UPLOAD_PLACEHOLDER')
let seq = 0

interface YBinding {
  doc: unknown
  type: unknown
  mapping: unknown
}

function yBinding(state: EditorState): YBinding | null {
  const binding = (ySyncPluginKey.getState(state) as { binding?: YBinding | null } | undefined)?.binding
  return binding ?? null
}

function mapSlots(slots: Slot[], tr: Transaction, state: EditorState): Slot[] {
  const remote = (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
  const binding = remote ? yBinding(state) : null
  const size = state.doc.content.size
  return slots.map((s) => {
    let pos = tr.mapping.map(s.pos, 1)
    if (binding && s.rel) {
      // 相对位置所在的内容被删了会解析成 null，此时退回 mapping 结果（占位至少还在文档里）
      const abs = relativePositionToAbsolutePosition(binding.doc as never, binding.type as never, s.rel, binding.mapping as never)
      if (abs != null) pos = abs
    }
    return { ...s, pos: Math.min(Math.max(0, pos), size) }
  })
}

/* 上传进度：PM 可能因段落重绘重建 widget DOM，进度存在模块里，新 DOM 建出来时补上当前值 */
const progress = new Map<number, number>()
const boxes = new Map<number, HTMLElement>()

function paintProgress(box: HTMLElement, ratio: number): void {
  // 请求体发完后还要等服务端落盘 / 生成 webp，进度条停在 95% 而不是 100%，避免"满了却还没好"
  const shown = Math.min(ratio, 1) * 0.95
  box.style.setProperty('--p', shown.toFixed(3))
  const pct = box.querySelector('.upload-ph-pct')
  if (pct) pct.textContent = `${Math.round(shown * 100)}%`
}

function setProgress(id: number, ratio: number): void {
  progress.set(id, ratio)
  const box = boxes.get(id)
  if (box?.isConnected) paintProgress(box, ratio)
}

function placeholderDOM(slot: Slot): HTMLElement {
  const box = document.createElement('span')
  box.className = 'upload-ph'
  box.contentEditable = 'false'
  box.title = COPY.upload.uploading(slot.file.name)
  const bar = document.createElement('span')
  bar.className = 'upload-ph-bar'
  bar.append(document.createElement('span'))
  const showCard = () => {
    box.classList.add('is-card')
    const icon = document.createElement('span')
    icon.className = 'upload-ph-icon'
    const name = document.createElement('span')
    name.className = 'upload-ph-name'
    name.textContent = slot.file.name
    const pct = document.createElement('span')
    pct.className = 'upload-ph-pct'
    box.prepend(icon, name, pct)
    paintProgress(box, progress.get(slot.id) ?? 0)
  }
  if (slot.preview) {
    const img = document.createElement('img')
    img.alt = ''
    img.src = slot.preview
    img.draggable = false
    img.addEventListener('error', () => {
      img.remove()
      showCard()
    })
    box.append(img)
  } else showCard()
  box.append(bar)
  paintProgress(box, progress.get(slot.id) ?? 0)
  boxes.set(slot.id, box)
  return box
}

function decorations(slots: Slot[], doc: ProsemirrorNode): DecorationSet {
  if (slots.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    slots.map((s) =>
      // key 相同 PM 就复用已有 DOM：每次事务重建装饰不会让 blob 预览重新加载闪烁
      Decoration.widget(s.pos, () => placeholderDOM(s), { key: `upload-${s.id}`, side: 1 + s.order, ignoreSelection: true }),
    ),
  )
}

/** 在 pos（null = 当前选区）为每个文件放一个占位。选区非空时先删掉选中内容（与粘贴替换选区的直觉一致） */
function addPlaceholders(view: EditorView, files: File[], pos: number | null): Slot[] {
  if (pos == null && !view.state.selection.empty) view.dispatch(view.state.tr.deleteSelection())
  const state = view.state
  const at = Math.min(Math.max(0, pos ?? state.selection.from), state.doc.content.size)
  // 本地事务在 dispatch 里同步刷进 Y.Doc，此刻 binding 与 state 一致，算出的相对位置可靠
  const binding = yBinding(state)
  let rel: unknown = null
  if (binding) {
    try {
      rel = absolutePositionToRelativePosition(at, binding.type as never, binding.mapping as never)
    } catch {
      rel = null
    }
  }
  const slots = files.map((file, order) => ({
    id: ++seq,
    pos: at,
    rel,
    order,
    file,
    preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  }))
  view.dispatch(state.tr.setMeta(placeholderKey, { add: slots } satisfies Meta))
  return slots
}

/** 撤掉占位；node 非空则在占位处插入真节点（同一事务，视觉上是原地替换）。
 * 落点插不进去（协同 / 输入让位置失效）就退回选区插入，保证文件不白传 */
function settle(view: EditorView, id: number, node: ProsemirrorNode | null): void {
  if (view.isDestroyed) return
  const slot = placeholderKey.getState(view.state)?.find((s) => s.id === id)
  const tr = view.state.tr.setMeta(placeholderKey, { remove: id } satisfies Meta)
  if (node) {
    try {
      if (!slot) throw new Error('placeholder gone')
      tr.insert(slot.pos, node)
    } catch {
      tr.replaceSelectionWith(node)
    }
  }
  view.dispatch(tr)
}

/** 先把视图层要显示的 display 版拉进浏览器缓存再换节点：否则占位撤掉时真图还是空盒，布局塌一下再撑开。
 * 网络卡住也不能让占位永远转圈，超时后照常替换（真图自己接着加载） */
async function preload(src: string): Promise<void> {
  const img = new Image()
  img.src = toDisplay(src)
  await Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 15000))])
}

/** 图片 mime → 插 commonmark image 节点（src 存原图 URL）；视频 / 音频 → 播放器（embed.ts）；其他文件 → 附件卡片 */
function nodeForFile(view: EditorView, meta: FileMeta): ProsemirrorNode | null {
  const schema = view.state.schema
  if (meta.mime.startsWith('image/')) {
    const image = schema.nodes.image
    return image ? image.create({ src: meta.url, alt: meta.name, title: '' }) : null
  }
  const media = meta.mime.startsWith('video/') ? 'video' : meta.mime.startsWith('audio/') ? 'audio' : null
  if (media && schema.nodes.embed) return schema.nodes.embed.create({ kind: media, src: meta.url, height: '' })
  const attachment = schema.nodes.attachment
  return attachment ? attachment.create({ src: meta.url, name: meta.name, size: meta.size }) : null
}

/** 占位一次全放出来，再顺序上传逐个替换；任一失败 alert 后继续剩下的（多选拖拽不因一个坏文件全丢） */
async function insertFiles(view: EditorView, files: File[], pos: number | null): Promise<void> {
  if (files.length === 0 || view.isDestroyed) return
  const slots = addPlaceholders(view, files, pos)
  for (const slot of slots) {
    try {
      const meta = await uploadFile(slot.file, (ratio) => setProgress(slot.id, ratio))
      if (view.isDestroyed) continue
      const node = nodeForFile(view, meta)
      if (node?.type.name === 'image') await preload(meta.url)
      settle(view, slot.id, node)
    } catch (err) {
      settle(view, slot.id, null)
      window.alert(err instanceof Error && err.message ? err.message : '上传失败，请重试')
    } finally {
      progress.delete(slot.id)
      boxes.delete(slot.id)
      if (slot.preview) URL.revokeObjectURL(slot.preview)
    }
  }
}

/** slash 菜单入口：隐藏 file input（accept 限定可选类型），选中后走同一上传插入路径 */
export function pickAndInsert(view: EditorView, accept: string): void {
  const input = document.createElement('input')
  input.type = 'file'
  if (accept) input.accept = accept
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : []
    input.remove()
    void insertFiles(view, files, null)
  })
  // 取消选择时 change 不触发，input 会一直留在 DOM 里，靠 cancel 事件摘掉
  input.addEventListener('cancel', () => input.remove())
  input.click()
}

/* uploadPlugin：接管粘贴 / 拖拽的文件，并持有占位状态（占位与接管入口同一插件，不会出现有上传没占位）。
 * clipboardData / DataTransfer.files 非空才接管（返回 true 让 PM preventDefault）；
 * 只读实例直接放行，挂了插件也不会触发上传。 */
export const uploadPlugin = $prose(
  () =>
    new Plugin<Slot[]>({
      key: placeholderKey,
      state: {
        init: () => [],
        apply: (tr, slots, _old, state) => {
          let next = slots.length > 0 && tr.docChanged ? mapSlots(slots, tr, state) : slots
          const meta = tr.getMeta(placeholderKey) as Meta | undefined
          if (meta && 'add' in meta) next = [...next, ...meta.add]
          else if (meta) next = next.filter((s) => s.id !== meta.remove)
          return next
        },
      },
      props: {
        decorations: (state) => decorations(placeholderKey.getState(state) ?? [], state.doc),
        handlePaste: (view, event) => {
          const files = event.clipboardData?.files
          if (!files || files.length === 0) return false
          if (!view.editable) return false
          void insertFiles(view, Array.from(files), null)
          return true
        },
        handleDrop: (view, event) => {
          const files = event.dataTransfer?.files
          if (!files || files.length === 0) return false
          if (!view.editable) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
          void insertFiles(view, Array.from(files), at ? at.pos : null)
          return true
        },
      },
    }),
)
