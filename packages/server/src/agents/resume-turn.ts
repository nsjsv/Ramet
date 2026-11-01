// ---------- 续跑（runResume）：失败 / 停止的最后一块回复，从断点接着干 ----------
// 不加用户消息、不进文档：发给 agent 的只是一句后台续跑说明（agent 只能靠 prompt 动起来；对模型来说等于「从最后完好的
// 状态接着跑」再多一句话）。三件事和普通一轮不同：
//   - 会话：原生优先，用跑这块回复的那个会话（过程档案记着 sessionId / cwd；老档案没有时，会话记录正好停在这块也算）。
//     本进程加载着就直接用，没有就 load；会话不是自己的（会话不跨人复用）、load 不上 → 新建会话，把回复之前的文档
//     照全文重放的格式发一遍，再附上失败那次的过程摘要与续跑说明
//   - 回复块：同一块，只把 stats 改回运行中（正文、run 属性留着），收尾照常 finalize 写回
//   - 过程：RunRecord 接上旧档案（RunRecord.resumeFrom），中断时写到一半的正文在续跑后第一段正文到来时收成一条说明；
//     收尾不新建过程页，同一页接着记（run-finalize.ts 的 extend）
// 会话建好之后的几步（配置、镜像、授权、绑定行、发送）与 runTurn 同一份（turn-steps.ts）。
import { loadDocFromDb } from '../collab.js'
import { lastUserMessageImages, resumeTarget, serializeDoc, type ResumeTarget } from './doc.js'
import { NoUserMessageError, NotResumableError, ReplyNotFoundError, type ManagerHost, type ResolvedAgent } from './manager-types.js'
import { resolvePromptEnv, withMemory } from './prompt-env.js'
import { closeRun, openRecord, projectAgentEvent } from './remote-run.js'
import { loadRunArchive } from './runs.js'
import type { RunState } from './run-state.js'
import { restoreMsgBefore } from './session-config.js'
import { planCarry } from './session-move.js'
import { loadOwnSession, loadToolProfile, persistTurnSession } from './session-store.js'
import { toolOf } from '@ramet/shared/reply-stats'
import { openReply } from './turn.js'
import { bindRun, errText, readySession, sendPrompt, settleRun, useSession, withImages } from './turn-steps.js'
import type { PromptBlock, TurnUsage } from './types.js'

/** 续跑说明的前缀：agent 据此知道这不是用户的新消息（测试的假 agent 也按它认） */
export const RESUME_TAG = '[Ramet 续跑]'

/** 发给 agent 的续跑说明。失败的带上原因（告诉它断在哪），停止的说明是用户自己停的 */
export function resumeNote(outcome: 'error' | 'cancelled', reason?: string): string {
  if (outcome === 'cancelled') {
    return `${RESUME_TAG} 用户刚才手动停止了这一轮。请从停下的地方接着完成上面的任务；已经完成的步骤不要重做。`
  }
  return (
    `${RESUME_TAG} 上一次执行中途断开了（${reason || '原因不明'}）。请从中断的地方接着完成上面的任务：` +
    '已经完成的步骤不要重做；中断时正在进行的那一步，先确认它是否已经生效，再决定要不要重做。'
  )
}

function targetOrThrow(target: ResumeTarget): Extract<ResumeTarget, { ok: true }> {
  if (target.ok) return target
  if (target.reason === 'no-reply') throw new ReplyNotFoundError()
  if (target.reason === 'no-message') throw new NoUserMessageError()
  throw new NotResumableError(target.reason)
}

