// ---------- 搬会话：中心 ↔ connector 之间的会话文件帧的应答形状、常量与校验 ----------
// 同一个工具从机器 X 换到机器 Y 时，原生会话的记录文件以中心那份为准：每轮从跑它的机器增量拉到中心，换机器时从中心写到目标机器。
// 执行端只有 connector：路径一律由那台机器上驱动的会话端口（drivers/<家>/session-port.ts）按工具规则算，中心只给
// agent / sessionId / cwd / 端口定义的不透明文件名。四种帧都是 machine 范围的驱动帧（protocol.ts 的 DRIVEN_SCOPE），
// 而且只认机器主人（会话记录里有工具结果和读过的文件内容，只在接入人自己的机器之间搬）。

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/** hello 里的能力标记：带它的 connector 认识 session-stat / session-read / session-write / session-close 四种帧 */
export const SESSION_CAP = 'session'

/** tailHash 取的尾巴长度：判断机器上的文件是不是只在中心已有的那段后面追加了内容（只追加的 JSONL 前缀不变） */
export const TAIL_BYTES = 4096
/** 单块读写的上限（解码后的字节）：中心与 connector 同一时刻只有一块在内存里 */
export const SESSION_CHUNK_BYTES = 1024 * 1024
/** 单个会话文件的上限：中心给的 size 超过它直接拒绝，免得一帧就把这台机器的磁盘占满 */
export const SESSION_FILE_MAX_BYTES = 1024 * 1024 * 1024
/** 会话帧在中心侧的等待上限：都是本机磁盘操作（close 要等驱动放掉会话），不需要冷启动那样的分钟级 */
export const SESSION_FRAME_TIMEOUT_MS = 60_000

/** 会话 id 只收这些字符：它会拼进本机路径（claude 的 <id>.jsonl、omp 的会话目录），不能带分隔符或 .. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id)
}

/** stat 里每个文件：tailHash = 文件在 known 给的长度处、最后 TAIL_BYTES 字节的 sha256（hex）；
 *  这个文件中心还没有（不在 known 里）或机器上的比 known 短（被整个重写过）= null，中心整份重拉 */
export type SessionFileStat = { name: string; size: number; tailHash: string | null }

export type SessionReply =
  | { op: 'session-stat'; files: SessionFileStat[] }
  /** data = base64；size = 读的那一刻文件的大小；eof = 这一块已经读到那一刻的文件末尾 */
  | { op: 'session-read'; data: string; size: number; eof: boolean }
  /** skipped = 内容寻址的文件（omp 的 blob）目标机器上已经有、哈希一致，不用再发后面的块 */
  | { op: 'session-write'; skipped?: true }
  | { op: 'session-close' }

/** 文件 [length - TAIL_BYTES, length) 的 sha256。中心对自己收到的那份、connector 对机器上的文件用同一个算法 */
export async function tailHashAt(path: string, length: number): Promise<string> {
  const start = Math.max(0, length - TAIL_BYTES)
  const buf = Buffer.alloc(length - start)
  const fh = await open(path, 'r')
  try {
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got)
      if (bytesRead === 0) throw new Error('文件比预期的短')
      got += bytesRead
    }
  } finally {
    await fh.close()
  }
  return createHash('sha256').update(buf).digest('hex')
}
