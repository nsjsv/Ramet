// ---------- 提示词环境：agent 这一轮实际看到的「引用 + 各回复的过程摘要」----------
// 全文重放（新建会话）时 AI 看到的是父页正文加每条 AI 回复所属过程页里还留着的步骤摘要（一步一行）；接着用已有会话时
// 补发的块也是同一种写法（catch-up.ts）。完整工具输出不进上下文（它只在 runs.record）；摘要里带过程页的定位，
// agent 要看全部自己 read_page。过程页事后删 / 改步骤不影响已有会话（上下文归 agent 自己的会话），新建会话时才按新的来。
//
// 解析是异步的（跨页读文档、按发起人判权限），文字拼装是同步的：resolvePromptEnv 先全部读好，serializeDoc 拿它渲染。
//
// 空间公共记忆（memories.ts）也在这里：本轮开头读好全部记忆渲染成一段（memory），全文重放时放在文档前面（withMemory）。
// 记忆只在新建会话时带上：老会话不因记忆变化重置，下一次新建会话才带上新记忆（同说明文件只在会话开始读一次）。
// promptHash 只剩老会话记录（只有 hash、没有 seen）的兼容判定在用。
//
// 工具档位（tool-profile.ts）为 none 时 Ramet 只当 UI：环境里只剩文档正文，不读记忆、不带过程摘要、
// 块引用不跨页读原块（nestedAtoms：定位 + 提及自带的快照）。
//
// 空间 AI（space-ai.ts）的一轮带 scope：块引用与过程摘要只读这个空间里的页（别的空间的按读不到处理，与它的凭证同一个范围），
// 每条用户消息带署名（speaker）：叫它的人在变，它要看得出每条是谁说的；记忆后面多一段空间概览（space-ai.ts 的 spaceOverview）。
// 别的 agent 不带 scope，提示词逐字节不变。

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { loadDocForRead, pageAccess } from '../collab.js'
import { pageMemory } from './space-context.js'
import type { AtomText } from '../updates.js'
import { stepLine } from './doc.js'
import { nestedAtoms, resolveRefs } from './refs.js'
import { pageInSpace, spaceOverview } from './space-ai.js'
import type { ToolProfile } from './tool-profile.js'

export type PromptEnv = {
  /** 原子节点的提示词文字（块引用 / 子页面块，见 refs.ts） */
  atoms: AtomText
  /** 某条 AI 回复所属过程页的摘要行（已带标题行）；没有 / 读不到 / 过程页已删返回 undefined */
  process: (reply: Y.XmlElement) => string[] | undefined
  /** 页面所在空间的全部公共记忆（+ 任务页记着的目标空间的约定），已渲染成提示词里的一段；没有为 ''（space-context.ts 的 pageMemory） */
  memory: string
  /** 这一轮的工具档位：会话按它交付工具，收尾落库的会话记录也记它（none 只有正文，见文件头） */
  tools: ToolProfile
  /** 用户消息的署名（发消息的人的用户名）；没有这一项 = 不署名 */
  speaker?: (message: Y.XmlElement) => string | undefined
}

/** 这一轮收窄到哪个空间（空间 AI） */
export type PromptScope = { space: string }

/** 删了号的人发过的消息署这个名 */
const GONE_USER = '已注销用户'

/** 这页里各条用户消息的署名：author 属性 → 用户名。通知块（notice）不是人发的、没有 author 的不署名 */
async function speakersOf(pool: Pool, fragment: Y.XmlFragment): Promise<(message: Y.XmlElement) => string | undefined> {
  const ids = new Set<string>()
  fragment.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'user_message' && attr(c, 'author')) ids.add(attr(c, 'author'))
  })
  const { rows } = ids.size
    ? await pool.query<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ANY($1::text[])', [[...ids]])
    : { rows: [] }
  const names = new Map(rows.map((r) => [r.id, r.username]))
  return (el) => {
    const author = attr(el, 'author')
    return author && !attr(el, 'notice') ? (names.get(author) ?? GONE_USER) : undefined
  }
}

