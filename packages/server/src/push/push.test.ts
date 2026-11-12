/* ---------- 浏览器推送：接口 + 派发（真 Postgres，整站起在 test-kit 里，推送服务是假的）----------
 * 收件箱条目用评论造（整页讨论：bob 开串 → 页面创建人 alice 收到「发了新评论」）。
 * 每条推送用订阅时的浏览器私钥真解密，断言内容与 noticeOf 一致。 */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from 'node:crypto'
import { beforeEach, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { base, joinPageSpace, pool, pushService, s, setupPage, userIdOf, waitFor } from '../agents/test-kit.js'
import { PushNetworkError } from './webpush.js'

beforeEach(() => {
  pushService.sent = []
  pushService.status = 201
  pushService.fail = null
})

const post = (path: string, cookie: string | null, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) })

type Device = { endpoint: string; ecdh: ECDH; auth: Buffer }

function device(): Device {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`, ecdh, auth: randomBytes(16) }
}

const keysOf = (d: Device) => ({ p256dh: d.ecdh.getPublicKey().toString('base64url'), auth: d.auth.toString('base64url') })

async function subscribe(cookie: string, d: Device): Promise<Response> {
  return post('/api/push/subscriptions', cookie, { endpoint: d.endpoint, keys: keysOf(d) })
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

/** 浏览器那一侧的解密（RFC 8291），测试自己实现一份，不复用被测代码 */
function decrypt(d: Device, body: Buffer): { title: string; body: string; url: string; tag: string } {
  const salt = body.subarray(0, 16)
  const idlen = body[20]!
  const asPublic = body.subarray(21, 21 + idlen)
  const sealed = body.subarray(21 + idlen)
  const uaPublic = d.ecdh.getPublicKey()
  const secret = d.ecdh.computeSecret(asPublic)
  const ikm = hmac(hmac(d.auth, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  expect(plain[plain.length - 1]).toBe(2)
  return JSON.parse(plain.subarray(0, -1).toString()) as { title: string; body: string; url: string; tag: string }
}

const sentTo = (d: Device) => pushService.sent.filter((r) => r.url === d.endpoint).map((r) => decrypt(d, r.body))

type World = { pageId: string; alice: string; bob: string }

async function world(): Promise<World> {
  const { cookie: alice, pageId } = await setupPage()
  const bob = await joinPageSpace(pageId, 'bob', { role: 'member' })
  await pool.query('UPDATE pages SET page_comments = true WHERE id = $1', [pageId])
  return { pageId, alice, bob }
}

/** bob 在整页讨论里开一个串（alice 是页面创建人，收件箱多一条「发了新评论」） */
async function openThread(w: World, text: string): Promise<string> {
  const res = await post(`/api/pages/${w.pageId}/comments`, w.bob, { kind: 'page', body: text })
  expect(res.status).toBe(201)
  return ((await res.json()) as { thread: { id: string } }).thread.id
}

/** 评论接口写成功就 poke 收件箱；去抖 300ms 后派发，等它跑完 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400))
  await s.push.idle()
}

/** 连 control:global 并上报自己的状态（同浏览器里的 presence.ts） */
async function presence(cookie: string, state: 'on' | 'off'): Promise<HocuspocusProvider> {
  const wsProvider = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${s.port}/collab`,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, undefined, { headers: { cookie } })
      }
    } as unknown as typeof WebSocket,
    quiet: true,
  })
  const provider = new HocuspocusProvider({ websocketProvider: wsProvider, name: 'control:global', token: 'test', quiet: true })
  await new Promise<void>((resolve) => provider.on('synced', () => resolve()))
  provider.sendStateless(`presence:${state}`)
  return provider
}

test('未登录 401；公钥稳定（重复取同一把）', async () => {
  expect((await fetch(`${base}/api/push/key`)).status).toBe(401)
  expect((await post('/api/push/subscriptions', null, {})).status).toBe(401)
  const { cookie } = await setupPage()
  const a = (await (await fetch(`${base}/api/push/key`, { headers: { cookie } })).json()) as { publicKey: string }
  const b = (await (await fetch(`${base}/api/push/key`, { headers: { cookie } })).json()) as { publicKey: string }
  expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(65)
  expect(b.publicKey).toBe(a.publicKey)
  expect((await pool.query('SELECT count(*)::int AS n FROM push_keys')).rows[0].n).toBe(1)
})

