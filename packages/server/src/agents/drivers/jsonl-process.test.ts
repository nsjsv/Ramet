/* ---------- JSONL 子进程：严格 LF 分帧、半行缓冲、CRLF、退出说明（真子进程，不起服务、不碰库）---------- */
import { afterEach, expect, test } from 'vitest'
import { JsonlProcess, LineSplitter, describeProcessExit } from './jsonl-process.js'
import { cliOf, parseVersion, probeVersion } from './cli-version.js'

const spawned: JsonlProcess[] = []
afterEach(() => {
  for (const p of spawned.splice(0)) p.kill()
})

/** 起一个 node -e 脚本，收齐它在 stdout 上的全部消息（等进程结束） */
async function run(script: string): Promise<{ msgs: unknown[]; noise: string[]; exit: { crashed: boolean; reason: string } }> {
  const msgs: unknown[] = []
  const noise: string[] = []
  let exit: { crashed: boolean; reason: string } | null = null
  const p = new JsonlProcess({
    id: 'fake',
    command: process.execPath,
    args: ['-e', script],
    onMessage: (m) => msgs.push(m),
    onNoise: (l) => noise.push(l),
    onExit: (e) => {
      exit = { crashed: e.crashed, reason: e.reason }
    },
  })
  spawned.push(p)
  await p.done
  return { msgs, noise, exit: exit! }
}

test('LineSplitter：只按 LF 切，U+2028 / U+2029 不算换行', () => {
  const s = new LineSplitter()
  expect(s.push('{"a":"x\u2028y\u2029z"}\n')).toEqual(['{"a":"x\u2028y\u2029z"}'])
})

test('LineSplitter：半行留到下一块，CRLF 去掉 \\r，流尾没写换行的那条由 flush 交出', () => {
  const s = new LineSplitter()
  expect(s.push('{"a":')).toEqual([])
  expect(s.push('1}\r\n{"b"')).toEqual(['{"a":1}'])
  expect(s.push(':2}\r\n\n')).toEqual(['{"b":2}', ''])
  expect(s.push('{"c":3}')).toEqual([])
  expect(s.flush()).toBe('{"c":3}')
  expect(s.flush()).toBeNull()
})

test('真子进程：JSON 字符串里的 U+2028 / U+2029 不把一条消息劈开', async () => {
  // JSON.stringify 不转义这两个字符：写出去的就是原样的行分隔符 / 段分隔符
  const { msgs, noise } = await run(`process.stdout.write(JSON.stringify({ t: 'a\\u2028b\\u2029c' }) + '\\n')`)
  expect(noise).toEqual([])
  expect(msgs).toEqual([{ t: 'a\u2028b\u2029c' }])
})

test('真子进程：一条消息分几次写、CRLF、多字节字符跨块，都按行完整交出', async () => {
  const script = `
    const out = Buffer.from(JSON.stringify({ n: 1, s: '中文' }) + '\\r\\n' + JSON.stringify({ n: 2 }) + '\\r\\n')
    const parts = [out.subarray(0, 10), out.subarray(10, 11), out.subarray(11)]
    let i = 0
    const next = () => { if (i < parts.length) { process.stdout.write(parts[i++]); setTimeout(next, 30) } }
    next()
  `
  const { msgs } = await run(script)
  expect(msgs).toEqual([{ n: 1, s: '中文' }, { n: 2 }])
})

test('真子进程：stdout 上不是 JSON 的行进 onNoise，不打断后面的消息；最后一条没换行也交出', async () => {
  const { msgs, noise } = await run(`process.stdout.write('warming up\\n{"ok":true}\\n{"last":1}')`)
  expect(noise).toEqual(['warming up'])
  expect(msgs).toEqual([{ ok: true }, { last: 1 }])
})

test('真子进程退出：说明里有退出码与 stderr 尾巴，算崩溃；最后一条消息先于退出交出', async () => {
  const { msgs, exit } = await run(`process.stdout.write('{"bye":1}\\n'); console.error('boom-reason'); process.exit(3)`)
  expect(msgs).toEqual([{ bye: 1 }])
  expect(exit.crashed).toBe(true)
  expect(exit.reason).toBe('fake 的 JSONL 进程断了（退出码 3）：boom-reason')
})

test('kill：不算崩溃，之后 send 返回 false', async () => {
  let crashed: boolean | null = null
  const p = new JsonlProcess({
    id: 'fake',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    onMessage: () => {},
    onExit: (e) => {
      crashed = e.crashed
    },
  })
  spawned.push(p)
  expect(p.send({ hi: 1 })).toBe(true)
  p.kill()
  expect(p.alive).toBe(false)
  expect(p.send({ hi: 2 })).toBe(false)
  await p.done
  expect(crashed).toBe(false)
  expect(p.describeExit()).toMatch(/信号 SIGTERM/)
})

test('send：消息按一行 JSON 写进 stdin（对端回显）', async () => {
  const msgs: unknown[] = []
  const p = new JsonlProcess({
    id: 'echo',
    command: process.execPath,
    args: ['-e', `process.stdin.on('data', (d) => process.stdout.write(d))`],
    onMessage: (m) => msgs.push(m),
  })
  spawned.push(p)
  p.send({ t: 'x\u2028y' })
  p.send({ t: 2 })
  for (let i = 0; i < 100 && msgs.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
  expect(msgs).toEqual([{ t: 'x\u2028y' }, { t: 2 }])
})

test('起不来（命令不存在）：说明是起不来，不是未处理的 error 事件', async () => {
  let reason = ''
  const p = new JsonlProcess({
    id: 'ghost',
    command: '/nonexistent/ramet-no-such-cli',
    onMessage: () => {},
    onExit: (e) => {
      reason = e.reason
    },
  })
  spawned.push(p)
  await p.done
  expect(p.alive).toBe(false)
  expect(reason).toMatch(/^ghost 起不来（\/nonexistent\/ramet-no-such-cli）：.*ENOENT/)
})

test('describeProcessExit：协议名进说明；没有退出事件就说管道关了', () => {
  expect(describeProcessExit('codex', 'JSONL', { code: null, signal: 'SIGKILL' }, '')).toBe('codex 的 JSONL 进程断了（信号 SIGKILL）')
  expect(describeProcessExit('codex', 'JSONL', null, 'a\n\nb')).toBe('codex 的 JSONL 进程断了（stdio 已关闭）：a | b')
})

test('CLI 版本：解析常见的 --version 输出；探测失败不报', async () => {
  expect(parseVersion('2.1.312 (Claude Code)\n')).toBe('2.1.312')
  expect(parseVersion('codex-cli 0.50.0')).toBe('0.50.0')
  expect(parseVersion('opencode v1.2.3-beta.4')).toBe('1.2.3-beta.4')
  expect(parseVersion('no version here')).toBeUndefined()
  expect(await probeVersion('/nonexistent/ramet-no-such-cli')).toBeUndefined()
  // node --version 输出 v22.x.y
  expect(await probeVersion(process.execPath)).toBe(process.versions.node)
})

test('CLI 版本：显式的 cli 优先；没写就探 command（驱动直接起的就是 CLI）', () => {
  expect(cliOf({ id: 'omp', label: 'omp', command: '/opt/wrap.sh', driver: 'omp', cli: '/bin/omp' })).toBe('/bin/omp')
  expect(cliOf({ id: 'claude', label: 'Claude', command: '/bin/claude', driver: 'claude' })).toBe('/bin/claude')
})
