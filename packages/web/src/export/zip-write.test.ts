import { inflateRawSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { buildZip, crc32 } from './zip-write'

/* 不变量：打出来的 zip 能被标准读法读回（目录项、方法、crc、UTF-8 文件名、压缩与存储两种内容都对） */

/** 测试里的最小读取：走中央目录 */
async function readBack(blob: Blob): Promise<Record<string, Buffer>> {
  const buf = Buffer.from(await blob.arrayBuffer())
  const eocd = buf.length - 22
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50)
  const total = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const out: Record<string, Buffer> = {}
  for (let i = 0; i < total; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const packed = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(data.length).toBe(size)
    expect(crc32(new Uint8Array(data))).toBe(crc)
    out[name] = data
  }
  return out
}

test('文本压缩、二进制存储、中文文件名、空文件，全部读得回', async () => {
  const text = '# 标题\n\n' + '正文 '.repeat(500)
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
  const zip = await buildZip([
    { path: '页面一/index.md', data: text },
    { path: '页面一/a.png', data: png, store: true },
    { path: 'empty.txt', data: '' },
  ])
  const back = await readBack(zip)
  expect(Object.keys(back)).toEqual(['页面一/index.md', '页面一/a.png', 'empty.txt'])
  expect(back['页面一/index.md']!.toString('utf8')).toBe(text)
  expect([...back['页面一/a.png']!]).toEqual([...png])
  expect(back['empty.txt']!.length).toBe(0)
})

test('crc32 与标准值一致', () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
})
