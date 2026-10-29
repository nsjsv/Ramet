// ---------- 空间 skill ----------
// 覆盖的约束：
//   导入（zip / 文件夹 / GitHub）落成 kind='skill' 的页面 + skills 行 + 附件，同名再导入是更新，一个包里某个 skill 写错只影响它自己
//   frontmatter 不合规报明确原因，什么都不落库
//   空间隔离：非成员看不到也看不出是否存在，viewer 只读，别的空间的 skill 不混进来
//   名字在空间内唯一（含回收站）：重名新建被拒，同名导入把回收站里的带回来
//   skill 页不能单独发布，搜索照常能搜到
//   agent 经 MCP 拿到索引与正文，文件按哈希同步到执行端缓存目录（改动过的还原，没了的删除）

import { afterAll, afterEach, beforeEach, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseBlocks } from '@ramet/shared/markdown-blocks'
import * as Y from 'yjs'
import { materialize } from './agents/markdown.js'
import { resolveRefs } from './agents/refs.js'
import { hashPassword } from './auth.js'
import { loadDocFromDb } from './collab.js'
import { closePool, getPool, initDb } from './db.js'
import { startServer } from './index.js'
import { fragmentToMarkdown } from './markdown-out.js'
import { mintPageToken } from './page-read.js'
import { makeZip, truncateAll } from './test-helpers.js'
import { textOf } from './updates.js'

if (!process.env.DATABASE_URL) {
  throw new Error('需要 DATABASE_URL 指向测试库,例如 postgres://postgres:postgres@localhost:5432/ramet_test')
}

const MCP = fileURLToPath(new URL('./mcp/ramet.mjs', import.meta.url))
const FAKE_AGENT = fileURLToPath(new URL('./agents/fake-agent.mjs', import.meta.url))
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'ramet-skills-uploads-'))
process.env.RAMET_AGENTS = JSON.stringify([{ id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_AGENT] }])

const pool = getPool()
await initDb(pool)
const s = await startServer(pool)
const base = `http://127.0.0.1:${s.port}`
process.env.RAMET_PUBLIC_URL = base

// beforeEach 兜底：同一个库里前一个测试文件遗留的行不能影响本文件的首个用例
beforeEach(async () => {
  await truncateAll(pool)
})
afterEach(async () => {
  await truncateAll(pool)
})
afterAll(async () => {
  await s.close()
  await closePool()
})

