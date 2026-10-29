// ---------- 提示词环境：agent 这一轮实际看到的「引用 + 各回复的过程摘要」----------
// 下一轮 AI 看到的是父页正文加每条 AI 回复所属过程页里还留着的步骤摘要（一步一行）。过程页删 / 改步骤，
// 提示词文字就变，基线 hash 跟着变，原生续聊失效、新会话全文重放（hash 本来就是对提示词文字算的，不另加判断）。
// 完整工具输出不进上下文（它只在 runs.record）；摘要里带过程页的定位，agent 要看全部自己 read_page。
//
// 解析是异步的（跨页读文档、按发起人判权限），文字拼装是同步的：resolvePromptEnv 先全部读好，serializeDoc 拿它渲染。
// 起止同口径：本轮开头解析出的环境就是 agent 看到的那份，收尾 hash 用它算（run.seen）；新回复的过程页是本轮才归档的，
// 收尾时由刚建好的文档算出摘要补进来（ReplyWriter.viewText 的 newProcess），与下一轮开头从库里读出的是同一份文字，口径不漂。
//
// 空间公共记忆（memories.ts）也在这里：本轮开头读好全部记忆渲染成一段（memory），全文重放时放在文档前面（withMemory），
// 会话复用的基线 hash 把它算进去（promptHash）。记忆变了说明 agent 会话里的上下文过期，hash 不等，新建会话全文重放；
// 记忆没变就是 load + 只发新消息。收尾 hash 用 run.seen.memory（开头那份）。
// 没有记忆时什么都不加，hash 与不带记忆的算法逐字节一致（老会话不因此全部重放）。
//
// 工具档位（tool-profile.ts）为 none 时 Ramet 只当 UI：环境里只剩文档正文，不读记忆、不带过程摘要（收尾也不补，
// ReplyWriter.viewText 认 env.tools）、块引用不跨页读原块（nestedAtoms：定位 + 提及自带的快照）。起止同口径照旧靠 run.seen。

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { loadDocForRead, pageAccess } from '../collab.js'
import { memoryBlockOfPage } from '../memories.js'
import type { AtomText } from '../updates.js'
import { stepLine } from './doc.js'
import { nestedAtoms, resolveRefs } from './refs.js'
import type { ToolProfile } from './tool-profile.js'

export type PromptEnv = {
  /** 原子节点的提示词文字（块引用 / 子页面块，见 refs.ts） */
  atoms: AtomText
  /** 某条 AI 回复所属过程页的摘要行（已带标题行）；没有 / 读不到 / 过程页已删返回 undefined */
  process: (reply: Y.XmlElement) => string[] | undefined
  /** 页面所在空间的全部公共记忆，已渲染成提示词里的一段；没有记忆为 ''（memories.ts 的 memoryBlock） */
  memory: string
  /** 这一轮的工具档位：会话按它交付工具，收尾落库的会话记录也记它（none 只有正文，见文件头） */
  tools: ToolProfile
}

/** 全文重放时 agent 收到的内容：记忆在前、文档在后；没有记忆则原样 */
export function withMemory(memory: string, docText: string): string {
  return memory ? `${memory}\n\n${docText}` : docText
}

/** 会话复用的基线 hash：对「文档视图」算；有记忆时把记忆一并算进去（带长度前缀 + NUL 前导，与无记忆的文档文字不会撞）。
 *  没有记忆时就是 sha256(text)。起始（turn.ts）与收尾（run-finalize.ts）都走这一个函数 */
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
): Promise<PromptEnv> {
  if (tools === 'none') return { atoms: nestedAtoms, process: () => undefined, memory: '', tools }
  const [atoms, memory] = await Promise.all([resolveRefs(pool, user, fragment, getLiveDoc), memoryBlockOfPage(pool, pageId)])
  const summaries = new Map<string, string[] | undefined>()
  await Promise.all(
    runIdsOf(fragment).map(async (id) => {
      if (!(await pageAccess(pool, id, user))) return
      const doc = await loadDocForRead(pool, `page:${id}`, getLiveDoc)
      summaries.set(id, summarizeProcess(id, doc.getXmlFragment('prosemirror')))
    }),
  )
  return { atoms, process: (reply) => summaries.get(attr(reply, 'run')), memory, tools }
}
