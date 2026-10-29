// ---------- 中心 server ↔ 本地 connector 的 WSS 协议 ----------
// 两端复用既有 AgentEvent / PromptBlock / AgentConfig，信封只加路由信息（rid/sessionId），
// 中间不做语义翻译。连接由 connector 主动发起（出站），中心只应答。
//
// 路径：
//   /connector/pair  无 token，仅用于配对：申请一次性链接，用户在浏览器确认后经这条连接下发长期 token（agents/pairing.ts）
//   /connector       header `x-ramet-connector: <token>`，注册 + 指令/事件中继

import type { AgentEvent, AskContent, ConfigOption, PromptBlock, SessionEvent, SessionState, TurnUsage } from './types.js'
import type { DirListing } from './dirs.js'
import type { PageTool } from '../page-read.js'
import type { MachineScope } from './machine-access.js'
import { PROJECT_CAP, QUICK_CAP, WRITE_CAP, type ProjectReply } from './project-types.js'
import { PREVIEW_CAP, type HeaderPairs } from './preview-types.js'
import { TERMINAL_CAP, type PtyExitReason } from './pty-types.js'

/** connector 上报的可用 agent（前端下拉项；id 在本机内唯一） */
export type ConnectorAgentInfo = { id: string; label: string; logo?: string | null }

/** connector → 中心 */
export type ConnMsg =
  /** 连接后的第一条：身份、本机默认 cwd（connector 机器上的路径）、可用 agent。
   *  inflight 是进程里还没结束的 prompt，中心据它判断进程还在跑哪些回合；
   *  重连后中心要的回合从这里认领，不在 resume 里的一律当进程已经换掉。不含事件日志。 */
  | {
      t: 'hello'
      name: string
      defaultCwd: string
      agents: ConnectorAgentInfo[]
      inflight?: { runId: string; agent: string; sessionId: string }[]
      /** connector 认识的能力（project = 项目面板的五种帧；terminal = 终端的 pty 帧，node-pty 装上了才有）。
       *  老 connector 没有这一项，视为没有任何新能力 */
      caps?: string[]
    }
  /** 请求成功应答（new/load 带 state = 该会话在执行端的会话级快照；config 带 configOptions；ls 带 dirs；
   *  项目帧（tree / read / files / git-status / git-diff / write）与终端帧（pty-*）带 project） */
  | {
      t: 'res'
      rid: string
      sessionId?: string
      cwd?: string
      state?: SessionState
      configOptions?: ConfigOption[]
      dirs?: DirListing
      project?: ProjectReply
      /** quick 帧的应答：本次单次调用的结束原因（文本增量走 quick-delta） */
      quick?: { stopReason: string }
    }
  /** 请求失败（含 prompt 中途失败；prompt 的失败带 runId/seq）。code = 'forbidden'：被 connector 拒绝（第二道闸：本机授权名单，
   *  或终端不是你的）；'not_found'：终端不存在；'conflict'：写文件时文件已不是用户读到的那一版 */
  | { t: 'err'; rid: string; runId?: string; seq?: number; message: string; code?: 'forbidden' | 'not_found' | 'conflict' }
  /** 流式事件（按 sessionId 归属，见 sessionId 字段；runId/seq 是跨重启重放的稳定身份与下标） */
  | { t: 'ev'; rid: string; runId?: string; seq?: number; ev: AgentEvent }
  /** prompt 正常结束（usage = agent 报的本轮用量；老 connector 不带） */
  | { t: 'end'; rid: string; runId?: string; seq?: number; stopReason: string; usage?: TurnUsage }
  /** 会话级事件（commands / config / permission / permission_resolved）：归会话、不归某一轮，由 connector
   *  上的常驻监听发出，不论有没有 prompt 在飞。中心按 connectorId + agent 路由到对应 RemoteAgent 的副本 */
  | { t: 'session'; agent: string; sessionId: string; ev: SessionEvent }
  /** hello 之后推一次本进程所有活会话的全量快照。中心据此对账，补齐断线期间发生的审批 / 命令 / 配置变化，
   *  快照里没有的会话当已结束 */
  | { t: 'sessions'; list: Array<{ agent: string; sessionId: string; state: SessionState }> }
  /** welcome.resume 的重放已经发完，此后的事件都是新产生的。
   *  中心收到它才从静默折事件切到向 SSE 推送，否则新进程会从空再播一遍。 */
  | { t: 'resumed'; runId: string }
  /** 随手 AI 本地通道的文本增量（rid 对应中心发的 quick 帧）；结束用 res { quick }，失败用 err */
  | { t: 'quick-delta'; rid: string; text: string }
  /** 终端输出（只在中心 attach 过的终端上推）：seq 在同一个 pty 内从 0 递增，一小段时间内的输出已合并 */
  | { t: 'pty-data'; ptyId: string; seq: number; data: string }
  /** 终端结束（进程退了 / 被关 / 授权收回 / 太久没订阅者），已 attach 的订阅者据此收尾 */
  | { t: 'pty-exit'; ptyId: string; code: number | null; reason: PtyExitReason }
  /** 端口预览的响应（reqId 对应中心发的 http-req）：先 http-res（状态 + 头），再若干 http-res-body 分片（chunk = base64），
   *  最后 end；error = 中途失败（中心掐掉浏览器连接，免得把截断的文件当成完整的）。头还没发就失败走 http-fail（中心渲染错误页） */
  | { t: 'http-res'; reqId: string; status: number; headers: HeaderPairs }
  | { t: 'http-res-body'; reqId: string; chunk?: string; end?: true; error?: string }
  | { t: 'http-fail'; reqId: string; status: number; message: string }
  /** 预览的 WebSocket（Vite HMR 等）：ws-ready = 上游握手成功（protocol = 上游选定的子协议）；ws-data 双向转发；
   *  ws-end = 上游关了（opened=false 表示握手阶段就失败了） */
  | { t: 'ws-ready'; wsId: string; protocol: string }
  | { t: 'ws-data'; wsId: string; data: string; binary: boolean }
  | { t: 'ws-end'; wsId: string; code: number; reason: string; opened: boolean }
  /** 仅配对路径：申请配对（带首发 agent 清单，确认页上给人看），中心回 PairReply */
  | { t: 'pair-request'; name: string; defaultCwd: string; agents: ConnectorAgentInfo[] }

