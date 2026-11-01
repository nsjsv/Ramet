// claude-native.test.ts 的 agent 配置：必须先于 test-kit 求值（ESM 按 import 顺序求值），test-kit 起服前读 RAMET_TEST_AGENTS。
// 只有一个 agent：id 用 claude（posture 表按真名判主人与提权选项），走原生驱动，可执行文件是假 claude。
// 中心本机与进程内 connector 读的是同一份（connector 的 localAgents 也读 RAMET_AGENTS）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_CLAUDE = fileURLToPath(new URL('./agents/fake/claude.mjs', import.meta.url))
/** 假 claude 的会话记录目录（resume 读它）：本文件独占 */
export const FAKE_CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'ramet-claude-native-'))

process.env.RAMET_TEST_AGENTS = JSON.stringify([
  { id: 'claude', label: 'Claude', command: FAKE_CLAUDE, driver: 'claude', env: { FAKE_CLAUDE_HOME } },
])
