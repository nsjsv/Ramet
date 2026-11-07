import { describe, expect, test } from 'vitest'
import { causeOf, quietGroups, type FoldBlock } from './quiet-fold'

const notice = (id: string, kind: string, headline: string): FoldBlock => ({ name: 'user_message', id, notice: kind, quiet: '', outcome: '', headline })
const user = (id: string): FoldBlock => ({ name: 'user_message', id, notice: '', quiet: '', outcome: '', headline: '你好' })
const reply = (id: string, quiet = '', outcome = 'end'): FoldBlock => ({ name: 'agent_reply', id, notice: '', quiet, outcome, headline: '' })

describe('「不用处理」折叠', () => {
  test('回复连同它前面紧挨着的通知折成一组；一行写来由与理由', () => {
    const blocks = [user('u1'), reply('r1'), notice('n1', 'event', '规则「评论提醒」· bob 在《周报》的评论'), reply('r2', '只是确认，不用处理')]
    expect(quietGroups(blocks)).toEqual([{ id: 'r2', start: 2, end: 3, line: '看了 bob 在《周报》的评论：只是确认，不用处理' }])
  })

  test('一轮看了几条通知：都折进去，停在第一块不是通知的地方', () => {
    const blocks = [user('u1'), notice('n1', 'event', '规则「a」· 评论'), notice('n2', 'timer', '定时「早报」· 每天 09:00'), reply('r1', '没事')]
    expect(quietGroups(blocks)).toEqual([{ id: 'r1', start: 1, end: 3, line: '看了 2 条通知：没事' }])
  })

  test('前面不是通知：只折回复本身', () => {
    expect(quietGroups([user('u1'), reply('r1', '不用管')])).toEqual([{ id: 'r1', start: 1, end: 1, line: '不用处理：不用管' }])
  })

  test('还在跑、失败、停止、没有理由的回复不折', () => {
    const n = notice('n1', 'event', '规则「a」· 评论')
    expect(quietGroups([n, reply('r1', '理由', 'run')])).toEqual([])
    expect(quietGroups([n, reply('r1', '理由', 'error')])).toEqual([])
    expect(quietGroups([n, reply('r1', '理由', 'cancelled')])).toEqual([])
    expect(quietGroups([n, reply('r1')])).toEqual([])
  })

  test('来由：事件取抬头后半句，定时取前半句，任务通知没有可读的字', () => {
    expect(causeOf(notice('n', 'event', '规则「a」· bob 在《周报》的评论'))).toBe('bob 在《周报》的评论')
    expect(causeOf(notice('n', 'timer', '定时「早报」· 每天 09:00 · 本应 09:00，延后到 09:30'))).toBe('定时「早报」')
    expect(causeOf(notice('n', 'done', '任务  已完成 · Codex · 3 分钟'))).toBe('任务通知')
    expect(quietGroups([notice('n1', 'timer', '定时「早报」· 每天 09:00'), reply('r1', '今天没新提交')])[0]!.line).toBe('看了定时「早报」：今天没新提交')
  })
})
