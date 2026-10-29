// ---------- 最小 zip 读取（只读、无依赖）----------
// 导入 skill 用（上传的 zip 与 GitHub codeload zip）。只认存储（0）与 deflate（8），加密和 zip64 报错。
// 路径经过规整并拒绝绝对路径与 `..`（zip slip），跳过目录项与 macOS 的 __MACOSX / .DS_Store。
// 总条数与解压后总字节有上限，防压缩炸弹。
import { inflateRawSync } from 'node:zlib'

export type ZipEntry = { path: string; data: Buffer }

export class ZipError extends Error {}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function readZip(buf: Buffer, limits: { entries: number; bytes: number } = { entries: 3000, bytes: 40 * 1024 * 1024 }): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('不是有效的 zip 文件')
  const total = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  if (at === 0xffffffff || total === 0xffff) throw new ZipError('不支持 zip64')
  if (total > limits.entries) throw new ZipError(`zip 里的文件太多（上限 ${limits.entries}）`)
  const out: ZipEntry[] = []
  let bytes = 0
  for (let n = 0; n < total; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('zip 目录损坏')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const path = safePath(name)
    if (!path) continue
    if (flags & 1) throw new ZipError('不支持加密的 zip')
    bytes += size
    if (bytes > limits.bytes) throw new ZipError('zip 解压后太大')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new ZipError('zip 文件头损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + compressed)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw new ZipError(`不支持的压缩方式 ${method}`)
    out.push({ path, data })
  }
  return out
}

/** 规整一个包内路径（zip 条目与浏览器选的文件夹里的相对路径共用）：
 *  反斜杠换成 /、去掉 ./，macOS 杂物（__MACOSX / .DS_Store）返回 null，
 *  绝对路径与 `..`（zip slip）直接报错，因为路径之后会被拼进缓存目录 */
export function safePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new ZipError(`不安全的路径：${raw}`)
  const parts = path.split('/')
  if (parts.includes('..') || parts.includes('')) throw new ZipError(`不安全的路径：${raw}`)
  if (parts[0] === '__MACOSX' || parts[parts.length - 1] === '.DS_Store') return null
  return path
}
