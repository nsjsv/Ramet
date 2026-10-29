// ---------- 项目面板的终端：中心 ↔ connector 之间 pty 帧的形状、上限与错误 ----------
// 终端 = connector 所在机器上的一个 pty（node-pty，只在 connector 进程里动态加载，中心进程永远不加载它）。
// pty 属于打开它的人（actor）：input / resize / attach / detach 只有他能做；关闭他或机器主人能做；
// 机器主人能看到这台机器上所有人的终端（列表 + 关闭），但不能往别人的终端里输入。
// 判定在 connector（PtyManager，按 actor 校验），中心不替它记归属，中心哪怕有 bug，这一关也过不去。
// 所有 pty 帧都是 machine 范围的驱动帧（protocol.ts 的 DRIVEN_SCOPE），要求 connector 在 hello 里声明 `terminal` 能力。

/** hello 里的能力标记：node-pty 在这台机器上加载成功才带。老 connector 和没装上 node-pty 的 connector 没有它，中心对它回 409 */
export const TERMINAL_CAP = 'terminal'

/** 每人每台机器最多同时开几个终端（已退出的不算，但会占一个回放槽直到被关 / 被清） */
export const PTY_MAX_PER_ACTOR = 5
/** 每个终端在 connector 上保留最近多少字节的输出：只用于短暂断线后按 seq 补差量。
 *  全新打开、或断得太久缓冲里已经接不上时，发屏幕快照（PtySnapshot），不再重放字节流 */
export const PTY_REPLAY_BYTES = 256 * 1024
/** 没有任何订阅者超过这么久就关掉（浏览器关了、中心断了都算没订阅者）。7 天：命令写一半走开，过几天回来接着用 */
export const PTY_IDLE_MS = 7 * 24 * 60 * 60_000
/** 屏幕快照带多少行滚动历史（当前屏之外）：1000 行，差网络下快照也在几十 KB 以内 */
export const SNAPSHOT_SCROLLBACK = 1000
/** 单次输入最多多少字符（粘贴大段文本才会逼近；网页端按它的一半分块发） */
export const PTY_INPUT_MAX = 64 * 1024
export const PTY_COLS_DEFAULT = 80
export const PTY_ROWS_DEFAULT = 24
export const PTY_COLS_MAX = 500
export const PTY_ROWS_MAX = 300

/** 一块输出：seq 在同一个 pty 内从 0 递增，回放与续传都按它 */
export type PtyChunk = { seq: number; data: string }

/** 屏幕快照：connector 上的无界面终端（connector/pty-screen.ts）此刻的样子，序列化成可以原样写回的转义序列
 *  （内容、颜色、光标、备用屏、终端模式，外加 SNAPSHOT_SCROLLBACK 行滚动历史）。
 *  seq = 快照包含到哪一块输出为止：seq ≤ 它的输出都已在快照里，之后只接 seq 更大的。
 *  cols / rows = 快照时的尺寸：网页端要先按这个尺寸写入，再调整成自己的尺寸（官方建议，否则会错位） */
export type PtySnapshot = { data: string; seq: number; cols: number; rows: number }

/** 一个终端的描述（pty-list / pty-open 应答）。actor = 打开它的人的 user id */
export type PtyInfo = {
  ptyId: string
  actor: string
  root: string
  /** 起的是哪个 shell（zsh / bash / sh…）；老 connector 没有 */
  shell?: string
  cols: number
  rows: number
  alive: boolean
  /** 退出码；还活着 / 被信号杀掉 = null */
  exitCode: number | null
  createdAt: number
}

/** 这些 op 与帧同名，放在 res.project 里（和项目面板的文件类应答同一条通道，askProject 通用） */
export type PtyReply =
  | { op: 'pty-open'; pty: PtyInfo }
  | { op: 'pty-input' }
  | { op: 'pty-resize' }
  | { op: 'pty-close' }
  | { op: 'pty-detach' }
  | {
      op: 'pty-attach'
      pty: PtyInfo
      /** seq > after 的、仍留在回放缓冲里的输出（≤ PTY_REPLAY_BYTES） */
      replay: PtyChunk[]
      /** 此刻最新的 seq（还没有输出 = -1）。此后 connector 直接推 pty-data（seq 更大） */
      last: number
      /** after 与缓冲里最老的一块之间有输出已经被挤掉了（回放不完整）。带快照时恒为 false（快照就是完整的） */
      lost: boolean
      /** 全新打开（after = -1）或断得太久接不上时给快照，此时 replay 为空、last = snapshot.seq。老 connector 没有 */
      snapshot?: PtySnapshot
    }
  | { op: 'pty-list'; ptys: PtyInfo[] }

/** pty-exit 的原因：exited = 进程自己退了，closed = 有人关的，revoked = 授权没了 / 收窄，idle = 太久没订阅者，shutdown = connector 收尾 */
export type PtyExitReason = 'exited' | 'closed' | 'revoked' | 'idle' | 'shutdown'

/** connector 拒绝 / 失败：message 是人话。forbidden = 不是你的终端；notFound = 终端不存在 */
export class PtyError extends Error {
  constructor(
    message: string,
    readonly kind: 'forbidden' | 'not_found' | 'failed' = 'failed',
  ) {
    super(message)
  }
}
