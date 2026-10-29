/* ---------- agent 注册表：自动检测本机已有 CLI ----------
 * 显式配置（RAMET_AGENTS / agents.json）永远优先；没配时报本机装了什么。 */

import { afterEach, expect, test } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('detectInstalledAgents：omp 直接报，claude 需 npx 且带 CLAUDE_CODE_EXECUTABLE，gemini 未装不报', () => {
  const path = fakeBin(['omp', 'npx', 'claude'])
  const found = detectInstalledAgents(path, 'linux')
  expect(found.map((a) => a.id)).toEqual(['omp', 'claude'])
  expect(found[0]).toMatchObject({ id: 'omp', command: join(path, 'omp'), args: ['acp'] })
  expect(found[1]!.env).toEqual({ CLAUDE_CODE_EXECUTABLE: join(path, 'claude') })
  expect(found[1]!.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])

  const onlyNpx = detectInstalledAgents(fakeBin(['npx']), 'linux', join(tmpdir(), 'no-claude-home'))
  expect(onlyNpx).toEqual([]) // 只有 npx：不猜，不报任何 agent
})

test('detectInstalledAgents：opencode 原生 acp；codex / pi 走包内入口；claude 可取版本目录里最高的那个', () => {
  const path = fakeBin(['node', 'opencode', 'codex', 'pi', 'bun'])
  const home = mkdtempSync(join(tmpdir(), 'ramet-claude-home-'))
  const versions = join(home, '.local', 'share', 'claude', 'versions')
  mkdirSync(versions, { recursive: true })
  writeFileSync(join(versions, '2.1.9'), 'x')
  chmodSync(join(versions, '2.1.9'), 0o755)
  writeFileSync(join(versions, '2.1.47'), 'x')
  chmodSync(join(versions, '2.1.47'), 0o755)

  const found = detectInstalledAgents(path, 'linux', home)
  expect(found.map((a) => a.id)).toEqual(['claude', 'codex', 'opencode', 'pi'])
  expect(found[0]!.env).toEqual({ CLAUDE_CODE_EXECUTABLE: join(versions, '2.1.47') })
  expect(found[1]!.env).toMatchObject({ CODEX_PATH: join(path, 'codex'), NO_BROWSER: '1' })
  expect(found[1]!.args?.[0]).toMatch(/codex-acp\/dist\/index\.js$/)
  expect(found[2]).toMatchObject({ command: join(path, 'opencode'), args: ['acp'] })
  expect(found[3]).toMatchObject({ command: join(path, 'bun') })
  expect(found[3]!.args?.[0]).toMatch(/pi-acp\/dist\/index\.mjs$/)
  expect(detectInstalledAgents(fakeBin(['node', 'pi']), 'linux', home).map((a) => a.id)).not.toContain('pi')
})

test('detectInstalledAgents：claude 有 node 时直跑包内适配器（不经 npx）；claude 无 node/npx 不报', () => {
  const path = fakeBin(['node', 'claude'])
  const [claude] = detectInstalledAgents(path, 'linux')
  expect(claude).toMatchObject({ id: 'claude', command: join(path, 'node') })
  // 包内解析出的入口是仓库 node_modules 里的真实文件（适配器是 server 的依赖）
  const entry = claude?.args?.[0] ?? ''
  expect(entry.endsWith('@agentclientprotocol/claude-agent-acp/dist/index.js')).toBe(true)
  expect(existsSync(entry)).toBe(true)

  expect(detectInstalledAgents(fakeBin(['claude']), 'linux')).toEqual([]) // 没有能起适配器的 node/npx
})

test('loadAgents：RAMET_AGENTS > agents.json > 自动检测', () => {
  const dir = fakeBin(['omp'])
  const cwd = mkdtempSync(join(tmpdir(), 'ramet-cwd-'))
  mkdirSync(join(cwd, 'sub'))

  process.env.PATH = dir
  process.env.RAMET_AGENTS = JSON.stringify([{ id: 'custom', label: 'Custom', command: 'echo' }])
  expect(loadAgents(cwd)).toMatchObject({ source: 'env', agents: [{ id: 'custom' }] })

  delete process.env.RAMET_AGENTS
  writeFileSync(join(cwd, 'agents.json'), JSON.stringify([{ id: 'fromfile', command: 'echo' }]))
  expect(loadAgents(cwd)).toMatchObject({ source: 'file', agents: [{ id: 'fromfile' }] })

  expect(loadAgents(mkdtempSync(join(tmpdir(), 'ramet-empty-')))).toMatchObject({
    source: 'auto',
    agents: [{ id: 'omp' }],
  })

  process.env.PATH = mkdtempSync(join(tmpdir(), 'ramet-empty-bin-'))
  expect(loadAgents(mkdtempSync(join(tmpdir(), 'ramet-empty-')))).toEqual({ agents: [], source: 'none' })
})
