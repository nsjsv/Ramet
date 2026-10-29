import { expect, test } from 'vitest'
import { dropOuterClaudeSession } from './claude-session-env.js'

test('从 Claude Code 里启动：清掉外层会话的变量，用户配置与其余环境保留', () => {
  const env: NodeJS.ProcessEnv = {
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 's',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 't',
    CLAUDE_PID: '42',
    CLAUDE_EFFORT: 'xhigh',
    AI_AGENT: 'claude-code',
    GIT_EDITOR: 'true',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    PATH: '/usr/bin',
  }
  expect(dropOuterClaudeSession(env)).toBe(10)
  expect(env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', PATH: '/usr/bin' })
})

test('没有 CLAUDECODE 标记：一个都不动', () => {
  const env: NodeJS.ProcessEnv = { CLAUDE_EFFORT: 'high', GIT_EDITOR: 'vim', PATH: '/usr/bin' }
  expect(dropOuterClaudeSession(env)).toBe(0)
  expect(env).toEqual({ CLAUDE_EFFORT: 'high', GIT_EDITOR: 'vim', PATH: '/usr/bin' })
})
