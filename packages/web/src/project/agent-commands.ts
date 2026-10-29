/* ---------- 「agent 跑的命令」：本页最近几轮里 agent 的命令步骤（只读）----------
 * 两路来源，步骤形状相同：命令步骤（kind = execute）的命令行、实时输出（step.output，ACP 终端里跑的由服务端追加）、
 * 退出状态（acp.terminalExit）都在步骤里。
 *   - 已结束的轮次：各自过程页的 runs.record（归档后不再变，以它为准）；
 *   - 在跑的这一轮：页面事件流里已有的 live run（agent-bar 的 store），不另取、不另连。一轮结束、store 清掉 run
 *     到过程页出现在页面列表里之间有个空档，面板开着期间看过的命令先留着（remember）补上。
 * 两路的 key 都是「回复块 id : 步骤 id」（record.replyId 就是那一轮的回复块），同一条命令不会列两遍。 */

import { isTerminal, type RunEntry, type ToolEntry } from '@ramet/shared/run-model'
import type { Page } from '../api'
import { commandOf, rec } from '../editor/run-detail'
import { stepExit, stepTerminalId } from '../editor/step-terminal'

export type CommandState = 'running' | 'done' | 'failed'

export interface AgentCommand {
  /** 稳定 key：回复块 + 步骤 id（同一条命令的多次更新是同一条） */
  key: string
  command: string
  state: CommandState
  exitCode: number | null
  signal: string | null
  /** ACP 终端里的命令才有（可以点「停止这条命令」） */
  terminalId: string | null
  entry: ToolEntry
}

/** 命令行：rawInput.command → 步骤标题 */
function commandLine(e: ToolEntry): string {
  return commandOf(rec(e.acp).rawInput) || e.title || e.detail || ''
}

export function agentCommandsOf(replyId: string, entries: readonly RunEntry[]): AgentCommand[] {
  const out: AgentCommand[] = []
  for (const e of entries) {
    if (e.k !== 'tool' || e.kind !== 'execute') continue
    const exit = stepExit(e)
    const failed = e.status === 'failed' || Boolean(exit && (exit.signal || (exit.exitCode ?? 0) !== 0))
    out.push({
      key: `${replyId}:${e.id}`,
      command: commandLine(e),
      state: !isTerminal(e.status) && !exit ? 'running' : failed ? 'failed' : 'done',
      exitCode: exit?.exitCode ?? null,
      signal: exit?.signal ?? null,
      terminalId: stepTerminalId(e),
      entry: e,
    })
  }
  return out
}

/** 把这一刻看到的命令并进已记住的（同 key 更新、新的追加在后），最多留 max 条（丢最老的） */
export function rememberCommands(prev: readonly AgentCommand[], seen: readonly AgentCommand[], max = 30): AgentCommand[] {
  const byKey = new Map(prev.map((c) => [c.key, c]))
  const next = prev.map((c) => seen.find((s) => s.key === c.key) ?? c)
  for (const c of seen) if (!byKey.has(c.key)) next.push(c)
  return next.slice(-max)
}

/** 列最近几轮：再往前的去过程页看（每轮要取一份完整 record，别为这个列表拉一长串） */
export const RECENT_RUNS = 3

/** 本页最近 n 轮的过程页 id（旧 → 新）：过程页是对话页的 kind = 'run' 子页 */
export function recentRunPages(pages: readonly Page[] | null, pageId: string, n = RECENT_RUNS): string[] {
  if (!pages) return []
  const runs = pages.filter((p) => p.kind === 'run' && p.parent_id === pageId)
  runs.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  return runs.slice(-n).map((p) => p.id)
}

/** 归档的在前、为准；live 里还没归档的（在跑的这一轮）接在后面，最多留 max 条（丢最老的） */
export function mergeCommands(archived: readonly AgentCommand[], live: readonly AgentCommand[], max = 30): AgentCommand[] {
  const have = new Set(archived.map((c) => c.key))
  return [...archived, ...live.filter((c) => !have.has(c.key))].slice(-max)
}
