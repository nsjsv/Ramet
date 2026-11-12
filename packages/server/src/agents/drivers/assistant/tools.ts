// ---------- Genet 的工具：中心本机拉起的 Ramet MCP 进程 + 步骤视图 ----------
// 与别的 agent 同一个 mcp/ramet.mjs、同一种凭证（page-read.ts 的 pageToolServer）：工具表与权限都由中心端点按凭证决定，这里只转发。
// 子进程的环境变量只有中心地址和凭证（StdioClientTransport 另外只继承 PATH / HOME 这几个），服务器的库地址、主密钥进不去。
// 交给 pi 的循环时包成 AgentTool（agentTools）；步骤视图由驱动按 pi 的工具事件画：
// 种类按工具名定，一行标题取输入里最像「对象」的那个字段，输入输出原样进 view.raw（前端只读视图）。

import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolView } from '@ramet/shared/run-model'
import { pageToolServer, type PageTool } from '../../../page-read.js'
import type { StepKind } from '../../types.js'
import { errorText } from '../error-text.js'
import { clipText, clipValue, NOTE_MAX, oneLine, rec, str } from '../tool-text.js'
import { clipResult } from './history.js'

/** 单次调用的上限：要等人批准的工具（移入回收站、记住一条记忆）没有超时，MCP SDK 缺省的 60 秒会把它们误杀 */
const CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000

const KINDS: Record<string, StepKind> = {
  read_page: 'read',
  read_image: 'read',
  read_collection: 'read',
  use_skill: 'read',
  search_pages: 'search',
  edit_page: 'edit',
  set_props: 'edit',
  create_page: 'edit',
  rename_page: 'edit',
  move_page: 'move',
  trash_page: 'delete',
}

/** 输入里拿来当一行标题的字段，按先后取第一个有值的 */
const TITLE_KEYS = ['title', 'query', 'name', 'pageId', 'collectionId', 'fileId', 'text']

export type AssistantImage = { mimeType: string; data: string }
export type AssistantToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
export type ToolOutcome = { text: string; images: AssistantImage[]; isError: boolean }
/** 画结果视图只要文字与图片张数 */
export type ToolFace = { text: string; images: number; isError: boolean }

/** 工具结果没有文字时的占位：有的协议不收空的工具结果 */
const EMPTY_RESULT = '（没有输出）'
export const STOPPED = '用户停止了这一轮，这个工具没有执行完'

/** 一次工具调用开始时的步骤：种类、一行标题、视图（输入原样） */
export function startFace(name: string, input: Record<string, unknown>): { kind: StepKind; title: string; view: ToolView; truncated?: boolean } {
  const title = TITLE_KEYS.map((k) => oneLine(str(input[k]))).find(Boolean) ?? name
  const raw = clipValue(input)
  return { kind: KINDS[name] ?? 'other', title, view: { tool: name, raw: { input: raw.value } }, ...(raw.truncated ? { truncated: true } : {}) }
}

/** 调用结束时的视图增量：结果文字 + 原样的输入输出（raw 整体替换，所以输入要再带一次）；失败带一行说明 */
export function resultFace(input: Record<string, unknown>, out: ToolFace): { view: ToolView; note?: string; truncated?: boolean } {
  const result = clipText(out.text)
  const output = clipValue({ text: out.text, ...(out.images > 0 ? { images: out.images } : {}) })
  const note = out.isError ? oneLine(out.text, NOTE_MAX) : ''
  return {
    view: { ...(out.text ? { result: result.text } : {}), raw: { input: clipValue(input).value, output: output.value } },
    ...(note ? { note } : {}),
    ...(result.truncated || output.truncated ? { truncated: true } : {}),
  }
}

/** MCP 工具结果的内容块：文字拼起来，图片单列，别的（资源等）序列化成文字，不丢 */
function outcomeOf(content: unknown, isError: boolean): ToolOutcome {
  const texts: string[] = []
  const images: AssistantImage[] = []
  for (const b of Array.isArray(content) ? content.map(rec) : []) {
    if (b.type === 'text') texts.push(str(b.text))
    else if (b.type === 'image' && str(b.data)) images.push({ mimeType: str(b.mimeType) || 'image/png', data: str(b.data) })
    else texts.push(JSON.stringify(b))
  }
  return { text: texts.join('\n'), images, isError }
}

/** 一个会话的 MCP 进程。进程自己退了（closed）就不能再用，调用方下一次重起 */
export class AssistantTools {
  closed = false

  private constructor(private readonly client: Client) {
    client.onclose = () => {
      this.closed = true
    }
  }

  static async start(tool: PageTool): Promise<AssistantTools> {
    const server = pageToolServer(tool)
    const client = new Client({ name: 'ramet-assistant', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((e) => [e.name, e.value])),
        stderr: 'ignore',
      }),
    )
    return new AssistantTools(client)
  }

  /** 每一轮开头列一次：可派的 agent 随机器上下线变（mcp/ramet.mjs 每次列工具都重新问中心） */
  async list(): Promise<AssistantToolSpec[]> {
    return (await this.client.listTools()).tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))
  }

  /** 调一次。停止（signal）时作废这次请求；工具自己报的错走 isError，不抛 */
  async call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const res = await this.client.callTool({ name, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS })
    return outcomeOf(res.content, res.isError === true)
  }

  close(): void {
    this.closed = true
    this.client.close().catch(() => undefined)
  }
}

/** MCP 工具 → pi 的 AgentTool。工具自己报的错走 isError（结果文字照样给模型）；MCP 调用本身失败 / 被停止就抛，
 *  pi 把它记成这一步的错误结果。没跑到的调用由 pi 补上结果，下一次请求照样合法 */
export function agentTools(tools: AssistantTools, specs: AssistantToolSpec[]): AgentTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    execute: async (_id, params, signal) => {
      let out: ToolOutcome
      try {
        out = await tools.call(spec.name, rec(params), signal ?? new AbortController().signal)
      } catch (err) {
        throw new Error(signal?.aborted ? STOPPED : `工具调用失败：${errorText(err)}`)
      }
      const text = clipResult(out.text)
      const images: ImageContent[] = out.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
      const content: Array<TextContent | ImageContent> = [...(text || images.length === 0 ? [{ type: 'text' as const, text: text || EMPTY_RESULT }] : []), ...images]
      return { content, details: undefined, ...(out.isError ? { isError: true } : {}) }
    },
  }))
}
