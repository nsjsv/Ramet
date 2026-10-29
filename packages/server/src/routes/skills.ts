// ---------- 空间 skill 的 REST（skill 库界面用；agent 用的是 ramet-tools.ts 里的 /api/ramet/skills*）----------
// 权限完全沿用页面：空间成员（含 viewer）可读，写（导入 / 新建 / 改 / 附件）要 owner|member。
// 非成员与不存在同响应 404，不泄露存在性。skill 页本身的删除 / 恢复 / 历史走通用的 /api/pages/*。

import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth, type AuthEnv } from '../auth.js'
import { SkillError } from '../skill-md.js'
import { fetchGithub, parseGithubUrl } from '../skill-github.js'
import {
  SKILL_LIMITS,
  blankBundle,
  bundlesOf,
  deleteSkillFile,
  entriesOfUpload,
  listSkills,
  putSkillFile,
  saveSkill,
  skillFileData,
  skillFileList,
  skillOfPage,
  updateSkillMeta,
  type SkillEnv,
  type SkillInfo,
  type SkillSource,
} from '../skills.js'
import { readZip, ZipError, type ZipEntry } from '../zip-read.js'
import { roleInSpace, writable } from './pages.js'

/** 导入请求体上限：与 nginx 的 client_max_body_size（10m）对齐 */
const IMPORT_MAX = 10 * 1024 * 1024

type ImportResult = { name?: string; root?: string; status: 'created' | 'updated' | 'error'; pageId?: string; error?: string }

