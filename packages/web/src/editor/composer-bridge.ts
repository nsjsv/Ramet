/* ---------- 对话输入框与文档的桥 ----------
 * 对话模式的输入框在 React 里（composer-input.tsx），气泡 / 顶栏切换在 React 外面（PM 装饰、编辑器页壳），所以几件事走这里：
 *  - 气泡的「引用」往输入框里放一段记号（insertIntoComposer）；
 *  - 文档 ⇄ 对话切换时没发出去的输入跟着走：对话到文档取走输入框的字（takeComposerText），
 *    文档到对话把草稿的字带过去（carryToChat，ChatView 挂载时 peekCarried，挂上后 clearCarried）。
 * 桥上传的是记号文字：页面提及 / 块引用 / agent 点名 / 成员落成 `@[标题](page:<id>)` / `@[文字](page:<页>#<块>)` /
 * `@[名字](agent:<id>)` / `@[名字](user:<id>)`。输入框进出时自己升 / 降（框里画的是 chip），发送（appendUserMessage）
 * 与回到文档时由 mention-upgrade.ts 升回 chip。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { mentionLabel } from './mention-query'

export interface Composer {
  get: () => string
  set: (text: string) => void
  insert: (text: string) => void
}

let current: Composer | null = null
let carried = ''

export function registerComposer(c: Composer): () => void {
  current = c
  return () => {
    if (current === c) current = null
  }
}

/** 往输入框末尾放一段文字并聚焦，没有输入框（只读 / 文档模式）返回 false */
export function insertIntoComposer(text: string): boolean {
  if (!current) return false
  current.insert(text)
  return true
}

/** 对话到文档：取走输入框里的字并清空，空白算没有 */
export function takeComposerText(): string {
  const text = current?.get() ?? ''
  if (!text.trim()) return ''
  current?.set('')
  return text
}

/** 文档到对话：先带着，ChatView 挂载时读（peek，StrictMode 下初始化函数会跑两次，读不能消耗），挂载后清掉 */
export function carryToChat(text: string): void {
  carried = text
}

export const peekCarried = (): string => carried

export function clearCarried(): void {
  carried = ''
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** 输入框里的块引用记号：label 取这块内容的开头 */
export function composerQuote(pageId: string, blockId: string, snippet: string): string {
  const s = flat(snippet)
  return `@[${mentionLabel(s.length > 40 ? `${s.slice(0, 40)}…` : s)}](page:${pageId}#${blockId})`
}

/** 草稿（user_message 块）转输入框里的字：段落按行、hardbreak 换行、页面提及 / 块引用 / agent 点名 / 成员提及落成记号，其余只取文字 */
export function draftToComposerText(msg: PMNode): string {
  const lines: string[] = []
  msg.forEach((block) => {
    let line = ''
    const visit = (n: PMNode): void => {
      if (n.isText) line += n.text ?? ''
      else if (n.type.name === 'hardbreak') line += '\n'
      else if (n.type.name === 'page_mention') line += `@[${mentionLabel(String(n.attrs.title ?? ''))}](page:${String(n.attrs.pageId ?? '')})`
      else if (n.type.name === 'agent_mention') line += `@[${String(n.attrs.label ?? '')}](agent:${String(n.attrs.agentId ?? '')})`
      else if (n.type.name === 'user_mention') line += `@[${String(n.attrs.name ?? '')}](user:${String(n.attrs.userId ?? '')})`
      else if (n.type.name === 'block_ref') {
        line += `@[${mentionLabel(flat(String(n.attrs.text ?? '')))}](page:${String(n.attrs.pageId ?? '')}#${String(n.attrs.blockId ?? '')})`
      } else n.forEach(visit)
    }
    visit(block)
    lines.push(line)
  })
  return lines.join('\n')
}
