/* ---------- agent 注册表：自动检测本机已有 CLI ----------
 * 显式配置（RAMET_AGENTS / agents.json）永远优先；没配时报本机装了什么。 */

import { afterEach, expect, test } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_MIN_VERSION, CODEX_MIN_VERSION, cliUnavailable, compareVersions, OMP_MIN_VERSION, PI_MIN_VERSION, unavailableAgents } from './drivers/cli-version.js'
import { detectInstalledAgents, findBinary, loadAgents } from './registry.js'

const savedPath = process.env.PATH
const savedAgents = process.env.RAMET_AGENTS

afterEach(() => {
  process.env.PATH = savedPath
  if (savedAgents === undefined) delete process.env.RAMET_AGENTS
  else process.env.RAMET_AGENTS = savedAgents
})

/** 造一个假 PATH：按名字建可执行文件（内容无所谓，只看存在与可执行位） */
function fakeBin(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ramet-bin-'))
  for (const name of names) {
    const file = join(dir, name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  return dir
}

test('findBinary：命中 PATH 上的可执行文件；不可执行位不算', () => {
  const dir = fakeBin(['omp'])
  writeFileSync(join(dir, 'gemini'), 'x') // 无执行位
  expect(findBinary('omp', dir, 'linux')).toBe(join(dir, 'omp'))
  expect(findBinary('gemini', dir, 'linux')).toBeNull()
  expect(findBinary('nope', dir, 'linux')).toBeNull()
})

test('detectInstalledAgents：omp、claude 走原生驱动（command 就是本机的 CLI），gemini 未装不报', () => {
  const path = fakeBin(['omp', 'npx', 'claude'])
  const found = detectInstalledAgents(path, 'linux')
  expect(found.map((a) => a.id)).toEqual(['omp', 'claude'])
  expect(found[0]).toEqual({ id: 'omp', label: 'omp', command: join(path, 'omp'), driver: 'omp' })
  expect(found[1]).toEqual({ id: 'claude', label: 'Claude', command: join(path, 'claude'), driver: 'claude' })

  const onlyNpx = detectInstalledAgents(fakeBin(['npx']), 'linux', join(tmpdir(), 'no-claude-home'))
  expect(onlyNpx).toEqual([]) // 只有 npx：不猜，不报任何 agent
})

test('detectInstalledAgents：只检测 claude / codex / pi / omp（opencode、gemini 不报）；claude 可取版本目录里最高的那个', () => {
  const path = fakeBin(['node', 'npx', 'opencode', 'gemini', 'codex', 'pi', 'bun'])
  const home = mkdtempSync(join(tmpdir(), 'ramet-claude-home-'))
  const versions = join(home, '.local', 'share', 'claude', 'versions')
  mkdirSync(versions, { recursive: true })
  writeFileSync(join(versions, '2.1.9'), 'x')
  chmodSync(join(versions, '2.1.9'), 0o755)
  writeFileSync(join(versions, '2.1.47'), 'x')
  chmodSync(join(versions, '2.1.47'), 0o755)

  const found = detectInstalledAgents(path, 'linux', home)
  expect(found.map((a) => a.id)).toEqual(['claude', 'codex', 'pi'])
  expect(found[0]).toMatchObject({ id: 'claude', driver: 'claude', command: join(versions, '2.1.47') })
  expect(found[1]).toEqual({ id: 'codex', label: 'Codex', command: join(path, 'codex'), driver: 'codex' })
  expect(found[2]).toEqual({ id: 'pi', label: 'Pi', command: join(path, 'pi'), driver: 'pi' })
  // 原生驱动直接起 pi：不要 bun
  const onlyPi = fakeBin(['pi'])
  expect(detectInstalledAgents(onlyPi, 'linux', home).filter((a) => a.id !== 'claude')).toEqual([{ id: 'pi', label: 'Pi', command: join(onlyPi, 'pi'), driver: 'pi' }])
})

test('detectInstalledAgents：claude / codex 只要本机有这个 CLI 就报（不要 node / npx）', () => {
  const path = fakeBin(['claude', 'codex'])
  const [claude, codex] = detectInstalledAgents(path, 'linux', join(tmpdir(), 'no-claude-home'))
  expect(claude).toEqual({ id: 'claude', label: 'Claude', command: join(path, 'claude'), driver: 'claude' })
  expect(codex).toEqual({ id: 'codex', label: 'Codex', command: join(path, 'codex'), driver: 'codex' })
  expect(detectInstalledAgents(fakeBin(['node']), 'linux', join(tmpdir(), 'no-claude-home'))).toEqual([])
})

test('CLI 版本门槛：原生 claude / codex / pi / omp 低于最低版本 → 不可用原因；版本取不到不拦', () => {
  expect(compareVersions('2.1.9', '2.1.47')).toBeLessThan(0)
  expect(compareVersions('2.1.312', CLAUDE_MIN_VERSION)).toBeGreaterThan(0)
  expect(compareVersions('2.1.246-beta.1', '2.1.246')).toBe(0)
  expect(cliUnavailable('claude', '2.1.200')).toMatch(/2\.1\.200.*太旧.*2\.1\.246/)
  expect(cliUnavailable('claude', CLAUDE_MIN_VERSION)).toBeUndefined()
  expect(cliUnavailable('claude', undefined)).toBeUndefined()
  expect(cliUnavailable(undefined, '0.0.1')).toBeUndefined()
  expect(cliUnavailable('codex', '0.158.9')).toMatch(/0\.158\.9.*太旧.*0\.159\.0/)
  expect(cliUnavailable('codex', CODEX_MIN_VERSION)).toBeUndefined()
  expect(cliUnavailable('codex', '0.159.3')).toBeUndefined()
  expect(cliUnavailable('pi', '1.0.9')).toMatch(/1\.0\.9.*太旧.*1\.1\.0/)
  expect(cliUnavailable('pi', PI_MIN_VERSION)).toBeUndefined()
  expect(cliUnavailable('omp', '18.4.2')).toMatch(/18\.4\.2.*太旧.*18\.5\.0/)
  expect(cliUnavailable('omp', OMP_MIN_VERSION)).toBeUndefined()
  const configs = [
    { id: 'claude', label: 'Claude', command: 'claude', driver: 'claude' as const },
    { id: 'codex', label: 'Codex', command: 'codex', driver: 'codex' as const },
    { id: 'pi', label: 'Pi', command: 'pi', driver: 'pi' as const },
    { id: 'omp', label: 'omp', command: 'omp', driver: 'omp' as const },
  ]
  const versions = new Map([['claude', '1.0.0'], ['codex', '0.1.0'], ['pi', '0.75.5'], ['omp', '18.14.1']])
  const down = unavailableAgents(configs, versions)
  expect([...down.keys()]).toEqual(['claude', 'codex', 'pi'])
})

test('loadAgents：RAMET_AGENTS > agents.json > 自动检测', () => {
  const dir = fakeBin(['omp'])
  const cwd = mkdtempSync(join(tmpdir(), 'ramet-cwd-'))
  mkdirSync(join(cwd, 'sub'))

  process.env.PATH = dir
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'custom', label: 'Custom', command: 'echo', driver: 'codex' }])
  expect(loadAgents(cwd)).toMatchObject({ source: 'env', agents: [{ id: 'custom' }] })

  delete process.env.RAMET_AGENTS
  writeFileSync(join(cwd, 'agents.json'), JSON.stringify([{ id: 'fromfile', command: 'echo', driver: 'pi' }]))
  expect(loadAgents(cwd)).toMatchObject({ source: 'file', agents: [{ id: 'fromfile' }] })

  expect(loadAgents(mkdtempSync(join(tmpdir(), 'ramet-empty-')))).toMatchObject({
    source: 'auto',
    agents: [{ id: 'omp' }],
  })

  process.env.PATH = mkdtempSync(join(tmpdir(), 'ramet-empty-bin-'))
  expect(loadAgents(mkdtempSync(join(tmpdir(), 'ramet-empty-')))).toEqual({ agents: [], source: 'none' })
})

