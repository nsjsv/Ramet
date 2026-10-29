// ---------- 一轮生成（runTurn）----------
// 需要 manager 状态的部分经 ManagerHost 拿，同 remote-run.ts 的 RemoteRunHost。
//   - 上下文拼装:序列化文档 → hash 比对 lastSyncedHash → 相等走 load+增量,不等走
//     new session 全文重放;@ 引用页正文不展开,AI 用 read_page 自己读
//   - 回复流:机器人客户端(@hocuspocus/provider 连自身 ws)把 chunk 追加为 agent_reply 块
//   - done 时更新 agent_session.sessions[agentId] = {sessionId, cwd, lastSyncedHash}
//   - 视图不变量:每一轮只看它自己的视图,起始 hash 与收尾 hash 都按同一视图算。
//     追加 = 页首到本轮回复(含);重新生成(redo)= 页首到目标回复之前,收尾 = 该视图 + 新回复。
//     redo 一律新建会话全文重放:ACP 会话不能分叉,旧会话已经看过旧回答
//   - 轮次监听只投影 RunRecord；会话级状态（命令 / 配置 / 待批审批）归会话镜像，这里只在会话建好后 bind
//   - 带队（run.team 非空）的两种轮：计划轮 `/带队 <目标>`、执行轮（continue 带 team）。会话口径与普通对话不同，都新建会话、
//     不复用旧的、不写会话记录 / 收尾 hash，组长的提示词末尾拼带队说明（team.ts 文件头有完整口径）；没有带队时下面的路径逐字节不变
import { extractTitle, insertSnapshot, loadDocFromDb } from '../collab.js'
import { ReplyWriter, lastUserMessage, lastUserMessageImages, redoTarget, serializeDoc, stripLastUserMessage } from './doc.js'
import { loadAiImage } from '../page-read.js'
import { promptHash, resolvePromptEnv, withMemory } from './prompt-env.js'
import { ReplyNotFoundError, type ManagerHost, type ResolvedAgent } from './manager-types.js'
import { openBotAsUser, openBotDoc, type Bot } from './open-bot.js'
import { authorize } from './posture.js'
import { closeRun, insertOpenRun, openRecord, projectAgentEvent, requestCancel } from './remote-run.js'
import type { RunState } from './run-state.js'
import { applyConfigs, applyMsgOpts, restoreMsgBefore } from './session-config.js'
import { loadOwnSession, loadToolProfile, persistSession } from './session-store.js'
import { planGoalOf, planNote, startExecRound } from './team.js'
import { toolProfileOf } from './tool-profile.js'
import type { ConfigOption, PromptBlock, TurnUsage } from './types.js'

/** 占位回复块。追加是往页尾插一块新的；重新生成是绑回目标块原地复位（块 id 不变，引用、收藏跟着新回答走）。
 *  复位是破坏性的，所以先存一张快照（actor = 发起人），保证旧回答在历史里，不依赖 5 分钟去重窗口或
 *  agent 写入的时机。快照失败则整轮失败，旧回答原样留着。 */
