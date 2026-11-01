// resume.test.ts 的 agent 配置：必须先于 test-kit 求值（ESM 按 import 顺序求值），test-kit 起服前读 RAMET_TEST_AGENTS。
// fake 同缺省配置（假 codex）；noload 是会话加载不上的 agent（没加载着的线程一律 resume 不上），测续跑时降级为新建会话。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE_CODEX = fileURLToPath(new URL('./agents/fake/codex.mjs', import.meta.url))
const home = (): string => mkdtempSync(join(tmpdir(), 'ramet-resume-codex-'))

process.env.RAMET_TEST_AGENTS = JSON.stringify([
  { id: 'fake', label: 'Fake', driver: 'codex', command: FAKE_CODEX, env: { CODEX_HOME: home() } },
  { id: 'noload', label: 'NoLoad', driver: 'codex', command: FAKE_CODEX, env: { CODEX_HOME: home(), FAKE_LOAD_FAIL: '1' } },
])
