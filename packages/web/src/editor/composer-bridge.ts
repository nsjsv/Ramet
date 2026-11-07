/* ---------- 对话输入框与文档的桥 ----------
 * 对话模式的输入框在 React 里（composer-input.tsx），气泡 / 顶栏切换在 React 外面（PM 装饰、编辑器页壳），所以几件事走这里：
 *  - 气泡的「引用」往输入框里放一段记号（insertIntoComposer）；
 *  - 文档 ⇄ 对话切换时没发出去的输入跟着走：对话到文档取走输入框的字（takeComposerText），
 *    文档到对话把草稿的字带过去（carryToChat，ChatView 挂载时 peekCarried，挂上后 clearCarried）。
 * 一切按页面分存：同一时刻可能有两个对话在场（当前页的对话视图 + 别处嵌着的另一页的对话），
 * 只有一份的话，这页气泡的「引用」会落进另一页的输入框，切换时也会把另一页的草稿搬过来。
 * 桥上传的是记号文字：页面提及 / 块引用 / agent 点名 / 成员落成 `@[标题](page:<id>)` / `@[文字](page:<页>#<块>)` /
 * `@[名字](agent:<id>)` / `@[名字](user:<id>)`，本站图片 / 文件引用落成 `@[图片](image:<id>)` / `@[文件名](file:<路径>)`。输入框进出时自己升 / 降（框里画的是 chip），发送（appendUserMessage）
 * 与回到文档时由 mention-upgrade.ts 升回 chip。 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { fileMark } from './file-mention'
import { FILE_URL_RE } from './media'
import { mentionLabel } from './mention-query'

export interface Composer {
  get: () => string
  set: (text: string) => void
  insert: (text: string) => void
  /** 输入框的根元素（引用飞行的落点）；还没建好是 null */
  dom: () => HTMLElement | null
  /** 聚焦，光标落在输入框记着的位置（新建的框在末尾） */
  focus: () => void
}

const composers = new Map<string, Composer>()
const carried = new Map<string, string>()

/** 登记某页的输入框；注销只摘自己（同一页先后挂两次时，旧的注销不会摘掉新的） */
export function registerComposer(pageId: string, c: Composer): () => void {
  composers.set(pageId, c)
  return () => {
    if (composers.get(pageId) === c) composers.delete(pageId)
  }
}

/** 往这页的输入框末尾放一段文字并聚焦，这页没有输入框（只读 / 文档模式）返回 false */
export function insertIntoComposer(pageId: string, text: string): boolean {
  const c = composers.get(pageId)
  if (!c) return false
  c.insert(text)
  return true
}

/** 聚焦这页的输入框，没有输入框或还没建好返回 false。不要直接 focus 根元素：浏览器会把光标放到最前面，
 *  PM 再把它读回自己的选区，预先放好的胶囊就挡在光标后面了 */
export function focusComposer(pageId: string): boolean {
  const c = composers.get(pageId)
  if (!c?.dom()) return false
  c.focus()
  return true
}

/** 这页输入框的根元素（没有输入框或还没建好是 null） */
export function composerDom(pageId: string): HTMLElement | null {
  return composers.get(pageId)?.dom() ?? null
}

/** 对话到文档：取走这页输入框里的字并清空，空白算没有 */
export function takeComposerText(pageId: string): string {
  const c = composers.get(pageId)
  const text = c?.get() ?? ''
  if (!text.trim()) return ''
  c?.set('')
  return text
}

/** 文档到对话：先带着，这页的 ChatView 挂载时读（peek，StrictMode 下初始化函数会跑两次，读不能消耗），挂载后清掉 */
export function carryToChat(pageId: string, text: string): void {
  if (text) carried.set(pageId, text)
  else carried.delete(pageId)
}

export const peekCarried = (pageId: string): string => carried.get(pageId) ?? ''

export function clearCarried(pageId: string): void {
  carried.delete(pageId)
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** 输入框里的块引用记号：label 取这块内容的开头 */
export function composerQuote(pageId: string, blockId: string, snippet: string): string {
  const s = flat(snippet)
  return `@[${mentionLabel(s.length > 40 ? `${s.slice(0, 40)}…` : s)}](page:${pageId}#${blockId})`
}

/** 本站图片地址（`/api/files/<id>`）→ 输入框里的图片记号；外链 / 还没传完的图没有记号 */
export function imageMark(src: string): string {
  return FILE_URL_RE.test(src) ? `@[图片](image:${src.slice(src.lastIndexOf('/') + 1)})` : ''
}

/** 草稿（user_message 块）转输入框里的字：段落按行、hardbreak 换行、页面提及 / 块引用 / agent 点名 / 成员提及 / 文件引用 /
 *  本站图片落成记号，其余只取文字。输入框自己的文档也走这里：还没传完的图没有 src，不出记号（上传中本来就发不出去） */
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
      else if (n.type.name === 'file_mention') line += fileMark(String(n.attrs.path ?? ''))
      else if (n.type.name === 'image') line += imageMark(String(n.attrs.src ?? ''))
      else if (n.type.name === 'block_ref') {
        line += `@[${mentionLabel(flat(String(n.attrs.text ?? '')))}](page:${String(n.attrs.pageId ?? '')}#${String(n.attrs.blockId ?? '')})`
      } else n.forEach(visit)
    }
    visit(block)
    lines.push(line)
  })
  return lines.join('\n')
}
