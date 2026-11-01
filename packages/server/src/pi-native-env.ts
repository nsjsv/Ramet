// pi-native.test.ts 的 agent 配置：必须先于 test-kit 求值（ESM 按 import 顺序求值），test-kit 起服前读 RAMET_TEST_AGENTS。
// 两个 agent：id 用 pi / omp（posture 表按真名判主人与 yolo），走原生驱动，可执行文件都是假 pi（FAKE_PI_DIALECT 切方言）。
// 假 omp 缺省「每一步都确认」，审批卡才会出现。中心本机与进程内 connector 读的是同一份（connector 的 localAgents 也读 RAMET_AGENTS），
// 会话记录目录（RAMET_SESSIONS_DIR）也是同一个进程环境。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_PI = fileURLToPath(new URL('./agents/fake/pi-rpc.mjs', import.meta.url))
/** 假 CLI 自己的家目录与 Ramet 存会话记录的目录：本文件独占 */
export const FAKE_PI_HOME = mkdtempSync(join(tmpdir(), 'ramet-pi-native-'))
process.env.RAMET_SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'ramet-pi-native-sessions-'))

process.env.RAMET_TEST_AGENTS = JSON.stringify([
  { id: 'pi', label: 'Pi', command: FAKE_PI, driver: 'pi', env: { FAKE_PI_HOME } },
  { id: 'omp', label: 'omp', command: FAKE_PI, driver: 'omp', env: { FAKE_PI_HOME, FAKE_PI_DIALECT: 'omp', FAKE_OMP_APPROVAL: 'always-ask' } },
])
