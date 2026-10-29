import { describe, expect, test } from 'vitest'
import { ApiError } from '../api'
import { startErrorText } from './team-errors'

describe('开工失败的原因', () => {
  test('组长不对（leader mismatch）：说明要先把出计划的 agent 选回来', () => {
    const text = startErrorText(new ApiError('原文', 409, 'leader mismatch'), 'Claude Code')
    expect(text).toContain('Claude Code')
    expect(text).toContain('选回来')
  })

  test('只有短码没有人话的翻译成人话', () => {
    expect(startErrorText(new ApiError('invalid team', 400, 'invalid team'), 'x')).toContain('刷新页面')
    expect(startErrorText(new ApiError('page not found', 404, 'page not found'), 'x')).toContain('写权限')
  })

  test('服务端自带人话的（403 带主人名、409 哪个任务不可用）原样给', () => {
    expect(startErrorText(new ApiError('任务「实现接口」：这台机器的主人是 bob', 403, 'forbidden'), 'x')).toBe('任务「实现接口」：这台机器的主人是 bob')
    expect(startErrorText(new ApiError('任务「文档」的负责人当前不可用，请先换人', 409, 'assignee unavailable'), 'x')).toContain('请先换人')
    expect(startErrorText(new ApiError('该页面已有 agent 正在生成', 409, 'busy'), 'x')).toContain('正在生成')
  })

  test('别的错误（网络断了）给它自己的话；什么都没有就给通用的', () => {
    expect(startErrorText(new Error('Failed to fetch'), 'x')).toBe('Failed to fetch')
    expect(startErrorText('boom', 'x')).toBe('开工失败')
  })
})
