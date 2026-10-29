import { expect, test } from 'vitest'
import { isRunEventType } from './run-event-types'

test('一轮的事件都放行（含带队的 team）；页面级 / 会话级事件不放行', () => {
  for (const type of ['reply', 'think', 'said', 'step', 'child', 'info', 'plan', 'team']) expect(isRunEventType(type), type).toBe(true)
  // team_plan 是页面级广播（整份计划视图），不是一轮的事件：进计划视图 store，不进 applyRunEvent
  for (const type of ['team_plan', 'run', 'status', 'permission', 'permission_resolved', 'commands', 'config', 'error', 'cwd', 'choice']) {
    expect(isRunEventType(type), type).toBe(false)
  }
})

test('原型链上的名字不算（agent 目录 / SSE 是外部输入）；非字符串不算', () => {
  for (const type of ['constructor', 'toString', '__proto__', undefined, null, 1, {}]) expect(isRunEventType(type)).toBe(false)
})
