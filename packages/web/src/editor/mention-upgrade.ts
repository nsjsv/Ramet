/* ---------- 降级形态 → 提及 chip（页面 / agent / 成员；打开页 migrate pass / 源码写回 / 粘贴 / 对话发送共用） ----------
 * 页面提及（page_mention）、块引用（block_ref）、agent 点名（agent_mention）、成员提及（user_mention）在 markdown /
 * 对话输入框里的形态：
 *   mdast 链接形态（toMarkdown 的输出）：文本恰为 `@名字`，单个 link mark，href 恰为 `page:<id>` / `agent:<id>` / `user:<id>`；
 *   纯文本形态：`@[名字](page:<id>)` / `@[名字](page:<页>#<块>)`（块引用）/ `@[名字](agent:<id>)` / `@[名字](user:<id>)`。
 *   对话输入框（composer-input.tsx）对外传的是纯文本形态：框内、发送、回到文档时都在这里升成 chip。
 *   对话输入框里的图片与文件引用也走纯文本形态：`@[图片](image:<文件 uuid>)` → 本站图片节点（别的地址不升），
 *   `@[文件名](file:<编码路径>)` → file_mention（编码见 file-mention.ts；链接形态 `[@路径](file:…)` 同样升）。
 * 纯文本形态按收口锚（`](page:` / `](agent:` / `](user:` / …）定位，不用第一个 `]` 切名字：标题里可能带 `]`
 * （如 `@[[开源内测]什么？…](page:…)`），用第一个 `]` 会切出半个标题、整条都升不回来。代码块 / 行内码里的原文不动。
 * 对 Transaction 原地操作（调用方各自组进单事务，即单个撤销步）；先收集后按 pos 降序替换。
 * 幂等：升过的节点不再是文本，重跑零 diff；协同多端同时跑也自然收敛。 */

import { Fragment } from '@milkdown/kit/prose/model'
import type { Node as ProsemirrorNode, NodeType } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { ySyncPluginKey } from 'y-prosemirror'
import { fileOfTarget } from './file-mention'
import { FILE_URL_RE } from './media'

type Kind = 'page' | 'agent' | 'user' | 'image' | 'file'
type Types = { page?: NodeType; agent?: NodeType; user?: NodeType; blockRef?: NodeType; image?: NodeType; file?: NodeType }

const LINK_HREF_RE = /^(page|agent|user|file):([^\s)]+)$/
const OPEN = '@['
const ANCHORS: ReadonlyArray<readonly [Kind, string]> = [
  ['page', '](page:'],
  ['agent', '](agent:'],
  ['user', '](user:'],
  ['image', '](image:'],
  ['file', '](file:'],
]

interface Repl {
  from: number
  to: number
  frag: Fragment
}

/** 一个提及对应的节点；对应的节点类型没注册（schema 里没有）就不升 */
function chipOf(kind: Kind, target: string, label: string, types: Types): ProsemirrorNode | null {
  if (kind === 'agent') return types.agent ? types.agent.create({ agentId: target, label }) : null
  if (kind === 'user') return types.user ? types.user.create({ userId: target, name: label }) : null
  if (kind === 'image') {
    const src = `/api/files/${target}`
    return types.image && FILE_URL_RE.test(src) ? types.image.create({ src }) : null
  }
  if (kind === 'file') return types.file ? types.file.create({ path: fileOfTarget(target) }) : null
  // `page:<页>#<块>` = 块引用（对话输入框里的「引用」落成这种记号，发送时升成 block_ref chip）；没有 `#` = 页面提及
  const hash = target.indexOf('#')
  if (hash > 0 && hash < target.length - 1 && types.blockRef) {
    return types.blockRef.create({ pageId: target.slice(0, hash), blockId: target.slice(hash + 1), text: label })
  }
  return types.page ? types.page.create({ pageId: target, title: label }) : null
}

