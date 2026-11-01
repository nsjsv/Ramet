// ---------- omp 的宿主工具：驱动自己当 MCP 客户端，把 Ramet 的页面工具经 set_host_tools 交给 omp ----------
// omp 的扩展 API 不能按会话注册 MCP 服务（只读 mcp.json / 插件目录，凭证得落盘），而 RPC 有原生的「宿主提供工具」：
// 工具定义经 set_host_tools 交过去，模型调用时 omp 发 host_tool_call，宿主回 host_tool_result。所以由驱动拉起 mcp/ramet.mjs、
// 列出工具、转发调用。凭证只在驱动进程（与它拉起的 MCP 进程）里，omp 进程和它跑的命令都看不到。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { pageToolServer, type PageTool } from '../../../page-read.js'
import { rec, str } from '../tool-text.js'
import type { HostToolCall, HostToolDefinition, HostToolResult } from './protocol.js'

/** 宿主工具名前缀：不撞 omp 的内置工具与用户自己的 MCP 工具 */
const PREFIX = 'ramet'
/** 单次调用的上限：Ramet 的工具里有会等很久的（等人审批、叫别的 agent），MCP SDK 缺省 60 秒会把它们误杀 */
const CALL_TIMEOUT_MS = 24 * 60 * 60 * 1000

type Route = { client: Client; name: string }

/** MCP 工具结果的内容块 → omp 的工具结果。文字 / 图片原样，其余（资源等）序列化成文字，不丢 */
function contentOf(raw: unknown): HostToolResult['content'] {
  const list = Array.isArray(raw) ? raw.map(rec) : []
  return list.map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: str(b.text) }
    if (b.type === 'image' && str(b.data)) return { type: 'image' as const, data: str(b.data), mimeType: str(b.mimeType) || 'image/png' }
    return { type: 'text' as const, text: JSON.stringify(b) }
  })
}

export class HostTools {
  private constructor(
    private readonly clients: Client[],
    private readonly routes: Map<string, Route>,
    readonly definitions: HostToolDefinition[],
  ) {}

  /** 每份页面工具起一个 MCP 进程并列出它的工具。env：MCP 进程沿用驱动的环境（同 agent 自己拉起时），再加上凭证 */
  static async start(tools: PageTool[], env: Record<string, string> = {}): Promise<HostTools> {
    const clients: Client[] = []
    const routes = new Map<string, Route>()
    const definitions: HostToolDefinition[] = []
    try {
      for (const [i, tool] of tools.entries()) {
        const s = pageToolServer(tool)
        const client = new Client({ name: 'ramet-omp-driver', version: '1.0.0' })
        const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
        await client.connect(
          new StdioClientTransport({
            command: s.command,
            args: s.args,
            env: { ...base, ...env, ...Object.fromEntries(s.env.map((e) => [e.name, e.value])) },
            stderr: 'ignore',
          }),
        )
        clients.push(client)
        const prefix = i === 0 ? PREFIX : `${PREFIX}${i + 1}`
        for (const t of (await client.listTools()).tools) {
          const name = `${prefix}_${t.name}`
          routes.set(name, { client, name: t.name })
          definitions.push({
            name,
            label: t.title ?? t.name,
            description: t.description ?? t.name,
            parameters: t.inputSchema as Record<string, unknown>,
            // 缺省 discoverable 会被挂成 xd:// 设备，模型的工具表里看不到
            loadMode: 'essential',
          })
        }
      }
    } catch (err) {
      for (const c of clients) await c.close().catch(() => {})
      throw err
    }
    return new HostTools(clients, routes, definitions)
  }

  /** 转发一次调用。MCP 报的工具错误抛出去（rpc 层据此回 isError），被撤回（host_tool_cancel）时 signal 中止这次请求 */
  async call(call: HostToolCall, signal: AbortSignal): Promise<HostToolResult> {
    const route = this.routes.get(call.toolName)
    if (!route) throw new Error(`没有宿主工具 ${call.toolName}`)
    const res = await route.client.callTool({ name: route.name, arguments: call.arguments ?? {} }, undefined, { signal, timeout: CALL_TIMEOUT_MS })
    const content = contentOf(res.content)
    if (res.isError) throw new Error(content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') || `${call.toolName} 失败`)
    return { content, ...(res.structuredContent !== undefined ? { details: res.structuredContent } : {}) }
  }

  close(): void {
    for (const c of this.clients) c.close().catch(() => {})
  }
}
