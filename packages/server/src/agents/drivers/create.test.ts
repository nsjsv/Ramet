/* ---------- 驱动分派：配置里的 driver、自动检测的标记、createAdapter（不起进程、不碰库）---------- */
import { afterEach, expect, test } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectInstalledAgents, loadAgents } from '../registry.js'
import { DriverBase } from './base.js'
import { ClaudeDriver } from './claude/driver.js'
import { CodexDriver } from './codex/driver.js'
import { createAdapter } from './create.js'
import { RpcAgentDriver } from './pi/driver.js'

const savedAgents = process.env.RAMET_AGENTS
afterEach(() => {
  if (savedAgents === undefined) delete process.env.RAMET_AGENTS
  else process.env.RAMET_AGENTS = savedAgents
})

const emptyCwd = (): string => mkdtempSync(join(tmpdir(), 'ramet-cwd-'))

test('显式配置：driver 原样带上；cli 可选', () => {
  process.env.RAMET_AGENTS = JSON.stringify([
    { id: 'omp', command: 'omp', driver: 'omp', cli: '/bin/omp' },
    { id: 'claude', command: '/bin/claude', driver: 'claude' },
  ])
  const { agents } = loadAgents(emptyCwd())
  expect(agents[0]).toMatchObject({ driver: 'omp', cli: '/bin/omp' })
  expect(agents[1]).toMatchObject({ driver: 'claude', command: '/bin/claude' })
  expect(agents[1]!.cli).toBeUndefined()
})

test('自动检测：四家都标原生驱动，command 就是 CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ramet-bin-'))
  for (const name of ['omp', 'opencode', 'npx', 'claude', 'codex', 'pi']) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name), 0o755)
  }
  const found = detectInstalledAgents(dir, 'linux', emptyCwd())
  expect(found.map((a) => a.id).sort()).toEqual(['claude', 'codex', 'omp', 'pi'])
  for (const a of found) expect(a).toMatchObject({ driver: a.id, command: join(dir, a.id) })
})

test('createAdapter：claude / codex / pi / omp 各是自己的原生驱动（刚建出来都是 pristine，不起进程）', () => {
  const claude = createAdapter({ id: 'claude', label: 'Claude', command: 'claude', driver: 'claude' })
  expect(claude).toBeInstanceOf(ClaudeDriver)
  expect(claude).toBeInstanceOf(DriverBase)
  expect(claude.busy).toBe(false)
  expect(claude.pristine).toBe(true)
  expect(claude.alive).toBe(false)
  const codex = createAdapter({ id: 'codex', label: 'Codex', command: 'codex', driver: 'codex' })
  expect(codex).toBeInstanceOf(CodexDriver)
  expect(codex.pristine).toBe(true)
  expect(codex.alive).toBe(false)
  for (const driver of ['pi', 'omp'] as const) {
    const rpc = createAdapter({ id: driver, label: driver, command: driver, driver })
    expect(rpc).toBeInstanceOf(RpcAgentDriver)
    expect((rpc as RpcAgentDriver).dialect).toBe(driver)
    expect(rpc.pristine).toBe(true)
    expect(rpc.alive).toBe(false)
  }
})
