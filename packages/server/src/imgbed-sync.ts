/* ---------- 图床镜像：队列 + 回读校验 + 补传扫描 + 断路器 ----------
 * 本地永远是正本（上传流程不变，文件永不删除），图床是第二份、也是默认的出图处。
 * - 上传后 storeFile 入队 orig + display；/icon 惰性生成后入队 icon；定时扫描兜底（存量补传、克隆出的新行、失败重试）。
 * - 队列串行，两次上传之间至少隔 spacingMs：TG bot 往同一频道约 20 条 / 分钟，超了图床回 400。
 * - 每份传完从图床读回比 sha256，一致才记 ok，读入口只认 ok 行（routes/files.ts），所以图床哪怕压了图，用户也拿不到。
 *   不一致记 skip（永不再传，last_error 记原因）；其它失败记 failed，按 2^attempts 分钟退避重试，上限一天。
 * - 断路器：定时读一份已镜像的小图，连续 PROBE_FAILS 次失败就打开（不跳转、队列暂停），一次成功即关闭。
 * - 域名经 CF 且 /api/files 会被边缘缓存（按源站 Cache-Control）：「以后还可能换到图床」的本地响应必须是短的 private 缓存
 *   （route().pending，见 routes/files.ts），否则那一刻的 200 会在 CF 上存一年，这份就再也走不到图床。
 *   探测在服务器上做，只反映图床本身的死活；浏览器那头的可达性由前端 file-fallback.ts 兜底。
 * 只镜像 sharp 认得出的位图原图（不信客户端 mime）；SVG 不上图床：图床域名上有后台会话，SVG 原图会成存储型 XSS。 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { Pool } from 'pg'
import { fetchFromBed, imgbedFromEnv, uploadToBed, type ImgbedConfig } from './imgbed.js'
import { variantPath, type FileVariant } from './uploads.js'

/** 读入口问一份文件该去哪：url = 302 到图床；url 为 null 时本地出，pending = 这份以后还可能换到图床
 *  （还没传完 / 传失败 / 断路器开着）。这时本地响应不能让 CF 边缘与浏览器长缓存，否则传好之后也永远到不了图床 */
export type BedRoute = { url: string | null; pending: boolean }

export type ImgbedSync = {
  /** candidate = 这份能上图床（原图要 mime 是 image/*；display / icon 恒是）。未配置 = 恒 { null, false }（与没有图床时一样） */
  route(fileId: string, variant: FileVariant, candidate: boolean): Promise<BedRoute>
  enqueue(fileId: string, variants?: FileVariant[]): void
  /** 起定时器并立刻扫一次（startServer 监听成功后调） */
  start(): void
  scan(): Promise<void>
  probe(): Promise<void>
  /** 测试用：等队列跑空 */
  idle(): Promise<void>
  dispose(): Promise<void>
}

export type ImgbedSyncOptions = {
  /** 不传 = 读环境变量；null = 明确关闭 */
  config?: ImgbedConfig | null
  spacingMs?: number
  /** 0 = 不起定时器（测试手动调 probe / scan） */
  probeEveryMs?: number
  scanEveryMs?: number
}

const SPACING_MS = 3500
const PROBE_EVERY_MS = 60_000
const SCAN_EVERY_MS = 10 * 60_000
const PROBE_FAILS = 3
const PROBE_TIMEOUT_MS = 10_000
/** 一次扫描每个变体最多入队这么多（新的优先）；队列跑完下一轮再取 */
const SCAN_BATCH = 200
/** 原图能上图床的格式（sharp metadata 的 format）→ 上传用的扩展名与类型 */
const RASTER: Record<string, { ext: string; mime: string }> = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
  gif: { ext: 'gif', mime: 'image/gif' },
}

const SELECT_ROUTE = 'SELECT status, path FROM file_mirrors WHERE file_id = $1 AND variant = $2'
// 退避：failed 行 2^attempts 分钟内不再试（上限一天）。扫描与单个任务用同一条口径，
// 否则 /icon 每被请求一次就绕过退避重传一次
const BACKOFF = 'make_interval(mins => LEAST(power(2, m.attempts), 1440)::int)'
const SELECT_MIRROR = `SELECT m.status, m.attempts, m.updated_at >= now() - ${BACKOFF} AS cooling
  FROM file_mirrors m WHERE m.file_id = $1 AND m.variant = $2`
const UPSERT_MIRROR = `INSERT INTO file_mirrors (file_id, variant, status, path, attempts, last_error, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, now())
  ON CONFLICT (file_id, variant) DO UPDATE SET status = EXCLUDED.status, path = EXCLUDED.path,
    attempts = EXCLUDED.attempts, last_error = EXCLUDED.last_error, updated_at = now()`