async function openReply(
  host: ManagerHost,
  pageId: string,
  agent: ResolvedAgent,
  user: { id: string },
  cookieHeader: string | null,
  redo: string | undefined,
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
    writer.reset()
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
  // 块引用的原块内容、各回复的过程摘要先读好（跨页、按发起人判权限，要 await）；之后视图边界与序列化同步算完，中途不再让出
  // 工具档位（tool-profile.ts）：本轮按它交付工具、拼提示词环境；会话记录也记它（换档就不复用旧会话）
  const profile = await loadToolProfile(host.pool, pageId)
  const env = await resolvePromptEnv(host.pool, user, fragment, pageId, profile, (name) => host.getLiveDoc(name))
  run.seen = env // 收尾基线 hash 用同一份（run-finalize.ts）
  // 这一轮的视图：追加 = 整页；重新生成 = 目标回复之前的全部内容（旧回答和它之后的东西都不给 agent 看）
  let viewEnd = fragment.length
  if (redo) {
    const target = redoTarget(fragment, redo)
    if (!target.ok) throw new ReplyNotFoundError()
    viewEnd = target.index
  }
  const docText = serializeDoc(fragment, viewEnd, env)
  // 基线 = 去掉本轮新用户消息后的视图:与 lastSyncedHash 相等即只追加了新输入。空间公共记忆（env.memory）也算进去：
  // 记忆变了，会话里的上下文就过期，hash 不等，全文重放并带上新记忆；没有记忆时 hash 与不带记忆的算法逐字节一致
  const hash = promptHash(env.memory, stripLastUserMessage(docText))
  const replayText = withMemory(env.memory, docText)
  // 带队的计划轮:最后一条用户消息以 `/带队` 开头(重新生成也一样,视图里最后一条就是它)。执行轮由 continue 带 team 标出。
  // 只在完整档认：别的档没有带队要的工具，`/带队…` 原样当文字发给 agent（前端本来就不给这个入口）
  if (!run.team && profile === 'full') {
    const goal = planGoalOf(lastUserMessage(docText))
    if (goal !== null) run.team = { kind: 'plan', goal }
  }

  // redo 不复用任何会话（ACP 会话不能分叉，旧会话已经看过旧回答）：当作没有记录，走下面的新建 + 全文重放
  // 别人建的会话不复用：它的 MCP 进程拿着那个人的页面凭证（SavedSession.userId），换人就新建 + 全文重放
  const saved = redo || run.team ? null : await loadOwnSession(host.pool, pageId, agent.id, user.id)
  // 已喂过文档（有 hash）且 cwd、工具档位都一致才算同一份文档，才可能走增量（工具是建会话时交付的，换档只能换会话）
  const sameSetup = saved != null && saved.cwd === cwd && toolProfileOf(saved.tools) === profile
  const synced = sameSetup && saved.lastSyncedHash !== null
  const sameDoc = synced && saved.lastSyncedHash === hash
  // 准备会话（选 agent 时建的、还没喂过文档）：加载它 + 全文重放，而不是再建一个（否则每次
  // 进页面都留一个孤儿会话）
  const adopt = sameSetup && saved.lastSyncedHash === null

  // 机器人客户端:连自身 ws。回复块先落一个占位,运行中的正文不进文档(归 RunRecord,经 SSE
  // 推给前端实时渲染),收尾时一次写入。占位一建好就发快照:前端据 replyId 立刻挂上状态条
  const { bot, writer, revoke } = await openReply(host, pageId, agent, user, cookieHeader, redo)
  const record = openRecord(run, writer.id, (ev) => host.broadcast(pageId, ev))
  run.record = record
  host.broadcast(pageId, record.snapshot(agent.id))
  let sessionId = ''
  let off: () => void = () => {}
  let usage: TurnUsage | undefined
  // prompt 正常返回过才算 agent 自己收了尾。关停期间 promise 被拒绝不算，远端行要留着。
  // prompted：绑定行已经写了但 prompt 还没发出去时，关停仍要收掉占位块——agent 根本没开始跑。
  let agentFinished = false
  let prompted = false
  let endTeam: (() => void) | undefined
  try {
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
    let blocks: PromptBlock[]
    if (saved && (sameDoc || adopt)) {
      sessionId = saved.sessionId
      let degraded = false
      let configOptions: ConfigOption[] = []
      if (!entry.loaded.has(sessionId)) {
        try {
          configOptions = (await entry.adapter.loadSession(sessionId, cwd, tools)).configOptions
        } catch {
          // session 在 agent 侧已不存在:降级为全文重放(结果正确,只是丢内部状态)
          degraded = true
          const created = await entry.adapter.newSession(cwd, tools)
          sessionId = created.sessionId
          configOptions = created.configOptions
        }
      }
      entry.loaded.add(sessionId)
      if (degraded || adopt) {
        blocks = [{ type: 'text', text: replayText }]
        await persistSession(host.pool, pageId, agent.id, sessionId, cwd, hash, user.id, profile)
      } else {
        blocks = [{ type: 'text', text: lastUserMessage(docText) ?? docText }]
      }
      await applyConfigs(host, pageId, agent.id, entry, sessionId, configOptions)
    } else {
      const created = await entry.adapter.newSession(cwd, tools)
      sessionId = created.sessionId
      entry.loaded.add(sessionId)
      blocks = [{ type: 'text', text: teamNote ? `${replayText}\n\n${teamNote}` : replayText }]
      // 带队的会话不写记录(文档 hash 对不上带队说明，下一轮普通对话自然全文重放)
      if (!run.team) await persistSession(host.pool, pageId, agent.id, sessionId, cwd, hash, user.id, profile)
      await applyConfigs(host, pageId, agent.id, entry, sessionId, created.configOptions)
    }

    // 会话建好、页面级配置应用完：绑进会话镜像（执行端快照播种 + 广播全量）。
    // 换了会话（全文重放建新会话）时旧会话的待批在这里按取消应答
    host.mirror.bind(pageId, agent.id, sessionId, entry.adapter)
    // 跳过全部确认只有机器主人能发起：会话此刻就在该档而发起人不是主人，本轮失败并给出原因。
    // 必须在 prompt 之前，也在消息级覆盖之前（覆盖不带 mode，见 applyMsgOpts）
    authorize(user, agent, {
      kind: 'run',
      mode: host.mirror.configs(pageId, agent.id).find((o) => o.category === 'mode')?.currentValue,
    })

    // 这条消息的配置覆盖（attrs.opts）：页面级 applyConfigs 之后再叠加，整轮生效、轮末还原。
    // 不落库，否则会把这一条消息的配置变成整个页面的配置（下一轮不该继承）。
    // run.msgBefore 由 applyMsgOpts 边应用边登记，并写进 open_runs：认领回来的 finally 没有这个闭包，
    // 只能靠行里的覆盖前的值还原。
    await applyMsgOpts(host, pageId, agent.id, entry, sessionId, run)
    off = entry.adapter.on((ev) => projectAgentEvent(run, record, ev, undefined, sessionId))
    run.sessionId = sessionId
    // 会话准备期间就点了停止 / 服务要关了:不再发起 prompt。远端且还没写绑定行的，占位块照常收成终态。
    if (run.cancelled || run.hold) return
    if (run.remote) {
      // 必须在 prompt 之前落库。写晚了，进程死在发送之后就没有行可认领，占位块只能被收成出错。
      await insertOpenRun(host.pool, {
        runId: run.runId,
        pageId,
        replyId: writer.id,
        sessionId,
        agentId: agent.id,
        connectorId: run.remote.connectorId,
        userId: user.id,
        cwd,
        startedAt: run.startedAt,
        msgOpts: run.msgOpts,
        msgBefore: run.msgBefore,
      })
      run.bound = true
      if (run.cancelled || run.hold) {
        if (run.cancelled) await requestCancel(host.pool, run.runId).catch(() => undefined)
        return
      }
    }
    // 这一轮那条用户消息里的图：作为图片块跟在文本后面（能不能收由执行端按 agent 的能力决定；超过体积闸的不带，链接仍在文本里）
    for (const id of lastUserMessageImages(fragment, viewEnd)) {
      const img = await loadAiImage(host.pool, id)
      if (!img.error) blocks.push({ type: 'image', mimeType: img.mime, data: img.data })
    }
    prompted = true
    const pending = entry.adapter.prompt(sessionId, blocks, run.runId)
    // abort 先赢时 prompt 稍后的拒绝不能变成 unhandledRejection
    void pending.catch(() => undefined)
    const res = await Promise.race([pending, run.abort.promise])
    agentFinished = true
    usage = res.usage
    if (run.shutdown) return
    if (res.stopReason === 'cancelled' || run.cancelled) {
      run.cancelled = true
      return
    }
    run.ended = true
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
      persistFinalHash: async (hash, tools) => {
        if (sessionId && !run.team) await persistSession(host.pool, pageId, agent.id, sessionId, cwd, hash, user.id, tools)
      },
      notifyPagesChanged: host.notifyPagesChanged,
    })
    // 排队派发的一轮：机器人用的临时会话收尾后删掉
    await revoke?.()
  }
}
