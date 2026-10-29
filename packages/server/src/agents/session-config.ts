// ---------- 会话配置与预备会话 ----------
// 页面级配置（agent_session.configs）的应用与收敛、消息级覆盖（attrs.opts）的应用与还原、
// 改配置（POST /agent-config）、选 agent 时预备会话（POST /agent-prepare）。
// 需要 manager 状态的部分（广播 / 适配器池 / agent 解析）经 ManagerHost 拿，同 remote-run.ts 的 RemoteRunHost。
import { recordMachineUse } from './machine-grants.js'
import { NoSessionError, UnknownAgentError, type AdapterEntry, type ManagerHost } from './manager-types.js'
import { authorize } from './posture.js'
import type { RunState } from './run-state.js'
import { effectiveCwd, loadConfigs, loadOwnSession, loadSessionState, loadToolProfile, persistConfigs, persistSession } from './session-store.js'
import { toolProfileOf } from './tool-profile.js'
import type { ConfigOption } from './types.js'

/** 会话建立后应用持久化配置：逐条 setConfigOption，用返回的 options 收敛落库（广播归会话镜像） */
export async function applyConfigs(
  host: ManagerHost,
  pageId: string,
  agentId: string,
  entry: AdapterEntry,
  sessionId: string,
  options: ConfigOption[],
): Promise<void> {
  const saved = await loadConfigs(host.pool, pageId, agentId)
  // 模型先设：有的 agent 换模型会连带重置思考程度，后设模型就把刚恢复的思考档冲掉了。
  // jsonb 的键序按键长排，不能指望存进去的顺序
  const isModel = (id: string) => options.find((o) => o.id === id)?.category === 'model'
  const order = Object.entries(saved).sort(([a], [b]) => Number(isModel(b)) - Number(isModel(a)))
  for (const [configId, value] of order) {
    try {
      options = await entry.adapter.setConfigOption(sessionId, configId, value)
    } catch {
      // agent 拒绝该 configId：丢弃该条，不影响其余
    }
  }
  // 回写值取返回 options 里该 id 的 currentValue，该 id 已不存在则丢弃
  const converged: Record<string, string> = {}
  for (const configId of Object.keys(saved)) {
    const o = options.find((c) => c.id === configId)
    if (o) converged[configId] = o.currentValue
  }
  if (Object.keys(converged).length > 0) await persistConfigs(host.pool, pageId, agentId, converged)
}

/** 这条消息的会话配置项覆盖：逐条 setConfigOption，覆盖前的值先登记进 run.msgBefore 再发请求
 *  （收尾据此还原；会话镜像据此知道这些值是临时的、不落成页面级意图，agent 的 config 事件可能早于应答到达）。
 *  值已相同就不动。agent 拒绝某条只 warn 并跳过，一条坏配置不该让整轮生成失败。
 *  mode 类不接受消息级覆盖：消息 attrs 在 Yjs 里谁都能写，权限姿态只走受控的会话配置通道（authorize）。
 *  不落库，下一轮 applyConfigs 会按页面级保存值收敛。 */