export function skillRoutes(env: SkillEnv) {
  const { pool } = env
  const app = new Hono<AuthEnv>()
  // 只管 /api/skills 一族：这个子应用挂在公开路由之后，不能用 '*' 把别人的路径也拦成 401
  app.use('/api/skills', requireAuth(pool))
  app.use('/api/skills/*', requireAuth(pool))

  const fail = (c: Context, err: unknown) => {
    if (err instanceof SkillError || err instanceof ZipError) return c.json({ error: err.message }, 400)
    throw err
  }

  /** 空间闸门：存在 + 是成员（不是 → 404）+ 需要写时有写权（viewer → 403） */
  async function spaceGate(c: Context<AuthEnv>, spaceId: string, needWrite: boolean): Promise<Response | null> {
    const role = await roleInSpace(pool, c.get('user'), spaceId)
    if (role === null) return c.json({ error: 'space not found' }, 404)
    if (needWrite && !writable(role)) return c.json({ error: 'forbidden' }, 403)
    return null
  }

  /** skill 闸门：skill 页存在（活的）+ 在其空间里可见 / 可写 */
  async function skillGate(
    c: Context<AuthEnv>,
    id: string,
    needWrite: boolean,
  ): Promise<{ res: Response; info?: undefined } | { res?: undefined; info: SkillInfo }> {
    const info = await skillOfPage(pool, id)
    const role = info ? await roleInSpace(pool, c.get('user'), info.spaceId) : null
    // 非成员与不存在逐字节同响应（不泄露存在性）
    if (!info || role === null) return { res: c.json({ error: 'skill not found' }, 404) }
    if (needWrite && !writable(role)) return { res: c.json({ error: 'forbidden' }, 403) }
    return { info }
  }

  app.get('/api/skills', async (c) => {
    const spaceId = c.req.query('spaceId') ?? ''
    if (!spaceId) return c.json({ error: 'spaceId required' }, 400)
    const denied = await spaceGate(c, spaceId, false)
    if (denied) return denied
    return c.json(await listSkills(pool, spaceId))
  })

  // 手动新建：名字 + 描述（frontmatter 规则），正文给一段起手模板，之后在页面里写
  app.post('/api/skills', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { spaceId?: unknown; name?: unknown; description?: unknown }
    if (typeof body.spaceId !== 'string' || !body.spaceId) return c.json({ error: 'spaceId required' }, 400)
    const denied = await spaceGate(c, body.spaceId, true)
    if (denied) return denied
    try {
      const bundle = blankBundle(String(body.name ?? ''), String(body.description ?? ''))
      return c.json(await saveSkill(env, c.get('user'), body.spaceId, bundle, null, 'create'), 201)
    } catch (err) {
      return fail(c, err)
    }
  })

  // 导入：multipart（zip 或文件夹，field: spaceId / kind / file[] / path[]）或 JSON（{spaceId, github}）。
  // 同名 = 更新。一个包里有多个 skill 时各自成败，结果逐个返回
  app.post(
    '/api/skills/import',
    bodyLimit({ maxSize: IMPORT_MAX, onError: (c) => c.json({ error: '文件太大（导入上限 10MB）' }, 413) }),
    async (c) => {
      const user = c.get('user')
      const isJson = (c.req.header('content-type') ?? '').includes('application/json')
      let spaceId = ''
      let entries: ZipEntry[]
      let source: SkillSource
      let subdir = ''
      try {
        if (isJson) {
          const body = (await c.req.json().catch(() => ({}))) as { spaceId?: unknown; github?: unknown }
          spaceId = typeof body.spaceId === 'string' ? body.spaceId : ''
          if (typeof body.github !== 'string' || !body.github.trim()) return c.json({ error: '请填 GitHub 仓库链接' }, 400)
          const denied = await spaceGate(c, spaceId, true)
          if (denied) return denied
          const target = parseGithubUrl(body.github)
          const fetched = await fetchGithub(target)
          entries = fetched.entries
          subdir = fetched.subdir
          source = { type: 'github', url: body.github.trim() }
        } else {
          const form = await c.req.parseBody({ all: true })
          spaceId = typeof form.spaceId === 'string' ? form.spaceId : ''
          const denied = await spaceGate(c, spaceId, true)
          if (denied) return denied
          const files = [form.file].flat().filter((f): f is File => f instanceof File)
          const paths = [form.path].flat().filter((p): p is string => typeof p === 'string')
          if (files.length === 0) return c.json({ error: '没有收到文件' }, 400)
          if (form.kind === 'folder') {
            if (paths.length !== files.length) return c.json({ error: '文件夹里每个文件都要带路径' }, 400)
            entries = entriesOfUpload(await Promise.all(files.map(async (f, i) => ({ path: paths[i]!, data: Buffer.from(await f.arrayBuffer()) }))))
            source = { type: 'folder' }
          } else {
            entries = readZip(Buffer.from(await files[0]!.arrayBuffer()))
            source = { type: 'zip', url: files[0]!.name }
          }
        }
        const { bundles, errors } = bundlesOf(entries, subdir)
        const results: ImportResult[] = errors.map((e) => ({ root: e.root, status: 'error', error: e.error }))
        for (const bundle of bundles) {
          try {
            const saved = await saveSkill(env, user, spaceId, bundle, source, 'upsert')
            results.push({ name: saved.name, status: saved.status, pageId: saved.pageId })
          } catch (err) {
            if (!(err instanceof SkillError)) throw err
            results.push({ name: bundle.meta.name, status: 'error', error: err.message })
          }
        }
        return c.json({ results })
      } catch (err) {
        return fail(c, err)
      }
    },
  )

  app.get('/api/skills/:id', async (c) => {
    const gate = await skillGate(c, c.req.param('id'), false)
    if (gate.res) return gate.res
    return c.json({ ...gate.info, files: await skillFileList(pool, gate.info.id), limits: SKILL_LIMITS })
  })

  app.patch('/api/skills/:id', async (c) => {
    const gate = await skillGate(c, c.req.param('id'), true)
    if (gate.res) return gate.res
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; description?: unknown }
    try {
      await updateSkillMeta(pool, gate.info, body)
    } catch (err) {
      return fail(c, err)
    }
    env.notify?.()
    return c.json(await skillOfPage(pool, gate.info.id))
  })

  app.get('/api/skills/:id/files', async (c) => {
    const gate = await skillGate(c, c.req.param('id'), false)
    if (gate.res) return gate.res
    const path = c.req.query('path') ?? ''
    const data = await skillFileData(pool, gate.info.id, path)
    if (!data) return c.json({ error: 'file not found' }, 404)
    c.header('content-type', 'application/octet-stream')
    c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}`)
    return c.body(new Uint8Array(data))
  })

  app.put(
    '/api/skills/:id/files',
    bodyLimit({ maxSize: SKILL_LIMITS.fileBytes, onError: (c) => c.json({ error: '文件太大' }, 413) }),
    async (c) => {
      const gate = await skillGate(c, c.req.param('id'), true)
      if (gate.res) return gate.res
      try {
        return c.json(await putSkillFile(pool, gate.info.id, c.req.query('path') ?? '', Buffer.from(await c.req.arrayBuffer())))
      } catch (err) {
        return fail(c, err)
      }
    },
  )

  app.delete('/api/skills/:id/files', async (c) => {
    const gate = await skillGate(c, c.req.param('id'), true)
    if (gate.res) return gate.res
    return (await deleteSkillFile(pool, gate.info.id, c.req.query('path') ?? ''))
      ? c.json({ ok: true })
      : c.json({ error: 'file not found' }, 404)
  })

  return app
}