const skillMd = (name: string, description = 'does things', body = '# Steps\n\n1. run it\n'): string =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`

async function insertUser(username: string, role = 'user'): Promise<string> {
  const id = randomUUID()
  await pool.query('INSERT INTO users (id, username, password, role) VALUES ($1, $2, $3, $4)', [id, username, hashPassword('pw-123456'), role])
  return id
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  })
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T
const call = (path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

type User = { id: string; cookie: string; spaceId: string }
async function newUser(name: string): Promise<User> {
  const id = await insertUser(name)
  const cookie = await login(name)
  const space = await json<{ id: string }>(await call('/api/spaces', cookie, 'POST', { name: `${name}-space` }))
  return { id, cookie, spaceId: space.id }
}

type Imported = { results: Array<{ name?: string; root?: string; status: string; pageId?: string; error?: string }> }

async function importZip(user: { cookie: string }, spaceId: string, zip: Buffer): Promise<Response> {
  const form = new FormData()
  form.append('spaceId', spaceId)
  form.append('kind', 'zip')
  form.append('file', new File([new Uint8Array(zip)], 'skills.zip', { type: 'application/zip' }))
  return fetch(`${base}/api/skills/import`, { method: 'POST', headers: { cookie: user.cookie }, body: form })
}

type SkillView = { id: string; name: string; description: string; files: number; bytes: number; source: { type: string } | null }
const listSkills = async (user: { cookie: string }, spaceId: string): Promise<SkillView[]> =>
  json(await call(`/api/skills?spaceId=${spaceId}`, user.cookie))

const PDF_ZIP = (extra: Record<string, string> = {}): Buffer =>
  makeZip({
    'pdf-tools/SKILL.md': skillMd('pdf-tools', 'Extract text from PDFs', '# PDF\n\nRun `scripts/extract.sh`.\n'),
    'pdf-tools/scripts/extract.sh': '#!/bin/sh\necho extracting\n',
    'pdf-tools/references/notes.md': '# notes\n',
    ...extra,
  })

async function pageBody(pageId: string): Promise<string> {
  const doc = await loadDocFromDb(pool, `page:${pageId}`)
  return fragmentToMarkdown(doc.getXmlFragment('prosemirror'))
}

test('zip 导入：skill 页（kind=skill、不进页面树）+ 附件 + 正文；同名再导入 = 更新并整套替换附件', async () => {
  const alice = await newUser('alice')
  const first = await json<Imported>(await importZip(alice, alice.spaceId, PDF_ZIP()))
  expect(first.results).toMatchObject([{ name: 'pdf-tools', status: 'created' }])
  const pageId = first.results[0]!.pageId!

  const page = (await pool.query('SELECT kind, in_page_tree, title, space_id, published FROM pages WHERE id = $1', [pageId])).rows[0]
  expect(page).toMatchObject({ kind: 'skill', in_page_tree: false, title: 'pdf-tools', space_id: alice.spaceId, published: false })
  expect(await pageBody(pageId)).toContain('Run `scripts/extract.sh`.')

  const detail = await json<SkillView & { files: Array<{ path: string; size: number; sha256: string }> }>(await call(`/api/skills/${pageId}`, alice.cookie))
  expect(detail.name).toBe('pdf-tools')
  expect(detail.description).toBe('Extract text from PDFs')
  expect(detail.files.map((f) => f.path)).toEqual(['references/notes.md', 'scripts/extract.sh'])
  expect(detail.source).toMatchObject({ type: 'zip' })
  expect((await listSkills(alice, alice.spaceId)).map((x) => x.name)).toEqual(['pdf-tools'])

  // 更新：正文改了、旧附件没了、新附件来了；页面 id 不变
  const second = await json<Imported>(
    await importZip(
      alice,
      alice.spaceId,
      makeZip({
        'SKILL.md': skillMd('pdf-tools', 'Now better', '# PDF v2\n'),
        'scripts/new.py': 'print(1)\n',
      }),
    ),
  )
  expect(second.results).toMatchObject([{ name: 'pdf-tools', status: 'updated', pageId }])
  const after = await json<SkillView & { files: Array<{ path: string }> }>(await call(`/api/skills/${pageId}`, alice.cookie))
  expect(after.description).toBe('Now better')
  expect(after.files.map((f) => f.path)).toEqual(['scripts/new.py'])
  expect(await pageBody(pageId)).toBe('# PDF v2')
  expect((await listSkills(alice, alice.spaceId)).length).toBe(1)
})

test('内容没变的重新导入不改写正文（块 id 保留）', async () => {
  const alice = await newUser('alice-same')
  const zip = makeZip({ 'SKILL.md': skillMd('same', 'd', '# Same\n\ntext\n') })
  const pageId = (await json<Imported>(await importZip(alice, alice.spaceId, zip))).results[0]!.pageId!
  const idsBefore = ((await loadDocFromDb(pool, `page:${pageId}`)).getXmlFragment('prosemirror').toArray() as Y.XmlElement[]).map((e) => e.getAttribute('id'))
  expect(idsBefore.every(Boolean)).toBe(true)
  await importZip(alice, alice.spaceId, zip)
  const idsAfter = ((await loadDocFromDb(pool, `page:${pageId}`)).getXmlFragment('prosemirror').toArray() as Y.XmlElement[]).map((e) => e.getAttribute('id'))
  expect(idsAfter).toEqual(idsBefore)
})

test('frontmatter 不合规：报明确原因，什么都不落库；一个包里的好 skill 不被拖累', async () => {
  const alice = await newUser('alice-bad')
  const missing = await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': '---\nname: x\n---\nbody' })))
  expect(missing.results).toMatchObject([{ status: 'error', error: expect.stringContaining('description') }])
  const badName = await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': skillMd('Bad_Name') })))
  expect(badName.results).toMatchObject([{ status: 'error', error: expect.stringContaining('name') }])
  const noFront = await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': '# 没有 frontmatter' })))
  expect(noFront.results[0]!.status).toBe('error')
  expect(await listSkills(alice, alice.spaceId)).toEqual([])

  const mixed = await json<Imported>(
    await importZip(
      alice,
      alice.spaceId,
      makeZip({ 'good/SKILL.md': skillMd('good'), 'broken/SKILL.md': '---\nname: broken\n---\n', 'good/scripts/a.sh': 'echo a' }),
    ),
  )
  expect(mixed.results.map((r) => [r.name ?? r.root, r.status]).sort()).toEqual([['broken', 'error'], ['good', 'created']])
  expect((await listSkills(alice, alice.spaceId)).map((x) => x.name)).toEqual(['good'])

  // 没有 SKILL.md / 不是 zip / 路径穿越：整次请求 400
  expect((await importZip(alice, alice.spaceId, makeZip({ 'readme.md': 'x' }))).status).toBe(400)
  expect((await importZip(alice, alice.spaceId, Buffer.from('not a zip'))).status).toBe(400)
  expect((await importZip(alice, alice.spaceId, makeZip({ '../evil/SKILL.md': skillMd('evil') }))).status).toBe(400)
})

test('整仓导入：嵌套目录里每个 SKILL.md 各是一个 skill，文件归属最深的那个', async () => {
  const alice = await newUser('alice-repo')
  const out = await json<Imported>(
    await importZip(
      alice,
      alice.spaceId,
      makeZip({
        'repo/README.md': 'ignored',
        'repo/skills/a/SKILL.md': skillMd('skill-a'),
        'repo/skills/a/run.sh': 'a',
        'repo/skills/a/inner/SKILL.md': skillMd('skill-inner'),
        'repo/skills/a/inner/only-inner.txt': 'x',
        'repo/skills/b/SKILL.md': skillMd('skill-b'),
        'repo/node_modules/x/SKILL.md': skillMd('skill-npm'),
      }),
    ),
  )
  expect(out.results.map((r) => r.name).sort()).toEqual(['skill-a', 'skill-b', 'skill-inner'])
  const byName = Object.fromEntries((await listSkills(alice, alice.spaceId)).map((x) => [x.name, x.files]))
  expect(byName).toEqual({ 'skill-a': 1, 'skill-b': 0, 'skill-inner': 1 })
})

test('文件夹上传：每个文件带相对路径', async () => {
  const alice = await newUser('alice-folder')
  const form = new FormData()
  form.append('spaceId', alice.spaceId)
  form.append('kind', 'folder')
  const parts: Array<[string, string]> = [
    ['my-skill/SKILL.md', skillMd('folder-skill')],
    ['my-skill/scripts/go.sh', '#!/bin/sh\n'],
  ]
  for (const [path, content] of parts) {
    form.append('file', new File([content], path.split('/').pop()!))
    form.append('path', path)
  }
  const out = await json<Imported>(await fetch(`${base}/api/skills/import`, { method: 'POST', headers: { cookie: alice.cookie }, body: form }))
  expect(out.results).toMatchObject([{ name: 'folder-skill', status: 'created' }])
  expect((await listSkills(alice, alice.spaceId))[0]).toMatchObject({ name: 'folder-skill', files: 1, source: { type: 'folder' } })
})

test('GitHub 导入：链接只用来取 owner/repo/ref，请求发往配置的基址（本地假服务代替网络）；tree 链接只导入那个子目录', async () => {
  const alice = await newUser('alice-gh')
  const zip = makeZip({
    'repo-main/skills/foo/SKILL.md': skillMd('foo'),
    'repo-main/skills/foo/scripts/x.sh': 'x',
    'repo-main/skills/bar/SKILL.md': skillMd('bar'),
  })
  const seen: string[] = []
  const fake = createServer((req, res) => {
    seen.push(req.url ?? '')
    if (req.url === '/acme/repo/zip/HEAD' || req.url === '/acme/repo/zip/main') {
      res.writeHead(200, { 'content-type': 'application/zip' })
      res.end(zip)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const port = (fake.address() as { port: number }).port
  process.env.GITHUB_CODELOAD_URL = `http://127.0.0.1:${port}`
  try {
    const github = (url: string): Promise<Response> =>
      fetch(`${base}/api/skills/import`, {
        method: 'POST',
        headers: { cookie: alice.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ spaceId: alice.spaceId, github: url }),
      })
    const whole = await json<Imported>(await github('https://github.com/acme/repo'))
    expect(whole.results.map((r) => r.name).sort()).toEqual(['bar', 'foo'])
    expect((await listSkills(alice, alice.spaceId)).find((x) => x.name === 'foo')!.source).toMatchObject({ type: 'github' })

    await pool.query('TRUNCATE skills CASCADE')
    const sub = await json<Imported>(await github('https://github.com/acme/repo/tree/main/skills/foo'))
    expect(sub.results.map((r) => r.name)).toEqual(['foo'])
    expect(seen).toContain('/acme/repo/zip/main')

    expect((await github('https://github.com/acme/missing')).status).toBe(400)
    expect((await github('https://evil.example.com/acme/repo')).status).toBe(400)
    expect((await github('not a url at all')).status).toBe(400)
    // 请求地址由 owner/repo 自己拼，用户给的主机名不会被请求
    expect(seen.every((u) => u.startsWith('/acme/'))).toBe(true)
  } finally {
    delete process.env.GITHUB_CODELOAD_URL
    await new Promise((resolve) => fake.close(resolve))
  }
})