/** 纯文本形态扫描：`@[` 起、以最近的收口锚收口、`)` 结束 */
function collectPlain(node: ProsemirrorNode, pos: number, types: Types, codeBlock: boolean, repls: Repl[]): void {
  if (codeBlock || node.marks.some((m) => m.type.name === 'inlineCode')) return
  const text = node.text ?? ''
  let open = text.indexOf(OPEN)
  while (open !== -1) {
    let tail = -1
    let kind: Kind = 'page'
    let anchor = ''
    for (const [k, a] of ANCHORS) {
      const at = text.indexOf(a, open + OPEN.length)
      if (at !== -1 && (tail === -1 || at < tail)) {
        tail = at
        kind = k
        anchor = a
      }
    }
    if (tail === -1) return
    const idStart = tail + anchor.length
    const close = text.indexOf(')', idStart)
    if (close === -1) return
    const target = text.slice(idStart, close)
    if (!target || /\s/.test(target)) {
      open = text.indexOf(OPEN, open + OPEN.length)
      continue
    }
    const chip = chipOf(kind, target, text.slice(open + OPEN.length, tail), types)
    if (chip) repls.push({ from: pos + open, to: pos + close + 1, frag: Fragment.from(chip) })
    open = text.indexOf(OPEN, close + 1)
  }
}

export function upgradeMentions(tr: Transaction): boolean {
  const nodes = tr.doc.type.schema.nodes
  const types: Types = {
    page: nodes.page_mention,
    agent: nodes.agent_mention,
    user: nodes.user_mention,
    blockRef: nodes.block_ref,
    image: nodes.image,
    file: nodes.file_mention,
  }
  if (!Object.values(types).some(Boolean)) return false
  const repls: Repl[] = []
  tr.doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return
    const links = node.marks.filter((m) => m.type.name === 'link')
    if (node.marks.length === 1 && links.length === 1) {
      const href = links[0]!.attrs.href
      const m = typeof href === 'string' ? LINK_HREF_RE.exec(href) : null
      if (m) {
        // 文本是 `@名字` 时剥掉前缀（chip 自己就是「提及」语义，画面不需要那个 @；agent / 成员 chip 自己会画 @）
        const label = node.text.startsWith('@') ? node.text.slice(1) : node.text
        const chip = chipOf(m[1] as Kind, m[2]!, label, { ...types, blockRef: undefined })
        if (chip) repls.push({ from: pos, to: pos + node.nodeSize, frag: Fragment.from(chip) })
      }
      return // 带 link mark：只可能是降级链接形态，不再按纯文本形态扫
    }
    collectPlain(node, pos, types, parent?.type.spec.code === true, repls)
  })
  // 降序替换：后面的 pos 不受前面替换影响
  for (let i = repls.length - 1; i >= 0; i--) {
    const r = repls[i]!
    tr.replaceWith(r.from, r.to, r.frag)
  }
  return repls.length > 0
}

/** 把当前文档里的降级形态升成 chip。没有可升的返回 null。 */
function upgradeTr(state: { tr: Transaction }): Transaction | null {
  const tr = state.tr
  return upgradeMentions(tr) ? tr : null
}

/** 协同把远端改动灌进来的那一笔（插件为它追加的事务也算：追到根事务看） */
function isRemote(tr: Transaction): boolean {
  const root = (tr.getMeta('appendedTransaction') as Transaction | undefined) ?? tr
  return !!(root.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
}

/**
 * 跟文档变化走：本端改动（粘贴、手打、对话输入框、源码写回）里出现的记号当场升成 chip，视图挂上时再扫一遍已经在手里的文档。
 * remote = 远端灌进来的改动也升，只给只读宿主（公开页）用：它不往回写，升只是为了画对。可写的编辑器不能这么做——
 * 协同同步那一笔里追加的改动，y-prosemirror 不写回 Yjs，只停在这一个编辑器里（同一文档的别的视图、别的端都看不到，
 * 要等它下一次本地编辑才连带写回，几个端各写一颗还会多出 chip）。远端来的内容由写入方落成 chip
 * （agent 回复经 @ramet/shared/markdown-blocks），老数据由打开页的转换 pass（editor-session.ts）升，那是一笔本端事务。
 */
export function mentionUpgradePlugin(opts: { remote?: boolean } = {}): Plugin {
  return new Plugin({
    appendTransaction(transactions: readonly Transaction[], _old: EditorState, state: EditorState) {
      if (!transactions.some((tr) => tr.docChanged && (opts.remote === true || !isRemote(tr)))) return null
      return upgradeTr(state)
    },
    view(view: EditorView) {
      queueMicrotask(() => {
        if (view.isDestroyed) return
        const tr = upgradeTr(view.state)
        if (tr) view.dispatch(tr)
      })
      return {}
    },
  })
}

export const mentionUpgrade = $prose(() => mentionUpgradePlugin())

/** 只读宿主（公开页）：远端灌进来的记号也升成 chip 来画（不写回） */
export const mentionDisplay = $prose(() => mentionUpgradePlugin({ remote: true }))