/** 中心 → connector，仅配对路径：pair-link = 一次性码（connector 拼成 <中心>/connect/<code> 打印给人，到浏览器确认）；
 *  确认后 paired（ownerId = 确认的人 = 这台机器的主人，connector 钉进本地配置，之后不再接受中心改写，见 connector/access.ts）；
 *  拒绝 / 过期 / 申请不合法走 pair-error。paired / pair-error 之后中心关掉这条连接 */
export type PairReply =
  | { t: 'pair-link'; code: string; expiresAt: string }
  | { t: 'paired'; connectorId: string; token: string; ownerId: string }
  | { t: 'pair-error'; message: string }

/** 中心 → connector。
 *  驱动机器的帧（new / load / ls / prompt / config / permission）一律带 `actor` = 操作人的 user id：
 *  connector 自己再判一次（只认主人与本地授权名单里的人，见 connector/access.ts），中心哪怕有 bug 放过了，
 *  这一关也过不去。actor 必填，漏写编译不过；hub 只发得出带 MachinePass 的驱动帧（hub.ts 的 driven）。 */
export type CenterMsg =
  /** resume = 中心还要的回合（after = 已经折进当前 RunRecord 的最后 seq；新进程没有内存 = -1，全部重放）；
   *  drop = hello 里有、但中心不认的 runId（connector 必须取消，没绑定就不许空转烧 token）。
   *  resume 是完整集合：inflight 里不在 resume 里的一律当 drop。
   *  ownerId = 机器主人。老 connector 的本地配置没有它，首次重连由这里补齐并钉住，之后固定（connector/access.ts） */
  | { t: 'welcome'; connectorId: string; ownerId?: string | null; resume?: { runId: string; after: number }[]; drop?: string[] }
  /** tools = 中心交给 AI 的能力（只含凭证和地址，不含命令）：命令由 connector 用自己那份
   *  代码与本机 node 拼（见 page-read.ts 的 pageToolServer） */
  | { t: 'new'; rid: string; actor: string; agent: string; cwd: string; tools?: PageTool[] }
  | { t: 'load'; rid: string; actor: string; agent: string; sessionId: string; cwd: string; tools?: PageTool[] }
  /** 列本机目录（工作区选择器）：与 agent 无关的机器能力，只按 connector 路由 */
  | { t: 'ls'; rid: string; actor: string; path: string }
  | { t: 'prompt'; rid: string; actor: string; runId: string; agent: string; sessionId: string; blocks: PromptBlock[] }
  /** 取消在飞回合。带 runId 时按回合取消（认领期停止：绑定的回合还没接回来），不带则按 agent + sessionId。
   *  不带 actor，connector 不判：取消只会让机器停下来，不会让它动起来；谁能停由页面写权限决定（manager.stop） */
  | { t: 'cancel'; agent: string; sessionId: string; runId?: string }
  /** 审批应答按 agent + requestId 回派：requestId 只在单个 agent 进程内唯一。content = 提问的答案（中心已校验；
   *  老 connector 不认这个字段也无妨，它不声明 elicitation，不会有提问） */
  | { t: 'permission'; actor: string; agent: string; requestId: string; optionId: string | null; content?: AskContent }
  | { t: 'config'; rid: string; actor: string; agent: string; sessionId: string; configId: string; value: string }
  /** 项目面板（machine 范围，只读）：root = 工作区绝对路径（中心取这个页面上这个 agent 的生效工作区），path = 相对 root 的路径
   *  （`/` 分隔，'' = root 本身）。路径约束由 connector 执行，不信中心：root 与目标都 realpath，目标必须在 root 之内
   *  （按路径分隔符比较前缀），符号链接指向 root 外、目标不存在、path 是绝对路径或含 NUL 一律拒绝（connector/project-path.ts） */
  | { t: 'tree'; rid: string; actor: string; root: string; path: string }
  | { t: 'read'; rid: string; actor: string; root: string; path: string }
  | { t: 'files'; rid: string; actor: string; root: string }
  | { t: 'git-status'; rid: string; actor: string; root: string }
  | { t: 'git-diff'; rid: string; actor: string; root: string; path?: string }
  /** 写文件（machine 范围，随手 AI 在代码查看器里收下改写时用）：只改已存在的普通文件，路径约束同 read（realpath、不越界、不进配置目录、
   *  不碰 .git 里面），原文件与新内容都 ≤ 1MB、不含 NUL、原文件必须是合法 UTF-8；connector 重读原文件算 sha256，与 baseHash 不符就拒绝
   *  （用户读到之后别人改过）；通过后写同目录临时文件、保留原权限位、rename 原子替换 */
  | { t: 'write'; rid: string; actor: string; root: string; path: string; baseHash: string; content: string }
  /** 终端（machine 范围）：pty 属于打开它的人（actor）。open 在 root（中心取这个页面上这个 agent 的生效工作区，connector 照样 realpath
   *  校验）里起 shell；input / resize / attach / detach 只有 pty 的主人能做（connector 按 actor 校验，不只靠中心）；
   *  close 他或机器主人能做；list 普通人只看到自己的，机器主人看到这台机器上所有人的。
   *  attach 的应答带 after 之后的回放，此后 connector 才往中心推 pty-data；detach = 中心不再有订阅者（connector 起 30 分钟闲置计时） */
  | { t: 'pty-open'; rid: string; actor: string; root: string; cols: number; rows: number }
  | { t: 'pty-input'; rid: string; actor: string; ptyId: string; data: string }
  | { t: 'pty-resize'; rid: string; actor: string; ptyId: string; cols: number; rows: number }
  | { t: 'pty-close'; rid: string; actor: string; ptyId: string }
  | { t: 'pty-attach'; rid: string; actor: string; ptyId: string; after: number }
  | { t: 'pty-detach'; rid: string; actor: string; ptyId: string }
  | { t: 'pty-list'; rid: string; actor: string }
  /** 端口预览（machine 范围，actor 是共享人：主人明确共享才是预览对页面读者开放的依据）。port-share / port-unshare 带 rid（应答走 res）；
   *  connector 只连 127.0.0.1:<共享时登记的端口>，帧里没有主机名字段，也不接受；每个 http / ws 帧都按 previewId 找到共享记录，
   *  用记录里的共享人再过一遍本机名单（machine 范围），共享人的授权没了就不转发。
   *  http-req 之后若 hasBody，请求体按 http-body 分片（chunk = base64）发完以 end 收尾；abort = 浏览器走了，掐掉上游。
   *  ws-open / ws-msg / ws-close 是 WebSocket 升级后的转发（text 原样、binary 为 base64） */
  | { t: 'port-share'; rid: string; actor: string; previewId: string; port: number }
  | { t: 'port-unshare'; rid: string; actor: string; previewId: string }
  | { t: 'http-req'; actor: string; previewId: string; reqId: string; method: string; path: string; headers: HeaderPairs; hasBody: boolean }
  | { t: 'http-body'; actor: string; previewId: string; reqId: string; chunk?: string; end?: true; abort?: true }
  | { t: 'ws-open'; actor: string; previewId: string; wsId: string; path: string; headers: HeaderPairs; protocols: string[] }
  | { t: 'ws-msg'; actor: string; previewId: string; wsId: string; data: string; binary: boolean }
  | { t: 'ws-close'; actor: string; previewId: string; wsId: string; code?: number }
  /** 随手 AI 本地通道（agent 范围）：在这台机器上用 agent 做一次文本改写。connector 起受限会话：临时空目录当 cwd、不给 MCP 工具、
   *  读写文件 / 开终端一律拒绝、审批自动拒绝、免确认档先切走（切不了就拒绝运行）、60 秒超时、每人同时一个；prompt 是中心拼好的整段文本。
   *  文本增量走 quick-delta，结束走 res { quick }，失败走 err */
  | { t: 'quick'; rid: string; actor: string; agent: string; prompt: string }
  /** 停掉一次 quick（按 rid）。非驱动帧：只会让机器停下来，不带 actor、connector 不判（同 cancel）；谁能停由发起这次调用的 HTTP 请求决定 */
  | { t: 'quick-cancel'; rid: string }
  /** 停止 agent 在 ACP 终端里跑的一条命令（terminal/kill）。非驱动帧：只会让机器停下来，不带 actor、connector 不判，
   *  谁能停由页面写权限决定（同 cancel）；connector 只认这个 agent 这个会话自己的终端，对不上就忽略 */
  | { t: 'kill-cmd'; agent: string; sessionId: string; terminalId: string }
  /** 此人在这台机器上的授权收窄了（换成了范围更小的新授权）：machine 范围没了，connector 关掉他的全部终端。
   *  非驱动帧，只会减少权限；与 grant-revoked 不同，它不动本地名单（新授权的本地条目是刚写进去的，不能删） */
  | { t: 'access-reduced'; userId: string; scope: MachineScope }
  /** 此人在这台机器上的授权没了（主人收回 / 本人放弃 / 到期）：connector 从本地名单删掉此人，并取消 actor 是此人的在飞 prompt。
   *  非驱动帧：只会减少权限，不带 actor、不过 DRIVEN_SCOPE、connector 不判。本地名单只有本机确认命令能加人，
   *  这个帧只删不加，中心哪怕伪造出带授权内容的帧，也加不进名单（connector/index.ts 只读 userId） */
  | { t: 'grant-revoked'; userId: string }
  | { t: 'bye'; reason: string }