test('非成员看不到也看不出是否存在；viewer 只读；别的空间的 skill 不混进来', async () => {
  const alice = await newUser('alice-iso')
  const bob = await newUser('bob-iso')
  const viewer = await newUser('viewer-iso')
  await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [alice.spaceId, viewer.id, 'viewer'])
  const pageId = (await json<Imported>(await importZip(alice, alice.spaceId, PDF_ZIP()))).results[0]!.pageId!
  await importZip(bob, bob.spaceId, makeZip({ 'SKILL.md': skillMd('bobs-only') }))

  // 非成员的列表 / 详情 / 导入 / 改 / 文件全是 404，且与「根本不存在」同响应
  const missing = await call(`/api/skills/${randomUUID()}`, bob.cookie)
  expect(missing.status).toBe(404)
  const missingBody = await missing.json()
  const denied = await call(`/api/skills/${pageId}`, bob.cookie)
  expect(denied.status).toBe(404)
  expect(await denied.json()).toEqual(missingBody)
  expect((await call(`/api/skills?spaceId=${alice.spaceId}`, bob.cookie)).status).toBe(404)
  expect((await importZip(bob, alice.spaceId, PDF_ZIP())).status).toBe(404)
  expect((await call(`/api/skills/${pageId}`, bob.cookie, 'PATCH', { description: 'x' })).status).toBe(404)
  expect((await call(`/api/skills/${pageId}/files?path=scripts/extract.sh`, bob.cookie)).status).toBe(404)

  // viewer 能读（列表 / 详情 / 下载附件），不能写
  expect((await listSkills(viewer, alice.spaceId)).map((x) => x.name)).toEqual(['pdf-tools'])
  expect((await call(`/api/skills/${pageId}/files?path=scripts/extract.sh`, viewer.cookie)).status).toBe(200)
  expect((await importZip(viewer, alice.spaceId, PDF_ZIP())).status).toBe(403)
  expect((await call('/api/skills', viewer.cookie, 'POST', { spaceId: alice.spaceId, name: 'v', description: 'd' })).status).toBe(403)
  expect((await call(`/api/skills/${pageId}`, viewer.cookie, 'PATCH', { description: 'x' })).status).toBe(403)
  expect((await call(`/api/skills/${pageId}/files?path=scripts/extract.sh`, viewer.cookie, 'DELETE')).status).toBe(403)

  // 各空间只列自己的；未登录 401
  expect((await listSkills(bob, bob.spaceId)).map((x) => x.name)).toEqual(['bobs-only'])
  expect((await fetch(`${base}/api/skills?spaceId=${alice.spaceId}`)).status).toBe(401)
})

