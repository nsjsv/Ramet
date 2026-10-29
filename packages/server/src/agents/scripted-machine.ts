/**
 * 测试用的脚本化 connector：直接说协议、记下全部下行帧，不跑真 agent。
 * 配对、连上、hello/welcome；之后 new / load / ls / config 立刻应答，项目面板的帧（tree / read / files / git-* / write）
 * 回固定内容（caps 缺省声明 project，不含 write；要测写文件传 ['project','write']，传 [] 模拟老 connector，终端的 pty 帧要声明 terminal），
 * prompt 默认立刻回一句话并结束（hold = true 时挂住不回，用来测停止 / 收回即断；收到 cancel 才以 cancelled 收尾）。
 * 随手 AI 的 quick 帧：回 quickDeltas 里的文本增量再 res（quickHold = true 时挂住，收到 quick-cancel 才回 err 已取消）。
 * 和 test-kit 一样依赖起一份真服务的副作用（import 即起服），只给机器授权相关的测试文件用。
 */
import { afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { approveConnector } from './connectors.js'
import { provisionConnector } from '../test-helpers.js'
import {
  CONNECTOR_PATH,
  CONNECTOR_TOKEN_HEADER,
  isDrivenMsg,
  type CenterMsg,
  type ConnMsg,
  type DrivenMsg,
} from './protocol.js'
import type { PtyChunk, PtyInfo, PtySnapshot } from './pty-types.js'
import type { ConfigOption, SessionState } from './types.js'
import { base, pool, waitFor } from './test-kit.js'

// connector 没有回环回落，中心对外地址必须显式给（同生产行为）
process.env.RAMET_PUBLIC_URL = base

export const MODEL: ConfigOption = { id: 'model', name: 'Model', category: 'model', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }
export const STATE: SessionState = { commands: [], configs: [MODEL], approvals: [] }
export const AGENTS = [{ id: 'claude', label: 'Claude' }, { id: 'fake', label: 'Fake' }]

/** 脚本化机器 read 应答里的 hash / write 应答里的新 hash（形状同真的 sha256 hex） */
export const READ_HASH = 'a'.repeat(64)
export const WRITE_HASH = 'b'.repeat(64)

export type PromptFrame = Extract<DrivenMsg, { t: 'prompt' }>

export type Machine = {
  id: string
  name: string
  /** 这台机器的长期 token（connector token 认证的端点用） */
  token: string
  ws: WebSocket
  frames: CenterMsg[]
  /** true = prompt 挂住不回（测停止 / 收回） */
  hold: boolean
  held: PromptFrame[]
  sessions: string[]
  /** list 回的终端（缺省空）；open 会往里加一个，id 依次 PTY-1、PTY-2… */
  ptys: PtyInfo[]
  /** attach 时回放的输出（缺省一块 `$ `）；seq > after 的才回 */
  ptyReplay: PtyChunk[]
  /** 设了：全新 attach（after = -1）按新 connector 的方式回屏幕快照（replay 为空、last = snapshot.seq）；不设 = 老 connector（回放） */
  ptySnapshot: PtySnapshot | null
  /** quick 帧的回复：逐条作为 quick-delta 发出，然后 res { quick:{stopReason:'end_turn'} } */
  quickDeltas: string[]
  /** true = quick 帧挂住不回（测取消 / 收回即断）；收到 quick-cancel 回 err */
  quickHold: boolean
  heldQuick: Extract<CenterMsg, { t: 'quick' }>[]
  /** true = write 帧按「文件已被改动」应答（err code conflict）；否则回 { path, hash: WRITE_HASH } */
  writeConflict: boolean
  /** 非空：所有 pty 帧都按「connector 拒绝」应答（模拟别人的终端 / 终端不存在） */
  refusePty: 'forbidden' | 'not_found' | null
  /** 端口预览：登记（previewId → port）。port-share / port-unshare 立刻应答 */
  shares: Map<string, number>
  /** 端口预览的流量：收到 http-req 时调用（缺省回一个 200 的 hello）；wsHandler 同理（缺省 ws-ready 并回显） */
  httpHandler: ((m: Machine, msg: Extract<CenterMsg, { t: 'http-req' }>) => void) | null
  wsHandler: ((m: Machine, msg: Extract<CenterMsg, { t: 'ws-open' | 'ws-msg' | 'ws-close' }>) => void) | null
  send: (msg: ConnMsg) => void
  driven: () => DrivenMsg[]
  /** 操作人是 actor 的驱动帧 */
  by: (actor: string) => DrivenMsg[]
  /** 下行帧里某种类型的 */
  of: <T extends CenterMsg['t']>(t: T) => Extract<CenterMsg, { t: T }>[]
}

const machines: Machine[] = []
// 登记在 test-kit 的 afterEach(truncateAll) 之后，所以先于它执行：先断开脚本化机器再清库
afterEach(() => {
  for (const m of machines.splice(0)) m.ws.terminate()
})

function respond(m: Machine, msg: CenterMsg): void {
  switch (msg.t) {
    case 'new': {
      const sessionId = `${m.name}-S${m.sessions.length + 1}`
      m.sessions.push(sessionId)
      m.send({ t: 'res', rid: msg.rid, sessionId, state: STATE })
      break
    }
    case 'load':
      m.send({ t: 'res', rid: msg.rid, state: STATE })
      break
    case 'ls':
      m.send({ t: 'res', rid: msg.rid, dirs: { path: '/tmp', parent: null, dirs: [], truncated: false } })
      break
    case 'config':
      m.send({ t: 'res', rid: msg.rid, configOptions: [MODEL] })
      break
    case 'tree':
      m.send({ t: 'res', rid: msg.rid, project: { op: 'tree', path: msg.path, entries: [{ name: 'a.txt', type: 'file', size: 3 }], truncated: false } })
      break
    case 'read':
      m.send({ t: 'res', rid: msg.rid, project: { op: 'read', path: msg.path, size: 3, binary: false, text: 'abc', truncated: false, hash: READ_HASH } })
      break
    case 'write':
      if (m.writeConflict) m.send({ t: 'err', rid: msg.rid, message: '文件已被改动，请重新打开', code: 'conflict' })
      else m.send({ t: 'res', rid: msg.rid, project: { op: 'write', path: msg.path, hash: WRITE_HASH } })
      break
    case 'files':
      m.send({ t: 'res', rid: msg.rid, project: { op: 'files', files: ['a.txt'], truncated: false } })
      break
    case 'git-status':
      m.send({
        t: 'res',
        rid: msg.rid,
        project: {
          op: 'git-status',
          repo: true,
          branch: 'main',
          files: [{ path: 'a.txt', mark: 'M', staged: false }, { path: 'b.txt', mark: '?', staged: false }],
          truncated: false,
        },
      })
      break
    case 'git-diff':
      m.send({ t: 'res', rid: msg.rid, project: { op: 'git-diff', ...(msg.path ? { path: msg.path } : {}), diff: '--- a\n+++ b\n', truncated: false } })
      break
    case 'pty-open':
    case 'pty-input':
    case 'pty-resize':
    case 'pty-close':
    case 'pty-attach':
    case 'pty-detach':
    case 'pty-list':
      respondPty(m, msg)
      break
    case 'port-share':
      m.shares.set(msg.previewId, msg.port)
      m.send({ t: 'res', rid: msg.rid, project: { op: 'port-share' } })
      break
    case 'port-unshare':
      m.shares.delete(msg.previewId)
      m.send({ t: 'res', rid: msg.rid, project: { op: 'port-unshare' } })
      break
    case 'http-req':
      if (m.httpHandler) m.httpHandler(m, msg)
      else {
        m.send({ t: 'http-res', reqId: msg.reqId, status: 200, headers: [['content-type', 'text/plain']] })
        m.send({ t: 'http-res-body', reqId: msg.reqId, chunk: Buffer.from(`hello ${m.shares.get(msg.previewId) ?? '?'}`).toString('base64') })
        m.send({ t: 'http-res-body', reqId: msg.reqId, end: true })
      }
      break
    case 'ws-open':
    case 'ws-msg':
    case 'ws-close':
      if (m.wsHandler) m.wsHandler(m, msg)
      else if (msg.t === 'ws-open') m.send({ t: 'ws-ready', wsId: msg.wsId, protocol: msg.protocols[0] ?? '' })
      else if (msg.t === 'ws-msg') m.send({ t: 'ws-data', wsId: msg.wsId, data: msg.data, binary: msg.binary })
      break
    case 'prompt':
      if (m.hold) {
        m.held.push(msg)
        break
      }
      m.send({ t: 'ev', rid: msg.rid, runId: msg.runId, seq: 0, ev: { type: 'text', delta: '好的', sessionId: msg.sessionId } })
      m.send({ t: 'end', rid: msg.rid, runId: msg.runId, seq: 1, stopReason: 'end_turn' })
      break
    case 'quick':
      if (m.quickHold) {
        m.heldQuick.push(msg)
        break
      }
      for (const text of m.quickDeltas) m.send({ t: 'quick-delta', rid: msg.rid, text })
      m.send({ t: 'res', rid: msg.rid, quick: { stopReason: 'end_turn' } })
      break
    case 'quick-cancel': {
      const held = m.heldQuick.find((q) => q.rid === msg.rid)
      if (held) m.send({ t: 'err', rid: held.rid, message: '已取消' })
      break
    }
    case 'cancel': {
      const held = m.held.find((p) => p.sessionId === msg.sessionId || (msg.runId && p.runId === msg.runId))
      if (held) m.send({ t: 'end', rid: held.rid, runId: held.runId, seq: 0, stopReason: 'cancelled' })
      break
    }
    default:
      break
  }
}

/** 终端帧的应答：形状对、内容固定。归属不在这里判（脚本化机器不是 connector），要测拒绝就设 refusePty */
function respondPty(m: Machine, msg: Extract<CenterMsg, { t: `pty-${string}` }>): void {
  if (m.refusePty) {
    m.send({ t: 'err', rid: msg.rid, message: m.refusePty === 'forbidden' ? '这不是你的终端' : '这个终端不存在或已经关闭', code: m.refusePty })
    return
  }
  const info = (ptyId: string, actor: string, root = '/tmp', cols = 80, rows = 24): PtyInfo => ({
    ptyId, actor, root, cols, rows, alive: true, exitCode: null, createdAt: Date.now(),
  })
  switch (msg.t) {
    case 'pty-open': {
      const pty = info(`PTY-${m.ptys.length + 1}`, msg.actor, msg.root, msg.cols || 80, msg.rows || 24)
      m.ptys.push(pty)
      m.send({ t: 'res', rid: msg.rid, project: { op: 'pty-open', pty } })
      break
    }
    case 'pty-list':
      m.send({ t: 'res', rid: msg.rid, project: { op: 'pty-list', ptys: m.ptys } })
      break
    case 'pty-attach': {
      const pty = m.ptys.find((p) => p.ptyId === msg.ptyId) ?? info(msg.ptyId, msg.actor)
      if (m.ptySnapshot && msg.after < 0) {
        const snapshot = m.ptySnapshot
        m.send({ t: 'res', rid: msg.rid, project: { op: 'pty-attach', pty, replay: [], last: snapshot.seq, lost: false, snapshot } })
        break
      }
      const replay = m.ptyReplay.filter((c) => c.seq > msg.after)
      m.send({ t: 'res', rid: msg.rid, project: { op: 'pty-attach', pty, replay, last: m.ptyReplay.at(-1)?.seq ?? -1, lost: false } })
      break
    }
    default:
      m.send({ t: 'res', rid: msg.rid, project: { op: msg.t as 'pty-input' | 'pty-resize' | 'pty-close' | 'pty-detach' } })
  }
}

/** 用长期 token 连上并 hello；等到 welcome。同一台机器可以断线后用同一个 token 再连（新的 frames） */
export async function connectMachine(init: { id: string; name: string; token: string; caps?: string[] }): Promise<Machine> {
  const frames: CenterMsg[] = []
  const ws = new WebSocket(`${base.replace('http', 'ws')}${CONNECTOR_PATH}`, { headers: { [CONNECTOR_TOKEN_HEADER]: init.token } })
  const { caps, ...identity } = init
  const m: Machine = {
    ...identity,
    ws,
    frames,
    hold: false,
    held: [],
    sessions: [],
    ptys: [],
    ptyReplay: [{ seq: 0, data: '$ ' }],
    ptySnapshot: null,
    quickDeltas: ['改', '好了'],
    quickHold: false,
    heldQuick: [],
    writeConflict: false,
    refusePty: null,
    shares: new Map(),
    httpHandler: null,
    wsHandler: null,
    send: (msg) => ws.send(JSON.stringify(msg)),
    driven: () => frames.filter(isDrivenMsg),
    by: (actor) => frames.filter(isDrivenMsg).filter((f) => f.actor === actor),
    of: <T extends CenterMsg['t']>(t: T) => frames.filter((f) => f.t === t) as Extract<CenterMsg, { t: T }>[],
  }
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as CenterMsg
    frames.push(msg)
    respond(m, msg)
  })
  const opened = Promise.withResolvers<void>()
  ws.once('open', () => opened.resolve())
  ws.once('error', (err) => opened.reject(err))
  await opened.promise
  machines.push(m)
  m.send({ t: 'hello', name: init.name, defaultCwd: '/tmp', agents: AGENTS, caps: caps ?? ['project'] })
  await waitFor(() => frames.some((f) => f.t === 'welcome'))
  return m
}

/** 建机器 + 连上；ownerId = 这台机器的主人（相当于在浏览器里确认配对的人）。
 *  成员配对的机器本来是 pending（等空间 owner 批准），这里默认当场批准，矩阵类测试要的是已在空间里生效的机器。
 *  要测 pending 本身，自己 provisionConnector + connectMachine（见 member-connect.test.ts） */
export async function pairMachine(spaceId: string, ownerId: string, name: string, caps?: string[]): Promise<Machine> {
  const paired = await provisionConnector(pool, { spaceId, ownerId, name })
  await approveConnector(pool, paired.connectorId)
  return connectMachine({ id: paired.connectorId, name, token: paired.token, ...(caps ? { caps } : {}) })
}