export async function applyMsgOpts(
  host: ManagerHost,
  pageId: string,
  agentId: string,
  entry: AdapterEntry,
  sessionId: string,
  run: RunState,
): Promise<void> {
  const before = host.mirror.configs(pageId, agentId)
  for (const [id, want] of Object.entries(run.msgOpts)) {
    const option = before.find((c) => c.id === id)
    if (!option || option.category === 'mode' || option.currentValue === want) continue
    run.msgBefore[id] = option.currentValue
    try {
      await entry.adapter.setConfigOption(sessionId, id, want)
    } catch (err) {
      delete run.msgBefore[id]
      console.warn(`[agent] 消息级配置 ${id}=${want} 未被接受：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** 轮末把消息级覆盖写回去。只动还在的适配器：4403 已经摘掉的就等下一轮 applyConfigs。 */
export async function restoreMsgBefore(
  /** 调用方用 host.adapterOf(key, pass) 取（绑定了发起人）；没有 = 适配器已被摘掉，不再把它拉起来 */
  entry: AdapterEntry | undefined,
  sessionId: string,
  before: Record<string, string>,
): Promise<void> {
  if (!sessionId || Object.keys(before).length === 0 || !entry) return
  for (const [id, value] of Object.entries(before)) {
    try {
      await entry.adapter.setConfigOption(sessionId, id, value)
    } catch {
      // 还原失败无碍：下一轮 applyConfigs 按页面级保存值重新收敛
    }
  }
}

/** 修改某 agent 的会话配置（POST /agent-config），返回该会话当前全部 config options */
export async function setSessionConfig(
  host: ManagerHost,
  pageId: string,
  body: { agent: string; configId: string; value: string },
  user: { id: string; role: string },
): Promise<ConfigOption[]> {
  const agent = await host.resolve(body.agent, user)
  if (!agent) throw new UnknownAgentError()
  let entry: AdapterEntry | undefined
  let sessionId: string | null = null
  const run = host.runOf(pageId)
  if (run && run.adapterKey === agent.id && run.sessionId) {
    entry = host.adapterOf(agent.id, agent.pass)
    sessionId = run.sessionId
  }
  if (!entry || !sessionId) {
    const saved = await loadSessionState(host.pool, pageId, agent.id)
    if (!saved) throw new NoSessionError()
    entry = host.ensureAdapter(agent)
    sessionId = saved.sessionId
    if (!entry.loaded.has(sessionId)) {
      try {
        // 按这个会话原来的档位交付工具（改配置不改档位）
        await entry.adapter.loadSession(sessionId, saved.cwd, host.pageReadTools(entry, user, agent, pageId, toolProfileOf(saved.tools)))
      } catch {
        // agent 侧 session 已不在，改配置无从谈起
        throw new NoSessionError()
      }
      entry.loaded.add(sessionId)
      // 会话的 MCP 现在拿的是这个人的凭证：记录跟着改，原来的人下一轮就不会接着用它（SavedSession.userId）
      await persistSession(host.pool, pageId, agent.id, sessionId, saved.cwd, saved.lastSyncedHash, user.id, toolProfileOf(saved.tools))
    }
  }
  // 绑进会话镜像（在跑的会话 runTurn 早绑过，重复 bind 只是用同一份执行端快照再播种一次）：
  // 下面 setConfigOption 的 config 事件靠它广播给前端、落成页面级意图
  host.mirror.bind(pageId, agent.id, sessionId, entry.adapter)
  // mode 是受控的会话配置通道里唯一能改权限姿态的入口，这里是唯一的 authorize()
  const option = host.mirror.configs(pageId, agent.id).find((o) => o.id === body.configId)
  authorize(user, agent, { kind: 'set-config', category: option?.category, value: body.value })
  // 非机器主人改会话配置要留痕；写不进审计就不改
  await recordMachineUse(host.pool, agent, user.id, 'config', pageId, { agent: agent.id, configId: body.configId, value: body.value })
  const options = await entry.adapter.setConfigOption(sessionId, body.configId, body.value)
  // 落库的是改完后的会话当前状态，而不只是用户动的那一项：agent 可能连带改了别的项
  // （如换模型顺带调 thinking），前端看到的就是新值，重开会话时要保持同一份
  await persistConfigs(
    host.pool,
    pageId,
    agent.id,
    Object.fromEntries(options.map((o) => [o.id, o.currentValue])),
  )
  return options
}

/** 选 agent 时预备会话（POST /agent-prepare）：只建 / 加载会话，不发起生成，好让前端立刻拿到
 *  模型 / 思考程度等配置项。新建的会话以 lastSyncedHash=null 落库，下一次生成会复用它
 *  并发全文重放（见 runTurn 的 adopt 分支），所以不会留下无用会话。 */
export async function prepareSession(
  host: ManagerHost,
  pageId: string,
  agentId: string,
  user: { id: string; role: string },
): Promise<void> {
  const agent = await host.resolve(agentId, user)
  if (!agent) throw new UnknownAgentError()
  const entry = host.ensureAdapter(agent)
  const cwd = await effectiveCwd(host.pool, pageId, agent)
  const profile = await loadToolProfile(host.pool, pageId)
  const tools = host.pageReadTools(entry, user, agent, pageId, profile)
  // 生效工作区随 prepare 广播：进页面/换 agent 就能在控制行显示（目录能不能用由下面 session/new 说）
  host.broadcast(pageId, { type: 'cwd', agentId: agent.id, cwd })
  // 别人的会话不复用（MCP 凭证是他的，见 SavedSession.userId）：按自己的凭证另建
  const saved = await loadOwnSession(host.pool, pageId, agent.id, user.id)
  // 会话只在 cwd 与工具档位都一致时可复用：工作区改过的旧会话在别的目录，换过档的旧会话工具不对，都作废重建
  const reusable = saved != null && saved.cwd === cwd && toolProfileOf(saved.tools) === profile
  let sessionId = reusable ? saved.sessionId : ''
  let options: ConfigOption[] = []
  if (sessionId && entry.loaded.has(sessionId)) {
    // 本进程已加载过：直接给已知选项，不打扰 agent
    options = entry.adapter.sessionState(sessionId).configs
  } else if (sessionId) {
    try {
      options = (await entry.adapter.loadSession(sessionId, cwd, tools)).configOptions
      entry.loaded.add(sessionId)
    } catch {
      // agent 侧已没有这个会话：当作没有，重新建一个
      sessionId = ''
    }
  }
  if (!sessionId) {
    const created = await entry.adapter.newSession(cwd, tools)
    sessionId = created.sessionId
    options = created.configOptions
    entry.loaded.add(sessionId)
    await persistSession(host.pool, pageId, agent.id, sessionId, cwd, null, user.id, profile)
  }
  await applyConfigs(host, pageId, agent.id, entry, sessionId, options)
  // 绑进会话镜像：执行端快照播种 + 广播全量（commands / config / 待批）。该 agent 没有配置项时 config 也会广播
  // 一个空数组，让前端知道已经问过、没有，否则每次进页面都会重新准备一次
  host.mirror.bind(pageId, agent.id, sessionId, entry.adapter)
}