test('名字空间内唯一（含回收站）：重名新建被拒，同名导入把回收站里的带回来；改名撞名被拒', async () => {
  const alice = await newUser('alice-uniq')
  const created = await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'dup', description: 'first' })
  expect(created.status).toBe(201)
  const pageId = (await json<{ pageId: string }>(created)).pageId
  expect(await pageBody(pageId)).toContain('# dup') // 起手模板

  const again = await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'dup', description: 'second' })
  expect(again.status).toBe(400)
  expect((await json<{ error: string }>(again)).error).toContain('dup')
  expect((await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'Bad Name', description: 'd' })).status).toBe(400)
  expect((await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'ok-name', description: '' })).status).toBe(400)

  // 进回收站后列表里没了，名字还占着
  expect((await call(`/api/pages/${pageId}/trash`, alice.cookie, 'POST', {})).status).toBe(200)
  expect(await listSkills(alice, alice.spaceId)).toEqual([])
  const blocked = await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'dup', description: 'third' })
  expect(blocked.status).toBe(400)
  expect((await json<{ error: string }>(blocked)).error).toContain('回收站')
  // 同名导入走更新，并把它从回收站带回来
  const revived = await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': skillMd('dup', 'revived') })))
  expect(revived.results).toMatchObject([{ name: 'dup', status: 'updated', pageId }])
  expect((await pool.query('SELECT deleted_at FROM pages WHERE id = $1', [pageId])).rows[0].deleted_at).toBeNull()
  expect((await listSkills(alice, alice.spaceId))[0]).toMatchObject({ name: 'dup', description: 'revived' })

  // 改名撞名
  await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'other', description: 'o' })
  const clash = await call(`/api/skills/${pageId}`, alice.cookie, 'PATCH', { name: 'other' })
  expect(clash.status).toBe(400)
  const renamed = await call(`/api/skills/${pageId}`, alice.cookie, 'PATCH', { name: 'renamed', description: 'new desc' })
  expect(renamed.status).toBe(200)
  expect(await json<SkillView>(renamed)).toMatchObject({ name: 'renamed', description: 'new desc' })
})

