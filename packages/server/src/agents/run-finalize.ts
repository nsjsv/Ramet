// ---------- 一轮 run 的收尾（四个出口共用的唯一一段）----------
// 正常结束、用户停止、出错、关停，以及跨 server 重启认领回来的远端回合，都走这里。
// 认领模块（remote-run.ts）也要复用同一段，避免收尾逻辑出现第二份实现
// （两份必然漂移，占位块就会有的收尾有的不收）。
//
// 收尾做三件事，顺序有硬约束：
//   1. record.close()：冲刷合批、结束还开着的思考
//   2. 归档过程页（有思考 / 工具条目才归档；失败只记日志，不反噬本轮结果）
//   3. writer.finalize：把当前那段话换成块结构 + stats + 过程页 id + 计划清单（plan 属性）+ 带队的团队计划（team 属性），一个事务
//      （前端看到 stats 变终态时真内容必然已就位）
// 续跑（extend）不新建过程页：同一页接着记（runs.ts 的 extendRun），回复块的 run 属性不变。
// 会话记录（看到哪一块）不在这里写：提示词发出去之前就记下了（turn.ts），所以认领回来的回合、失败 / 停止的回合都不用补
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { DocWriter } from '../collab.js'
import type { ReplyWriter } from './doc.js'
import { archiveRun, extendRun } from './runs.js'
import type { RunRecord, RunOutcome } from './run-record.js'
import type { RunState } from './run-state.js'
import type { TurnUsage } from './types.js'
import { drainBot } from './open-bot.js'

export type FinalizeResult = { outcome: RunOutcome; ms: number; runPageId: string | null }

/** 续跑：接着记的过程页与写它的通道（user = 发起人，写入记给 agent） */
export type RunExtension = { runPageId: string; user: { id: string; role: string }; write: DocWriter | undefined }

/** outcome 的三出口判定：正常结束 / 用户停止 / 其余（出错、关停、使用授权被收回）都记 error */
export function runOutcome(run: RunState): RunOutcome {
  if (run.ended) return 'end'
  if (run.cancelled && !run.shutdown && !run.revoked) return 'cancelled'
  return 'error'
}

export async function finalizeRun(opts: {
  pool: Pool
  bot: { provider: HocuspocusProvider; doc: Y.Doc }
  writer: ReplyWriter
  record: RunRecord
  run: RunState
  agentId: string
  ownerId: string
  usage: TurnUsage | undefined
  notifyPagesChanged?: () => void
  extend?: RunExtension
}): Promise<FinalizeResult> {
  const ms = opts.record.close()
  const outcome = runOutcome(opts.run)
  const { run } = opts
  const error = outcome === 'error' ? (run.revoked ?? run.error ?? (run.shutdown ? '服务重启，本轮已中止' : null)) : null
  const meta = {
    agent: opts.agentId,
    parentId: run.pageId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.cwd ? { cwd: run.cwd } : {}),
    ...(error ? { error } : {}),
  }
  let runPageId: string | null = null
  if (opts.extend) {
    runPageId = opts.extend.runPageId
    try {
      if (!opts.extend.write) throw new Error('没有文档写入通道')
      const record = opts.record.record(meta, outcome, ms, opts.usage)
      await extendRun(opts.pool, opts.extend.write, { runPageId, user: opts.extend.user, record, from: opts.record.base })
    } catch (err) {
      console.error(`[agent] 续跑的过程接续失败(${runPageId}): ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (opts.record.hasEntries() || opts.record.hasOutput() || opts.record.hasInfo() || opts.record.hasPlan() || opts.record.hasTeam()) {
    // 纯文本回合、甚至只有元数据（用量 / plan / 无最终答案）的回合，只要收到了东西就归档，
    // 不能因为没工具条目就谎称没有过程
    try {
      const archived = await archiveRun(opts.pool, {
        parentId: run.pageId,
        ownerId: opts.ownerId,
        record: opts.record.record(meta, outcome, ms, opts.usage),
      })
      runPageId = archived.id
      opts.notifyPagesChanged?.()
    } catch (err) {
      console.error(`[agent] 过程归档失败(${opts.run.pageId}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  opts.run.runPageId = runPageId
  opts.writer.finalize(opts.record.state.text, opts.record.stats(outcome, ms, opts.usage), runPageId, opts.record.state.plan, opts.record.state.team)
  // 收尾那一笔必须被服务端收下再断开（关停时紧接着就是 hocuspocus.destroy）
  await drainBot(opts.bot.provider)
  return { outcome, ms, runPageId }
}
