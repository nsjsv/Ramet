/* ---------- 媒体：上传 + 粘贴/拖拽接入 + 图片 webp 显示 + 图片灯箱 ----------
 * 后端契约（POST /api/files）：登录态 multipart，10MB 上限，201 回
 * {id, url, display, name, mime, size}；url=/api/files/<id> 原图，display=/api/files/<id>/display
 * 是 sharp 生成的 webp 压缩版（无则服务端退原图）。原图 URL 是文档里的 canonical 地址：
 * 快照/markdown 一律用原图，视图层（toDOM）与灯箱默认换成 display，见 imageDisplaySchema。 */

import { $nodeSchema, $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProsemirrorNode } from '@milkdown/kit/prose/model'
import { COPY } from '../copy'
import { formatSize } from './attachment'
import { directUrl } from '../file-fallback'

export interface FileMeta {
  id: string
  url: string
  display: string
  name: string
  mime: string
  size: number
}

/** 与服务端 bodyLimit 的 10MB 一致：超限在发请求前就拒，省一次注定 413 的上传流量 */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 上传原文件，不做客户端压缩。
 * 不走 api.ts 的 request()：那边硬编码 Content-Type: application/json，
 * FormData 必须让浏览器自己生成 multipart boundary。 */
export async function uploadFile(file: File): Promise<FileMeta> {
  if (file.size > MAX_FILE_SIZE) throw new Error(`文件超过 10MB（${formatSize(file.size)}），请压缩后再上传`)
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/files', { method: 'POST', body: form })
  if (!res.ok) {
    if (res.status === 413) throw new Error('文件超过 10MB，请压缩后再上传')
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `上传失败（${res.status}）`)
  }
  return (await res.json()) as FileMeta
}

/* ---------- image schema 覆盖：视图层渲染 webp display 版 ----------
 * 照抄 preset-commonmark 的 imageSchema，只改 toDOM。
 * $nodeSchema('image') 经 upsertById 原位替换 nodesCtx 里的同名条目：
 * - final Schema 的 nodes.image 变成本 spec，commonmark 内部命令 / 输入规则取 imageSchema.type(ctx) 时自动解析到本节点类型；
 * - 原位替换保持 schema.nodes 的枚举顺序，markdown token 匹配次序不受影响；
 * - attrs / parseMarkdown / toMarkdown 与原版一致，存量和增量 Y.Doc 与序列化都兼容。
 * attrs.src 恒存原图 URL（canonical），仅 toDOM 输出时追加 /display。 */

/** 本站上传的文件地址：/api/files/<uuid>。外链图片（含历史文档里的裸图）没有 display 版，原样输出。
 * 导出供 page-ref.ts 的降级链接升块判定复用（attachment 的逆路径）。 */
export const FILE_URL_RE = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const imageDisplaySchema = $nodeSchema('image', () => ({
  inline: true,
  group: 'inline',
  selectable: true,
  draggable: true,
  marks: '',
  atom: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '' },
    alt: { default: '' },
    title: { default: '' },
  },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        // 剥掉 /display 后缀：从编辑器拷出的剪贴板 HTML 里 src 已被 toDOM 换成 display 版，
        // 不归一的话 attrs.src 会被污染成非 canonical 的 display URL（灯箱 / 导出全跟着错）
        const src = (el.getAttribute('src') || '').replace(/\/display$/, '')
        return {
          src,
          alt: el.getAttribute('alt') || '',
          title: el.getAttribute('title') || el.getAttribute('alt') || '',
        }
      },
    },
  ],
  toDOM: (node) => {
    const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
    const displaySrc = FILE_URL_RE.test(src) ? `${src}/display` : src
    // 包一层 span：img 是 replaced 元素，伪元素 / inset 阴影 / 背景都叠不上，
    // 选中态的遮罩与包边需要可定位盒子，全落在 wrapper（prose.css .img-wrap）。
    // parseDOM 仍匹配内层 img[src]，剪贴板 / 拖拽 / 外部粘贴解析不受影响
    return ['span', { class: 'img-wrap' }, ['img', { ...node.attrs, src: displaySrc }]]
  },
  parseMarkdown: {
    match: ({ type }) => type === 'image',
    runner: (state, node, type) => {
      const url = node.url
      const alt = node.alt
      const title = node.title
      state.addNode(type, { src: url, alt, title })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'image',
    runner: (state, node) => {
      state.addNode('image', undefined, undefined, {
        title: node.attrs.title,
        url: node.attrs.src,
        alt: node.attrs.alt,
      })
    },
  },
}))

/** 纯图片块 / 条目：paragraph 只含一个 image（文字加图混合不算）。
 * 选中高亮（Editor.tsx selected-img-item）与列表符号隐藏（imageItemMark）共用。
 * 必须在 JS 判 doc 结构：DOM 里 PM 有尾部 <br>、图片在 wrapper 里，CSS 结构选择器
 * （:only-child / :has）不是被 <br> 破坏就是非法嵌套 */
export function isImageItem(n: ProsemirrorNode | null | undefined): boolean {
  if (!n) return false
  if (n.type.name === 'paragraph') return n.childCount === 1 && n.child(0).type.name === 'image'
  if (n.type.name === 'list_item' || n.type.name === 'bullet_list' || n.type.name === 'ordered_list')
    return n.childCount === 1 && isImageItem(n.child(0))
  return false
}

