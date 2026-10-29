/* ---------- 一步里的 ACP 终端（agent 用 terminal/* 在它所在机器上跑的命令）----------
 * 服务端（agents/acp-terminals.ts）把命令绑到工具步骤上：tool_call 内容里嵌 `{type:'terminal', terminalId}`（acp.content），
 * 实时输出追加到这一步的 output，命令退出后补一个 `acp.terminalExit`。这里只读这两处，不猜别的形状。
 * 运行中的托盘（run-tray.ts）、步骤展开（run-view.ts）与项目面板的命令列表共用。 */
import { isTerminal, type ToolEntry } from '@ramet/shared/run-model'

export type StepExit = { exitCode: number | null; signal: string | null }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** 这一步嵌的终端 id，没有说明不是 ACP 终端里的命令 */
export function stepTerminalId(e: ToolEntry): string | null {
  const content = rec(e.acp).content
  if (!Array.isArray(content)) return null
  for (const item of content) {
    const c = rec(item)
    if (c.type === 'terminal' && typeof c.terminalId === 'string' && c.terminalId) return c.terminalId
  }
  return null
}

/** 命令退出信息（acp.terminalExit）；还在跑或不是终端命令返回 null */
export function stepExit(e: ToolEntry): StepExit | null {
  const exit = rec(rec(e.acp).terminalExit)
  if (!('exitCode' in exit) && !('signal' in exit)) return null
  return {
    exitCode: typeof exit.exitCode === 'number' ? exit.exitCode : null,
    signal: typeof exit.signal === 'string' && exit.signal ? exit.signal : null,
  }
}

/** ACP 终端里的命令还在跑（没退出、步骤也没收尾），可以停止 */
export function isRunningCommand(e: ToolEntry): boolean {
  return stepTerminalId(e) !== null && stepExit(e) === null && !isTerminal(e.status)
}
