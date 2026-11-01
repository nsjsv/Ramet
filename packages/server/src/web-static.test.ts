/* ---------- 前端产物托管（web-static.ts）：缓存头、长缓存路径的查询串 / 缺文件 404、SPA fallback、
 * server 自己的路径不接管、越出产物目录、gzip、条件请求、切换软链后现解析 ---------- */
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { webRootFromEnv, webStatic } from './web-static.js'

let dir: string
let app: Hono

const BIG_JS = `console.log(${JSON.stringify('x'.repeat(4000))})\n`

async function release(name: string, indexHtml: string): Promise<string> {
  const root = join(dir, 'releases', name)
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'twemoji'), { recursive: true })
  await writeFile(join(root, 'index.html'), indexHtml)
  await writeFile(join(root, 'version.json'), '{"id":"x"}\n')
  await writeFile(join(root, 'assets', 'index-abc.js'), BIG_JS)
  await writeFile(join(root, 'twemoji', '1f600.svg'), '<svg/>')
  await writeFile(join(root, 'twemoji-sprite-64.png'), 'png')
  return root
}

/** 部署机上的布局：web/dist 是指向某个 release 的相对软链，切换时原子替换 */
async function point(name: string): Promise<void> {
  const tmp = join(dir, 'web', '.dist.tmp')
  await symlink(join('..', 'releases', name), tmp)
  await rename(tmp, join(dir, 'web', 'dist'))
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ramet-web-static-'))
  await release('r1', '<html>one</html>')
  await release('r2', '<html>two</html>')
  await writeFile(join(dir, 'secret.txt'), 'nope')
  await mkdir(join(dir, 'web'))
  await point('r1')
  app = new Hono()
  app.use('*', webStatic(join(dir, 'web', 'dist')))
  app.get('/api/ping', (c) => c.text('pong'))
  app.post('/anything', (c) => c.text('posted'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('webStatic', () => {
  test('入口页与 SPA 路由：no-cache，前端路由都回 index.html', async () => {
    for (const path of ['/', '/index.html', '/page/123', '/p/some-slug']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control'), path).toBe('no-cache')
      expect(res.headers.get('content-type'), path).toContain('text/html')
      expect(await res.text(), path).toBe('<html>one</html>')
    }
  })

  test('长缓存路径：一年 immutable；带查询串 404；缺文件 404 不落 SPA', async () => {
    for (const path of ['/assets/index-abc.js', '/twemoji/1f600.svg', '/twemoji-sprite-64.png']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=31536000, immutable')
      expect((await app.request(`${path}?x=1`)).status, `${path}?x=1`).toBe(404)
    }
    expect((await app.request('/assets/missing.js')).status).toBe(404)
    expect((await app.request('/twemoji/1fae8.svg')).status).toBe(404)
  })

  test('其它文件 no-cache；/dl/ 恒 404', async () => {
    const res = await app.request('/version.json')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.json()).toEqual({ id: 'x' })
    expect((await app.request('/dl/ramet-connector.tgz')).status).toBe(404)
  })

  test('server 自己的路径与非 GET 不接管', async () => {
    expect(await (await app.request('/api/ping')).text()).toBe('pong')
    expect((await app.request('/api/nope')).status).toBe(404)
    expect((await app.request('/collab')).status).toBe(404)
    expect(await (await app.request('/anything', { method: 'POST' })).text()).toBe('posted')
  })

  test('越出产物目录：不出文件', async () => {
    for (const path of ['/../../secret.txt', '/assets/../../../secret.txt', '/%2e%2e/%2e%2e/secret.txt']) {
      const res = await app.request(path)
      expect(await res.text(), path).not.toContain('nope')
    }
  })

  test('gzip：要了才压，带 Vary；小文件不压', async () => {
    const zipped = await app.request('/assets/index-abc.js', { headers: { 'accept-encoding': 'gzip, br' } })
    expect(zipped.headers.get('content-encoding')).toBe('gzip')
    expect(zipped.headers.get('vary')).toBe('Accept-Encoding')
    expect(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString()).toBe(BIG_JS)
    const again = await app.request('/assets/index-abc.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(gunzipSync(Buffer.from(await again.arrayBuffer())).toString()).toBe(BIG_JS)
    const plain = await app.request('/assets/index-abc.js')
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(BIG_JS)
    const small = await app.request('/version.json', { headers: { 'accept-encoding': 'gzip' } })
    expect(small.headers.get('content-encoding')).toBeNull()
  })

  test('ETag 命中回 304；HEAD 只有头', async () => {
    const first = await app.request('/index.html')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    const cached = await app.request('/index.html', { headers: { 'if-none-match': etag ?? '' } })
    expect(cached.status).toBe(304)
    const head = await app.request('/assets/index-abc.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(BIG_JS)))
    expect(await head.text()).toBe('')
  })

  test('软链切到新 release 后立即出新内容（不重启）', async () => {
    await point('r2')
    expect(await (await app.request('/')).text()).toBe('<html>two</html>')
    await point('r1')
  })

  test('产物目录不存在：整个不接管（dev 走 vite）', async () => {
    const bare = new Hono()
    bare.use('*', webStatic(join(dir, 'no-such-dist')))
    bare.get('/', (c) => c.text('fallthrough'))
    expect(await (await bare.request('/')).text()).toBe('fallthrough')
  })

  test('目录来源：RAMET_WEB_DIST 优先，缺省是与 server 包同级的 web/dist', () => {
    expect(webRootFromEnv({ RAMET_WEB_DIST: '/srv/web/dist' })).toBe('/srv/web/dist')
    expect(webRootFromEnv({}).endsWith(join('packages', 'web', 'dist'))).toBe(true)
  })
})
