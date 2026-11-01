// ---------- 按配置的驱动建适配器 ----------
// 中心本机与 connector 都只经这里建执行端；新增驱动只在这里多一个分支，不改 Manager / connector 流程。

import type { AgentConfig } from '../types.js'
import type { DriverBase } from './base.js'
import { ClaudeDriver } from './claude/driver.js'
import { CodexDriver } from './codex/driver.js'
import { RpcAgentDriver } from './pi/driver.js'

/** spawnCwd：进程共享的驱动（codex）起进程用的工作目录，connector 侧必须传本机默认目录 */
export function createAdapter(cfg: AgentConfig, spawnCwd?: string): DriverBase {
  const driver = cfg.driver
  switch (driver) {
    case 'claude':
      // 会话进程各自在会话的工作区里起，不用 spawnCwd
      return new ClaudeDriver(cfg)
    case 'codex':
      // 一个 app-server 进程承载全部线程；进程本身在 spawnCwd 里起（各线程另带自己的 cwd）
      return new CodexDriver(cfg, spawnCwd)
    case 'pi':
    case 'omp':
      // 每个会话一个 RPC 进程，各自在会话的工作区里起，不用 spawnCwd
      return new RpcAgentDriver(cfg, driver)
  }
}
