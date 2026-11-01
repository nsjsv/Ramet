/* ---------- 四家会话端口：列文件、下发位置、拒绝穿越 / 非法 name / 非法 id、下发后的收拾 ----------
 * 只碰临时目录（CLAUDE_CONFIG_DIR / CODEX_HOME / OMP_CODING_AGENT_DIR 经 cfg.env 给，RAMET_SESSIONS_DIR 经进程环境）。不连库。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { claudeSessionPort, projectDirName } from './claude/session-port.js'
import { codexSessionPort, ownRollout } from './codex/session-port.js'
import { ompSessionPort, piSessionPort } from './pi/session-port.js'
import { relSegments } from './session-port.js'

const root = mkdtempSync(join(tmpdir(), 'session-port-test-'))
process.env.RAMET_SESSIONS_DIR = join(root, 'ramet-sessions')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ID = '3f2b1c9e-0000-4000-8000-000000000001'
const BAD_IDS = ['', '../x', 'a/b', 'a\\b', '.', '..', 'x'.repeat(200), 'a b', 'a\0b']

function put(path: string, content: string | Buffer): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

const names = (files: Array<{ name: string }>) => files.map((f) => f.name).sort()

test('relSegments：只收 <前缀><相对路径>，拒绝空段 / . / .. / 反斜杠 / NUL / 绝对路径', () => {
  expect(relSegments('sub/a/b.jsonl', 'sub/')).toEqual(['a', 'b.jsonl'])
  for (const bad of ['sub/', 'sub//a', 'sub/./a', 'sub/../a', 'sub/a/..', 'sub/a\\b', 'sub/a\0', '/etc/passwd', 'other/a', 'sub/.ramet-import-x.tmp']) {
    expect(relSegments(bad, 'sub/')).toBeNull()
  }
  expect(relSegments(42, 'sub/')).toBeNull()
})

describe('claude', () => {
  const config = join(root, 'claude-config')
  const env = { CLAUDE_CONFIG_DIR: config }
  const port = claudeSessionPort(env)
  const projects = join(config, 'projects')

  test('项目目录名与 SDK 同一规则：非字母数字换成 -，超过 200 截断加哈希；CLAUDE_CODE_PROJECT_DIR_NAME 只在设了配置目录时生效', () => {
    expect(projectDirName('/home/u/my proj.x', undefined)).toBe('-home-u-my-proj-x')
    const long = '/' + 'a'.repeat(300)
    const name = projectDirName(long, undefined)
    expect(name.startsWith('-' + 'a'.repeat(199) + '-')).toBe(true)
    expect(name.length).toBeGreaterThan(200)
    expect(projectDirName(long, undefined)).toBe(name)
    expect(projectDirName('/x', { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: 'fixed' })).toBe('fixed')
    expect(projectDirName('/x', { CLAUDE_CODE_PROJECT_DIR_NAME: 'fixed' })).toBe('-x')
    expect(projectDirName('/x', { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '../up' })).toBe('-x')
  })

  test('list：主记录 + 同名子目录（子代理记录）；多个项目目录里都有时取最近写过的；没有 = 空', async () => {
    expect(await port.list(ID)).toEqual([])
    const old = put(join(projects, '-old', `${ID}.jsonl`), 'old\n')
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    put(join(projects, '-new', `${ID}.jsonl`), 'main\n')
    put(join(projects, '-new', ID, 'subagents', 'agent-1.jsonl'), 'sub\n')
    put(join(projects, '-new', 'other-session.jsonl'), 'x\n')
    const files = await port.list(ID)
    expect(names(files)).toEqual(['main.jsonl', 'sub/subagents/agent-1.jsonl'])
    expect(files.find((f) => f.name === 'main.jsonl')).toMatchObject({ size: 5, path: join(projects, '-new', `${ID}.jsonl`) })
    for (const bad of BAD_IDS) expect(await port.list(bad)).toEqual([])
  })

  test('target：按目标 cwd 的项目目录；不认的 name / 穿越 / 非法 id 返回 null', () => {
    const dir = join(projects, '-work-proj')
    expect(port.target(ID, '/work/proj', 'main.jsonl')).toBe(join(dir, `${ID}.jsonl`))
    expect(port.target(ID, '/work/proj', 'sub/subagents/agent-1.jsonl')).toBe(join(dir, ID, 'subagents', 'agent-1.jsonl'))
    for (const bad of ['../x.jsonl', 'sub/../../x', 'sub/', '/etc/passwd', 'main.json', 'sub/a\\b', 'blobs/x']) {
      expect(port.target(ID, '/work/proj', bad)).toBeNull()
    }
    for (const bad of BAD_IDS) expect(port.target(bad, '/work/proj', 'main.jsonl')).toBeNull()
  })

  test('afterImport：删掉其它项目目录里同 id 的记录与子目录，目标目录和别的会话不动', async () => {
    const keep = join(projects, projectDirName('/work/proj', env))
    put(join(keep, `${ID}.jsonl`), 'new\n')
    await port.afterImport!(ID, '/work/proj')
    expect(existsSync(join(projects, '-old', `${ID}.jsonl`))).toBe(false)
    expect(existsSync(join(projects, '-new', `${ID}.jsonl`))).toBe(false)
    expect(existsSync(join(projects, '-new', ID))).toBe(false)
    expect(existsSync(join(projects, '-new', 'other-session.jsonl'))).toBe(true)
    expect(readFileSync(join(keep, `${ID}.jsonl`), 'utf8')).toBe('new\n')
    expect(names(await port.list(ID))).toEqual(['main.jsonl'])
  })
})

describe('codex', () => {
  const home = join(root, 'codex-home')
  const port = codexSessionPort({ CODEX_HOME: home })

  test('list：codex 自己的日期目录里按 threadId 找；connector 自管目录里有就以它为准', async () => {
    expect(await port.list(ID)).toEqual([])
    const native = put(join(home, 'sessions', '2026', '10', '30', `rollout-2026-10-30T01-02-03-${ID}.jsonl`), 'native\n')
    put(join(home, 'sessions', '2026', '10', '30', 'rollout-2026-10-30T01-02-03-other.jsonl'), 'x\n')
    expect(await port.list(ID)).toEqual([{ name: 'main.jsonl', size: 7, path: native }])
    const own = put(ownRollout(ID), 'own copy\n')
    expect(own).toBe(join(process.env.RAMET_SESSIONS_DIR!, 'codex', `${ID}.jsonl`))
    expect(await port.list(ID)).toEqual([{ name: 'main.jsonl', size: 9, path: own }])
  })

  test('target：只认 main.jsonl，写到自管目录（与 cwd 无关）', () => {
    expect(port.target(ID, '/anywhere', 'main.jsonl')).toBe(ownRollout(ID))
    for (const bad of ['sub/a', '../main.jsonl', '2026/10/30/rollout-x.jsonl', '']) expect(port.target(ID, '/a', bad)).toBeNull()
    for (const bad of BAD_IDS) expect(port.target(bad, '/a', 'main.jsonl')).toBeNull()
    expect(port.afterImport).toBeUndefined()
  })
})

describe('pi', () => {
  const port = piSessionPort()
  const file = () => join(process.env.RAMET_SESSIONS_DIR!, 'pi', `${ID}.jsonl`)

  test('list / target：<会话根>/pi/<id>.jsonl，name = main.jsonl', async () => {
    expect(await port.list(ID)).toEqual([])
    put(file(), JSON.stringify({ type: 'session', version: 3, id: ID, cwd: '/machine-x/proj' }) + '\n{"type":"turn","turns":1}\n')
    expect(names(await port.list(ID))).toEqual(['main.jsonl'])
    expect(port.target(ID, '/y', 'main.jsonl')).toBe(file())
    for (const bad of ['dir/x', '../x', 'main.jsonl/..']) expect(port.target(ID, '/y', bad)).toBeNull()
    for (const bad of BAD_IDS) expect(port.target(bad, '/y', 'main.jsonl')).toBeNull()
  })

  test('afterImport：首行的 cwd 改成目标机器的工作目录，后面原样；已经对了就不动', async () => {
    await port.afterImport!(ID, '/machine-y/proj')
    const lines = readFileSync(file(), 'utf8').split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'session', version: 3, id: ID, cwd: '/machine-y/proj' })
    expect(lines.slice(1)).toEqual(['{"type":"turn","turns":1}', ''])
    const before = readFileSync(file(), 'utf8')
    await port.afterImport!(ID, '/machine-y/proj')
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })
})

describe('omp', () => {
  const agentDir = join(root, 'omp-agent')
  const port = ompSessionPort({ OMP_CODING_AGENT_DIR: agentDir })
  const dir = () => join(process.env.RAMET_SESSIONS_DIR!, 'omp', ID)
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const hashMissing = 'c'.repeat(64)

  test('list：整个会话目录（记录 + artifacts）+ 记录里引用到、本机 blob 库里有的 blob', async () => {
    expect(await port.list(ID)).toEqual([])
    put(join(dir(), '2026-10-30T00-00-00_x.jsonl'), JSON.stringify({ type: 'session', cwd: '/machine-x/p' }) + `\n{"img":"blob:sha256:${hashA}"}\n{"img":"blob:sha256:${hashMissing}"}\n`)
    put(join(dir(), 'artifacts', 'sub-1.jsonl'), JSON.stringify({ type: 'session', cwd: '/machine-x/p' }) + `\n{"img":"blob:sha256:${hashB}"}\n`)
    put(join(dir(), 'artifacts', 'out.txt'), `blob:sha256:${'d'.repeat(64)}`)
    put(join(agentDir, 'blobs', hashA), 'AAA')
    put(join(agentDir, 'blobs', hashB), 'BBB')
    put(join(agentDir, 'blobs', 'd'.repeat(64)), 'DDD')
    expect(names(await port.list(ID))).toEqual([
      `blobs/${hashA}`,
      `blobs/${hashB}`,
      'dir/2026-10-30T00-00-00_x.jsonl',
      'dir/artifacts/out.txt',
      'dir/artifacts/sub-1.jsonl',
    ])
  })

  test('只有 artifacts、顶层没有记录 = 本机没有这个会话', async () => {
    const other = '3f2b1c9e-0000-4000-8000-000000000002'
    put(join(process.env.RAMET_SESSIONS_DIR!, 'omp', other, 'artifacts', 'a.jsonl'), '{}\n')
    expect(await port.list(other)).toEqual([])
  })

  test('target / contentHash：dir/ 进会话目录，blobs/<64 位 hex> 进 blob 库，别的一律 null', () => {
    expect(port.target(ID, '/y', 'dir/artifacts/sub-1.jsonl')).toBe(join(dir(), 'artifacts', 'sub-1.jsonl'))
    expect(port.target(ID, '/y', `blobs/${hashA}`)).toBe(join(agentDir, 'blobs', hashA))
    expect(port.contentHash!(`blobs/${hashA}`)).toBe(hashA)
    expect(port.contentHash!('dir/x.jsonl')).toBeNull()
    for (const bad of ['dir/../x', 'dir/', 'blobs/xyz', `blobs/${hashA.toUpperCase()}`, `blobs/${hashA}/x`, 'blobs/../x', 'main.jsonl', '/abs']) {
      expect(port.target(ID, '/y', bad)).toBeNull()
    }
    for (const bad of BAD_IDS) expect(port.target(bad, '/y', 'dir/a.jsonl')).toBeNull()
  })

  test('afterImport：只改会话目录顶层记录的 cwd（artifacts 里的不动）', async () => {
    await port.afterImport!(ID, '/machine-y/p')
    const top = readFileSync(join(dir(), '2026-10-30T00-00-00_x.jsonl'), 'utf8').split('\n')
    expect(JSON.parse(top[0]!)).toEqual({ type: 'session', cwd: '/machine-y/p' })
    expect(top[1]).toBe(`{"img":"blob:sha256:${hashA}"}`)
    const sub = readFileSync(join(dir(), 'artifacts', 'sub-1.jsonl'), 'utf8').split('\n')
    expect(JSON.parse(sub[0]!)).toEqual({ type: 'session', cwd: '/machine-x/p' })
  })
})
