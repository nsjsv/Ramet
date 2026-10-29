import * as Y from 'yjs'

// 文档「读得见的内容」的规范化串：两份文档内容相同 ⇔ 串相同，与 Yjs 内部怎么走到这一步无关。
// 判定一次存版本是不是真改了东西：改了又撤销会留下新插入 + 删除的 struct，状态向量往前走了
// （增量非空），读得见的内容却和上一版一字不差。
// 不按类型类分派（Y.Text / XmlFragment …）：从 update 解出来、没人 getXxx 过的顶层类型只是未定型的
// 占位，只能走原始 item 链。口径同 Y.Text.toDelta：删掉的 item 不算；格式标记折成当前生效的属性集；
// 相邻同属性的文字合并，所以文字拆成几个 item、留着多余的格式标记都不影响结果。
// 节点属性（XmlElement 的 _map，如勾选状态、块 id、列宽）算内容：只改属性也是一次真修改。

type Token = { t: string; a: string } | { v: unknown; a: string }
type Node = { n?: string; s: Token[]; m: Record<string, unknown> }

function itemValues(item: Y.Item): unknown[] {
  const c = item.content
  if (c instanceof Y.ContentType) return [typeNode(c.type)]
  if (c instanceof Y.ContentBinary) return [Buffer.from(c.content).toString('base64')]
  if (c instanceof Y.ContentDoc) return [{ doc: c.doc?.guid ?? null }]
  return c.getContent() // ContentAny / ContentJSON / ContentEmbed
}

function typeNode(type: Y.AbstractType<any>): Node {
  const seq: Token[] = []
  const attrs = new Map<string, unknown>()
  let attrKey = ''
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue
    const c = item.content
    if (c instanceof Y.ContentFormat) {
      if (c.value === null) attrs.delete(c.key)
      else attrs.set(c.key, c.value)
      attrKey = attrs.size > 0 ? stable(Object.fromEntries(attrs)) : ''
      continue
    }
    if (c instanceof Y.ContentString) {
      const last = seq[seq.length - 1]
      if (last && 't' in last && last.a === attrKey) last.t += c.str
      else seq.push({ t: c.str, a: attrKey })
      continue
    }
    for (const v of itemValues(item)) seq.push({ v, a: attrKey })
  }
  const map: Record<string, unknown> = {}
  for (const [key, item] of type._map) {
    if (item.deleted) continue
    const values = itemValues(item)
    map[key] = values[values.length - 1]
  }
  const node: Node = { s: seq, m: map }
  if (type instanceof Y.XmlElement) node.n = type.nodeName
  else if (type instanceof Y.XmlHook) node.n = `hook:${type.hookName}`
  return node
}

/** 键序无关的 JSON（属性 / 格式值是对象时，插入顺序不该影响判等） */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 整篇文档的内容键（所有顶层类型；空的顶层类型不算，一边 getXmlFragment 过、一边没有不是差异） */
export function contentKey(doc: Y.Doc): string {
  const out: Record<string, Node> = {}
  for (const [name, type] of doc.share) {
    const node = typeNode(type)
    if (node.s.length > 0 || Object.keys(node.m).length > 0) out[name] = node
  }
  return stable(out)
}

// 空段落：段落里除了空的文字节点什么都没有（块 id 等属性不算内容）
function isBlankParagraph(token: Token): boolean {
  if (!('v' in token)) return false
  const node = token.v as Node
  return node.n === 'paragraph' && node.s.every((t) => 'v' in t && !(t.v as Node).n && (t.v as Node).s.length === 0)
}

/** 页面还是刚建好的样子：正文只有空段落（或没有），除标题外别的顶层类型都空。标题不看：
 *  带标题新建的页面（newPageDoc(title, [])）一打开也是这个样子，不值一个版本 */
export function isBlankPage(doc: Y.Doc): boolean {
  for (const [name, type] of doc.share) {
    if (name === 'title') continue
    const node = typeNode(type)
    if (Object.keys(node.m).length > 0) return false
    if (name === 'prosemirror' ? !node.s.every(isBlankParagraph) : node.s.length > 0) return false
  }
  return true
}
