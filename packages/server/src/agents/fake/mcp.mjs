// 假 agent 经 MCP 回打中心：用本会话收到的第一份 MCP 配置拉起 Ramet 的 MCP 进程（就是真 agent 的做法）。
// 配置已由协议层归一成 { name, command, args, env: {名: 值} }，这里与协议无关。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** 拉起 MCP 进程，跑 fn(client)，再关掉；本会话没有 MCP 配置时返回 null */
export async function withMcp(s, fn) {
  const spec = s.mcp[0]
  if (!spec) return null
  const client = new Client({ name: 'fake-agent', version: '0.0.1' })
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...(spec.env ?? {}) } }))
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => undefined)
  }
}

export const toolText = (res) => (res.content ?? []).map((c) => c.text ?? '').join('')
export const mcpToolNames = (s) => withMcp(s, async (c) => (await c.listTools()).tools.map((t) => t.name))
