// ---------- 空间 skill：导入 / 新建 / 更新 / 读取 ----------
// 一个 skill 是一个 kind='skill' 的页面，权限、协同、历史、回收站都沿用页面那一套：
//   正文 = SKILL.md 的 markdown 正文（页面的协同文档）
//   name / description / 其余 frontmatter 在 skills 表里，不进正文，编辑器改不乱
//   附件 = skill_files（scripts / references / assets，相对 skill 根的路径）
// 页面 in_page_tree=false，不进页面树；skill 名在空间内唯一由 skills 表的 UNIQUE 保证（含回收站）。
//
// zip、浏览器选的文件夹、GitHub 仓库都先变成「路径 + 字节」列表，再走 bundlesOf → saveSkill。
// 更新就是重新导入同名 skill：附件整套替换，正文只在内容真有变化时才改写（不打断块 id 与历史）。

import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import * as Y from 'yjs'
import { parseBlocks, type Block } from '@ramet/shared/markdown-blocks'
import { materialize, newPageDoc } from './agents/markdown.js'
import { appendDocUpdate, insertSnapshot, loadDocForRead, type DocWriter } from './collab.js'
import { withTransaction } from './db.js'
import { fragmentToMarkdown } from './markdown-out.js'
import { emitSkillMd, parseSkillMd, SkillError, validateSkill, type SkillMeta } from './skill-md.js'
import { textOf } from './updates.js'
import { safePath, type ZipEntry } from './zip-read.js'

export const SKILL_LIMITS = {
  /** 一个 skill 的附件个数 / 单个大小 / 总大小 */
  files: 200,
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  /** 一次导入最多识别几个 skill（整仓导入时） */
  perImport: 50,
} as const

export type Actor = { id: string; role: string }

export type SkillEnv = {
  pool: Pool
  write: DocWriter
  getLiveDoc?: (docName: string) => Y.Doc | undefined
  /** 页面列表变了（新页 / 回收站恢复）：广播给在线端重拉 */
  notify?: () => void
}

export type SkillSource = { type: 'zip' | 'folder' | 'github'; url?: string }

export type SkillBundle = { root: string; meta: SkillMeta; body: string; files: Array<{ path: string; data: Buffer }> }

export type SkillInfo = {
  /** 页面 id */
  id: string
  spaceId: string
  name: string
  description: string
  extra: Record<string, unknown>
  source: (SkillSource & { at: string }) | null
  updatedAt: string
  /** 页面标题（展示用；skill 的身份是 name） */
  title: string
  files: number
  bytes: number
}

export type SkillFileInfo = { path: string; size: number; sha256: string }

// ---------- 包 → skill ----------

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const inside = (path: string, root: string): boolean => root === '' || path === root || path.startsWith(`${root}/`)
const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** 浏览器选的文件夹里的 (相对路径, 内容)：和 zip 条目走同一套路径规整 */
export function entriesOfUpload(files: Array<{ path: string; data: Buffer }>): ZipEntry[] {
  const out: ZipEntry[] = []
  for (const f of files) {
    const path = safePath(f.path)
    if (path) out.push({ path, data: f.data })
  }
  return out
}

/** 附件的数量 / 大小闸门，导入与逐个上传共用 */
function checkFiles(files: Array<{ path: string; size: number }>): void {
  if (files.length > SKILL_LIMITS.files) throw new SkillError(`附件太多（上限 ${SKILL_LIMITS.files} 个）`)
  let total = 0
  for (const f of files) {
    if (f.size > SKILL_LIMITS.fileBytes) throw new SkillError(`${f.path} 太大（单个文件上限 ${SKILL_LIMITS.fileBytes / 1024 / 1024}MB）`)
    total += f.size
  }
  if (total > SKILL_LIMITS.totalBytes) throw new SkillError(`附件总大小超过 ${SKILL_LIMITS.totalBytes / 1024 / 1024}MB`)
}

/** 路径 + 字节 → skill 包：每个 SKILL.md 所在目录是一个 skill 根，文件归属最深的那个根。
 *  某个 skill 不合规只记在 errors 里，不拖累同仓库里的其它 skill */
