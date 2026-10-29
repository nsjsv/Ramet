/* ---------- 随手 AI（⌘J）：正文里的改写 / 起草 ----------
 * 单次调用：不开 agent 会话、不进对话、不出岛、不进工作台。选中一段 ⌘J 是改写，没选中是在光标处起草；
 * 光标在文档里正在写的 `>>` 草稿中，则把整条草稿写清楚（quick-draft.ts，固定指令）。
 * 结果以修订画在文档里：原文划掉（.quick-del）、新文字标绿（.quick-ins），全是 ProseMirror 装饰，
 * 不改文档；↵ 收下是一个事务替换（进 Yjs 与历史，⌘Z 回原样，落点规则见 quick-apply.ts），Esc 不要。
 * 生成中 Esc 取消请求（浮层的 onClose 统一负责：中止流、清装饰）。
 * 小浮层是 quick-popover.ts（纯 DOM、挂 body）；通道 / 模型 / key 在设置 → 随手 AI，请求走 quick-api.ts 的 SSE。
 * 键位：Mod-J。⌘I 仍是斜体；浏览器自带的 Ctrl+J（下载）在编辑器里被接管。
 * 只挂编辑器（editor-session.ts，viewer 不挂）；PublicPage 不挂。装饰不是节点，两个宿主的 schema 清单无需改动。 */

import { parserCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { posToDOMRect } from '@milkdown/kit/prose'
import { Fragment, type Node as PMNode, type Schema } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { COPY } from '../copy'
import { needsSettings, quickReadiness, streamQuick, type QuickBody } from '../quick-api'
import { openSettings } from '../settings-bus'
import { findBlockIdPos } from './block-id'
import { draftToComposerText } from './composer-bridge'
import { draftIdOf } from './doc-send'
import { normalizeTopLevelLists } from './list-blocks'
import { upgradeMentions } from './mention-upgrade'
import { LiveMarkdown } from './live-markdown'
import { applyQuickResult, blockPreviewAt, selectionMarkdown, textAfter, textBefore } from './quick-apply'
import { rewriteDraft, type DraftHost } from './quick-draft'
import { isQuickKey } from './quick-keys'
import { QuickPopover, type QuickPreset } from './quick-popover'

const Q = COPY.quick

/** 改写时给模型的前后文（够保持口吻，不多送内容）/ 起草时的前后文 */
const REWRITE_CONTEXT = 300
const DRAFT_CONTEXT = 2000

/** replace 换掉 [from, to]（原文划掉）；insert 在 to 处插入（光标起草 / 选区加续写），[from, to] 只是选区 */
interface Preview {
  from: number
  to: number
  mode: 'replace' | 'insert'
  text: string
}

interface QuickState {
  preview: Preview | null
}

const quickKey = new PluginKey<QuickState>('rametQuickAi')

type QuickMeta = { set: Preview | null }

/** 结果有换行用块预览（挂在所在文本块之后），否则用行内预览（紧跟在被换的文字后面） */
const isBlockText = (text: string): boolean => /\n/.test(text.trim())

function previewDom(schema: Schema, text: string, owner: QuickController | null): HTMLElement {
  const block = isBlockText(text)
  const el = document.createElement(block ? 'div' : 'span')
  el.className = 'quick-ins' + (block ? ' is-block' : '')
  el.contentEditable = 'false'
  if (block) {
    const live = new LiveMarkdown(schema)
    live.render(text.trim())
    el.append(live.el)
  } else {
    el.textContent = text.trimStart()
  }
  if (owner) owner.previewEl = el
  return el
}

function caretDom(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'quick-caret'
  el.contentEditable = 'false'
  return el
}

/** 光标所在的草稿消息（文档最后一条用户消息且其后没有回复）；内容不是纯段落（有列表 / 代码块……）时不当草稿整理，免得压平结构 */
function draftAt(state: EditorState): { id: string } | null {
  const { $head } = state.selection
  if ($head.depth < 1) return null
  const top = $head.node(1)
  const id: unknown = top.attrs.id
  if (top.type.name !== 'user_message' || typeof id !== 'string' || id !== draftIdOf(state.doc)) return null
  let simple = true
  top.forEach((child) => {
    if (child.type.name !== 'paragraph') simple = false
  })
  return simple ? { id } : null
}

function docDraftHost(view: EditorView, id: string): DraftHost {
  const find = (): { pos: number; node: PMNode } | null => {
    const pos = findBlockIdPos(view.state.doc, id)
    const node = pos === null ? null : view.state.doc.nodeAt(pos)
    return pos !== null && node ? { pos, node } : null
  }
  return {
    get: () => {
      const hit = find()
      return hit ? draftToComposerText(hit.node) : ''
    },
    set: (text) => {
      const hit = find()
      if (!hit || view.isDestroyed) return false
      const { schema } = view.state
      const paras = text.split('\n').map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null))
      const inner = { from: hit.pos + 1, to: hit.pos + hit.node.nodeSize - 1 }
      const tr = view.state.tr.replaceWith(inner.from, inner.to, paras)
      tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(inner.to, -1)), -1))
      upgradeMentions(tr) // 记号升回 chip，同一个事务，一次 ⌘Z 回原文
      view.dispatch(tr.scrollIntoView())
      view.focus()
      return true
    },
    anchor: () => {
      const hit = find()
      const dom = hit ? view.nodeDOM(hit.pos) : null
      return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
    },
  }
}

