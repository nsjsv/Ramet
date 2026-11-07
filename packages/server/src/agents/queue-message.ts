// ---------- 排队消息落进文档：服务端以排队的人的身份写一条 user_message（与前端 appendUserMessage 同形）----------
// 前端发送时：文字按行成段，`@[名字](agent:<id>)` 这类记号在同一事务里升成 chip（mention-upgrade.ts），附件图片成末尾一段。
// 服务端派发排队消息时没有编辑器，在这里照做。chip 必须是真节点，@ 点名链（doc.ts 的 agent_mention）只认节点，不认记号文字。
// 记号的切法与前端同一口径：`@[` 起，按最近的收口锚（`](page:` / `](agent:` / `](user:` / `](image:` / `](file:`）收口，`)` 结束；
// `page:<页>#<块>` 是块引用，`image:<文件 uuid>` 是落在原位的本站图片（别的地址不升，原样留字），`file:<编码路径>` 是文件引用
// （路径的编码见前端 file-mention.ts 的 fileTarget）。
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'

type Kind = 'page' | 'agent' | 'user' | 'image' | 'file'

const OPEN = '@['
const ANCHORS: ReadonlyArray<readonly [Kind, string]> = [
  ['page', '](page:'],
  ['agent', '](agent:'],
  ['user', '](user:'],
  ['image', '](image:'],
  ['file', '](file:'],
]
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** 记号对应的节点；升不了（图片地址不是本站文件）返回 null，调用方原样留字 */
function chip(kind: Kind, target: string, label: string): Y.XmlElement | null {
  const set = (name: string, attrs: Record<string, string>): Y.XmlElement => {
    const el = new Y.XmlElement(name)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }
  if (kind === 'agent') return set('agent_mention', { agentId: target, label })
  if (kind === 'user') return set('user_mention', { userId: target, name: label })
  if (kind === 'image') return FILE_ID.test(target) ? set('image', { src: `/api/files/${target}`, alt: '', title: '' }) : null
  if (kind === 'file') return set('file_mention', { path: decodeTarget(target) })
  const hash = target.indexOf('#')
  if (hash > 0 && hash < target.length - 1) return set('block_ref', { pageId: target.slice(0, hash), blockId: target.slice(hash + 1), text: label })
  return set('page_mention', { pageId: target, title: label })
}

/** 一行记号文字 → 段落里的行内内容（文字 + chip） */
export function lineInlines(line: string): Array<Y.XmlText | Y.XmlElement> {
  const out: Array<Y.XmlText | Y.XmlElement> = []
  // 升不了的记号原样并进前后的字：同一段文字只出一个 XmlText
  let pending = ''
  const flush = (): void => {
    if (!pending) return
    const t = new Y.XmlText()
    t.insert(0, pending)
    out.push(t)
    pending = ''
  }
  let rest = line
  for (;;) {
    const open = rest.indexOf(OPEN)
    if (open === -1) break
    let tail = -1
    let kind: Kind = 'page'
    let anchor = ''
    for (const [k, a] of ANCHORS) {
      const at = rest.indexOf(a, open + OPEN.length)
      if (at !== -1 && (tail === -1 || at < tail)) {
        tail = at
        kind = k
        anchor = a
      }
    }
    const close = tail === -1 ? -1 : rest.indexOf(')', tail + anchor.length)
    if (close === -1 || close === tail + anchor.length) break
    const el = chip(kind, rest.slice(tail + anchor.length, close), rest.slice(open + OPEN.length, tail))
    pending += rest.slice(0, el ? open : close + 1)
    if (el) {
      flush()
      out.push(el)
    }
    rest = rest.slice(close + 1)
  }
  pending += rest
  flush()
  return out
}

/** 消息的调用配置，沿用文档里上一条用户消息的（同前端 appendUserMessage 的继承规则）：
 *  没指定来源或来源相同就原样沿用（agent / cwd / opts 的原始属性串），换了来源则旧来源的目录 / 配置不沿用 */
export function inheritedAttrs(fragment: Y.XmlFragment, agent: string): { agent: string; cwd: string; opts: string } {
  let last: Y.XmlElement | null = null
  fragment.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'user_message') last = c
  })
  const attr = (name: string): string => {
    const v: unknown = (last as Y.XmlElement | null)?.getAttribute(name)
    return typeof v === 'string' ? v : ''
  }
  const prev = { agent: attr('agent'), cwd: attr('cwd'), opts: attr('opts') }
  if (!agent || agent === prev.agent) return prev
  return prev.agent ? { agent, cwd: '', opts: '' } : { ...prev, agent }
}

/** 一条用户消息块：文字按行成段（空行也是一段，同前端）。新前端的图片是文字里的记号（落在原位）；
 *  老前端单列的附件图片（`/api/files/<id>`）成末尾一段 */
export function userMessageElement(
  text: string,
  images: readonly string[],
  /** timer = 定时器写的消息、rule = 别的规则写的（目标页上看得出是自动化发的） */
  attrs: { agent: string; cwd: string; opts: string; author: string; ctx?: string; timer?: string; rule?: string },
): Y.XmlElement {
  const msg = new Y.XmlElement('user_message')
  msg.setAttribute('id', randomUUID())
  for (const [k, v] of Object.entries(attrs)) msg.setAttribute(k, v)
  const paras: Y.XmlElement[] = []
  if (text || images.length === 0) {
    for (const line of text.split('\n')) {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, lineInlines(line))
      paras.push(p)
    }
  }
  if (images.length > 0) {
    const p = new Y.XmlElement('paragraph')
    p.insert(
      0,
      images.map((src) => {
        const img = new Y.XmlElement('image')
        img.setAttribute('src', src)
        img.setAttribute('alt', '')
        img.setAttribute('title', '')
        return img
      }),
    )
    paras.push(p)
  }
  msg.insert(0, paras)
  return msg
}