export function bundlesOf(entries: ZipEntry[], subdir = ''): { bundles: SkillBundle[]; errors: Array<{ root: string; error: string }> } {
  const scoped = entries.filter((e) => inside(e.path, subdir) && !e.path.split('/').some((seg) => SKIP_DIRS.has(seg)))
  const roots = [...new Set(scoped.filter((e) => baseOf(e.path) === 'SKILL.md').map((e) => dirOf(e.path)))]
  if (roots.length === 0) throw new SkillError('没有找到 SKILL.md（每个 skill 的根目录里都要有它）')
  if (roots.length > SKILL_LIMITS.perImport) throw new SkillError(`一次最多导入 ${SKILL_LIMITS.perImport} 个 skill`)
  const deepestFirst = [...roots].sort((a, b) => b.length - a.length)
  const owned = new Map<string, ZipEntry[]>(roots.map((r) => [r, []]))
  for (const e of scoped) {
    const root = deepestFirst.find((r) => inside(e.path, r))
    if (root !== undefined) owned.get(root)!.push(e)
  }

  const bundles: SkillBundle[] = []
  const errors: Array<{ root: string; error: string }> = []
  const seen = new Set<string>()
  for (const root of roots) {
    try {
      const prefix = root ? `${root}/` : ''
      const list = owned.get(root)!
      const main = list.find((e) => e.path === `${prefix}SKILL.md`)!
      const { meta, body } = parseSkillMd(main.data.toString('utf8'))
      const skill = validateSkill(meta)
      if (seen.has(skill.name)) throw new SkillError(`导入的包里有两个叫 ${skill.name} 的 skill`)
      const files = list.filter((e) => e !== main).map((e) => ({ path: e.path.slice(prefix.length), data: e.data }))
      checkFiles(files.map((f) => ({ path: f.path, size: f.data.length })))
      seen.add(skill.name)
      bundles.push({ root, meta: skill, body, files })
    } catch (err) {
      if (!(err instanceof SkillError)) throw err
      errors.push({ root: root || '（压缩包根目录）', error: err.message })
    }
  }
  return { bundles, errors }
}

// ---------- 读 ----------

const INFO_SELECT = `SELECT s.page_id AS id, s.space_id, s.name, s.description, s.extra, s.source, s.updated_at, p.title,
  (SELECT count(*)::int FROM skill_files f WHERE f.page_id = s.page_id) AS files,
  (SELECT coalesce(sum(octet_length(f.data)), 0)::int FROM skill_files f WHERE f.page_id = s.page_id) AS bytes
  FROM skills s JOIN live_pages p ON p.id = s.page_id`

type InfoRow = {
  id: string
  space_id: string
  name: string
  description: string
  extra: Record<string, unknown>
  source: (SkillSource & { at: string }) | null
  updated_at: Date
  title: string
  files: number
  bytes: number
}

const toInfo = (r: InfoRow): SkillInfo => ({
  id: r.id,
  spaceId: r.space_id,
  name: r.name,
  description: r.description,
  extra: r.extra,
  source: r.source,
  updatedAt: r.updated_at.toISOString(),
  title: r.title,
  files: r.files,
  bytes: r.bytes,
})

/** 空间里的活 skill（回收站里的不列），按名字排 */
export async function listSkills(pool: Pool, spaceId: string): Promise<SkillInfo[]> {
  const { rows } = await pool.query<InfoRow>(`${INFO_SELECT} WHERE s.space_id = $1 ORDER BY s.name`, [spaceId])
  return rows.map(toInfo)
}

export async function skillOfPage(pool: Pool, pageId: string): Promise<SkillInfo | null> {
  const { rows } = await pool.query<InfoRow>(`${INFO_SELECT} WHERE s.page_id = $1`, [pageId])
  return rows[0] ? toInfo(rows[0]) : null
}

export async function skillByName(pool: Pool, spaceId: string, name: string): Promise<SkillInfo | null> {
  const { rows } = await pool.query<InfoRow>(`${INFO_SELECT} WHERE s.space_id = $1 AND s.name = $2`, [spaceId, name])
  return rows[0] ? toInfo(rows[0]) : null
}

export async function skillFileList(pool: Pool, pageId: string): Promise<SkillFileInfo[]> {
  const { rows } = await pool.query<{ path: string; size: number; sha256: string }>(
    'SELECT path, octet_length(data)::int AS size, sha256 FROM skill_files WHERE page_id = $1 ORDER BY path',
    [pageId],
  )
  return rows
}

