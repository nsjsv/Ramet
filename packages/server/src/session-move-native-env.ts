// session-move-native.test.ts 的 agent 配置：必须先于 test-kit 求值（ESM 按 import 顺序求值），test-kit 起服前读 RAMET_TEST_AGENTS。
// 中心本机的 agent 用不到（用例只用两台子进程 connector），但目录里要有东西：四家假 CLI 各一项，家目录本文件独占。
// 两台 connector 各自的 agent 配置与家目录由用例在起子进程时给（machineAgents），模拟两台真正分开的机器。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE_CLAUDE = fileURLToPath(new URL('./agents/fake/claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./agents/fake/codex.mjs', import.meta.url))
const FAKE_PI = fileURLToPath(new URL('./agents/fake/pi-rpc.mjs', import.meta.url))

/** 一台机器上的四家原生驱动。家目录用各 CLI 自己认的变量（CLAUDE_CONFIG_DIR / CODEX_HOME），会话端口与假 CLI 看的是同一个位置 */
export function machineAgents(home: string): unknown[] {
  return [
    { id: 'claude', label: 'Claude', command: FAKE_CLAUDE, driver: 'claude', env: { CLAUDE_CONFIG_DIR: join(home, 'claude') } },
    { id: 'codex', label: 'Codex', command: FAKE_CODEX, driver: 'codex', env: { CODEX_HOME: join(home, 'codex') } },
    { id: 'pi', label: 'Pi', command: FAKE_PI, driver: 'pi', env: { FAKE_PI_HOME: join(home, 'pi') } },
    { id: 'omp', label: 'omp', command: FAKE_PI, driver: 'omp', env: { FAKE_PI_HOME: join(home, 'pi'), FAKE_PI_DIALECT: 'omp' } },
  ]
}

process.env.RAMET_TEST_AGENTS = JSON.stringify(machineAgents(mkdtempSync(join(tmpdir(), 'ramet-move-center-'))))
