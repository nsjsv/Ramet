/* ---------- 文件落库（上传路由与导入共用） ----------
 * 原图落盘 UPLOAD_DIR/<uuid>，图片（非 gif）另生成 <uuid>.webp 的 display 版；同内容（sha256）静默复用已有行 ——
 * 不落盘、不插表、不跑 sharp。先落盘后插表：行可见时文件必已在磁盘。文件永不删除（版本回溯契约）。 */

import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { variantPath } from './uploads.js'

// display 版参数:最长边 1600(浏览器内显示够用),webp q80;原图永不被改写
const DISPLAY_MAX_EDGE = 1600
const DISPLAY_QUALITY = 80

const INSERT_FILE = 'INSERT INTO files (id, name, mime, size, content_hash) VALUES ($1, $2, $3, $4, $5)'
// 查重命中取 size 也在内:响应形态要求原样回传已有行全部字段
const SELECT_FILE_BY_HASH = 'SELECT id, name, mime, size FROM files WHERE content_hash = $1 LIMIT 1'

export type StoredFile = { id: string; url: string; display: string; name: string; mime: string; size: number }

function stored(row: { id: string; name: string; mime: string; size: number }): StoredFile {
  return { id: row.id, url: `/api/files/${row.id}`, display: `/api/files/${row.id}/display`, name: row.name, mime: row.mime, size: row.size }
}

/** onStored：新落了一行（查重命中不算）时回调，图床镜像据此入队（imgbed-sync.ts）；不阻塞、不抛给调用方 */
export async function storeFile(pool: Pool, data: Buffer, name: string, mime: string, onStored?: (id: string) => void): Promise<StoredFile> {
  // 查重:同 hash 静默复用已有行;NULL 永不相等:存量老行(未回填 hash)永不命中,重传多落一份属可接受
  const contentHash = createHash('sha256').update(data).digest('hex')
  const dup = (await pool.query<{ id: string; name: string; mime: string; size: number }>(SELECT_FILE_BY_HASH, [contentHash])).rows[0]
  if (dup) return stored(dup)
  const id = randomUUID()
  // 磁盘名恒为 uuid:用户提供的文件名(可能带怪字符)只进 DB,用于下载时的 Content-Disposition
  await writeFile(variantPath(id, 'orig'), data)
  // display 版:图片(非 gif,动图压成静帧不如退原图)才生成;失败静默跳过 —— GET /display 会退回原图
  if (mime.startsWith('image/') && mime !== 'image/gif') {
    try {
      const webp = await sharp(data)
        .resize({ width: DISPLAY_MAX_EDGE, height: DISPLAY_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: DISPLAY_QUALITY })
        .toBuffer()
      await writeFile(variantPath(id, 'display'), webp)
    } catch {
      // fallthrough:无 display 版,前端退原图
    }
  }
  await pool.query(INSERT_FILE, [id, name, mime, data.length, contentHash])
  onStored?.(id)
  return stored({ id, name, mime, size: data.length })
}
