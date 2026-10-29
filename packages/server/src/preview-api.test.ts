// ---------- 端口预览的 REST、进入票据、CSRF 加固 ----------
// 覆盖：共享的授权矩阵（13 种角色，被拒的人机器一侧没有任何帧）；参数与能力（端口 / 路径 / 名额 / 离线 / 太旧 / 没开预览端口）；
// 列表 / 停止的权限；票据一次性 / 过期 / 绑人 / 页面不可读时拒绝；使用记录；Ramet 主端口的 CSRF（Origin / Sec-Fetch-Site / 协同升级）。
// 流量本身（cookie 剥离、转发、WebSocket、撤销即断）在 preview-proxy.test.ts，真 connector 全链路在 preview-e2e.test.ts。
import { describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { startServer } from './index.js'
import { agentsList, base, insertUser, pool, postJson, previewBase, s, waitFor } from './agents/test-kit.js'
import {
  ALLOWED, DENIED, ROLES, api, enterPreview, list, previewFrames, pvCookie, refusedStatus, share, shareOk, ticketUrl, viaPreview, visit, world,
  type Role,
} from './preview-fixtures.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('共享', () => {
  test('授权矩阵：13 种角色；没有 machine 授权的人机器一侧一个帧都没收到', async () => {
    const w = await world()
    for (const role of DENIED) {
      const res = await share(w, w.cookie[role], 3000)
      expect(res.status, role).toBe(refusedStatus(role))
      expect(await res.json(), role).not.toHaveProperty('id')
    }
    for (const role of DENIED) expect(w.m.by(w.id[role]), `${role} 的驱动帧`).toEqual([])
    expect(w.m.shares.size).toBe(0)
    // 403 的文案告诉人找谁要授权；只授权 agent 的人同样 403（两个 scope 互不蕴含）
    expect(await (await share(w, w.cookie.agentOnly, 3000)).json()).toMatchObject({ error: 'forbidden', message: expect.stringContaining('mowner') })

    const ports: Partial<Record<Role, number>> = { mowner: 3001, machineOnly: 3002, both: 3003 }
    for (const role of ALLOWED) {
      const res = await share(w, w.cookie[role], ports[role]!, { path: '/app?x=1' })
      expect(res.status, role).toBe(201)
      expect(await res.json()).toMatchObject({ id: expect.any(String), port: ports[role], path: '/app?x=1', machine: 'box' })
    }
    // 登记帧以共享人署名：connector 按这个人再判一次
    expect(w.m.of('port-share').map((f) => [f.actor, f.port])).toEqual(ALLOWED.map((r) => [w.id[r], ports[r]]))
    expect(previewFrames(w.m).every((f) => ALLOWED.some((r) => f.actor === w.id[r]))).toBe(true)
  })

  test('viewer：即使机器主人给了他 machine 授权也不能共享（页面只读）；但能看列表、能取票据（下面）', async () => {
    const w = await world()
    await pool.query("UPDATE space_members SET role = 'viewer' WHERE user_id = $1", [w.id.machineOnly])
    const res = await share(w, w.cookie.machineOnly, 3000)
    expect(res.status).toBe(403)
    expect(w.m.by(w.id.machineOnly)).toEqual([])
  })

  test('参数：端口 1024–65535 的整数；入口路径 / 开头且不能是 //host；缺 agent；本机 agent；没登录', async () => {
    const w = await world()
    for (const port of [0, 80, 1023, 65536, -1, 3000.5, '3000', null, 'abc']) {
      const res = await share(w, w.cookie.mowner, port as number)
      expect(res.status, String(port)).toBe(400)
    }
    for (const path of ['//evil.example', '/\\evil.example', 'index.html', 'http://evil.example/', '/a b', '/a\nb']) {
      const res = await share(w, w.cookie.mowner, 3000, { path })
      expect(res.status, path).toBe(400)
    }
    expect((await api('POST', `/api/pages/${w.pageId}/project/previews`, w.cookie.mowner, { port: 3000 })).status).toBe(400) // 缺 agent
    expect((await api('POST', `/api/pages/${w.pageId}/project/previews`, w.cookie.mowner, { agent: 'fake', port: 3000 })).status).toBe(400) // 本机 agent
    expect((await fetch(`${base}/api/pages/${w.pageId}/project/previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect(w.m.of('port-share')).toEqual([])
    // 没写 path / 写空 = 根路径
    expect(await (await share(w, w.cookie.mowner, 3000)).json()).toMatchObject({ path: '/' })
  })

  test('connector 太旧（hello 没有 preview 能力）：409 且一个帧都没发；授权判定在它之前', async () => {
    const w = await world(['project'])
    const res = await share(w, w.cookie.mowner, 3000)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'connector outdated' })
    expect((await share(w, w.cookie.plain, 3000)).status).toBe(403) // 没授权的人看到的是 403
    expect(previewFrames(w.m)).toEqual([])
  })

  test('机器离线：409；授权判定在「是否在线」之前', async () => {
    const w = await world()
    w.m.ws.terminate()
    await waitFor(async () => !(await agentsList(w.cookie.mowner)).some((a) => a.id === w.agent))
    expect((await share(w, w.cookie.mowner, 3000)).status).toBe(409)
    expect((await share(w, w.cookie.plain, 3000)).status).toBe(403)
  })

  test('服务器没有开预览端口：共享 / 取票据回 409「服务器没有开启预览端口」，列表回空', async () => {
    const off = await startServer(pool, 0, { preview: null })
    try {
      expect(off.previewPort).toBeNull()
      const w = await world()
      const res = await fetch(`http://127.0.0.1:${off.port}/api/pages/${w.pageId}/project/previews`, {
        method: 'POST',
        headers: { cookie: w.cookie.mowner, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: w.agent, port: 3000 }),
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'preview disabled', message: '服务器没有开启预览端口' })
      const t = await fetch(`http://127.0.0.1:${off.port}/api/pages/${w.pageId}/previews/x/ticket`, { method: 'POST', headers: { cookie: w.cookie.mowner } })
      expect(t.status).toBe(409)
      const l = await fetch(`http://127.0.0.1:${off.port}/api/pages/${w.pageId}/previews`, { headers: { cookie: w.cookie.mowner } })
      expect(await l.json()).toEqual({ enabled: false, previews: [] })
      expect(previewFrames(w.m)).toEqual([])
    } finally {
      await off.close()
    }
  })

  test('每台机器最多 5 个共享中的预览；同页同端口是同一条；停掉一个名额就回来；页面删了的预览不占名额', async () => {
    const w = await world()
    const ids: string[] = []
    for (const port of [3001, 3002, 3003, 3004, 3005]) ids.push(await shareOk(w, w.cookie.mowner, port))
    expect(await shareOk(w, w.cookie.machineOnly, 3001)).toBe(ids[0]) // 同页同机同端口：现成的那条
    const over = await share(w, w.cookie.mowner, 3006)
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: 'too many previews' })
    expect((await api('DELETE', `/api/pages/${w.pageId}/previews/${ids[0]}`, w.cookie.mowner)).status).toBe(200)
    await shareOk(w, w.cookie.mowner, 3006)
    // 页面进了回收站：它的预览不再占机器的名额（下次共享时清掉）
    const page2 = (await (await postJson('/api/pages', w.cookie.sowner, { space_id: w.spaceId })).json()) as { id: string }
    await expect(share({ pageId: page2.id, agent: w.agent }, w.cookie.mowner, 3007)).resolves.toMatchObject({ status: 409 })
    expect((await api('POST', `/api/pages/${w.pageId}/trash`, w.cookie.sowner, {})).status).toBe(200)
    expect((await share({ pageId: page2.id, agent: w.agent }, w.cookie.mowner, 3007)).status).toBe(201)
  })
})

