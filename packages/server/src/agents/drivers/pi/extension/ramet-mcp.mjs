// ---------- pi 扩展：把 Ramet 的页面工具按会话注册成 MCP 服务（纯 JS，pi 用 `-e <本文件>` 加载） ----------
// 驱动经环境变量 RAMET_PI_MCP 交来 {<服务名>: {command, args, env, exposure}}。注册只对这个 pi 进程（这个会话）生效、不落盘，
// 所以不写用户的 mcp.json，也不往项目里放文件。读完立刻删掉这个变量：凭证在 MCP 配置的 env 里，留着会被 agent 跑的命令看到。
// 刻意写成纯 JS、不 import 任何东西：connector 那台机器上它和 mcp/ramet.mjs 一样按路径被直接加载。

export default function rametMcp(pi) {
  const raw = process.env.RAMET_PI_MCP
  delete process.env.RAMET_PI_MCP
  if (!raw || typeof pi?.registerMcpServer !== 'function') return
  let servers
  try {
    servers = JSON.parse(raw)
  } catch {
    return
  }
  for (const [name, config] of Object.entries(servers ?? {})) {
    if (config && typeof config === 'object') pi.registerMcpServer(name, config)
  }
}
