/* ---------- AI 写回文档（edit_page 内核） ----------
 * AI 只按文字定位，不碰块 id：给一段原文 `old` 和要换成的文字 `new`，先 read_page 再拿原文做 `old`。
 * `old` 在 `updates.fragmentSpans` 从当前文档算出的整篇文字里找（与 read_page 读到的行同一份字符串，行号只给人看），
 * 落点由服务端按字符区间自己算。
 *
 * 一次调用里的 ops 按顺序落在同一个 Yjs 事务里，要么全进，要么全不进。
 * Yjs 事务不因异常回滚，所以整套 ops 先在影子文档（当前状态的副本）上跑一遍，任何失败
 * （`old` 没找到 / 出现多次、`image:<uuid>` 不存在）都在碰真文档之前抛出，通过后才在真文档的一个事务里原样重跑。
 *
 * 写哪个文档、怎么写由注入的 `DocWriter` 决定，唯一实现是 collab.ts 的 createDocWriter：
 * 走 hocuspocus 的直连会话，内存有活文档就改那份（协同中的人立刻看见），没有就加载；
 * 增量走 collab 的 onChange → onStoreDocument 落盘，不另写快照 SQL。
 *
 * 权限沿用 routes/pages.ts：非成员 / 不存在 404（不泄露存在性），可见但 viewer 403。 */

import type { Pool } from 'pg'
import * as Y from 'yjs'
import {
  parseBlocks,
  type Attrs,
  type Block,
  type Inline,
  type MarkSpec,
} from '@ramet/shared/markdown-blocks'
import { pageAccess, type DocWriter } from './collab.js'
import { fragmentSpans, textOf, type FragmentSpan } from './updates.js'
import { materialize, materializeInlines } from './agents/markdown.js'

/** 图片：`image:<uuid>` 单独一行落成 image 节点，src 是本站原图地址（不带 /display）。
 *  uuid 是文件 id，写之前要查库确认存在。外链不是这个形状，当普通文字。 */
const IMAGE_LINE_RE = /^image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
/** 页面提及：`page:<uuid>` 记号落成 page_mention 行内 chip（title 可空）。出现在 `new` 的任何位置都升成 chip */
const PAGE_TOKEN_RE = /page:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
/** 同上但不带 /g：只做有没有的判定，/g 的 lastIndex 状态会让重复调用漏判 */
const HAS_PAGE_TOKEN_RE = /page:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export type EditOp = { op: 'replace'; old: string; new: string }

/** 校验失败：message 是给 AI 看的原因（MCP 原样转成 tool 错误），status 给 HTTP 层。
 *  所有失败都发生在写之前，文档保持调用前的样子 */
export class EditError extends Error {
  constructor(message: string, readonly status: 404 | 400) {
    super(message)
  }
}

/** fileId 必须是已存在的图片（规则与 read_image 同一份：没有这张图 = 404） */
async function assertImageFile(pool: Pool, fileId: string): Promise<void> {
  const { rows } = await pool.query<{ mime: string }>('SELECT mime FROM files WHERE id = $1', [fileId])
  const mime = rows[0]?.mime
  if (!mime || !mime.startsWith('image/')) throw new EditError(`没有这张图：${fileId}`, 404)
}

// ---------- `new` → 块 / 行内 ----------

/** 一行里的 `page:<uuid>` 记号 → page_mention chip，其余按文字。图片整块落成 image 节点（见 lineBlock），
 *  行内出现的 image: 当普通文字，与 textOf 只认 image 节点 attr 同一口径。 */
function inlinesWithMentions(line: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of line.matchAll(PAGE_TOKEN_RE)) {
    if (m.index! > last) out.push({ text: line.slice(last, m.index), marks: [] })
    out.push({ atom: 'page_mention', attrs: { pageId: m[1]!, title: '' } })
    last = m.index! + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), marks: [] })
  return out
}

/** 一行文字 → 块。`image:<uuid>` 单独一行落成 image 节点；带 `page:<uuid>` 记号的行落成 chip 段落，
 *  不能交给 parseBlocks，它会把记号当普通文字，前端反解不回 chip */