describe('列表与停止', () => {
  test('页面可读的人都能看列表（含 viewer、没有 machine 授权的成员）；非成员 404；字段只含该有的', async () => {
    const w = await world()
    const mine = await shareOk(w, w.cookie.machineOnly, 3000, { path: '/x' })
    for (const role of ['mowner', 'machineOnly', 'plain', 'viewer', 'sowner', 'gadmin'] as Role[]) {
      const l = await list(w, w.cookie[role])
      expect(l.enabled).toBe(true)
      expect(l.previews, role).toHaveLength(1)
      expect(l.previews[0], role).toMatchObject({ id: mine, port: 3000, path: '/x', machine: 'box', shared_by: 'machineOnly', online: true, mine: role === 'machineOnly' })
      expect(l.previews[0]).not.toHaveProperty('pass')
      expect(JSON.stringify(l)).not.toContain(w.id.machineOnly) // 不泄露 user id
    }
    expect((await api('GET', `/api/pages/${w.pageId}/previews`, w.cookie.outsider)).status).toBe(404)
    expect((await api('GET', `/api/pages/nope/previews`, w.cookie.mowner)).status).toBe(404)
    expect((await fetch(`${base}/api/pages/${w.pageId}/previews`)).status).toBe(401)
    // 谁能停：共享人、机器主人
    const can = async (role: Role): Promise<boolean> => (await list(w, w.cookie[role])).previews[0]!.can_stop
    expect([await can('machineOnly'), await can('mowner'), await can('both'), await can('viewer'), await can('sowner')]).toEqual([true, true, false, false, false])
  })

  test('停止：共享人或机器主人；别的成员 / viewer 403，非成员 404；停止后登记、会话、票据全部失效，机器收到 port-unshare', async () => {
    const w = await world()
    const p1 = await shareOk(w, w.cookie.machineOnly, 3000)
    const p2 = await shareOk(w, w.cookie.mowner, 3001)
    const del = (role: Role, id: string, page = w.pageId) => api('DELETE', `/api/pages/${page}/previews/${id}`, w.cookie[role])
    expect((await del('both', p1)).status).toBe(403) // 也有 machine 授权，但不是共享人也不是主人
    expect((await del('plain', p1)).status).toBe(403)
    expect((await del('viewer', p1)).status).toBe(403)
    expect((await del('sowner', p1)).status).toBe(403) // 空间 owner 没有特权
    expect((await del('outsider', p1)).status).toBe(404)
    expect((await del('mowner', 'nope')).status).toBe(404)
    const other = (await (await postJson('/api/pages', w.cookie.sowner, { space_id: w.spaceId })).json()) as { id: string }
    expect((await del('mowner', p1, other.id)).status).toBe(404) // 预览不属于这个页面
    expect((await list(w, w.cookie.mowner)).previews).toHaveLength(2)

    const pv = await enterPreview(w, w.cookie.viewer, p1)
    const url = await ticketUrl(w, w.cookie.viewer, p1)
    // 机器主人停别人共享的：署名是主人
    expect((await del('mowner', p1)).status).toBe(200)
    expect(w.m.of('port-unshare').at(-1)).toMatchObject({ actor: w.id.mowner, previewId: p1 })
    expect(w.m.shares.has(p1)).toBe(false)
    expect((await viaPreview(pv, '/')).status).toBe(404) // 会话失效
    expect((await visit(url)).status).toBe(403) // 票据随预览一起作废
    // 共享人停自己的：署名是共享人
    const p3 = await shareOk(w, w.cookie.machineOnly, 3002)
    expect((await del('machineOnly', p3)).status).toBe(200)
    expect(w.m.of('port-unshare').at(-1)).toMatchObject({ actor: w.id.machineOnly, previewId: p3 })
    expect((await list(w, w.cookie.mowner)).previews.map((p) => p.id)).toEqual([p2])
  })

  test('使用记录：非主人共享 / 停止共享各记一条（action=preview），主人自己的不记', async () => {
    const w = await world()
    const mine = await shareOk(w, w.cookie.mowner, 3000)
    const guest = await shareOk(w, w.cookie.machineOnly, 3001, { path: '/g' })
    await api('DELETE', `/api/pages/${w.pageId}/previews/${mine}`, w.cookie.mowner)
    await api('DELETE', `/api/pages/${w.pageId}/previews/${guest}`, w.cookie.machineOnly)
    const { rows } = await pool.query<{ user_id: string; page_id: string; detail: Record<string, unknown> }>(
      "SELECT user_id, page_id, detail FROM machine_usage_log WHERE connector_id = $1 AND action = 'preview' ORDER BY id",
      [w.m.id],
    )
    expect(rows.map((r) => [r.user_id, r.detail.op, r.detail.port])).toEqual([[w.id.machineOnly, 'share', 3001], [w.id.machineOnly, 'stop', 3001]])
    expect(rows.every((r) => r.page_id === w.pageId)).toBe(true)
    // 主人读得到
    const log = await api('GET', `/api/machines/${w.m.id}/usage`, w.cookie.mowner)
    expect(log.status).toBe(200)
    expect(JSON.stringify(await log.json())).toContain('preview')
  })
})