/** 会驱动机器的帧 */
export type DrivenMsg = Extract<
  CenterMsg,
  {
    t:
      | 'new' | 'load' | 'ls' | 'prompt' | 'config' | 'permission' | 'quick'
      | 'tree' | 'read' | 'files' | 'git-status' | 'git-diff' | 'write'
      | 'pty-open' | 'pty-input' | 'pty-resize' | 'pty-close' | 'pty-attach' | 'pty-detach' | 'pty-list'
      | 'port-share' | 'port-unshare' | 'http-req' | 'http-body' | 'ws-open' | 'ws-msg' | 'ws-close'
  }
>

/** 项目面板的帧（DrivenMsg 的子集；connector 据此分派到 connector/project.ts） */
export type ProjectMsg = Extract<CenterMsg, { t: 'tree' | 'read' | 'files' | 'git-status' | 'git-diff' | 'write' }>

/** 终端的帧（DrivenMsg 的子集；connector 据此分派到 connector/pty.ts） */
export type PtyMsg = Extract<
  CenterMsg,
  { t: 'pty-open' | 'pty-input' | 'pty-resize' | 'pty-close' | 'pty-attach' | 'pty-detach' | 'pty-list' }
>

/** 端口预览的帧（DrivenMsg 的子集；connector 据此分派到 connector/preview.ts） */
export type PreviewMsg = Extract<
  CenterMsg,
  { t: 'port-share' | 'port-unshare' | 'http-req' | 'http-body' | 'ws-open' | 'ws-msg' | 'ws-close' }
