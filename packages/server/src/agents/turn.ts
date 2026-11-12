// ---------- 一轮生成（runTurn）----------
// 需要 manager 状态的部分经 ManagerHost 拿，同 remote-run.ts 的 RemoteRunHost。
//   - 上下文拼装：同一个 agent 在同一页一直接着它自己的会话（上下文归 agent），会话记录记着它看到哪一块（SavedSession.seen），
//     这一轮只发那块之后新增的内容（带署名，catch-up.ts）+ 新消息；文档前面的改动、空间记忆变化都不让会话作废。
//     只在结构性原因下新建会话 + 全文重放：第一次进这页、换了工作区 / 工具档位 / 人、会话加载不上、重新生成、带队轮。
//     @ 引用页正文不展开，AI 用 read_page 自己读
//   - 回复流:机器人客户端(@hocuspocus/provider 连自身 ws)把 chunk 追加为 agent_reply 块
//   - 提示词发出去之前把会话记录的 seen 记成本轮的回复块：不论怎么收尾（结束 / 停止 / 出错 / 认领回来），下一轮都接着这个会话
//   - 视图：追加 = 整页；重新生成(redo)= 页首到目标回复之前（旧回答和它之后的东西都不给 agent 看）。
//     redo 一律新建会话全文重放:会话不能分叉,旧会话已经看过旧回答
//   - 轮次监听只投影 RunRecord；会话级状态（命令 / 配置 / 待批审批）归会话镜像，这里只在会话建好后 bind
//   - 带队（run.team 非空）的两种轮：计划轮 `/带队 <目标>`、执行轮（continue 带 team）。会话口径与普通对话不同，都新建会话、
//     不复用旧的、不写会话记录，组长的提示词末尾拼带队说明（team.ts 文件头有完整口径）；没有带队时下面的路径逐字节不变
import { extractTitle, insertSnapshot, loadDocFromDb } from '../collab.js'
import { NO_NAMES, deltaPrompt, resolveNames } from './catch-up.js'
import { toolOf } from '@ramet/shared/reply-stats'
import { ReplyWriter, lastUserMessage, lastUserMessageImages, lockedTool, redoTarget, serializeDoc } from './doc.js'
import { canLeadTeam, NO_TEAM_LEAD } from './assistant-agent.js'
import { SPACE_AI_NO_TEAM } from './space-ai.js'
import { resolvePromptEnv, withMemory } from './prompt-env.js'
import { ReplyNotFoundError, type ManagerHost, type ResolvedAgent } from './manager-types.js'
import { openBotAsUser, openBotDoc, type Bot } from './open-bot.js'
import { closeRun, openRecord, projectAgentEvent } from './remote-run.js'
import type { RunState } from './run-state.js'
import { restoreMsgBefore } from './session-config.js'
import { planCarry } from './session-move.js'
import { loadOwnSession, loadToolProfile, persistSession, persistTurnSession } from './session-store.js'
import { planGoalOf, planNote, startExecRound } from './team.js'
import { toolProfileOf } from './tool-profile.js'
import { bindRun, errText, readySession, sendPrompt, settleRun, useSession, withImages } from './turn-steps.js'
import type { TurnUsage } from './types.js'

/** 占位回复块。追加是往页尾插一块新的；重新生成是绑回目标块原地复位（块 id 不变，引用、收藏跟着新回答走）。
 *  复位是破坏性的，所以先存一张快照（actor = 发起人），保证旧回答在历史里，不依赖 5 分钟去重窗口或
 *  agent 写入的时机。快照失败则整轮失败，旧回答原样留着。续跑（keep）同样绑回目标块，但只把它改回运行中，正文留着 */
export async function openReply(
  host: ManagerHost,
  pageId: string,
  agent: ResolvedAgent,
  user: { id: string },
  cookieHeader: string | null,
  redo: string | undefined,
  keep = false,
): Promise<{ bot: Bot; writer: ReplyWriter; revoke?: () => Promise<void> }> {
  // 没有浏览器 cookie（排队派发）：以发起人的身份临时签一张只给这次写入用的会话，收尾时删掉（同认领期的做法）
  const asUser =
    cookieHeader === null
      ? await openBotAsUser({ pool: host.pool, pageId, wsPort: host.wsPort, botSecret: host.botSecret, userId: user.id, agentId: agent.id })
      : null
  const bot = asUser ?? (await openBotDoc({ pageId, wsPort: host.wsPort, botSecret: host.botSecret, cookieHeader: cookieHeader ?? '', agentId: agent.id }))
  const revoke = asUser?.revoke
  if (!redo) return { bot, writer: new ReplyWriter(bot.doc, agent.id), ...(revoke ? { revoke } : {}) }
  try {
    const writer = ReplyWriter.bind(bot.doc, redo)
    if (!writer) throw new ReplyNotFoundError()
    if (!(await insertSnapshot(host.pool, pageId, extractTitle(bot.doc), 'manual', bot.doc, user.id))) {
      throw new Error('页面不存在')
    }
    if (keep) writer.reopen()
    else writer.reset()
    return { bot, writer, ...(revoke ? { revoke } : {}) }
  } catch (err) {
    bot.provider.destroy()
    await revoke?.()
    throw err
  }
}

