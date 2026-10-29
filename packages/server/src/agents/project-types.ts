// ---------- 项目面板：中心 ↔ connector 之间的回复形状、上限与错误 ----------
// 项目面板用来浏览 / 查看 agent 所在机器上的工作区（文件树、文件内容、git 只读改动）。执行端只有 connector，
// 中心只鉴权、转发。这里的类型两端共用；常量是执行端的上限（中心不重复裁剪，只转发）。
// 所有项目帧都是 machine 范围的驱动帧（见 protocol.ts 的 DRIVEN_SCOPE）：别人的机器上的文件不是公开的，
// 读也算，中心要 assertCanUse(..., 'machine') 签凭据才能发，connector 收到后再按 actor 判一次。

import { PREVIEW_CAP } from './preview-types.js'
import { TERMINAL_CAP, type PtyReply } from './pty-types.js'

/** hello 里的能力标记：带 'project' 的 connector 认识下面的五种只读帧（写文件是另一个能力 'write'）。老 connector 没有这个标记，
 *  中心不发新帧（发了它也只会在 switch 里掉进 default 不应答，等到超时），接口回 409 */
export const PROJECT_CAP = 'project'
/** 随手 AI 的本地通道（quick 帧：在这台机器上用 agent 单次改写，受限会话）。老 connector 没有，中心回 409 connector outdated */
export const QUICK_CAP = 'quick'
/** 写文件（write 帧：代码查看器里收下随手 AI 的改写）。带 'project' 但没有 'write' 的老 connector，中心回 409 connector outdated，不发帧 */
export const WRITE_CAP = 'write'
/** prompt 帧里的图片块（这一轮那条用户消息里的截图，PromptBlock 的 image 变体）。老 connector 的 AcpAgent 不认它
 *  （会当成 resource 块发出去），中心发帧前把图片块剥掉，只发文本 */
export const PROMPT_IMAGE_CAP = 'prompt-image'
/** 新 connector 一定有的能力（不含 terminal：它依赖 node-pty，装不上就没有，见 connectorCaps）。preview 是端口预览 */
export const CONNECTOR_CAPS: string[] = [PROJECT_CAP, PREVIEW_CAP, QUICK_CAP, WRITE_CAP, PROMPT_IMAGE_CAP]

/** connector 的 hello 里上报的能力：node-pty 加载成功才多一个 terminal */
export function connectorCaps(terminal: boolean): string[] {
  return terminal ? [...CONNECTOR_CAPS, TERMINAL_CAP] : [...CONNECTOR_CAPS]
}

/** 单目录最多回多少条（超出标 truncated）：node_modules 这类目录动辄上万条，浏览器与中继都不该吃这个带宽 */
export const TREE_MAX_ENTRIES = 1000
/** 读文件最多回多少字节（超出只给前这么多并标 truncated） */
export const READ_MAX_BYTES = 1024 * 1024
/** ⌘P 文件清单条数上限 */
export const FILES_MAX = 20_000
/** 改动文件列表条数上限 */
export const STATUS_MAX_FILES = 3000
/** 单次 diff 最多回多少字节 */
export const DIFF_MAX_BYTES = 1024 * 1024

/** 单个文件的改动标记（合并了暂存区与工作区）：M 修改 · A 新增 · D 删除 · R 重命名 / 复制 · U 冲突 · ? 未跟踪 */
export type GitMark = 'M' | 'A' | 'D' | 'R' | 'U' | '?'

/** type：dir / file；link = 指向工作区外或已失效的符号链接（不可展开、不可打开）。
 *  指向工作区内的符号链接按目标类型给 dir / file（带 link: true） */
export type TreeEntry = { name: string; type: 'dir' | 'file' | 'link'; size?: number; link?: true; git?: GitMark }

export type TreeReply = { op: 'tree'; path: string; entries: TreeEntry[]; truncated: boolean }
export type ReadReply = {
  op: 'read'
  path: string
  /** 文件真实大小（字节） */
  size: number
  /** 二进制（前 READ_MAX_BYTES 字节里有 NUL）：不回内容 */
  binary: boolean
  text: string
  truncated: boolean
  /** 文件全部字节的 sha256（hex）。只有读全了的文本文件才有：二进制 / 超 READ_MAX_BYTES 截断的没有，不允许改。
   *  写回时当 baseHash 带上，connector 重读比对，不符说明读到之后文件被别人改过 */
  hash?: string
}
export type FilesReply = { op: 'files'; files: string[]; truncated: boolean }
export type GitFile = { path: string; mark: GitMark; /** 改动已在暂存区 */ staged: boolean; /** 重命名 / 复制的来源 */ from?: string }
export type GitStatusReply = {
  op: 'git-status'
  /** false 表示工作区不是 git 仓库（或本机没有 git） */
  repo: boolean
  branch: string | null
  /** 游离 HEAD（没有分支名） */
  detached?: true
  ahead?: number
  behind?: number
  files: GitFile[]
  truncated: boolean
}
export type GitDiffReply = { op: 'git-diff'; path?: string; diff: string; truncated: boolean }
/** 写文件的应答：path = 实际写到的文件（符号链接解开后，相对 root），hash = 写完之后的 sha256（下一次写的 baseHash） */
export type WriteReply = { op: 'write'; path: string; hash: string }

/** 端口预览的登记 / 撤销应答（真正的流量走 http-* / ws-* 帧，不在 res 里） */
export type PreviewReply = { op: 'port-share' } | { op: 'port-unshare' }

/** 项目面板的全部应答（res.project）：文件类 + 终端类（pty-types.ts）+ 预览登记共用一条通道，中心的 askProject 通用 */
export type ProjectReply = TreeReply | ReadReply | FilesReply | GitStatusReply | GitDiffReply | WriteReply | PtyReply | PreviewReply

/** connector 太旧，不认项目帧，接口回 409 */
export class ConnectorOutdatedError extends Error {
  constructor(message = '这台机器上的 connector 版本太旧，升级后才能用项目面板') {
    super(message)
  }
}

/** connector 有项目面板能力，但没有终端能力（node-pty 没装上），终端接口回 409 */
export class TerminalUnsupportedError extends ConnectorOutdatedError {
  constructor() {
    super('这台机器上的 connector 不支持终端（node-pty 没装上）')
  }
}

/** 执行端（connector）拒绝或失败：message 是人话，原样给用户看。
 *  forbidden 是拒绝（第二道闸：本机名单；或终端不是你的）；notFound 是终端不存在；conflict 是写文件时文件已被改动（baseHash 不符） */
export class ProjectError extends Error {
  constructor(
    message: string,
    readonly forbidden = false,
    readonly notFound = false,
    readonly conflict = false,
  ) {
    super(message)
  }
}