>

/** 每种驱动帧需要的 scope：中心发帧前（hub）与 connector 收帧后用同一张表，新增驱动帧漏登记编译不过。
 *  文件树 / 读文件 / git 状态与 diff 也是 machine：别人机器上的文件不是公开的，读也算，只有 agent 授权的人用不了 */
export const DRIVEN_SCOPE: Record<DrivenMsg['t'], MachineScope> = {
  new: 'agent',
  load: 'agent',
  ls: 'agent',
  prompt: 'agent',
  config: 'agent',
  permission: 'agent',
  // 驱动这台机器上的 agent 跑一次：agent 范围
  quick: 'agent',
  tree: 'machine',
  read: 'machine',
  files: 'machine',
  'git-status': 'machine',
  'git-diff': 'machine',
  // 写文件、开终端都要 machine 范围，只有 agent 授权的人不行
  write: 'machine',
  'pty-open': 'machine',
  'pty-input': 'machine',
  'pty-resize': 'machine',
  'pty-close': 'machine',
  'pty-attach': 'machine',
  'pty-detach': 'machine',
  'pty-list': 'machine',
  // 端口预览是把本机 127.0.0.1 某个端口的网站转给别人看，共享人要有 machine 范围
  'port-share': 'machine',
  'port-unshare': 'machine',
  'http-req': 'machine',
  'http-body': 'machine',
  'ws-open': 'machine',
  'ws-msg': 'machine',
  'ws-close': 'machine',
}

