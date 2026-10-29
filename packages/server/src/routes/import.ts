/* ---------- 导入与模板 ----------
 * POST /api/spaces/:id/import（multipart：file = .md / .markdown / .zip，parent = 可选的父页 id）
 *   把一个 markdown 文件或一包（Obsidian 库 / 文件夹打的 zip）建成页面树：规划与改写在 import-md.ts（纯函数），
 *   这里读包、只上传被引用的附件（file-store.ts，同内容复用）、建页（单事务）、写文档（newPageDoc，同 create_page）。
 *   权限同建页：空间 member 以上（viewer 403，非成员 404），父页须同空间。上限：包 60MB、解压 200MB、2000 页、单个附件 10MB。
 * POST /api/pages/:id/instantiate（JSON：space_id、parent_id?）
 *   从模板新建：把这一页（连子页）复制到目标空间 / 父页下（clone.ts 的 copyPageTree，与公开页克隆同一套），
 *   新页不是模板。源页只要读得到就行（设为模板只决定它出不出现在模板列表里）。 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Pool } from 'pg'
import type * as Y from 'yjs'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import { requireAuth, type AuthEnv } from '../auth.js'
import { collectSubtreeIds, copyPageTree, resolveDocs } from '../clone.js'
import { writeDocState } from '../collab.js'
import { withTransaction } from '../db.js'
import { storeFile, type StoredFile } from '../file-store.js'
import { ASSET_TOKEN, assetKind, finishBlocks, LinkIndex, MD_RE, planPages, rewriteMarkdown, type ImportFile } from '../import-md.js'
import { newPageDoc } from '../agents/markdown.js'
import { readZip, safePath, ZipError } from '../zip-read.js'
import { INSERT, pageRole, parentOk, roleInSpace, SELECT, SET_TITLE } from './pages.js'

const MAX_UPLOAD = 60 * 1024 * 1024
const MAX_UNZIPPED = 200 * 1024 * 1024
const MAX_PAGES = 2000
const MAX_ASSET = 10 * 1024 * 1024

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
}

function mimeOf(path: string): string {
  return MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

const baseName = (path: string): string => path.split('/').pop() ?? path
const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/')

/** 父页下现有子页的最大排序号（导入的页排在它们后面） */
const MAX_POSITION = `SELECT coalesce(max(position), -1) AS max FROM live_pages WHERE parent_id IS NOT DISTINCT FROM $1 AND space_id = $2`