test('显式配置：每项必须写四家之一的 driver；没写 / 写 acp / 写错都当场报错并列出四家，agents.json 写错不落回自动检测', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ramet-cwd-'))
  const four = /driver 必须是 claude \/ codex \/ pi \/ omp 之一/
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'old', command: 'omp', args: ['acp'] }])
  expect(() => loadAgents(cwd)).toThrow(four)
  expect(() => loadAgents(cwd)).toThrow(/agent old 没写 driver/)
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'x', command: 'omp', driver: 'acp' }])
  expect(() => loadAgents(cwd)).toThrow(four)
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'x', command: 'x', driver: 'codex-native' }])
  expect(() => loadAgents(cwd)).toThrow(four)

  delete process.env.RAMET_AGENTS
  process.env.PATH = fakeBin(['omp'])
  writeFileSync(join(cwd, 'agents.json'), JSON.stringify([{ id: 'fromfile', command: 'echo' }]))
  expect(() => loadAgents(cwd)).toThrow(/agents\.json.*driver 必须是/)
})

test('显式配置：ramet: 开头的 id 留给中心自己的 agent（Genet ramet:assistant），配置里用了当场报错', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ramet-cwd-'))
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'ramet:assistant', command: 'claude', driver: 'claude' }])
  expect(() => loadAgents(cwd)).toThrow(/ramet: 开头的 id 留给 Ramet 自己/)
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'my-ramet:claude', command: 'claude', driver: 'claude' }])
  expect(loadAgents(cwd).agents.map((a) => a.id)).toEqual(['my-ramet:claude'])
  delete process.env.RAMET_AGENTS
})