/** 纯图片列表条目常驻打 img-item 类（CSS：不画点 / 序号 / 待办框，缩进保留），图片条目不需要列表符号 */
const imageItemKey = new PluginKey('IMAGE_ITEM_MARK')
export const imageItemMark = $prose(
  () =>
    new Plugin({
      key: imageItemKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, old) => {
          if (!tr.docChanged) return old.map(tr.mapping, tr.doc)
          // 每次文档变更全量扫 list_item，O(doc)，文档规模小够用
          const decos: Decoration[] = []
          tr.doc.descendants((n, pos) => {
            if (n.type.name !== 'list_item') return true
            if (isImageItem(n)) {
              decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'img-item' }))
              return false // 纯图片条目内容只可能是单段含图，内部不会再有 li
            }
            return true // 非图片条目必须继续下钻：嵌套图片条目（图片拖成子级）在子 list 里
          })
          return DecorationSet.create(tr.doc, decos)
        },
      },
      props: { decorations: (s) => imageItemKey.getState(s) },
    }),
)

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

/** 在 pos（null = 当前选区）插入节点。上传是异步的，落点可能因协同/输入失效：
 * 插不进去就退回选区插入，保证文件不白传。 */
function insertNode(view: EditorView, node: ProsemirrorNode, pos: number | null): void {
  if (view.isDestroyed) return
  try {
    const tr = view.state.tr
    if (pos != null) tr.insert(Math.min(Math.max(0, pos), tr.doc.content.size), node)
    else tr.replaceSelectionWith(node)
    view.dispatch(tr)
  } catch {
    if (view.isDestroyed) return
    view.dispatch(view.state.tr.replaceSelectionWith(node))
  }
}

/** 顺序上传并逐个插入；任一失败 alert 后继续剩下的（多选拖拽不因一个坏文件全丢） */
async function insertFiles(view: EditorView, files: File[], pos: number | null): Promise<void> {
  let at = pos
  for (const file of files) {
    try {
      const meta = await uploadFile(file)
      const node = nodeForFile(view, meta)
      if (!node) continue
      insertNode(view, node, at)
      // 同一落点插多个时后插的要排在先插的后面：落点按节点尺寸前移（选区插入则 PM 自己维护光标）
      if (at != null) at += node.nodeSize
    } catch (err) {
      window.alert(err instanceof Error && err.message ? err.message : '上传失败，请重试')
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

/* ---------- uploadPlugin：接管粘贴 / 拖拽的文件 ----------
 * clipboardData / DataTransfer.files 非空才接管（返回 true 让 PM preventDefault）；
 * 只读实例直接放行，挂了插件也不会触发上传。上传期间没有占位态。 */
export const uploadPlugin = $prose(
  () =>
    new Plugin({
      props: {
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

/* ---------- lightboxPlugin：点图片看大图（默认压缩版，按钮才拉原图） ----------
 * handleClickOn 命中 image 节点时开全屏浮层，默认显示 display 版（编辑区已加载过，浏览器缓存命中，
 * 不产生新请求）；点浮层底部「显示原图」才下载 attrs.src（原图 URL）。外链图片 / 历史裸图没有
 * display 版，原样显示、不出按钮。点浮层或 Esc 关闭（document keydown 挂一次，浮层移除时解绑）。
 * 同时接管附件卡片的下载点击：contenteditable 里浏览器不跟进 <a> 点击（/page/ 链接的跳转
 * 也是因此才手动拦的），必须 preventDefault 后用游离 <a download> 合成点击触发下载。
 * gif / svg 等没有 webp 派生版的图，服务端让 /display 直接退回原图，这时点按钮是重复请求同一份字节。 */

function openLightbox(src: string): void {
  if (document.querySelector('.lightbox')) return
  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  const img = document.createElement('img')
  const shown = FILE_URL_RE.test(src) ? `${src}/display` : src
  img.src = shown
  overlay.appendChild(img)
  if (shown !== src) overlay.appendChild(originalButton(img, src))
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    close()
  }
  const close = () => {
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('click', close)
  document.body.appendChild(overlay)
}

/** 「显示原图」：先在离屏 Image 里下载完再换 src（先换会闪白）；失败恢复按钮可重试。
 * 点按钮不能冒泡到浮层（浮层点击会关闭） */
function originalButton(img: HTMLImageElement, original: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'lightbox-original'
  btn.textContent = COPY.lightbox.showOriginal
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    btn.disabled = true
    btn.textContent = COPY.lightbox.loadingOriginal
    const probe = new Image()
    probe.onload = () => {
      img.src = original
      btn.remove()
    }
    probe.onerror = () => {
      btn.disabled = false
      btn.textContent = COPY.lightbox.originalFailed
    }
    probe.src = original
  })
  return btn
}

export const lightboxPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleClickOn: (_view, _pos, node) => {
          if (node.type.name !== 'image') return false
          const src = node.attrs.src
          if (typeof src !== 'string' || !src) return false
          openLightbox(src)
          return true
        },
        handleDOMEvents: {
          click: (_view, event) => {
            const a = (event.target as Element | null)?.closest?.('a')
            if (!a) return false
            const href = a.getAttribute('href') ?? ''
            if (!href.startsWith('/api/files/')) return false
            // 游离 <a>：不挂在文档树里，合成 click 不会再冒泡进 PM 的监听（否则同一个 a 上二次触发成死循环）
            event.preventDefault()
            const dl = document.createElement('a')
            // 固定走源站：图片可能 302 到图床，跨域跳转后 download 指定的文件名会失效
            dl.href = directUrl(href) ?? href
            dl.download = a.getAttribute('download') ?? ''
            document.body.appendChild(dl) // Firefox 要求元素在文档里才响应程序化 click
            dl.click()
            dl.remove()
            return true
          },
        },
      },
    }),
)
