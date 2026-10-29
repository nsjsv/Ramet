/* ---------- 浏览器里打 zip（无依赖）----------
 * 导出在浏览器里做（序列化用的是活编辑器的 markdown 序列化，服务端没有第二套）：文本文件用 CompressionStream('deflate-raw')
 * 压缩，图片 / 附件原样存储（已经是压缩格式）。文件名按 UTF-8 写（flag 0x0800）。不支持 zip64（单文件 / 总量 4GB、
 * 6.5 万个文件以上），导出场景用不到。 */

export type ZipFile = { path: string; data: Uint8Array | string; /** 不压缩直接存（图片 / 附件） */ store?: boolean }

const encoder = new TextEncoder()

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export async function buildZip(files: ZipFile[], now = new Date()): Promise<Blob> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  const { time, date } = dosStamp(now)
  let offset = 0
  for (const file of files) {
    const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data
    const packed = file.store ? null : await deflateRaw(raw)
    // 压缩没变小就存原样（小文件常见）
    const useDeflate = packed !== null && packed.length < raw.length
    const body = useDeflate ? packed : raw
    const method = useDeflate ? 8 : 0
    const name = encoder.encode(file.path)
    const crc = crc32(raw)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local, body)

    const entry = new Uint8Array(46 + name.length)
    const ev = new DataView(entry.buffer)
    ev.setUint32(0, 0x02014b50, true)
    ev.setUint16(4, 20, true)
    ev.setUint16(6, 20, true)
    ev.setUint16(8, 0x0800, true)
    ev.setUint16(10, method, true)
    ev.setUint16(12, time, true)
    ev.setUint16(14, date, true)
    ev.setUint32(16, crc, true)
    ev.setUint32(20, body.length, true)
    ev.setUint32(24, raw.length, true)
    ev.setUint16(28, name.length, true)
    ev.setUint32(42, offset, true)
    entry.set(name, 46)
    central.push(entry)
    offset += local.length + body.length
  }
  const size = central.reduce((n, e) => n + e.length, 0)
  const end = new Uint8Array(22)
  const dv = new DataView(end.buffer)
  dv.setUint32(0, 0x06054b50, true)
  dv.setUint16(8, files.length, true)
  dv.setUint16(10, files.length, true)
  dv.setUint32(12, size, true)
  dv.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end] as BlobPart[], { type: 'application/zip' })
}
