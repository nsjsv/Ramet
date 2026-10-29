/* ---------- 代码块语法高亮 ----------
 * 一个 tokenizer（highlightRanges：lowlight 的 hast 转成扁平的 [from, to, class]），两种画法：
 *   - PM 视图（编辑器 / 公开页）：codeHighlight 插件出 inline decoration。按 语言 + 文本 缓存 token，
 *     打字时只重算被改到的代码块（ReplaceStep 的改动区间）；其它步骤（改语言是 ReplaceAroundStep）与库加载完成时全量重建，
 *     全量也走缓存，lowlight 只跑真变了的块。
 *   - 静态 DOM（对话气泡、历史预览、AI 实时回复、同步块）：hydrateCode 把 `pre[data-language] > code` 的文字换成带 class 的 span（文字不变）。
 * 库按需加载（lazy.ts）：文档里有带语言的代码块才拉，没到之前不画，到了派一笔空事务（meta）重建。
 * 超长代码块（> MAX_CODE 字）不高亮，每次按键重跑整块不值。 */

import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state'
import { ReplaceStep } from '@milkdown/kit/prose/transform'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { highlightName } from './code-langs'
import { loadLowlight, lowlightReady, onLazyLoaded, type Lowlight } from './lazy'

export type Token = { from: number; to: number; cls: string }

const MAX_CODE = 20_000

type Hast = { type: string; value?: string; properties?: { className?: unknown }; children?: Hast[] }

/** 代码文本转扁平 token（嵌套 span 的 class 拼在一起，没 class 的文字不出 token）。语言不认识返回 [] */
export function highlightRanges(lowlight: Lowlight, code: string, language: string): Token[] {
  const name = highlightName(language)
  if (!name || !code || code.length > MAX_CODE || !lowlight.registered(name)) return []
  const tree = lowlight.highlight(name, code) as unknown as Hast
  const out: Token[] = []
  let pos = 0
  const walk = (nodes: Hast[], classes: string[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const len = node.value?.length ?? 0
        if (len && classes.length) out.push({ from: pos, to: pos + len, cls: classes.join(' ') })
        pos += len
      } else if (node.type === 'element') {
        const cls = node.properties?.className
        walk(node.children ?? [], Array.isArray(cls) ? [...classes, ...cls.map(String)] : classes)
      }
    }
  }
  walk(tree.children ?? [], [])
  return out
}

/** 有没有需要高亮的代码块（决定要不要拉库） */
function wantsHighlight(language: unknown): boolean {
  return typeof language === 'string' && language.trim() !== '' && language.trim().toLowerCase() !== 'mermaid'
}

/* ---------- token 缓存（PM 插件与静态宿主共用） ---------- */

const cache = new Map<string, Token[]>()

function tokensFor(lowlight: Lowlight, code: string, language: string): Token[] {
  const key = `${language}\u0000${code}`
  const hit = cache.get(key)
  if (hit) return hit
  const tokens = highlightRanges(lowlight, code, language)
  if (cache.size > 400) cache.clear()
  cache.set(key, tokens)
  return tokens
}

/* ---------- PM 插件 ---------- */

const key = new PluginKey<DecorationSet>('RAMET_CODE_HIGHLIGHT')

function blockDecorations(lowlight: Lowlight, node: PMNode, pos: number): Decoration[] {
  if (!wantsHighlight(node.attrs.language)) return []
  const base = pos + 1
  return tokensFor(lowlight, node.textContent, String(node.attrs.language)).map((t) =>
    Decoration.inline(base + t.from, base + t.to, { class: t.cls }),
  )
}

function fullSet(doc: PMNode): DecorationSet {
  const lowlight = lowlightReady()
  if (!lowlight) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.spec.code && node.type.name === 'code_block') decos.push(...blockDecorations(lowlight, node, pos))
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decos)
}

