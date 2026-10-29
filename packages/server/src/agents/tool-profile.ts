// ---------- 工具档位 ----------
// 对话页给 agent 哪一档 Ramet 工具：
//   none    = Ramet 只当 UI：不挂 Ramet MCP，提示词只有文档正文（不注入记忆、不带过程摘要、块引用不跨页解析）
//   minimal = 读写当前页：read_page / read_image / edit_page（凭证带 profile，中心端点据此拦其余工具）
//   full    = 全部（缺省，没有这个键的页面按它算）
// 页面级意图存在 agent_session.tools（session-store.ts）；会话记录 sessions[agentId].tools 记这个会话建 / 加载时交付的是哪一档。
// 工具随 session/new|load 的 mcpServers 交付、已加载的会话不会重发，所以档位与 cwd 一样是会话复用条件的一部分：不等就新建 + 全文重放。
// ACP 的文件 / 终端代办（acp.ts 的 clientCapabilities）三档都保留，不归这里管。

export type ToolProfile = 'none' | 'minimal' | 'full'

/** 精简档的工具（也正是 MCP 进程连不上中心时的兜底那三个，mcp/ramet.mjs 的 FALLBACK） */
export const MINIMAL_TOOLS = ['read_page', 'read_image', 'edit_page']

export function isToolProfile(v: unknown): v is ToolProfile {
  return v === 'none' || v === 'minimal' || v === 'full'
}

/** 库里的原始值转成档位；没有 / 认不出就是 full（没存过档位的页面和会话记录） */
export function toolProfileOf(raw: unknown): ToolProfile {
  return isToolProfile(raw) ? raw : 'full'
}
