// codex-native.test.ts 的 agent 配置：必须先于 test-kit 求值（ESM 按 import 顺序求值），test-kit 起服前读 RAMET_TEST_AGENTS。
// 只有一个 agent：id 用 codex（posture 表按真名判主人与「完全访问」），走原生驱动，可执行文件是假 codex。
// 中心本机与进程内 connector 读的是同一份（connector 的 localAgents 也读 RAMET_AGENTS）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_CODEX = fileURLToPath(new URL('./agents/fake/codex.mjs', import.meta.url))
/** 假 codex 的会话记录目录（resume 读它）：本文件独占 */
export const FAKE_CODEX_HOME = mkdtempSync(join(tmpdir(), 'ramet-codex-native-'))

process.env.RAMET_TEST_AGENTS = JSON.stringify([
  { id: 'codex', label: 'Codex', command: FAKE_CODEX, driver: 'codex', env: { FAKE_CODEX_HOME } },
])