/** 全文重放时 agent 收到的内容：记忆在前、文档在后；没有记忆则原样 */
export function withMemory(memory: string, docText: string): string {
  return memory ? `${memory}\n\n${docText}` : docText
}

/** 老会话记录的基线 hash：对「文档视图」算；有记忆时把记忆一并算进去（带长度前缀 + NUL 前导，与无记忆的文档文字不会撞）。
 *  没有记忆时就是 sha256(text)。只给没有 seen 的老记录判一次能不能增量（catch-up.ts 的 deltaPrompt） */
export function promptHash(memory: string, text: string): string {
  const hash = createHash('sha256')
  if (memory) hash.update(`\u0000memory:${memory.length}:${memory}`)
  return hash.update(text).digest('hex')
}

/** 每条回复最多列这么多步，超出写一行说明（提示词体积有上界；全部步骤 agent 自己 read_page） */
const MAX_LINES = 80

function attr(el: Y.XmlElement, name: string): string {
  const v: unknown = el.getAttribute(name)
  return typeof v === 'string' ? v : ''
}

/** 过程页正文转成摘要行（顶层 run_step 按文档序；子代理的步骤缩进两格）。一步都没有返回 undefined */
export function summarizeProcess(runPageId: string, body: Y.XmlFragment): string[] | undefined {
  const lines: string[] = []
  let total = 0
  body.forEach((c) => {
    if (!(c instanceof Y.XmlElement) || c.nodeName !== 'run_step') return
    total++
    if (lines.length < MAX_LINES) lines.push(`${attr(c, 'parent') ? '  ' : ''}- ${stepLine(c)}`)
  })
  if (total === 0) return undefined
  const more = total > lines.length ? [`…（另有 ${total - lines.length} 步未列出，完整过程见 page:${runPageId}）`] : []
  return [`过程 page:${runPageId}（共 ${total} 步）：`, ...lines, ...more]
}

/** 视图里各条回复的过程页 id（回复都是顶层块） */
function runIdsOf(fragment: Y.XmlFragment): string[] {
  const ids = new Set<string>()
  fragment.forEach((c) => {
    if (c instanceof Y.XmlElement && c.nodeName === 'agent_reply') {
      const run = attr(c, 'run')
      if (run) ids.add(run)
    }
  })
  return [...ids]
}

/** 读好引用与各回复的过程摘要。没权限 / 页已删 / 在回收站（pageAccess 为空）都没有摘要，不区分原因（同引用）。
 *  读文档活文档优先（正在编辑中的过程页是最新的）；并发读，过程页都很小 */
export async function resolvePromptEnv(
  pool: Pool,
  user: { id: string; role: string },
  fragment: Y.XmlFragment,
  /** 这一轮跑在哪个页面上（空间的公共记忆按它找） */
  pageId: string,
  /** 页面的工具档位；none = 只有正文，什么都不读 */
  tools: ToolProfile,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  scope?: PromptScope,
): Promise<PromptEnv> {
  if (tools === 'none') return { atoms: nestedAtoms, process: () => undefined, memory: '', tools }
  const inScope = scope ? (id: string) => pageInSpace(pool, id, scope.space) : undefined
  const [atoms, pageMem, speaker, overview] = await Promise.all([
    resolveRefs(pool, user, fragment, getLiveDoc, inScope),
    pageMemory(pool, pageId),
    scope ? speakersOf(pool, fragment) : undefined,
    scope ? spaceOverview(pool, scope.space) : undefined,
  ])
  // 空间 AI：空间概览跟在记忆后面，同记忆一样只在新建会话时带
  const memory = overview ? [pageMem, overview].filter(Boolean).join('\n\n') : pageMem
  const summaries = new Map<string, string[] | undefined>()
  await Promise.all(
    runIdsOf(fragment).map(async (id) => {
      if (!(await pageAccess(pool, id, user)) || (inScope && !(await inScope(id)))) return
      const doc = await loadDocForRead(pool, `page:${id}`, getLiveDoc)
      summaries.set(id, summarizeProcess(id, doc.getXmlFragment('prosemirror')))
    }),
  )
  return { atoms, process: (reply) => summaries.get(attr(reply, 'run')), memory, tools, ...(speaker ? { speaker } : {}) }
}
