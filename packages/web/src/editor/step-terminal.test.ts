import { expect, test } from 'vitest'
import type { ToolEntry } from '@ramet/shared/run-model'
import { isRunningCommand, stepExit, stepTerminalId } from './step-terminal'

const step = (extra: Partial<ToolEntry> = {}): ToolEntry => ({ k: 'tool', id: 't1', kind: 'execute', title: 'npm test', status: 'in_progress', ...extra })
const withTerminal = (acp: Record<string, unknown> = {}) => ({ content: [{ type: 'terminal', terminalId: 'T-1' }], ...acp })

test('stepTerminalId：只认 acp.content 里的 terminal 项；别的形状 = 不是终端命令', () => {
  expect(stepTerminalId(step({ acp: withTerminal() }))).toBe('T-1')
  expect(stepTerminalId(step({ acp: { content: [{ type: 'content', content: { type: 'text', text: 'x' } }, { type: 'terminal', terminalId: 'T-2' }] } }))).toBe('T-2')
  expect(stepTerminalId(step())).toBeNull()
  expect(stepTerminalId(step({ acp: { content: 'nope' } }))).toBeNull()
  expect(stepTerminalId(step({ acp: { content: [{ type: 'terminal', terminalId: '' }] } }))).toBeNull()
})

test('stepExit：服务端补的 acp.terminalExit；退出码 / 信号二选一，缺的当 null；没补 = 还在跑', () => {
  expect(stepExit(step({ acp: withTerminal() }))).toBeNull()
  expect(stepExit(step({ acp: withTerminal({ terminalExit: { terminalId: 'T-1', exitCode: 2, signal: null } }) }))).toEqual({ exitCode: 2, signal: null })
  expect(stepExit(step({ acp: withTerminal({ terminalExit: { terminalId: 'T-1', exitCode: null, signal: 'SIGTERM' } }) }))).toEqual({ exitCode: null, signal: 'SIGTERM' })
  expect(stepExit(step({ acp: withTerminal({ terminalExit: { exitCode: 0 } }) }))).toEqual({ exitCode: 0, signal: null })
})

test('isRunningCommand：有终端、没退出、步骤没收尾才算在跑（才有「停止这条命令」）', () => {
  expect(isRunningCommand(step({ acp: withTerminal() }))).toBe(true)
  expect(isRunningCommand(step({ acp: withTerminal({ terminalExit: { exitCode: 0, signal: null } }) }))).toBe(false)
  expect(isRunningCommand(step({ status: 'completed', acp: withTerminal() }))).toBe(false)
  expect(isRunningCommand(step({ status: 'failed', acp: withTerminal() }))).toBe(false)
  expect(isRunningCommand(step())).toBe(false) // 不是 ACP 终端里的命令：我们停不了它
})