describe('进入票据', () => {
  test('viewer 能取票据、进入（主人明确共享 = 对本页读者开放）；非成员 404；没登录 401；不存在的预览 404', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.mowner, 3000, { path: '/app?x=1' })
    const res = await visit(await ticketUrl(w, w.cookie.viewer, p))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/app?x=1')
    const setCookie = res.headers.getSetCookie()[0]!
    expect(setCookie).toMatch(/^ramet_pv=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await api('POST', `/api/pages/${w.pageId}/previews/${p}/ticket`, w.cookie.outsider, {})).status).toBe(404)
    expect((await fetch(`${base}/api/pages/${w.pageId}/previews/${p}/ticket`, { method: 'POST' })).status).toBe(401)
    expect((await api('POST', `/api/pages/${w.pageId}/previews/nope/ticket`, w.cookie.viewer, {})).status).toBe(404)
  })

  test('一次性：用过一次就作废；乱写的 / 缺的 / POST 都不行', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.mowner, 3000)
    const url = await ticketUrl(w, w.cookie.viewer, p)
    expect((await visit(url)).status).toBe(302)
    const again = await visit(url)
    expect(again.status).toBe(403)
    expect(await again.text()).toContain('用过或者过期')
    expect(again.headers.get('set-cookie')).toBeNull()
    for (const bad of ['', '?t=', '?t=abc', `?t=${'0'.repeat(64)}`, `?t=${'g'.repeat(64)}`]) {
      const res = await visit(`${previewBase}/__ramet/enter${bad}`)
      expect(res.status, bad).toBe(403)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    const post = await fetch(url, { method: 'POST' })
    expect(post.status).toBe(405)
  })

  test('过期：超过有效期就不认', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.mowner, 3000)
    const url = await ticketUrl(w, w.cookie.viewer, p)
    await sleep(2700) // test-kit 里票据有效期 2.5 秒
    expect((await visit(url)).status).toBe(403)
  })

  test('绑人：浏览器若带着 Ramet 的登录 cookie（同主机不同端口会带过来），必须是发票据的那个人；不对也算用掉了', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.mowner, 3000)
    const url = await ticketUrl(w, w.cookie.viewer, p)
    const other = await visit(url, { cookie: w.cookie.plain })
    expect(other.status).toBe(403)
    expect(await other.text()).toContain('不是发给当前登录的账号')
    expect((await visit(url, { cookie: w.cookie.viewer })).status).toBe(403) // 票据已经被消费
    const url2 = await ticketUrl(w, w.cookie.viewer, p)
    expect((await visit(url2, { cookie: w.cookie.viewer })).status).toBe(302) // 同一个人：放行
  })

  test('取票据之后、进入之前：此人看不到这个页面了 / 共享人没有 machine 授权了 / 预览停了 → 都不让进', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.machineOnly, 3000)
    const gone = await ticketUrl(w, w.cookie.viewer, p)
    await pool.query('DELETE FROM space_members WHERE user_id = $1', [w.id.viewer])
    const res = await visit(gone)
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()

    const url = await ticketUrl(w, w.cookie.plain, p)
    await pool.query("UPDATE machine_grants SET revoked_at = now() WHERE user_id = $1", [w.id.machineOnly]) // 没走收回流程，直接让判定为假
    const noGrant = await visit(url)
    expect(noGrant.status).toBe(404)
    expect((await list(w, w.cookie.mowner)).previews).toEqual([]) // 顺手把预览停了
  })

  test('每人未使用的票据有上限，超了 429', async () => {
    const w = await world()
    const p = await shareOk(w, w.cookie.mowner, 3000)
    for (let i = 0; i < 20; i++) await ticketUrl(w, w.cookie.viewer, p)
    expect((await api('POST', `/api/pages/${w.pageId}/previews/${p}/ticket`, w.cookie.viewer, {})).status).toBe(429)
    await ticketUrl(w, w.cookie.plain, p) // 别人不受影响
  })
})