export async function skillFileData(pool: Pool, pageId: string, path: string): Promise<Buffer | null> {
  const { rows } = await pool.query<{ data: Buffer }>('SELECT data FROM skill_files WHERE page_id = $1 AND path = $2', [pageId, path])
  return rows[0]?.data ?? null
}

/** 页面正文（活文档优先）→ SKILL.md 的 markdown 正文 */
export async function skillBody(env: Pick<SkillEnv, 'pool' | 'getLiveDoc'>, pageId: string): Promise<string> {
  const doc = await loadDocForRead(env.pool, `page:${pageId}`, env.getLiveDoc)
  return fragmentToMarkdown(doc.getXmlFragment('prosemirror'))
}

/** 完整的 SKILL.md（frontmatter + 正文），下载 / 导出用 */
export async function skillMarkdown(env: SkillEnv, info: SkillInfo): Promise<string> {
  return emitSkillMd({ name: info.name, description: info.description, extra: info.extra }, await skillBody(env, info.id))
}

// ---------- 写 ----------

const SELECT_BY_NAME = `SELECT s.page_id, p.deleted_at FROM skills s JOIN pages p ON p.id = s.page_id
  WHERE s.space_id = $1 AND s.name = $2 FOR UPDATE OF s`
const INSERT_PAGE = `INSERT INTO pages (id, owner_id, space_id, title, kind, in_page_tree, content_text)
  VALUES ($1, $2, $3, $4, 'skill', false, $5)`
const INSERT_SKILL = 'INSERT INTO skills (page_id, space_id, name, description, extra, source) VALUES ($1, $2, $3, $4, $5, $6)'
const UPDATE_SKILL = 'UPDATE skills SET description = $2, extra = $3, source = $4, updated_at = now() WHERE page_id = $1'
const RESTORE_PAGE = 'UPDATE pages SET deleted_at = NULL WHERE id = $1'
const DELETE_FILES = 'DELETE FROM skill_files WHERE page_id = $1'
const UPSERT_FILE = `INSERT INTO skill_files (page_id, path, data, sha256) VALUES ($1, $2, $3, $4)
  ON CONFLICT (page_id, path) DO UPDATE SET data = EXCLUDED.data, sha256 = EXCLUDED.sha256`
const TOUCH_SKILL = 'UPDATE skills SET updated_at = now() WHERE page_id = $1'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

async function writeFiles(client: PoolClient, pageId: string, files: Array<{ path: string; data: Buffer }>): Promise<void> {
  for (const f of files) await client.query(UPSERT_FILE, [pageId, f.path, f.data, sha256(f.data)])
}

export type SaveResult = { pageId: string; name: string; status: 'created' | 'updated' }

/** 新建 / 更新一个 skill。`create` 遇到同名报错（手动新建不能悄悄覆盖别人的）；
 *  `upsert` 遇到同名就更新，同名在回收站里则连页面一起带回来。
 *  调用方已确认 user 在 spaceId 里有写权限，同名 skill 一定在同一空间，不必再判。 */