/** onStored：新落的附件交给图床镜像入队（同 POST /api/files，见 file-store.ts） */
export function importRoutes(
  pool: Pool,
  notify?: () => void,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  onStored?: (fileId: string) => void,
) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)
  const limit = bodyLimit({ maxSize: MAX_UPLOAD, onError: (c) => c.json({ error: '导入的文件太大（上限 60MB）' }, 413) })

  app.post('/api/spaces/:id/import', auth, limit, async (c) => {
    const user = c.get('user')
    const spaceId = c.req.param('id')
    const role = await roleInSpace(pool, user, spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) return c.json({ error: 'file required' }, 400)
    const parentId = typeof body['parent'] === 'string' && body['parent'] ? body['parent'] : null
    if (!(await parentOk(pool, user, parentId, spaceId))) return c.json({ error: 'parent not found' }, 400)

    const buf = Buffer.from(await file.arrayBuffer())
    let files: ImportFile[]
    try {
      if (/\.zip$/i.test(file.name) || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
        files = readZip(buf, { entries: 10000, bytes: MAX_UNZIPPED })
      } else if (MD_RE.test(file.name)) {
        files = [{ path: safePath(baseName(file.name)) ?? 'untitled.md', data: buf }]
      } else {
        return c.json({ error: '只支持 .md / .markdown / .zip' }, 400)
      }
    } catch (err) {
      if (err instanceof ZipError) return c.json({ error: err.message }, 400)
      throw err
    }

    const pages = planPages(files, randomUUID)
    if (pages.length === 0) return c.json({ error: '没有找到 Markdown 文件' }, 400)
    if (pages.length > MAX_PAGES) return c.json({ error: `页面太多（上限 ${MAX_PAGES}）` }, 400)
    const index = new LinkIndex(pages, files)
    const byPath = new Map(files.map((f) => [f.path, f]))
    const rewritten = pages.map((p) =>
      p.mdPath ? rewriteMarkdown(byPath.get(p.mdPath)!.data.toString('utf8'), dirOf(p.mdPath), index) : { text: '', title: null, assets: [] },
    )

    // 只上传被引用到的附件（没被引用的不进来），超过单文件上限的保留原文链接
    const uploaded = new Map<string, StoredFile>()
    for (const r of rewritten) {
      for (const path of r.assets) {
        const f = byPath.get(path)
        if (uploaded.has(path) || !f || f.data.length > MAX_ASSET) continue
        uploaded.set(path, await storeFile(pool, f.data, baseName(path), mimeOf(path), onStored))
      }
    }
    const filesByUrl = new Map([...uploaded.values()].map((s) => [s.url, { name: s.name, size: s.size }]))
    const tokenRe = new RegExp(`${ASSET_TOKEN}(\\d+)`, 'g')

    const idOf = new Map(pages.map((p) => [p.key, p.id]))
    const titles = pages.map((p, i) => rewritten[i]!.title ?? p.title)
    const base = Number((await pool.query<{ max: number }>(MAX_POSITION, [parentId, spaceId])).rows[0]?.max ?? -1) + 1
    await withTransaction(pool, async (client) => {
      for (const [i, page] of pages.entries()) {
        const parent = page.parentKey ? idOf.get(page.parentKey)! : parentId
        await client.query(INSERT, [page.id, parent, user.id, spaceId, true])
        await client.query(SET_TITLE, [titles[i], page.id])
        await client.query('UPDATE pages SET position = $1 WHERE id = $2', [page.parentKey ? i : base + i, page.id])
      }
    })
    for (const [i, page] of pages.entries()) {
      const r = rewritten[i]!
      const text = r.text.replace(tokenRe, (whole, n: string) => {
        const path = r.assets[Number(n)]
        const done = path ? uploaded.get(path) : undefined
        return done ? done.url : path ? baseName(path) : whole
      })
      const blocks = finishBlocks(parseBlocks(text).blocks, filesByUrl)
      await writeDocState(pool, `page:${page.id}`, newPageDoc(titles[i]!, blocks))
    }
    notify?.()
    const roots = pages.filter((p) => !p.parentKey).map((p) => p.id)
    const media = [...uploaded.keys()].filter((p) => assetKind(p) !== 'file').length
    return c.json({ pages: pages.length, files: uploaded.size, media, roots })
  })

  app.post('/api/pages/:id/instantiate', auth, async (c) => {
    const user = c.get('user')
    const sourceId = c.req.param('id')
    const source = (await pool.query<{ space_id: string | null; owner_id: string | null }>(SELECT, [sourceId])).rows[0]
    if (!source || (await pageRole(pool, user, source)) === null) return c.json({ error: 'page not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { space_id?: unknown; parent_id?: unknown }
    const spaceId = typeof body.space_id === 'string' ? body.space_id : source.space_id
    if (!spaceId) return c.json({ error: 'space_id required' }, 400)
    const role = await roleInSpace(pool, user, spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null
    if (!(await parentOk(pool, user, parentId, spaceId))) return c.json({ error: 'parent not found' }, 400)
    const docs = await resolveDocs(pool, getLiveDoc, await collectSubtreeIds(pool, [sourceId]))
    const base = Number((await pool.query<{ max: number }>(MAX_POSITION, [parentId, spaceId])).rows[0]?.max ?? -1) + 1
    const newId = await withTransaction(pool, async (client) => {
      const { newRootIds } = await copyPageTree(client, [sourceId], spaceId, user.id, docs)
      const id = newRootIds[0]
      if (id) await client.query('UPDATE pages SET parent_id = $1, position = $2 WHERE id = $3', [parentId, base, id])
      return id
    })
    if (!newId) return c.json({ error: 'page not found' }, 404)
    notify?.()
    return c.json({ id: newId }, 201)
  })

  return app
}