test('附件：上传 / 下载 / 删除；SKILL.md 与不安全路径被拒', async () => {
  const alice = await newUser('alice-files')
  const pageId = (await json<{ pageId: string }>(await call('/api/skills', alice.cookie, 'POST', { spaceId: alice.spaceId, name: 'with-files', description: 'd' }))).pageId
  const put = (path: string, data: string): Promise<Response> =>
    fetch(`${base}/api/skills/${pageId}/files?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { cookie: alice.cookie }, body: data })

  const ok = await put('scripts/hello.py', 'print("hi")\n')
  expect(ok.status).toBe(200)
  expect(await json<{ path: string; size: number }>(ok)).toMatchObject({ path: 'scripts/hello.py', size: 12 })
  const got = await call(`/api/skills/${pageId}/files?path=scripts/hello.py`, alice.cookie)
  expect(await got.text()).toBe('print("hi")\n')
  // 覆盖同路径
  expect((await put('scripts/hello.py', 'v2')).status).toBe(200)
  expect(await (await call(`/api/skills/${pageId}/files?path=scripts/hello.py`, alice.cookie)).text()).toBe('v2')

  for (const bad of ['SKILL.md', '../x.txt', '/abs.txt', 'a//b.txt']) expect((await put(bad, 'x')).status, bad).toBe(400)
  expect((await call(`/api/skills/${pageId}/files?path=scripts/hello.py`, alice.cookie, 'DELETE')).status).toBe(200)
  expect((await call(`/api/skills/${pageId}/files?path=scripts/hello.py`, alice.cookie)).status).toBe(404)
  expect((await call(`/api/skills/${pageId}/files?path=scripts/hello.py`, alice.cookie, 'DELETE')).status).toBe(404)
})

test('skill 页不能单独发布；正文能被搜到', async () => {
  const alice = await newUser('alice-misc')
  const pageId = (await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': skillMd('searchable-thing', 'd', '# Findme\n\nuniquekeyword here\n') })))).results[0]!.pageId!
  const publish = await call(`/api/pages/${pageId}/publish`, alice.cookie, 'PATCH', { published: true })
  expect(publish.status).toBe(400)
  const hits = await json<Array<{ id: string }>>(await call('/api/search?q=uniquekeyword', alice.cookie))
  expect(hits.map((h) => h.id)).toEqual([pageId])
  // DB 约束兜底，任何写入路径都造不出公开的 skill 页
  await expect(pool.query('UPDATE pages SET published = true WHERE id = $1', [pageId])).rejects.toThrow()
})

async function mcpClient(token: string, cache: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP],
      env: { RAMET_PAGE_URL: base, RAMET_PAGE_TOKEN: token, RAMET_SKILL_CACHE: cache },
      stderr: 'inherit',
    }),
  )
  return client
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content
  if (!content?.[0]?.text) throw new Error('MCP 返回不是文本内容')
  return content[0].text
}

test('MCP：索引在工具说明里；use_skill 回正文并把文件同步到缓存目录（脚本可执行；改动被还原、没了的被删）', async () => {
  const alice = await newUser('alice-mcp')
  const bob = await newUser('bob-mcp')
  const pageId = (await pool.query("INSERT INTO pages (id, owner_id, space_id) VALUES ($1, $2, $3) RETURNING id", [randomUUID(), alice.id, alice.spaceId])).rows[0].id as string
  await importZip(alice, alice.spaceId, PDF_ZIP())
  await importZip(bob, bob.spaceId, makeZip({ 'SKILL.md': skillMd('bobs-secret', 'bob only') }))
  const cache = await mkdtemp(join(tmpdir(), 'ramet-skill-cache-'))

  const client = await mcpClient(mintPageToken(alice.id, 'fake', { pageId }), cache)
  const tools = await client.listTools()
  const useSkill = tools.tools.find((t) => t.name === 'use_skill')
  expect(useSkill).toBeTruthy()
  expect(useSkill!.description).toContain('pdf-tools：Extract text from PDFs')
  expect(useSkill!.description).not.toContain('bobs-secret') // 别的空间的 skill 不进索引

  const text = toolText(await client.callTool({ name: 'use_skill', arguments: { name: 'pdf-tools' } }))
  const dir = join(cache, alice.spaceId, 'pdf-tools')
  expect(text).toContain('Run `scripts/extract.sh`.')
  expect(text).toContain(dir)
  expect(text).toContain('scripts/extract.sh')
  expect(await readFile(join(dir, 'scripts/extract.sh'), 'utf8')).toBe('#!/bin/sh\necho extracting\n')
  expect((await stat(join(dir, 'scripts/extract.sh'))).mode & 0o111).not.toBe(0) // shebang → 可执行
  expect(await readFile(join(dir, 'references/notes.md'), 'utf8')).toBe('# notes\n')

  // 本地被改动的文件再调用时还原成中心的版本，中心删掉的文件本地也删
  await writeFile(join(dir, 'references/notes.md'), 'tampered')
  await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': skillMd('pdf-tools', 'Extract text from PDFs'), 'references/notes.md': '# notes\n' }))
  toolText(await client.callTool({ name: 'use_skill', arguments: { name: 'pdf-tools' } }))
  expect(await readFile(join(dir, 'references/notes.md'), 'utf8')).toBe('# notes\n')
  await expect(stat(join(dir, 'scripts/extract.sh'))).rejects.toThrow()

  // 别的空间的 skill 对这个 agent 不存在
  const other = await client.callTool({ name: 'use_skill', arguments: { name: 'bobs-secret' } })
  expect(other.isError).toBe(true)
  expect(toolText(other)).toContain('没有叫 bobs-secret 的 skill')
  await client.close()
  await rm(cache, { recursive: true, force: true })
})

test('空间里没有 skill：不暴露 use_skill', async () => {
  const alice = await newUser('alice-noskill')
  const client = await mcpClient(mintPageToken(alice.id, 'fake'), tmpdir())
  expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('use_skill')
  await client.close()
})

test('提示词里 @ 提及 skill 页写成 skill:<名字>，看不见的页面仍给 page: 定位', async () => {
  const alice = await newUser('alice-ref')
  const bob = await newUser('bob-ref')
  const skillPage = (await json<Imported>(await importZip(alice, alice.spaceId, makeZip({ 'SKILL.md': skillMd('mentioned') })))).results[0]!.pageId!
  const doc = new Y.Doc()
  materialize(
    doc.getXmlFragment('prosemirror'),
    parseBlocks('用一下').blocks.map((b) => ({ ...b, inlines: [...(b.inlines ?? []), { atom: 'page_mention', attrs: { pageId: skillPage, title: 'mentioned' } }] })),
  )
  const render = async (user: { id: string }): Promise<string> => {
    const atoms = await resolveRefs(pool, { id: user.id, role: 'user' }, doc.getXmlFragment('prosemirror'))
    return textOf(doc.getXmlFragment('prosemirror'), atoms)
  }
  expect(await render(alice)).toContain('skill:mentioned')
  expect(await render(bob)).toContain(`page:${skillPage}`)
})