test('订阅地址不在推送服务清单里 / 密钥不对：400，不落库', async () => {
  const { cookie } = await setupPage()
  const d = device()
  for (const endpoint of ['https://127.0.0.1/push', 'http://fcm.googleapis.com/fcm/send/x', 'https://attacker.example/fcm.googleapis.com']) {
    expect((await post('/api/push/subscriptions', cookie, { endpoint, keys: keysOf(d) })).status, endpoint).toBe(400)
  }
  const offCurve = Buffer.alloc(65, 1)
  offCurve[0] = 4
  expect((await post('/api/push/subscriptions', cookie, { endpoint: d.endpoint, keys: { p256dh: offCurve.toString('base64url'), auth: keysOf(d).auth } })).status).toBe(400)
  expect((await post('/api/push/subscriptions', cookie, { endpoint: d.endpoint, keys: { p256dh: keysOf(d).p256dh } })).status).toBe(400)
  expect((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(0)
})

test('新出现的条目推一次，内容同收件箱；同一件事不重发；串里来了新回复再推', async () => {
  const w = await world()
  const d = device()
  expect((await subscribe(w.alice, d)).status).toBe(200)
  const tid = await openThread(w, '这页写得不错')
  await settle()
  const first = sentTo(d)
  expect(first).toEqual([{ title: 'bob 发了新评论', body: expect.stringContaining('这页写得不错'), url: `/page/${w.pageId}?comment=${tid}`, tag: `comment:${tid}` }])
  const req = pushService.sent[0]!
  expect(req.headers['content-encoding']).toBe('aes128gcm')
  expect(req.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  expect(req.headers.urgency).toBe('normal')

  // 别的信号（同一个人的收件箱没新东西）：不重发
  await openThread({ ...w, bob: w.alice }, '自己开的串不通知自己')
  await settle()
  expect(sentTo(d)).toHaveLength(1)

  // alice 在串里回复过，bob 再回复 → 同一个串、新的时间，算新的一件
  expect((await post(`/api/comment-threads/${tid}/replies`, w.alice, { body: '谢谢' })).status).toBe(201)
  expect((await post(`/api/comment-threads/${tid}/replies`, w.bob, { body: '不客气' })).status).toBe(201)
  await settle()
  const all = sentTo(d)
  expect(all).toHaveLength(2)
  expect(all[1]).toMatchObject({ title: 'bob 回复了你', tag: `comment:${tid}` })
})

test('开启前已有的条目不补发', async () => {
  const w = await world()
  await openThread(w, '开启之前的评论')
  await settle()
  const d = device()
  await subscribe(w.alice, d)
  await openThread({ ...w, bob: w.alice }, '触发一次派发')
  await settle()
  expect(sentTo(d)).toEqual([])
  // 重复登记同一台设备不重种基线、不影响之后的
  await subscribe(w.alice, d)
  await openThread(w, '之后的评论')
  await settle()
  expect(sentTo(d).map((n) => n.body)).toEqual([expect.stringContaining('之后的评论')])
})

test('人在跟前：记下不发，离开之后也不补推；断开连接 = 不在', async () => {
  const w = await world()
  const d = device()
  await subscribe(w.alice, d)
  const tab = await presence(w.alice, 'on')
  try {
    await waitFor(async () => {
      await openThread(w, '在跟前时来的')
      await settle()
      return (await pool.query('SELECT count(*)::int AS n FROM push_sent')).rows[0].n > 0
    })
    expect(sentTo(d)).toEqual([])
    tab.sendStateless('presence:off')
    await new Promise((r) => setTimeout(r, 100))
    await openThread(w, '离开之后来的')
    await settle()
    expect(sentTo(d).map((n) => n.body)).toEqual([expect.stringContaining('离开之后来的')])
    tab.sendStateless('presence:on')
    await new Promise((r) => setTimeout(r, 100))
  } finally {
    tab.destroy()
  }
  await waitFor(async () => {
    await openThread(w, '标签页关了之后来的')
    await settle()
    return sentTo(d).some((n) => n.body.includes('标签页关了之后来的'))
  })
})

test('一次新出现太多：前 9 条照发，其余合成一条「还有 N 件事」', async () => {
  const w = await world()
  const d = device()
  await subscribe(w.alice, d)
  const tab = await presence(w.alice, 'on')
  for (let i = 0; i < 12; i++) await openThread(w, `第 ${i} 条`)
  // 在跟前时攒下的不算；离开后一口气来 12 条
  await settle()
  tab.destroy()
  await new Promise((r) => setTimeout(r, 200))
  await pool.query('DELETE FROM push_sent')
  await openThread({ ...w, bob: w.alice }, '触发')
  await settle()
  const got = sentTo(d)
  expect(got).toHaveLength(10)
  expect(got[9]).toMatchObject({ title: '还有 3 件事', url: '/inbox' })
})

test('推送服务回 410：订阅删掉；500 / 连不上：状态里有可读原因，下次成功清掉', async () => {
  const w = await world()
  const gone = device()
  const flaky = device()
  await subscribe(w.alice, gone)
  await subscribe(w.alice, flaky)
  const status = async (d: Device) => (await (await post('/api/push/status', w.alice, { endpoint: d.endpoint })).json()) as { registered: boolean; error: string | null }

  pushService.status = 410
  await openThread(w, 'a')
  await settle()
  expect(await status(gone)).toMatchObject({ registered: false })
  expect(await status(flaky)).toMatchObject({ registered: false })

  await subscribe(w.alice, flaky)
  pushService.status = 500
  await openThread(w, 'b')
  await settle()
  expect(await status(flaky)).toEqual({ registered: true, error: '推送服务返回 500', failedAt: expect.any(String) })

  pushService.fail = new PushNetworkError('fcm.googleapis.com', 'ETIMEDOUT')
  const test1 = (await (await post('/api/push/test', w.alice, { endpoint: flaky.endpoint })).json()) as { ok: boolean; error?: string }
  expect(test1).toEqual({ ok: false, error: '连不上推送服务 fcm.googleapis.com（ETIMEDOUT）' })
  expect((await status(flaky)).error).toBe('连不上推送服务 fcm.googleapis.com（ETIMEDOUT）')

  pushService.fail = null
  pushService.status = 201
  const test2 = (await (await post('/api/push/test', w.alice, { endpoint: flaky.endpoint })).json()) as { ok: boolean }
  expect(test2).toEqual({ ok: true })
  expect(sentTo(flaky).at(-1)).toMatchObject({ title: 'Ramet 测试通知', tag: 'ramet:test' })
  expect(await status(flaky)).toEqual({ registered: true, error: null, failedAt: null })
})

test('换号登录同一个浏览器：订阅归新的人，上一个人不再收到；注销只删自己的', async () => {
  const w = await world()
  const d = device()
  await subscribe(w.alice, d)
  await subscribe(w.bob, d)
  const owner = (await pool.query('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [d.endpoint])).rows[0].user_id
  expect(owner).toBe(await userIdOf('bob'))
  await openThread(w, '给 alice 的')
  await settle()
  expect(sentTo(d)).toEqual([])
  // alice 拿别人的 endpoint 注销 / 测试 / 查状态：都当没有
  await post('/api/push/unsubscribe', w.alice, { endpoint: d.endpoint })
  expect((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(1)
  expect(await (await post('/api/push/test', w.alice, { endpoint: d.endpoint })).json()).toMatchObject({ ok: false })
  expect(await (await post('/api/push/status', w.alice, { endpoint: d.endpoint })).json()).toMatchObject({ registered: false })
  await post('/api/push/unsubscribe', w.bob, { endpoint: d.endpoint })
  expect((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(0)
})