describe('CSRF 加固（Ramet 主端口）', () => {
  const origin = (value: string | undefined, extra: Record<string, string> = {}): Record<string, string> => ({
    ...(value === undefined ? {} : { origin: value }),
    ...extra,
  })

  test('带外来 Origin 的改数据请求 403；预览源（同主机不同端口）也是外来；同源与没带 Origin（connector / MCP / 测试）放行', async () => {
    const w = await world()
    const post = (h: Record<string, string>) => api('POST', '/api/pages', w.cookie.sowner, { space_id: w.spaceId }, h)
    for (const bad of ['http://evil.example', previewBase, 'null', 'garbage', 'http://127.0.0.1:1']) {
      const res = await post(origin(bad))
      expect(res.status, bad).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
    expect((await post(origin(base))).status).toBe(201) // 同源
    expect((await post({})).status).toBe(201) // 没带 Origin
    const pages = ((await (await api('GET', '/api/pages', w.cookie.sowner)).json()) as unknown[]).length
    expect(pages).toBe(3) // 被拒的请求没有建出页面（world 里 1 个加上面成功的 2 个）
  })

  test('Sec-Fetch-Site：same-site（预览源就是）/ cross-site 一律 403；same-origin / none 放行', async () => {
    const w = await world()
    const post = (site: string) => api('POST', '/api/pages', w.cookie.sowner, { space_id: w.spaceId }, { 'sec-fetch-site': site })
    expect((await post('same-site')).status).toBe(403)
    expect((await post('cross-site')).status).toBe(403)
    expect((await post('same-origin')).status).toBe(201)
    expect((await post('none')).status).toBe(201)
  })

  test('覆盖所有 /api 子应用与各种方法：PATCH / PUT / DELETE / 共享预览 / 登录；GET 不拦', async () => {
    const w = await world()
    const bad = origin(previewBase)
    expect((await api('PATCH', `/api/pages/${w.pageId}`, w.cookie.sowner, { title: 'x' }, bad)).status).toBe(403)
    expect((await api('DELETE', `/api/pages/${w.pageId}`, w.cookie.sowner, undefined, bad)).status).toBe(403)
    expect((await api('POST', `/api/pages/${w.pageId}/project/previews`, w.cookie.mowner, { agent: w.agent, port: 3000 }, bad)).status).toBe(403)
    expect((await api('POST', '/api/auth/logout', w.cookie.sowner, {}, bad)).status).toBe(403)
    expect((await api('POST', '/api/spaces', w.cookie.sowner, { name: 'x' }, bad)).status).toBe(403)
    expect(w.m.of('port-share')).toEqual([])
    expect((await api('GET', '/api/pages', w.cookie.sowner, undefined, bad)).status).toBe(200) // GET 不改数据
    const page = (await (await api('GET', `/api/pages`, w.cookie.sowner)).json()) as Array<{ id: string; title: string }>
    expect(page.find((p) => p.id === w.pageId)?.title).not.toBe('x')
  })

  test('协同升级（/collab）同理：浏览器握手带外来 Origin 不给升级，同源与没带 Origin 照常', async () => {
    const w = await world()
    const open = (originHeader: string | undefined): Promise<'open' | 'refused'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/collab`, { headers: { cookie: w.cookie.sowner, ...(originHeader ? { origin: originHeader } : {}) } })
        ws.on('open', () => {
          ws.terminate()
          resolve('open')
        })
        ws.on('error', () => resolve('refused'))
        ws.on('unexpected-response', () => resolve('refused'))
      })
    expect(await open(previewBase)).toBe('refused')
    expect(await open('http://evil.example')).toBe('refused')
    expect(await open(base)).toBe('open')
    expect(await open(undefined)).toBe('open')
  })

  test('Ramet 的登录 cookie 是 HttpOnly（预览页里的脚本读不到）', async () => {
    await insertUser('cookie-check')
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cookie-check', password: 'pw-123456' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/^ramet_session=[0-9a-f]+;.*HttpOnly/)
  })
})

test('测试服务确实带预览监听', () => {
  expect(s.previewPort).toBeGreaterThan(0)
  expect(ROLES.length).toBe(13)
  expect(pvCookie).toBeTypeOf('function')
})