interface Session {
  /** 打开时选区里的文字（收下前核对：原文被改了就不替换） */
  original: string
}

const PRESETS: QuickPreset[] = [
  { id: 'concise', label: Q.presets.concise },
  { id: 'polish', label: Q.presets.polish },
  { id: 'continue', label: Q.presets.continue },
  { id: 'english', label: Q.presets.english },
]
const CARET_PRESETS = PRESETS.filter((p) => p.id === 'continue')

const controllers = new WeakMap<EditorView, QuickController>()

/** 选区菜单里的「✨ ⌘J」按钮 / 快捷键共用的入口；这个视图没挂随手 AI（只读等）返回 false */
export function openQuickAi(view: EditorView): boolean {
  return controllers.get(view)?.open() ?? false
}

class QuickController {
  /** 当前预览的 DOM（浮层锚在它下面）。由 previewDom 写入 */
  previewEl: HTMLElement | null = null
  private pop: QuickPopover | null = null
  private sess: Session | null = null
  private abort: AbortController | null = null
  private buf = ''
  private raf = 0

  constructor(
    private view: EditorView,
    private ctx: Ctx,
    private enabled: boolean,
  ) {}

  preview(): Preview | null {
    return quickKey.getState(this.view.state)?.preview ?? null
  }

  private setPreview(preview: Preview | null): void {
    if (this.view.isDestroyed) return
    const meta: QuickMeta = { set: preview }
    this.view.dispatch(this.view.state.tr.setMeta(quickKey, meta).setMeta('addToHistory', false))
  }

  /** ⌘J / 按钮：返回 true 表示这个按键已经处理（浏览器自带的 Ctrl+J 不该再出来） */
  open(): boolean {
    const { view } = this
    if (!this.enabled || !view.editable) return false
    if (this.sess) {
      this.pop?.focus()
      return true
    }
    const draft = draftAt(view.state)
    if (draft) {
      rewriteDraft(docDraftHost(view, draft.id))
      return true
    }
    const sel = view.state.selection
    if (!(sel instanceof TextSelection)) return true // 块选区 / 单元格选区：不处理，也别让浏览器弹下载页
    const { from, to, empty } = sel
    this.sess = { original: empty ? '' : view.state.doc.textBetween(from, to, '\n\n', ' ') }
    this.setPreview({ from, to, mode: empty ? 'insert' : 'replace', text: '' })
    const sess = this.sess
    this.pop = new QuickPopover({
      input: true,
      presets: empty ? CARET_PRESETS : PRESETS,
      placeholder: empty ? Q.placeholderDraft : Q.placeholderRewrite,
      anchor: () => this.anchorRect(),
      onRun: (text, preset) => this.run(text, preset),
      onAccept: () => this.accept(),
      onClose: () => this.close(),
      onSettings: () => {
        this.close()
        openSettings('quick')
      },
    })
    this.pop.reposition()
    this.pop.focus()
    void quickReadiness().then((r) => {
      if (!r.ok && this.sess === sess) this.pop?.setPhase({ kind: 'error', message: r.message, settings: true })
    })
    return true
  }