function lineBlock(line: string): Block {
  const image = IMAGE_LINE_RE.exec(line.trim())
  if (image) {
    return {
      name: 'paragraph',
      attrs: {},
      inlines: [{ atom: 'image', attrs: { src: `/api/files/${image[1]}`, alt: '', title: '' } }],
    }
  }
  if (HAS_PAGE_TOKEN_RE.test(line)) {
    return { name: 'paragraph', attrs: {}, inlines: inlinesWithMentions(line) }
  }
  return parseBlocks(line).blocks[0] ?? { name: 'paragraph', attrs: {}, inlines: [{ text: line, marks: [] }] }
}

/** `new` → 块序列（一次 replace 落成的一批顶层块）。
 *  空行分块或出现 `image:` `page:` 记号时逐行落块（记号不能被 markdown 解析吃掉），
 *  其余整段跑一次 markdown，标题 / 列表 / 表格这类跨行结构才留得住。 */
export function parseNew(text: string): Block[] {
  if (!text) return []
  const lines = text.split('\n')
  const perLine =
    lines.length > 1
      ? lines.some((line) => line.trim() === '' || IMAGE_LINE_RE.test(line.trim())) || HAS_PAGE_TOKEN_RE.test(text)
      : IMAGE_LINE_RE.test(text.trim()) || HAS_PAGE_TOKEN_RE.test(text)
  if (perLine) {
    const out: Block[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      out.push(lineBlock(line))
    }
    return out
  }
  const blocks = parseBlocks(text).blocks
  if (blocks.length > 0) return blocks
  return [{ name: 'paragraph', attrs: {}, inlines: inlinesWithMentions(text) }]
}

/** `new` 作为行内内容（换掉一段文字里的片段）时的形态，只有单一段落能这样落。
 *  解析成多块 / 标题 / 列表等结构时返回 null，交给整块替换 */
function inlineNew(text: string): Inline[] | null {
  const blocks = parseNew(text)
  if (blocks.length !== 1) return null
  const block = blocks[0]!
  return block.name === 'paragraph' && block.inlines ? block.inlines : null
}

// ---------- 定位 `old` ----------

/** 找 `old` 的唯一命中。找不到和出现多次都失败，不猜 AI 想改哪一处 */
function matchOnce(text: string, old: string): number {
  const at = text.indexOf(old)
  if (at < 0) throw new EditError(`没找到要替换的原文：${JSON.stringify(old)}`, 404)
  if (text.indexOf(old, at + 1) >= 0) {
    throw new EditError(
      `原文出现了 ${text.split(old).length - 1} 次，请带上更多上下文让它在文档里唯一：${JSON.stringify(old)}`,
      400,
    )
  }
  return at
}

/** `old` 的区间 [from, to) 盖住了哪些顶层子节点：返回父 fragment 里的下标区间 [first, last)（被换掉的顶层块）
 *  与盖住的 span 个数，空区间（`old` 为空 = 追加）返回 null。
 *  空块（hr / 空段落等）宽度为 0 盖不到，所以下标区间会跨过它们，要用 `n` 判断是不是只盖到一块。 */
function coveredSpans(spans: FragmentSpan[], from: number, to: number): { first: number; last: number; n: number } | null {
  if (to <= from) return null
  let first = -1
  let last = -1
  let n = 0
  for (const span of spans) {
    if (span.end <= from || span.start >= to) continue
    if (first < 0) first = span.index
    last = span.index
    n++
  }
  return first < 0 ? null : { first, last: last + 1, n }
}

// ---------- 一段文字内的行内替换（保住没被盖住的芯片 / 格式） ----------

/** 带派生宽度的行内项：宽度与 updates.textOf 同一口径（文字取字数、hardbreak 一个 '\n'、
 *  原子节点取它派生的记号），才能把 `old` 的字符区间映射回具体节点。 */
type WidthInline = { inline: Inline; width: number }