/** 只有 ReplaceStep 的事务返回被改到的代码块在新文档里的位置；有别的步骤返回 null（调用方全量重建） */
function touchedCodeBlocks(tr: Transaction): Array<{ pos: number; node: PMNode }> | null {
  if (!tr.steps.every((step) => step instanceof ReplaceStep)) return null
  const ranges: Array<[number, number]> = []
  tr.mapping.maps.forEach((map, i) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = tr.mapping.slice(i + 1)
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)])
    })
  })
  const out = new Map<number, PMNode>()
  for (const [from, to] of ranges) {
    tr.doc.nodesBetween(Math.max(0, from), Math.min(tr.doc.content.size, to), (node, pos) => {
      if (node.type.name === 'code_block') out.set(pos, node)
      return !node.isTextblock
    })
  }
  return [...out].map(([pos, node]) => ({ pos, node }))
}

function docWantsHighlight(doc: PMNode): boolean {
  let want = false
  doc.descendants((node) => {
    if (want) return false
    if (node.type.name === 'code_block' && wantsHighlight(node.attrs.language)) want = true
    return !node.isTextblock
  })
  return want
}

/** 原始 PM 插件，不经 milkdown 的视图也能用（历史预览的只读 EditorView） */
export function createCodeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
      key,
      state: {
        init: (_config, state) => fullSet(state.doc),
        apply: (tr, set, _old, state) => {
          if (tr.getMeta(key) === 'reload') return fullSet(state.doc)
          if (!tr.docChanged) return set
          const lowlight = lowlightReady()
          if (!lowlight) return set.map(tr.mapping, tr.doc)
          const touched = touchedCodeBlocks(tr)
          if (!touched) return fullSet(state.doc)
          let next = set.map(tr.mapping, tr.doc)
          for (const { pos, node } of touched) {
            next = next.remove(next.find(pos, pos + node.nodeSize))
            next = next.add(tr.doc, blockDecorations(lowlight, node, pos))
          }
          return next
        },
      },
      props: {
        decorations: (state) => key.getState(state),
      },
      view: (view) => {
        let requested = false
        const ensure = (): void => {
          if (requested || lowlightReady() || !docWantsHighlight(view.state.doc)) return
          requested = true
          void loadLowlight().catch(() => {
            requested = false // 下次文档变化再试
          })
        }
        const off = onLazyLoaded((name) => {
          if (name === 'lowlight' && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, 'reload'))
        })
        ensure()
        return {
          update: () => ensure(),
          destroy: off,
        }
      },
    })
}

export const codeHighlight = $prose(() => createCodeHighlightPlugin())

/* ---------- 静态 DOM ---------- */

/** 把 token 画进 code 元素（文字不变，只是切成 span） */
function paint(code: HTMLElement, text: string, tokens: Token[]): void {
  const frag = document.createDocumentFragment()
  let pos = 0
  for (const t of tokens) {
    if (t.from > pos) frag.append(text.slice(pos, t.from))
    const span = document.createElement('span')
    span.className = t.cls
    span.textContent = text.slice(t.from, t.to)
    frag.append(span)
    pos = t.to
  }
  if (pos < text.length) frag.append(text.slice(pos))
  code.replaceChildren(frag)
}

/** root 里（含 root 自己）带语言的代码块的 code 元素 */
function codeElements(root: HTMLElement): HTMLElement[] {
  const pres = [...(root.matches('pre[data-language]') ? [root] : []), ...root.querySelectorAll<HTMLElement>('pre[data-language]')]
  return pres.flatMap((pre) => {
    const code = pre.querySelector<HTMLElement>(':scope > code')
    return code ? [code] : []
  })
}

/** 静态宿主里的代码块高亮，幂等（画过且文字没变的跳过）；库没到就先拉，到了再画一遍 */
export function hydrateCode(root: HTMLElement): void {
  const blocks = codeElements(root)
  if (!blocks.length) return
  const lowlight = lowlightReady()
  if (!lowlight) {
    const want = [...blocks].some((code) => wantsHighlight(code.parentElement?.dataset.language))
    if (want) void loadLowlight().then(() => hydrateCode(root), () => undefined)
    return
  }
  for (const code of blocks) {
    const language = code.parentElement?.dataset.language ?? ''
    const text = code.textContent ?? ''
    const sig = `${language}:${text.length}`
    if (!wantsHighlight(language) || code.dataset.hl === sig) continue
    paint(code, text, tokensFor(lowlight, text, language))
    code.dataset.hl = sig
  }
}