  private anchorRect(): DOMRect | null {
    if (this.previewEl?.isConnected) return this.previewEl.getBoundingClientRect()
    const p = this.preview()
    if (!p || this.view.isDestroyed) return null
    try {
      return posToDOMRect(this.view, p.from, p.to)
    } catch {
      return null
    }
  }

  private run(text: string, preset?: QuickPreset): void {
    const p = this.preview()
    if (!this.sess || !p) return
    this.abort?.abort()
    const ctrl = new AbortController()
    this.abort = ctrl
    this.buf = ''
    this.previewEl = null
    // 选中一段再点「续写」预设，是接在选区后面写，不是换掉它
    const append = preset?.id === 'continue' && p.from < p.to
    const mode: Preview['mode'] = append || p.from === p.to ? 'insert' : 'replace'
    this.setPreview({ ...p, mode, text: '' })
    const instruction = preset ? Q.presetInstructions[preset.id as keyof typeof Q.presetInstructions] : text
    const { state } = this.view
    const body: QuickBody =
      mode === 'replace'
        ? {
            kind: 'rewrite',
            instruction,
            text: selectionMarkdown(state, p.from, p.to, (doc) => this.ctx.get(serializerCtx)(doc)),
            before: textBefore(state, p.from, REWRITE_CONTEXT),
            after: textAfter(state, p.to, REWRITE_CONTEXT),
          }
        : { kind: 'draft', instruction, before: textBefore(state, p.to, DRAFT_CONTEXT), after: textAfter(state, p.to, DRAFT_CONTEXT) }
    this.pop?.setPhase({ kind: 'running' })
    void streamQuick(body, (d) => this.onDelta(d, ctrl), ctrl.signal).then((out) => {
      if (ctrl !== this.abort || !this.sess) return
      if (!out.ok && out.code === 'aborted') return
      this.flush()
      if (out.ok) {
        this.pop?.setPhase({ kind: 'review' })
        return
      }
      this.buf = ''
      const cur = this.preview()
      if (cur) this.setPreview({ ...cur, text: '' })
      this.pop?.setPhase({ kind: 'error', message: out.message, settings: needsSettings(out.code) })
    })
  }

  /** 增量按帧合并再上屏：流式每个字都派一次事务太碎 */
  private onDelta(d: string, ctrl: AbortController): void {
    if (ctrl !== this.abort) return
    this.buf += d
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0
        this.flush()
      })
    }
  }

  private flush(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    const p = this.preview()
    if (!p || p.text === this.buf) return
    this.setPreview({ ...p, text: this.buf })
    this.pop?.reposition()
  }

  private accept(): void {
    const { view } = this
    const s = this.sess
    const p = this.preview()
    const markdown = this.buf.trim()
    if (!s || !p || !markdown || view.isDestroyed) return
    // 原文在等待期间被别人（或自己）改过：不替换，免得盖掉新写的东西
    if (p.mode === 'replace' && (p.from >= p.to || view.state.doc.textBetween(p.from, p.to, '\n\n', ' ') !== s.original)) {
      this.pop?.setPhase({ kind: 'error', message: Q.stale })
      return
    }
    let blocks = Fragment.empty
    try {
      const parsed = this.ctx.get(parserCtx)(markdown) // 与粘贴 markdown 同一个解析器
      if (parsed) blocks = normalizeTopLevelLists(parsed)
    } catch {
      // 解析失败：blocks 留空，applyQuickResult 返回 null，浮层报「放不进去」
    }
    const replace = p.mode === 'replace'
    const tr = applyQuickResult(view.state, { from: replace ? p.from : p.to, to: p.to, replace, markdown, blocks })
    if (!tr) {
      this.pop?.setPhase({ kind: 'error', message: Q.cannotPlace })
      return
    }
    upgradeMentions(tr) // 结果里的 @[…](page:…) 记号 / 降级链接升回 chip
    const meta: QuickMeta = { set: null }
    tr.setMeta(quickKey, meta)
    this.teardown()
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  /** 不要 / Esc / 点外面 / 生成中取消：中止请求、清装饰、收浮层 */
  close(): void {
    if (!this.sess && !this.pop) return
    this.teardown()
    this.setPreview(null)
    if (!this.view.isDestroyed) this.view.focus()
  }

  private teardown(): void {
    this.abort?.abort()
    this.abort = null
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.pop?.destroy()
    this.pop = null
    this.sess = null
    this.previewEl = null
    this.buf = ''
  }

  dispose(): void {
    this.teardown()
  }
}

