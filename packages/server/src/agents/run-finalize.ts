// ---------- 一轮 run 的收尾（四个出口共用的唯一一段）----------
// 正常结束、用户停止、出错、关停，以及跨 server 重启认领回来的远端回合，都走这里。
// 认领模块（remote-run.ts）也要复用同一段，避免收尾逻辑出现第二份实现
// （两份必然漂移，占位块就会有的收尾有的不收）。
//
// 收尾做四件事，顺序有硬约束：
//   1. record.close()：冲刷合批、结束还开着的思考
//   2. 归档过程页（有思考 / 工具条目才归档；失败只记日志，不反噬本轮结果）
//   3. writer.finalize：把当前那段话换成块结构 + stats + 过程页 id + 计划清单（plan 属性）+ 带队的团队计划（team 属性），一个事务
//      （前端看到 stats 变终态时真内容必然已就位）
//   4. 正常结束时把收尾后的文档 hash 落库（下一轮据此判增量还是全文重放；口径 = 本轮开头解析的引用）
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { ReplyWriter } from './doc.js'
import { archiveRun } from './runs.js'
import { promptHash, summarizeProcess } from './prompt-env.js'
import type { RunRecord, RunOutcome } from './run-record.js'
import type { RunState } from './run-state.js'
import type { TurnUsage } from './types.js'
import type { ToolProfile } from './tool-profile.js'
import { drainBot } from './open-bot.js'

export type FinalizeResult = { outcome: RunOutcome; ms: number; runPageId: string | null }

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
  /** 正常结束时把收尾后的文档 hash 落库（SAVE_STATE 在调用方）；tools = 本轮开头定下的工具档位，会话记录一并记它 */
  persistFinalHash: (hash: string, tools: ToolProfile) => Promise<void>
}): Promise<FinalizeResult> {
  const ms = opts.record.close()
  const outcome = runOutcome(opts.run)
  let runPageId: string | null = null
  let processLines: string[] | undefined
  // 纯文本回合、甚至只有元数据（用量 / plan / 无最终答案）的回合，只要收到了东西就归档，
  // 不能因为没工具条目就谎称没有过程
  if (opts.record.hasEntries() || opts.record.hasOutput() || opts.record.hasInfo() || opts.record.hasPlan() || opts.record.hasTeam()) {
    try {
      const archived = await archiveRun(opts.pool, {
        parentId: opts.run.pageId,
        ownerId: opts.ownerId,
        record: opts.record.record({ agent: opts.agentId, parentId: opts.run.pageId }, outcome, ms, opts.usage),
      })
      runPageId = archived.id
      processLines = summarizeProcess(archived.id, archived.doc.getXmlFragment('prosemirror'))
      opts.notifyPagesChanged?.()
    } catch (err) {
      console.error(`[agent] 过程归档失败(${opts.run.pageId}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  opts.run.runPageId = runPageId
  opts.writer.finalize(opts.record.state.text, opts.record.stats(outcome, ms, opts.usage), runPageId, opts.record.state.plan, opts.record.state.team)
  if (opts.run.ended && opts.run.seen) {
    // 基线 = 本轮收尾后的视图（页首到本轮回复，含回复）：起始 hash 与收尾 hash 必须同一视图、同一口径。
    // 引用与各回复的过程摘要按本轮开头解析的那份渲染（agent 看到的就是它），新回复的过程摘要由刚归档的文档补进来。
    // 期间若有人在回复之前编辑，下次 hash 不匹配，自然走全文重放；回复之后追加的内容留给下一轮增量。
    // 认领回来的回合没有开头的解析（run.seen = null），不落收尾 hash：库里留的是开头那份，
    // 下一轮必然不匹配，全文重放（保守，不冒充同步）
    const finalText = opts.writer.viewText(opts.run.seen, processLines)
    await opts.persistFinalHash(promptHash(opts.run.seen.memory, finalText), opts.run.seen.tools)
  }
  // 收尾那一笔必须被服务端收下再断开（关停时紧接着就是 hocuspocus.destroy）
  await drainBot(opts.bot.provider)
  return { outcome, ms, runPageId }
}