/** 某些帧要求 connector 在 hello 里声明过的能力（老 connector 不认这些帧）。hub 发帧前查 conn.caps，不满足就不发 */
export const FRAME_CAP: Partial<Record<DrivenMsg['t'], string>> = {
  quick: QUICK_CAP,
  tree: PROJECT_CAP,
  read: PROJECT_CAP,
  files: PROJECT_CAP,
  'git-status': PROJECT_CAP,
  'git-diff': PROJECT_CAP,
  write: WRITE_CAP,
  'pty-open': TERMINAL_CAP,
  'pty-input': TERMINAL_CAP,
  'pty-resize': TERMINAL_CAP,
  'pty-close': TERMINAL_CAP,
  'pty-attach': TERMINAL_CAP,
  'pty-detach': TERMINAL_CAP,
  'pty-list': TERMINAL_CAP,
  'port-share': PREVIEW_CAP,
  'port-unshare': PREVIEW_CAP,
  'http-req': PREVIEW_CAP,
  'http-body': PREVIEW_CAP,
  'ws-open': PREVIEW_CAP,
  'ws-msg': PREVIEW_CAP,
  'ws-close': PREVIEW_CAP,
}

/** 帧是不是驱动帧（connector 据此决定要不要过第二道闸；未知 t 不在表里，既不是驱动帧也不会被执行） */
export function isDrivenMsg(msg: CenterMsg): msg is DrivenMsg {
  return Object.hasOwn(DRIVEN_SCOPE, msg.t)
}

export type AnyMsg = ConnMsg | CenterMsg

/** 长期 token 的连接头（不是 query：避免进日志/Referer） */
export const CONNECTOR_TOKEN_HEADER = 'x-ramet-connector'
export const CONNECTOR_PAIR_PATH = '/connector/pair'
export const CONNECTOR_PATH = '/connector'
/** 关闭码：token 无效或被撤销，connector 收到即停止重连（区别于网络抖动的 1006） */
export const CONNECTOR_REVOKED_CODE = 4403