/** 预览装饰：replace = 原文划掉（还没结果时只标选区）+ 结果挂在后面；insert = 结果挂在插入点（光标处先画一根插入线） */
function quickDecorations(state: EditorState, owner: QuickController | null): DecorationSet | null {
  const p = quickKey.getState(state)?.preview
  if (!p || p.to > state.doc.content.size || p.from > p.to) return null
  const decos: Decoration[] = []
  const hasText = p.text.trim().length > 0
  if (p.mode === 'replace') decos.push(Decoration.inline(p.from, p.to, { class: hasText ? 'quick-del' : 'quick-sel' }))
  else if (!hasText && p.from < p.to) decos.push(Decoration.inline(p.from, p.to, { class: 'quick-sel' }))
  if (hasText) {
    const block = isBlockText(p.text)
    const at = block ? blockPreviewAt(state, p.to) : p.to
    const text = p.text
    decos.push(
      Decoration.widget(at, () => previewDom(state.schema, text, owner), { side: 1, key: `quick-${at}-${text.length}-${block}`, ignoreSelection: true }),
    )
  } else if (p.mode === 'insert' && p.from === p.to) {
    decos.push(Decoration.widget(p.to, caretDom, { side: 1, key: 'quick-caret', ignoreSelection: true }))
  }
  return DecorationSet.create(state.doc, decos)
}

/** 随手 AI 插件。enabled = 有写权（viewer 不挂） */
export function quickAi(opts: { enabled: boolean }) {
  return $prose((ctx) => {
    // 装饰函数拿不到视图：控制器在 view() 里建好后记在这个闭包里（每个编辑器实例一份；collab 重建插件视图时被新的覆盖）
    let current: QuickController | null = null
    return new Plugin<QuickState>({
      key: quickKey,
      state: {
        init: () => ({ preview: null }),
        apply(tr, value) {
          const meta = tr.getMeta(quickKey) as QuickMeta | undefined
          if (meta) return { preview: meta.set }
          const p = value.preview
          if (!p || !tr.docChanged) return value
          // 文档在预览期间被改（本端或协作者）：范围跟着走；原文有没有变，收下时核对
          const from = tr.mapping.map(p.from, 1)
          const to = Math.max(from, tr.mapping.map(p.to, -1))
          return { preview: { ...p, from, to } }
        },
      },
      props: {
        decorations: (state) => quickDecorations(state, current),
        handleKeyDown: (view, event) => (isQuickKey(event) ? (controllers.get(view)?.open() ?? false) : false),
      },
      view: (view) => {
        const controller = new QuickController(view, ctx, opts.enabled)
        controllers.set(view, controller)
        current = controller
        return {
          destroy: () => {
            controller.dispose()
            controllers.delete(view)
            if (current === controller) current = null
          },
        }
      },
    })
  })
}
