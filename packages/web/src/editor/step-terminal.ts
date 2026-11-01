/* ---------- 一步里可以停止的命令（agent 在它所在机器上跑、我们握着句柄的那种）----------
 * 句柄与退出状态都在步骤视图里（viewOf：handle / exit）；只有原始载荷（step.acp）的老记录也由它推出。
 * 运行中的托盘（run-tray.ts）、步骤展开（run-view.ts）与项目面板的命令列表共用。 */
import { isTerminal, viewOf, type ToolEntry } from '@ramet/shared/run-model'

export type StepExit = { exitCode: number | null; signal: string | null }

/** 这一步的命令句柄，没有说明我们停不了它 */
export function stepTerminalId(e: ToolEntry): string | null {
  return viewOf(e).handle || null
}

/** 命令退出信息；还在跑或不知道返回 null */
export function stepExit(e: ToolEntry): StepExit | null {
  const exit = viewOf(e).exit
  return exit ? { exitCode: exit.code, signal: exit.signal } : null
}

/** 唤起子代理的那一步（Claude 的 Agent / Task 工具、Codex 的协作调用、omp 的 task 工具）：它的句柄停的是子代理，不是一条命令 */
export function isSubagentStep(e: ToolEntry): boolean {
  const tool = viewOf(e).tool
  return tool === 'Agent' || tool === 'Task' || tool === 'collabAgent' || tool === 'task'
}

/** 可停止的命令还在跑（没退出、步骤也没收尾） */
export function isRunningCommand(e: ToolEntry): boolean {
  return stepTerminalId(e) !== null && stepExit(e) === null && !isTerminal(e.status)
}