export async function runResume(
  host: ManagerHost,
  pageId: string,
  agent: ResolvedAgent,
  cwd: string,
  user: { id: string; role: string },
  cookieHeader: string | null,
  run: RunState,
  replyId: string,
): Promise<void> {
  const entry = host.ensureAdapter(agent)
  const docName = `page:${pageId}`
  const fragment = (host.getLiveDoc(docName) ?? (await loadDocFromDb(host.pool, docName))).getXmlFragment('prosemirror')
  // 解析到开跑之间文档可能变了：再判一次（之后读档案、拼提示词环境还要 await，读完再判一次、同步算完提示词）
  const first = targetOrThrow(resumeTarget(fragment, replyId))
  const [archive, profile, own] = await Promise.all([
    loadRunArchive(host.pool, first.run, user),
    loadToolProfile(host.pool, pageId),
    loadOwnSession(host.pool, pageId, agent.id, user.id),
  ])
  const env = await resolvePromptEnv(host.pool, user, fragment, pageId, profile, (name) => host.getLiveDoc(name))
  const target = targetOrThrow(resumeTarget(fragment, replyId))
  // 只接这块回复自己的档案（agent 也对得上）；读不到（过程页被删了 / 没有过程）就不接，收尾按普通一轮新建过程页
  // 原机器不在线时续跑换到了同一工具的另一台（reply-target.ts）：档案照样接（同一个工具），会话从中心下发过去
  const base = archive && archive.record.replyId === replyId && toolOf(archive.record.agent) === toolOf(agent.id) ? archive : null
  const note = resumeNote(target.outcome, base?.record.error)
  // 原生优先：跑这块回复的那个会话。档案里的会话只给发起人自己（过程页 owner 就是发起人）；
  // 没有档案时看会话记录：它看到的正好是这块回复，就是跑这块的那个会话（loadOwnSession 已只给本人）
  const prior =
    base?.record.sessionId && base.ownerId === user.id
      ? { sessionId: base.record.sessionId, cwd: base.record.cwd ?? cwd }
      : own?.seen === replyId
        ? { sessionId: own.sessionId, cwd: own.cwd }
        : null
  // 跑这块回复的是另一台机器（同一工具）：把那个会话从中心下发到这台（session-move.ts），目录用这台的
  const carry =
    base?.record.sessionId && base.ownerId === user.id && base.record.agent !== agent.id
      ? await planCarry(host, pageId, agent, user, cwd, { agentId: base.record.agent, sessionId: base.record.sessionId, seen: replyId })
      : null
  const runCwd = carry ? cwd : (prior?.cwd ?? cwd)
  // 兜底（新会话）的提示词：回复之前的文档（全文重放的格式，记忆在前）+ 失败那次的过程摘要 + 续跑说明；带上那条用户消息的图
  const process = env.process(target.el)
  const replay = [
    withMemory(env.memory, serializeDoc(fragment, target.index, env)),
    process ? `你上次对这条消息的执行中断了，中断前的${process.join('\n')}` : '',
    note,
  ]
    .filter(Boolean)
    .join('\n\n')
  const images = lastUserMessageImages(fragment, target.index)

  // 计时接着中断前的用时走；必须在建 RunRecord 与写远端绑定行之前定下（认领回来的回合按绑定行的 started_at 接）
  run.startedAt = Date.now() - (base?.record.ms ?? 0)
  const { bot, writer, revoke } = await openReply(host, pageId, agent, user, cookieHeader, replyId, true)
  const record = openRecord(run, writer.id, (ev) => host.broadcast(pageId, ev), base?.record)
  run.record = record
  // 建好先发一次快照：前端立刻看到中断前的步骤
  host.broadcast(pageId, record.snapshot(agent.id))
  let sessionId = ''
  let off: () => void = () => {}
  let usage: TurnUsage | undefined
  let agentFinished = false
  let prompted = false
  try {
    const tools = host.pageReadTools(entry, user, agent, pageId, profile)
    const carried = carry ? await carry.run(record) : true
    const opened = await useSession(entry, carried ? (prior?.sessionId ?? null) : null, runCwd, tools)
    carry?.settle(opened.fresh)
    sessionId = opened.sessionId
    await readySession(host, pageId, agent, entry, sessionId, opened.configOptions, user, run)
    off = entry.adapter.on((ev) => projectAgentEvent(run, record, ev, undefined, sessionId))
    const row = { pageId, replyId: writer.id, sessionId, agentId: agent.id, userId: user.id, cwd: runCwd, ...(base ? { baseRun: base.id } : {}) }
    if (!(await bindRun(host, run, row))) return
    const blocks: PromptBlock[] = opened.fresh
      ? await withImages(host.pool, [{ type: 'text', text: replay }], images)
      : [{ type: 'text', text: note }]
    // 发出去之前记下会话看到这块回复（兜底新建的会话也记成这一页这个 agent 的会话）：下一轮接着它
    await persistTurnSession(host.pool, pageId, agent.id, sessionId, runCwd, writer.id, user.id, profile)
    prompted = true
    const res = await sendPrompt(entry, sessionId, blocks, run)
    agentFinished = true
    usage = res.usage
    settleRun(run, res)
  } catch (err) {
    run.error = errText(err)
    throw err
  } finally {
    off()
    await closeRun({
      pool: host.pool,
      run,
      record,
      writer,
      bot,
      agentId: agent.id,
      ownerId: user.id,
      usage,
      park: run.hold && run.bound && prompted && !agentFinished,
      restore: () => restoreMsgBefore(host.adapterOf(agent.id, agent.pass), sessionId, run.msgBefore),
      notifyPagesChanged: host.notifyPagesChanged,
      ...(base ? { extend: { runPageId: base.id, user, write: host.writeDoc } } : {}),
    })
    await revoke?.()
  }
}