export async function runTurn(
  host: ManagerHost,
  pageId: string,
  agent: ResolvedAgent,
  cwd: string,
  user: { id: string; role: string },
  cookieHeader: string | null,
  /** 这条消息的会话配置项覆盖在 run.msgOpts（attrs.opts）：该轮生效、轮末还原；空就只用页面级 */
  run: RunState,
  /** 要原地重新生成的那块 agent_reply 的 id；缺省是往页尾追加 */
  redo?: string,
): Promise<void> {
  // let：执行轮的组员阶段可能很长，组长的适配器空闲期间可能被回收，组员跑完后要重新要一次
  let entry = host.ensureAdapter(agent)
  const docName = `page:${pageId}`
  const live = host.getLiveDoc(docName)
  const fragment = (live ?? (await loadDocFromDb(host.pool, docName))).getXmlFragment('prosemirror')
  // 工具档位（tool-profile.ts）：本轮按它交付工具、拼提示词环境；会话记录也记它（换档就不复用旧会话）。
  // 别人建的会话不复用：它的 MCP 进程拿着那个人的页面凭证（SavedSession.userId），换人就新建 + 全文重放
  // 换机器：这一页这个工具的会话上次在别的机器上跑，就从中心把它下发到这台再接着用（session-move.ts），记录照抄一份给这台
  const carry = redo || run.team ? null : await planCarry(host, pageId, agent, user, cwd)
  const [profile, own] = await Promise.all([
    loadToolProfile(host.pool, pageId),
    carry ? carry.saved : loadOwnSession(host.pool, pageId, agent.id, user.id),
  ])
  // 块引用的原块内容、各回复的过程摘要、补发内容的署名先读好（跨页、按发起人判权限，要 await）；之后视图边界与提示词同步算完，中途不再让出
  const [env, names] = await Promise.all([
    resolvePromptEnv(host.pool, user, fragment, pageId, profile, (name) => host.getLiveDoc(name), agent.space ? { space: agent.space.id } : undefined),
    !redo && own?.seen ? resolveNames(host.pool, fragment, host.agentNames, pageId) : NO_NAMES,
  ])
  // 这一轮的视图：追加 = 整页；重新生成 = 目标回复之前的全部内容（旧回答和它之后的东西都不给 agent 看）
  let viewEnd = fragment.length
  if (redo) {
    const target = redoTarget(fragment, redo)
    if (!target.ok) throw new ReplyNotFoundError()
    viewEnd = target.index
  }
  const docText = serializeDoc(fragment, viewEnd, env)
  // 全文重放：空间公共记忆在前、文档在后（记忆只在新建会话时带，老会话不因记忆变化重置）
  const replayText = withMemory(env.memory, docText)
  // 带队的计划轮:最后一条用户消息以 `/带队` 开头(重新生成也一样,视图里最后一条就是它)。执行轮由 continue 带 team 标出。
  // 只在完整档认：别的档没有带队要的工具，`/带队…` 原样当文字发给 agent（前端本来就不给这个入口）
  if (!run.team && profile === 'full') {
    const goal = planGoalOf(lastUserMessage(docText))
    if (goal !== null) run.team = { kind: 'plan', goal }
  }

  // redo 不复用任何会话（会话不能分叉，旧会话已经看过旧回答），带队轮也不复用：当作没有记录，走下面的新建 + 全文重放
  const saved = redo || run.team ? null : own
  // cwd、工具档位都一致才可能接着用（工具是建会话时交付的，换档只能换会话）
  const sameSetup = saved != null && saved.cwd === cwd && toolProfileOf(saved.tools) === profile
  // 准备会话（选 agent 时建的 / 新建了还没发出提示词，没喂过文档）：加载它 + 全文重放，而不是再建一个（否则每次进页面都留一个孤儿会话）
  const adopt = sameSetup && !saved.seen && !saved.lastSyncedHash
  // 接着用：只发它没见过的；老记录的 hash 对不上 = null，新建
  const delta = sameSetup && !adopt ? deltaPrompt(saved, { fragment, end: viewEnd, docText, env, names, pageId }) : null

  // 页面此前没有回复：这一轮的占位块就是第一块回复，它的工具从此锁定这一页（前端据此收起别的工具）
  const firstReply = !redo && !lockedTool(fragment)
  // 机器人客户端:连自身 ws。回复块先落一个占位,运行中的正文不进文档(归 RunRecord,经 SSE
  // 推给前端实时渲染),收尾时一次写入。占位一建好就发快照:前端据 replyId 立刻挂上状态条
  const { bot, writer, revoke } = await openReply(host, pageId, agent, user, cookieHeader, redo)
  const record = openRecord(run, writer.id, (ev) => host.broadcast(pageId, ev))
  run.record = record
  host.broadcast(pageId, record.snapshot(agent.id))
  if (firstReply) host.broadcast(pageId, { type: 'tool_lock', tool: toolOf(agent.id) })
  let sessionId = ''
  let off: () => void = () => {}
  let usage: TurnUsage | undefined
  // prompt 正常返回过才算 agent 自己收了尾。关停期间 promise 被拒绝不算，远端行要留着。
  // prompted：绑定行已经写了但 prompt 还没发出去时，关停仍要收掉占位块——agent 根本没开始跑。
  let agentFinished = false
  let prompted = false
  let endTeam: (() => void) | undefined
  try {
    // 这一轮是不是带队（计划轮 / 执行轮）到这里已经定了，组长能不能带队只在这里判：不能就在这块回复上报出来，不出计划、不跑组员
    if (run.team && !canLeadTeam(agent)) throw new Error(agent.space ? SPACE_AI_NO_TEAM : NO_TEAM_LEAD)
    // 带队:计划轮拼「出计划」说明;执行轮先由中心把组员按依赖跑完(此时还没有组长会话,适配器可能已被闲置回收,所以跑完再要一次),
    // 再把各组员的结果作为附录拼在提示词后面。组员阶段里本轮被停止 / 关停 → 直接收尾,不建组长会话
    let teamNote = ''
    if (run.team?.kind === 'exec') {
      const started = await startExecRound(host.team, run, record, user)
      endTeam = started.end
      if (run.cancelled || run.hold) return
      entry = host.ensureAdapter(agent)
      teamNote = started.exec.appendix()
    } else if (run.team?.kind === 'plan') {
      teamNote = planNote(await host.team.plans.candidates(user))
    }
    const tools = run.team
      ? host.teamTools(entry, user, agent, pageId, { kind: run.team.kind, runId: run.runId, ...(run.team.kind === 'exec' ? { planId: run.team.planId } : {}) })
      : host.pageReadTools(entry, user, agent, pageId, profile)
    // 接着用（增量 / adopt）：本进程没加载过就 load，load 不上（agent 侧已不存在）降级为新建 + 全文重放
    // 换机器的下发在回复块建好之后做（运行条上看得到进度）；下发失败就当没有记录，新建 + 全文重放
    // （带队的计划轮在 carry 判定之后才认出来，它不接任何会话，也就不搬）
    const move = run.team ? null : carry
    const carried = move ? await move.run(record) : true
    const opened = await useSession(entry, carried && saved && (delta !== null || adopt) ? saved.sessionId : null, cwd, tools)
    move?.settle(opened.fresh)
    sessionId = opened.sessionId
    const text = !opened.fresh && delta !== null ? delta : teamNote ? `${replayText}\n\n${teamNote}` : replayText
    // 带队的会话不写记录（下一轮普通对话接着用原来的会话，补发带队那几轮）；新建的先记成准备会话，发出提示词前再记看到哪一块
    if (opened.fresh && !run.team) await persistSession(host.pool, pageId, agent.id, sessionId, cwd, null, user.id, profile)
    await readySession(host, pageId, agent, entry, sessionId, opened.configOptions, user, run)
    off = entry.adapter.on((ev) => projectAgentEvent(run, record, ev, undefined, sessionId))
    // 会话准备期间就点了停止 / 服务要关了:不再发起 prompt。远端且还没写绑定行的，占位块照常收成终态
    if (!(await bindRun(host, run, { pageId, replyId: writer.id, sessionId, agentId: agent.id, userId: user.id, cwd }))) return
    const blocks = await withImages(host.pool, [{ type: 'text', text }], lastUserMessageImages(fragment, viewEnd))
    // 发出去之前记下会话看到哪一块（本轮的回复块）：不论这一轮怎么收尾，下一轮都只补发这块之后的内容、接着这个会话
    if (!run.team) await persistTurnSession(host.pool, pageId, agent.id, sessionId, cwd, writer.id, user.id, profile)
    prompted = true
    const res = await sendPrompt(entry, sessionId, blocks, run)
    agentFinished = true
    usage = res.usage
    settleRun(run, res)
  } catch (err) {
    // 失败原因随过程档案落库（续跑时告诉 agent 断在哪）；收尾在 finally，所以要在这里先记下
    run.error = errText(err)
    throw err
  } finally {
    // off() 必须走 finally，prompt 抛错时漏摘会让监听器在常驻适配器进程里越攒越多。
    // 收尾只有 closeRun 这一份（认领回来的回合也走它）。
    off()
    endTeam?.() // 带队:团队整体状态（done / cancelled / error）落进 team 原语，必须赶在 closeRun 写回复块之前
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
    })
    // 排队派发的一轮：机器人用的临时会话收尾后删掉
    await revoke?.()
  }
}