export async function saveSkill(
  env: SkillEnv,
  user: Actor,
  spaceId: string,
  bundle: Pick<SkillBundle, 'meta' | 'body' | 'files'>,
  source: SkillSource | null,
  mode: 'create' | 'upsert',
): Promise<SaveResult> {
  const { meta } = bundle
  const blocks = parseBlocks(bundle.body).blocks
  const stamp = source ? JSON.stringify({ ...source, at: new Date().toISOString() }) : null
  let attempt = 0
  for (;;) {
    try {
      const done = await withTransaction(env.pool, async (client) => {
        const found = (await client.query<{ page_id: string; deleted_at: string | null }>(SELECT_BY_NAME, [spaceId, meta.name])).rows[0]
        if (found) {
          if (mode === 'create') throw new SkillError(found.deleted_at ? `回收站里已有叫 ${meta.name} 的 skill，请先恢复或永久删除它` : `已有叫 ${meta.name} 的 skill`)
          await client.query(UPDATE_SKILL, [found.page_id, meta.description, JSON.stringify(meta.extra), stamp])
          await client.query(DELETE_FILES, [found.page_id])
          await writeFiles(client, found.page_id, bundle.files)
          if (found.deleted_at) await client.query(RESTORE_PAGE, [found.page_id])
          return { pageId: found.page_id, created: false as const }
        }
        const id = randomUUID()
        const doc = newPageDoc(meta.name, blocks)
        await client.query(INSERT_PAGE, [id, user.id, spaceId, meta.name, textOf(doc.getXmlFragment('prosemirror'))])
        await client.query(INSERT_SKILL, [id, spaceId, meta.name, meta.description, JSON.stringify(meta.extra), stamp])
        await writeFiles(client, id, bundle.files)
        await appendDocUpdate(client, `page:${id}`, Buffer.from(Y.encodeStateAsUpdate(doc)))
        return { pageId: id, created: true as const, doc }
      })
      if (done.created) {
        // 新建就留一份历史；快照失败不能让已建好的 skill 变成失败
        try {
          await insertSnapshot(env.pool, done.pageId, meta.name, 'auto', done.doc, user.id, 'user', null)
        } catch (err) {
          console.error(`[skills] ${done.pageId} 写入历史失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        await replaceBody(env, user, done.pageId, blocks)
      }
      env.notify?.()
      return { pageId: done.pageId, name: meta.name, status: done.created ? 'created' : 'updated' }
    } catch (err) {
      // 两个同名导入并发：后一个被唯一约束拒掉，重来一次就会走更新分支
      if (attempt++ === 0 && (err as { code?: string }).code === '23505') continue
      throw err
    }
  }
}

/** 用新正文替换页面正文（经协同会话，在线的人立刻看到）。内容没变就不动，免得打断块 id 与历史 */
async function replaceBody(env: SkillEnv, user: Actor, pageId: string, blocks: Block[]): Promise<void> {
  const next = new Y.Doc()
  materialize(next.getXmlFragment('prosemirror'), blocks)
  const canonical = fragmentToMarkdown(next.getXmlFragment('prosemirror'))
  await env.write(
    `page:${pageId}`,
    user,
    (doc, origin) => {
      const fragment = doc.getXmlFragment('prosemirror')
      if (fragmentToMarkdown(fragment) === canonical) return
      doc.transact(() => {
        fragment.delete(0, fragment.length)
        materialize(fragment, blocks)
      }, origin)
    },
    'user',
  )
}

export function blankBundle(name: string, description: string): Pick<SkillBundle, 'meta' | 'body' | 'files'> {
  const meta = validateSkill({ name, description })
  const body = `# ${meta.name}\n\n写清楚这个 skill 做什么、什么时候用、一步步怎么做。需要脚本或参考资料时，在上方「文件」里添加，并在这里用相对路径引用，例如 \`scripts/run.py\`。\n`
  return { meta, body, files: [] }
}

/** 改名字 / 描述（frontmatter 规则同导入）。同空间重名由唯一约束拒绝 */
export async function updateSkillMeta(pool: Pool, info: SkillInfo, patch: { name?: unknown; description?: unknown }): Promise<void> {
  const meta = validateSkill({
    ...info.extra,
    name: patch.name ?? info.name,
    description: patch.description ?? info.description,
  })
  try {
    await pool.query('UPDATE skills SET name = $2, description = $3, updated_at = now() WHERE page_id = $1', [info.id, meta.name, meta.description])
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new SkillError(`已有叫 ${meta.name} 的 skill`)
    throw err
  }
}

/** 单个附件的新增 / 替换。SKILL.md 不是附件（它的正文是页面本身） */
export async function putSkillFile(pool: Pool, pageId: string, rawPath: string, data: Buffer): Promise<SkillFileInfo> {
  const path = safePath(rawPath)
  if (!path) throw new SkillError('不能用这个文件名')
  if (path === 'SKILL.md') throw new SkillError('SKILL.md 就是这个页面的正文，直接在页面里编辑')
  const existing = await skillFileList(pool, pageId)
  const others = existing.filter((f) => f.path !== path)
  checkFiles([...others, { path, size: data.length }])
  await withTransaction(pool, async (client) => {
    await client.query(UPSERT_FILE, [pageId, path, data, sha256(data)])
    await client.query(TOUCH_SKILL, [pageId])
  })
  return { path, size: data.length, sha256: sha256(data) }
}

export async function deleteSkillFile(pool: Pool, pageId: string, path: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM skill_files WHERE page_id = $1 AND path = $2', [pageId, path])
  if (rowCount) await pool.query(TOUCH_SKILL, [pageId])
  return Boolean(rowCount)
}