/** 块的行内内容 → 行内项数组（含格式 attrs 与芯片），遍历方式与 textOf 一致 */
function inlinesOf(block: Y.XmlElement): WidthInline[] {
  const out: WidthInline[] = []
  const push = (inline: Inline, width: number): void => {
    if (width > 0) out.push({ inline, width })
  }
  block.forEach((child) => {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>) {
        const insert = op.insert
        if (typeof insert === 'string') {
          push({ text: insert, marks: marksOf(op.attributes) }, insert.length)
        } else if (insert instanceof Y.XmlElement) {
          const nested = insert
          push(
            nested.nodeName === 'hardbreak'
              ? { br: true }
              : { atom: nested.nodeName, attrs: nested.getAttributes() },
            nested.nodeName === 'hardbreak' ? 1 : textOfWidth(nested),
          )
        }
      }
      return
    }
    if (!(child instanceof Y.XmlElement)) return
    push(
      child.nodeName === 'hardbreak' ? { br: true } : { atom: child.nodeName, attrs: child.getAttributes() },
      child.nodeName === 'hardbreak' ? 1 : textOfWidth(child),
    )
  })
  return out
}

/** 原子节点派生记号的宽度，就是 textOf 给它的那段文字的长度：读到的整篇文字与按字符区间定位
 *  必须是同一套规则（page:<id> / image:<id>[ alt] / @名字 / 块引用的文字等），不在这里另抄一份 */
function textOfWidth(node: Y.XmlElement): number {
  return textOf(node).length
}

function marksOf(attributes?: Record<string, unknown>): MarkSpec[] {
  if (!attributes) return []
  return Object.entries(attributes).map(([name, attrs]) => ({ name, attrs: (attrs ?? {}) as Attrs }))
}

/** 把块里 [start, start+len) 的字符区间换成 `insert` 的行内内容，没被盖住的部分（芯片、格式、两边的文字）原样留下。
 *  块自身的 attrs（id / heading 的 level）不动。 */
function spliceInlines(block: Y.XmlElement, start: number, len: number, insert: Inline[]): void {
  const out: Inline[] = []
  let pos = 0
  let done = false
  const emit = (): void => {
    if (done) return
    out.push(...insert)
    done = true
  }
  for (const { inline, width } of inlinesOf(block)) {
    const from = pos
    const to = pos + width
    pos = to
    if (to <= start || from >= start + len) {
      out.push(inline)
      continue
    }
    if ('text' in inline) {
      // 文字被切，保留头部与尾部没被盖住的几段
      const head = inline.text.slice(0, Math.max(0, start - from))
      const tail = inline.text.slice(Math.max(0, start + len - from))
      if (head) out.push({ text: head, marks: inline.marks })
      emit()
      if (tail) out.push({ text: tail, marks: inline.marks })
      continue
    }
    emit() // br / 原子节点被盖住，直接换成 new
  }
  emit()
  block.delete(0, block.length)
  materializeInlines(block, out)
}

// ---------- 写 ----------

function isPlainBlock(node: Y.XmlElement): boolean {
  return node.nodeName === 'paragraph' || node.nodeName === 'heading'
}

/** 用 `new` 解析出的块换掉被 `old` 盖住的顶层块（跨块或盖到 `image:` `page:` 记号时），没被盖住的块（含 `user_message` / `agent_reply`）原样不动 */
function replaceBlocks(fragment: Y.XmlFragment, first: number, last: number, blocks: Block[]): void {
  fragment.delete(first, last - first)
  materialize(fragment, blocks, first)
}

/** 单个 op，按当前文档状态定位（前面的 op 已经改过它）。影子文档上已确认整套能走通，这里重跑应当恒成功 */
function applyOne(fragment: Y.XmlFragment, op: EditOp): void {
  const { text, spans } = fragmentSpans(fragment)
  if (op.old === '') {
    if (op.new) materialize(fragment, parseNew(op.new)) // 追加到文末
    return
  }
  const at = matchOnce(text, op.old)
  const cover = coveredSpans(spans, at, at + op.old.length)
  if (!cover) throw new EditError(`没找到要替换的原文：${JSON.stringify(op.old)}`, 404)
  // 只盖到一块时，段落 / 标题走行内替换（保住 id / level / 芯片），hr 这类必须整块换
  if (cover.n === 1) {
    const node = fragment.get(cover.first)
    if (node instanceof Y.XmlElement && isPlainBlock(node)) {
      const insert = inlineNew(op.new)
      if (insert) {
        spliceInlines(node, at - spans.find((s) => s.index === cover.first)!.start, op.old.length, insert)
        return
      }
    }
  }
  // 跨块、命中非段落块、或 new 带了多块结构时整块替换
  replaceBlocks(fragment, cover.first, cover.last, parseNew(op.new))
}

