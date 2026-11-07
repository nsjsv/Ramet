import { describe, expect, test } from 'vitest'
import { agentRunErrorOf, approvalHosted, registerApprovalHost, setAgentRunError } from './agent-bar'
import {
  carryToChat,
  clearCarried,
  composerDom,
  insertIntoComposer,
  peekCarried,
  registerComposer,
  takeComposerText,
  type Composer,
} from './composer-bridge'

/** 测试用输入框：记着框里的字，insert 追加 */
function fakeComposer(initial = ''): Composer & { text: string } {
  const c = {
    text: initial,
    get: () => c.text,
    set: (t: string) => {
      c.text = t
    },
    insert: (t: string) => {
      c.text += t
    },
    dom: () => null,
    focus: () => undefined,
  }
  return c
}

describe('对话输入框桥按页面分开（两个对话同时在场）', () => {
  test('引用只落进同一页的输入框，另一页的不动', () => {
    const a = fakeComposer()
    const b = fakeComposer()
    const offA = registerComposer('page-a', a)
    const offB = registerComposer('page-b', b)
    expect(insertIntoComposer('page-a', '@[x](page:p#1)')).toBe(true)
    expect(a.text).toBe('@[x](page:p#1)')
    expect(b.text).toBe('')
    // 没登记输入框的页（文档模式 / 只读）返回 false，调用方退回复制
    expect(insertIntoComposer('page-c', 'y')).toBe(false)
    expect(composerDom('page-c')).toBeNull()
    offA()
    offB()
  })

  test('对话到文档只取走这一页的字', () => {
    const a = fakeComposer('a 的草稿')
    const b = fakeComposer('b 的草稿')
    const offA = registerComposer('page-a', a)
    const offB = registerComposer('page-b', b)
    expect(takeComposerText('page-a')).toBe('a 的草稿')
    expect(a.text).toBe('')
    expect(b.text).toBe('b 的草稿')
    offA()
    offB()
  })

  test('文档到对话带过去的草稿只给同一页的 ChatView', () => {
    carryToChat('page-a', '带过去的字')
    expect(peekCarried('page-b')).toBe('')
    expect(peekCarried('page-a')).toBe('带过去的字')
    expect(peekCarried('page-a')).toBe('带过去的字') // peek 不消耗
    clearCarried('page-a')
    expect(peekCarried('page-a')).toBe('')
    carryToChat('page-a', 'x')
    carryToChat('page-a', '') // 带空串 = 没有
    expect(peekCarried('page-a')).toBe('')
  })

  test('同一页先后挂两个输入框：旧的注销不摘掉新的', () => {
    const first = fakeComposer()
    const second = fakeComposer()
    const offFirst = registerComposer('page-a', first)
    const offSecond = registerComposer('page-a', second)
    offFirst()
    expect(insertIntoComposer('page-a', 'z')).toBe(true)
    expect(second.text).toBe('z')
    offSecond()
    expect(insertIntoComposer('page-a', 'z')).toBe(false)
  })
})

describe('运行错误按页面分开', () => {
  test('一页的失败不显示在另一页，清掉也只清这一页', () => {
    setAgentRunError('page-a', '启动失败：忙')
    setAgentRunError('page-b', '排队失败')
    expect(agentRunErrorOf('page-a')).toBe('启动失败：忙')
    expect(agentRunErrorOf('page-b')).toBe('排队失败')
    expect(agentRunErrorOf('page-c')).toBeNull()
    setAgentRunError('page-a', null)
    expect(agentRunErrorOf('page-a')).toBeNull()
    expect(agentRunErrorOf('page-b')).toBe('排队失败')
    setAgentRunError('page-b', '') // 空串同 null
    expect(agentRunErrorOf('page-b')).toBeNull()
  })
})

describe('审批宿主按页面计数', () => {
  test('别的页的运行条不让这一页的兜底弹条消失', () => {
    const offB = registerApprovalHost('page-b')
    expect(approvalHosted('page-b')).toBe(true)
    expect(approvalHosted('page-a')).toBe(false)
    offB()
    expect(approvalHosted('page-b')).toBe(false)
  })

  test('同一页两条运行条：都注销了才算没人承接；注销幂等', () => {
    const one = registerApprovalHost('page-a')
    const two = registerApprovalHost('page-a')
    one()
    one() // 重复注销不多减
    expect(approvalHosted('page-a')).toBe(true)
    two()
    expect(approvalHosted('page-a')).toBe(false)
  })
})
