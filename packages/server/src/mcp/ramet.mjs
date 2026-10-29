#!/usr/bin/env node
// ---------- AI 侧的 Ramet MCP 进程（stdio，纯 JS） ----------
// 由 ACP agent 按 session/new|load 的 mcpServers 配置拉起。这个进程不连 Postgres、不读任何配置文件：
// 只有两个环境变量，中心地址与一把凭证（见 page-read.ts；凭证绑着哪一页上的哪个 agent）。
// 工具按模块拆在 ./tools/*.mjs，每个模块导出 tools: [{ name, define(caps), run(args, caps) }]；
// 这里只负责问中心这把凭证能用哪些工具（GET /api/ramet/tools，被叫的会话没有 run_agent）、列出、分发。
// 权限判定全在中心端点，这里只带凭证。
//
// 纯 JS：本地与 connector 两侧都用 process.execPath 直跑本文件，不依赖 tsx、工作目录、tsconfig
// （connector 那台机器只有 node，整个 mcp/ 目录随代码一起在）。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { call, reply } from './lib.mjs'
import * as dispatch from './tools/dispatch.mjs'
import * as hub from './tools/hub.mjs'
import * as images from './tools/images.mjs'
import * as memory from './tools/memory.mjs'
import * as pages from './tools/pages.mjs'
import * as skills from './tools/skills.mjs'
import * as team from './tools/team.mjs'

const ALL = [...pages.tools, ...images.tools, ...hub.tools, ...memory.tools, ...dispatch.tools, ...skills.tools, ...team.tools]
/** 中心不认识 /api/ramet/tools 或暂时不通时的兜底：只留三个基础工具 */
const FALLBACK = { tools: ['read_page', 'read_image', 'edit_page'], agents: [] }

let capsOnce
/** 这把凭证能用的工具与可叫的 agent；进程内缓存一次（会话很短，凭证上下文不会中途变） */
function loadCaps() {
  capsOnce ??= call('/api/ramet/tools')
    .then((r) => (r.ok && Array.isArray(r.json?.tools) ? r.json : FALLBACK))
    .catch(() => FALLBACK)
  return capsOnce
}

const server = new Server({ name: 'ramet', version: '1.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const caps = await loadCaps()
  return { tools: ALL.filter((t) => caps.tools.includes(t.name)).map((t) => t.define(caps)) }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const caps = await loadCaps()
  const tool = ALL.find((t) => t.name === req.params.name)
  if (!tool) throw new Error(`未知工具 ${req.params.name}`)
  if (!caps.tools.includes(tool.name)) return reply(`工具 ${tool.name} 在这个会话里不可用。`, true)
  return tool.run(req.params.arguments ?? {}, caps)
})

await server.connect(new StdioServerTransport())