function runOps(fragment: Y.XmlFragment, ops: EditOp[]): void {
  for (const op of ops) applyOne(fragment, op)
}

/** 先校验后写：在影子文档上把整套 ops 跑一遍，任何失败都发生在碰真文档之前，通过后在真文档的一个事务里原样重跑
 *  （同一份起始状态，结果确定）。Yjs 事务不因异常回滚，所以任一失败则整次不写只能靠写前排除。
 *  origin 传给 Yjs：collab 的 onChange 从它的 context 里取发起者，据此把这次写入记成 AI
 *  （快照另存一条，不进用户 5 分钟去重），而不是当成用户手改 */
export function applyOps(doc: Y.Doc, ops: EditOp[], origin: unknown): void {
  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
    runOps(scratch.getXmlFragment('prosemirror'), ops)
  } finally {
    scratch.destroy()
  }
  doc.transact(() => runOps(doc.getXmlFragment('prosemirror'), ops), origin)
}

// ---------- 入口 ----------

export type EditOutcome = { ok: true } | { status: 404 | 403 | 400; error: string }

/** 权限闸 → 校验 `new` 里的图片 id → 在可落盘的文档会话里应用 ops。
 *  校验（`old` 定位、图片存在性）先于 doc.transact（见 applyOps 的影子文档），任何失败都不会在文档里留半截。
 *  `write` 由调用方注入（唯一实现 collab.ts 的 createDocWriter），内存有活文档就用那份，没有就加载，
 *  并走 collab 的 onChange → onStoreDocument 落盘。 */
export async function editPageForUser(
  pool: Pool,
  user: { id: string; role: string },
  pageId: string,
  ops: EditOp[],
  write: DocWriter,
): Promise<EditOutcome> {
  if (ops.length === 0) return { status: 400, error: 'ops 不能为空' }
  const role = await pageAccess(pool, pageId, user)
  // 不存在 / 已回收 / 非成员一律同一个 404，不泄露存在性
  if (!role) return { status: 404, error: 'page not found' }
  if (role === 'viewer') return { status: 403, error: 'forbidden' }

  // 图片 id 要查库，放在文档会话之前，坏 id 不会白白开一次连接
  try {
    for (const op of ops) {
      for (const line of op.new.split('\n')) {
        const image = IMAGE_LINE_RE.exec(line.trim())
        if (image) await assertImageFile(pool, image[1]!)
      }
    }
  } catch (err) {
    if (err instanceof EditError) return { status: err.status, error: err.message }
    throw err
  }
  try {
    await write(`page:${pageId}`, user, (doc, origin) => applyOps(doc, ops, origin))
  } catch (err) {
    if (err instanceof EditError) return { status: err.status, error: err.message }
    throw err
  }
  return { ok: true }
}

/** MCP 传来的 ops → EditOp，形状不对直接抛。唯一的 op 是 replace */
export function parseOps(raw: unknown): EditOp[] {
  if (!Array.isArray(raw)) throw new EditError('ops 必须是数组', 400)
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new EditError('op 必须是对象', 400)
    const o = item as Record<string, unknown>
    if (o.op !== 'replace') throw new EditError(`未知 op：${String(o.op)}（只支持 replace）`, 400)
    if (typeof o.old !== 'string' || typeof o.new !== 'string') {
      throw new EditError('replace 需要字符串 old 与 new', 400)
    }
    return { op: 'replace', old: o.old, new: o.new }
  })
}
