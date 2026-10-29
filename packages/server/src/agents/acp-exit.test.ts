import { expect, test } from 'vitest'
import { AcpAgent, describeAgentExit, errorText } from './acp.js'

test('errorText：带上 JSON-RPC 的 data —— 红条不能只剩一句 Internal error', () => {
  const bare = Object.assign(new Error('Internal error'), {})
  expect(errorText(bare)).toBe('Internal error')
  const withData = Object.assign(new Error('Internal error'), {
    data: { details: 'spawn /usr/local/bin/node ENOENT' },
  })
  expect(errorText(withData)).toBe('Internal error：{"details":"spawn /usr/local/bin/node ENOENT"}')
  const withString = Object.assign(new Error('boom'), { data: 'no such file' })
  expect(errorText(withString)).toBe('boom：no such file')
  expect(errorText('plain')).toBe('plain')
})

test('describeAgentExit：退出码和 stderr 尾巴；没有退出事件就说管道关了', () => {
  expect(describeAgentExit('omp', { code: 3, signal: null }, 'hello\nboom-reason')).toBe(
    'omp 的 ACP 进程断了（退出码 3）：hello | boom-reason',
  )
  expect(describeAgentExit('omp', { code: null, signal: 'SIGTERM' }, '')).toBe('omp 的 ACP 进程断了（信号 SIGTERM）')
  expect(describeAgentExit('omp', null, '')).toBe('omp 的 ACP 进程断了（stdio 已关闭）')
})

test('ACP 进程自己退出时，调用方拿到退出码和 stderr，不是空的 connection closed', async () => {
  const agent = new AcpAgent({
    id: 'boom',
    label: 'boom',
    command: process.execPath,
    args: ['-e', 'console.error("boom-reason"); process.exit(3)'],
  })
  await expect(agent.newSession('/tmp')).rejects.toThrow(/退出码 3）.*boom-reason/)
})

/** 说最小 ACP 的假 agent：initialize 正常，session/new 回 JSON-RPC error（带 data）——
 *  复现真实故障：omp 起 MCP 工具进程失败时 session/new 只回 "Internal error"，真正原因在 data 里。 */
const FAIL_SESSION_SCRIPT = `
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n')
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'spawn /usr/local/bin/node ENOENT' } } }) + '\\n')
    }
  }
})
`

test('session/new 失败时把 JSON-RPC data 里的真实原因带到调用方（红条不止一句 Internal error）', async () => {
  const agent = new AcpAgent({
    id: 'omp',
    label: 'omp',
    command: process.execPath,
    args: ['-e', FAIL_SESSION_SCRIPT],
  })
  await expect(agent.newSession('/tmp')).rejects.toThrow(/Internal error.*spawn \/usr\/local\/bin\/node ENOENT/)
  agent.kill()
})
