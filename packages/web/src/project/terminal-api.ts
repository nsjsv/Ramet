/* ---------- 终端的 REST 客户端（server routes/project-pty.ts）+ WebSocket 地址 ----------
 * 终端 = agent 所在机器上的一个 shell（pty 在 connector 上，中心只转发）。归 machine 范围：没有授权的人拿到的是 403，
 * 机器离线 / connector 太旧 / node-pty 没装上是 409，request() 抛的 ApiError.message 已是服务端的人话，直接展示。
 * 这里只有 list / open / close；订阅（快照 / 输出）、输入、改尺寸都走一条 WebSocket（terminal-session.ts，服务端 routes/pty-socket.ts）。 */

import { request } from '../api'

export interface TermInfo {
  ptyId: string
  /** 终端的起始目录（执行端的绝对路径） */
  root: string
  /** 起的是哪个 shell（zsh / bash…）；老 connector 没有 */
  shell?: string
  cols: number
  rows: number
  /** false = 进程已经退出（终端还留着，回放还能看，要手动关掉） */
  alive: boolean
  /** 退出码；还活着 / 被信号杀掉 = null */
  exitCode: number | null
  createdAt: number
  /** 是不是我打开的。不是我的（只有机器主人能看到）只能关，不能输入 */
  mine: boolean
  /** 打开它的人的用户名 */
  owner: string
}

export interface TermList {
  /** 我是这台机器的主人：列表里有这台机器上所有人的终端 */
  isOwner: boolean
  ptys: TermInfo[]
}

const base = (pageId: string, agent: string, suffix = ''): string =>
  `/api/pages/${pageId}/project/pty${suffix}?agent=${encodeURIComponent(agent)}`

export const terminalApi = {
  list: (pageId: string, agent: string) => request<TermList>(base(pageId, agent)),
  open: (pageId: string, agent: string, cols: number, rows: number) =>
    request<{ pty: TermInfo }>(base(pageId, agent), { method: 'POST', body: JSON.stringify({ cols, rows }) }),
  close: (pageId: string, agent: string, ptyId: string) =>
    request<{ ok: true }>(base(pageId, agent, `/${ptyId}`), { method: 'DELETE' }),
  /** 终端的 WebSocket 地址。after = 已经写进屏幕的最大 seq（全新打开 = -1 → 服务端给屏幕快照）。同源：https 页面自然是 wss */
  socketUrl: (pageId: string, agent: string, ptyId: string, after: number): string => {
    const q = new URLSearchParams({ page: pageId, agent, pty: ptyId, after: String(after) })
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/term?${q}`
  },
}