// 「还要处理」= 没有行，或 failed 且退避期已过
const NEEDS_WORK = `NOT EXISTS (SELECT 1 FROM file_mirrors m WHERE m.file_id = x.id AND m.variant = $1
  AND NOT (m.status = 'failed' AND m.updated_at < now() - ${BACKOFF}))`
const SCAN_FILES = `SELECT x.id FROM files x WHERE x.mime LIKE 'image/%' AND ${NEEDS_WORK} ORDER BY x.created_at DESC LIMIT $2`
// 图标只看真被当图标 / 头像用的文件；盘上还没生成的跳过（等 /icon 被请求时生成并入队）
const SCAN_ICONS = `SELECT x.id FROM (SELECT icon_file_id AS id FROM pages WHERE icon_file_id IS NOT NULL
  UNION SELECT avatar_file_id FROM users WHERE avatar_file_id IS NOT NULL) x WHERE ${NEEDS_WORK} LIMIT $2`
// 探测挑最近的一份小图（图标 > display > 原图），省图床流量
const PROBE_TARGET = `SELECT path FROM file_mirrors WHERE status = 'ok'
  ORDER BY CASE variant WHEN 'icon' THEN 0 WHEN 'display' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`

type Job = { fileId: string; variant: FileVariant }
type Local = { data: Buffer; name: string; type: string }

const OFF: ImgbedSync = {
  route: async () => ({ url: null, pending: false }),
  enqueue: () => {},
  start: () => {},
  scan: async () => {},
  probe: async () => {},
  idle: async () => {},
  dispose: async () => {},
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref())
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

// 本地那份要上传的字节；null = 该变体不存在或不适合上图床
async function localVariant(id: string, variant: FileVariant, mime: string): Promise<Local | null> {
  if (variant === 'orig' && !mime.startsWith('image/')) return null // 不为探测格式把视频之类整读进内存
  const path = variantPath(id, variant)
  if (!existsSync(path)) return null
  const data = await readFile(path)
  if (variant !== 'orig') return { data, name: `${id}.${variant}.webp`, type: 'image/webp' }
  let format: string | undefined
  try {
    format = (await sharp(data).metadata()).format
  } catch {
    return null
  }
  const kind = format ? RASTER[format] : undefined
  return kind ? { data, name: `${id}.${kind.ext}`, type: kind.mime } : null
}

export function createImgbedSync(pool: Pool, opts: ImgbedSyncOptions = {}): ImgbedSync {
  const found = opts.config === undefined ? imgbedFromEnv() : opts.config
  if (!found) return OFF
  const cfg: ImgbedConfig = found
  const spacingMs = opts.spacingMs ?? SPACING_MS
  const probeEveryMs = opts.probeEveryMs ?? PROBE_EVERY_MS
  const scanEveryMs = opts.scanEveryMs ?? SCAN_EVERY_MS
  const abort = new AbortController()
  const timers: NodeJS.Timeout[] = []
  const pending: Job[] = []
  const queued = new Set<string>()
  let pumping: Promise<void> | null = null
  let scanning: Promise<void> | null = null
  let open = false
  let fails = 0

  const key = (j: Job): string => `${j.fileId}:${j.variant}`
  const settle = (j: Job, status: 'ok' | 'failed' | 'skip', path: string | null, attempts: number, error: string | null) =>
    pool.query(UPSERT_MIRROR, [j.fileId, j.variant, status, path, attempts, error])

  // 处理一个任务；回 true = 真打了图床（调用方据此限速）
  async function runJob(job: Job): Promise<boolean> {
    const prev = (await pool.query<{ status: string; attempts: number; cooling: boolean }>(SELECT_MIRROR, [job.fileId, job.variant])).rows[0]
    if (prev && (prev.status !== 'failed' || prev.cooling)) return false
    const file = (await pool.query<{ mime: string }>('SELECT mime FROM files WHERE id = $1', [job.fileId])).rows[0]
    if (!file) return false
    const local = await localVariant(job.fileId, job.variant, file.mime)
    if (!local) {
      // 图标还没生成不算定论（以后被请求时会生成并再入队）；其余变体本地没有就是永远没有
      if (job.variant !== 'icon') await settle(job, 'skip', null, prev?.attempts ?? 0, null)
      return false
    }
    const attempts = (prev?.attempts ?? 0) + 1
    try {
      const path = await uploadToBed(cfg, local.data, local.name, local.type, abort.signal)
      const back = await fetchFromBed(cfg, path, abort.signal)
      if (sha256(back) !== sha256(local.data)) {
        console.error(`[imgbed] ${key(job)} 回读字节与本地不一致（图床压过图？），该份一直本地出`)
        await settle(job, 'skip', path, attempts, '回读字节与本地不一致')
      } else {
        await settle(job, 'ok', path, attempts, null)
      }
    } catch (err) {
      if (abort.signal.aborted) return true
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[imgbed] ${key(job)} 第 ${attempts} 次上传失败: ${msg}`)
      await settle(job, 'failed', null, attempts, msg.slice(0, 500))
    }
    return true
  }

  function pump(): void {
    if (pumping || open || abort.signal.aborted) return
    pumping = (async () => {
      while (!open && !abort.signal.aborted) {
        const job = pending.shift()
        if (!job) break
        queued.delete(key(job))
        let hit = false
        try {
          hit = await runJob(job)
        } catch (err) {
          if (!abort.signal.aborted) console.error(`[imgbed] ${key(job)} 镜像任务出错:`, err)
        }
        if (hit && spacingMs > 0) await sleep(spacingMs)
      }
    })().finally(() => {
      pumping = null
      // 收尾那一刻进来的任务：上面的循环已经退出，重新拉起
      if (pending.length > 0) pump()
    })
  }

  function enqueue(fileId: string, variants: FileVariant[] = ['orig', 'display']): void {
    if (abort.signal.aborted) return
    for (const variant of variants) {
      const job = { fileId, variant }
      if (queued.has(key(job))) continue
      queued.add(key(job))
      pending.push(job)
    }
    pump()
  }

  async function scanOnce(): Promise<void> {
    for (const variant of ['orig', 'display'] as const) {
      const rows = (await pool.query<{ id: string }>(SCAN_FILES, [variant, SCAN_BATCH])).rows
      for (const r of rows) enqueue(r.id, [variant])
    }
    const icons = (await pool.query<{ id: string }>(SCAN_ICONS, ['icon', SCAN_BATCH])).rows
    for (const r of icons) if (existsSync(variantPath(r.id, 'icon'))) enqueue(r.id, ['icon'])
  }

  function scan(): Promise<void> {
    if (open || abort.signal.aborted) return Promise.resolve()
    scanning ??= scanOnce()
      .catch((err: unknown) => {
        if (!abort.signal.aborted) console.error('[imgbed] 补传扫描失败:', err)
      })
      .finally(() => {
        scanning = null
      })
    return scanning
  }

  function setOpen(next: boolean): void {
    if (open === next) return
    open = next
    if (next) console.error(`[imgbed] 图床连续 ${PROBE_FAILS} 次探测失败，暂停跳转与上传，全部本地出`)
    else {
      console.log('[imgbed] 图床恢复，重新跳转')
      pump()
    }
  }

  async function probe(): Promise<void> {
    if (abort.signal.aborted) return
    try {
      const target = (await pool.query<{ path: string }>(PROBE_TARGET)).rows[0]
      if (!target) return
      await fetchFromBed(cfg, target.path, abort.signal, PROBE_TIMEOUT_MS)
      fails = 0
      setOpen(false)
    } catch (err) {
      if (abort.signal.aborted) return
      fails += 1
      if (fails >= PROBE_FAILS) setOpen(true)
      else console.error(`[imgbed] 探测失败（${fails}/${PROBE_FAILS}）:`, err instanceof Error ? err.message : err)
    }
  }

  return {
    async route(fileId, variant, candidate) {
      const row = (await pool.query<{ status: string; path: string | null }>(SELECT_ROUTE, [fileId, variant])).rows[0]
      if (row?.status === 'ok' && row.path && !open) return { url: `${cfg.publicUrl}${row.path}`, pending: false }
      if (row?.status === 'skip' || !candidate) return { url: null, pending: false }
      return { url: null, pending: true }
    },
    enqueue,
    start() {
      void scan()
      if (probeEveryMs > 0) timers.push(setInterval(() => void probe(), probeEveryMs))
      if (scanEveryMs > 0) timers.push(setInterval(() => void scan(), scanEveryMs))
      for (const t of timers) t.unref()
    },
    scan,
    probe,
    async idle() {
      while (!open && !abort.signal.aborted && (pumping || scanning || pending.length > 0)) await sleep(5)
    },
    async dispose() {
      abort.abort()
      for (const t of timers) clearInterval(t)
      pending.length = 0
      queued.clear()
      await Promise.allSettled([pumping, scanning])
    },
  }
}
