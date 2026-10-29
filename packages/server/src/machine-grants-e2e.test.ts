/* ---------- 授权全链路（真 server + 真 connector 进程内 + 真命令行）----------
 * 网页发起授权 → 机器上 `grant confirm`（要输入 yes）→ 本机名单与中心同时生效 → 被授权人两道闸都过 →
 * 网页收回 → 中心拒绝 + 本机名单被中心的 grant-revoked 帧清掉；本机 `grant revoke` → 中心也收回。
 * 授权流程缺任何一步（没输 yes / 命令没跑成 / 中心没确认）都不生效。 */
import { expect, test } from 'vitest'
import { CONNECTOR_TOKEN_HEADER } from './agents/protocol.js'
import { readConnectorConfig } from './connector/access.js'
import { runGrantCommand, type GrantIo } from './connector/grant-cli.js'
import {
  SSECollector,
  agentsList,
  base,
  connectorLogs,
  connectorTokenFile,
  insertUser,
  login,
  pool,
  postJson,
  startConnector,
  waitFor,
} from './agents/test-kit.js'

process.env.RAMET_PUBLIC_URL = base

const call = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

function io(answer: string, fetchImpl: typeof fetch = fetch): GrantIo & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: (l) => lines.push(l), ask: async () => answer, fetch: fetchImpl }
}

test('全链路：网页发起 → 机器上输入 yes 确认 → 两道闸都放行；没输 yes / 确认没送达中心都不生效；网页收回与本机收回都两边同时失效', async () => {
  const mowner = await insertUser('mowner')
  await insertUser('sowner')
  const alice = await insertUser('alice')
  const cookie = { mowner: await login('mowner'), sowner: await login('sowner'), alice: await login('alice') }
  const space = (await (await postJson('/api/spaces', cookie.sowner, { name: 's' })).json()) as { id: string }
  for (const [id, role] of [[mowner, 'member'], [alice, 'member']] as const) {
    await pool.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [space.id, id, role])
  }
  const page = (await (await postJson('/api/pages', cookie.sowner, { space_id: space.id })).json()) as { id: string }
  const real = await startConnector({ spaceId: space.id, ownerId: mowner, name: 'realbox', cookie: cookie.mowner })
  const claude = `c:${real}:claude`
  const file = connectorTokenFile(real)
  const logs = (): string[] => connectorLogs(real)
  const count = (prefix: string): number => logs().filter((l) => l.startsWith(prefix)).length
  const cli = (argv: string[], i: GrantIo): Promise<number> => runGrantCommand([...argv, '--token-file', file], { defaultTokenFile: file, io: i })
  const prepare = (): Promise<Response> => postJson(`/api/pages/${page.id}/agent-prepare`, cookie.alice, { agent: claude })
  const localUsers = (): string[] => (readConnectorConfig(file)?.grants ?? []).map((g) => g.userId)

  // 网页上发起
  const issued = (await (
    await call('POST', `/api/machines/${real}/grants`, cookie.mowner, {
      password: 'pw-123456', userId: alice, username: 'alice', machineName: 'realbox', scopes: ['agent'], days: 2, acknowledged: true,
    })
  ).json()) as { grantId: string; code: string; command: string }
  expect(issued.command).toContain(issued.code)
  // 还没在机器上确认：两道闸都不放行
  expect((await prepare()).status).toBe(403)
  expect((await agentsList(cookie.alice)).some((a) => a.id === claude)).toBe(false)

  // 在机器上敲了命令但没输 yes：不生效
  expect(await cli(['confirm', issued.code], io('no'))).toBe(1)
  expect(localUsers()).toEqual([])
  expect((await prepare()).status).toBe(403)

  // 输了 yes 但确认没送达中心（网络断了）：本机名单回滚，仍不生效；码没被消耗，可以重来
  const flaky: typeof fetch = (input, init) => {
    if (init?.method === 'POST') return Promise.reject(new TypeError('网络断了'))
    return fetch(input, init)
  }
  const failed = io('yes', flaky)
  expect(await cli(['confirm', issued.code], failed)).toBe(1)
  expect(failed.lines.join('\n')).toContain('连不上中心')
  expect(localUsers()).toEqual([])
  expect((await prepare()).status).toBe(403)

  // 输入 yes（码大小写 / 连字符不计）：本机名单与中心同时生效
  const ok = io('yes')
  expect(await cli(['confirm', issued.code.toLowerCase().replaceAll('-', '')], ok)).toBe(0)
  expect(localUsers()).toEqual([alice])
  expect(readConnectorConfig(file)).toMatchObject({ ownerId: mowner, grants: [{ username: 'alice', scopes: ['agent'], grantId: issued.grantId }] })
  expect(await cli(['confirm', issued.code], io('yes'))).toBe(1) // 码是一次性的
  expect(localUsers()).toEqual([alice]) // 重复确认没把名单弄坏

  // 两道闸都放行：alice 能建会话、改配置；connector 没有拒绝过她
  const sse = new SSECollector()
  await sse.start(page.id, cookie.alice)
  expect((await prepare()).status).toBe(202)
  await sse.wait((e) => e.type === 'config' && e.agentId === claude && e.options.length > 0)
  expect(count('指令 new')).toBeGreaterThan(0)
  expect(count('拒绝 ')).toBe(0)
  expect((await postJson(`/api/pages/${page.id}/agent-config`, cookie.alice, { agent: claude, configId: 'model', value: 'm1' })).status).toBe(200)
  expect(count('指令 config')).toBe(1)

  // 网页上收回：中心拒绝，且中心的 grant-revoked 帧把本机名单里的她删掉（第二道闸也关）
  expect((await call('DELETE', `/api/machines/${real}/grants/${issued.grantId}`, cookie.mowner)).status).toBe(200)
  expect((await prepare()).status).toBe(403)
  await waitFor(() => localUsers().length === 0)
  expect(logs().some((l) => l.startsWith('授权已收回 userId='))).toBe(true)

  // 再授权一次 → 本机命令行收回：本机名单与中心同时失效
  const again = (await (
    await call('POST', `/api/machines/${real}/grants`, cookie.mowner, {
      password: 'pw-123456', userId: alice, username: 'alice', machineName: 'realbox', scopes: ['agent', 'machine'], days: 1, acknowledged: true,
    })
  ).json()) as { code: string; grantId: string }
  expect(await cli(['confirm', again.code], io('yes'))).toBe(0)
  expect((await prepare()).status).toBe(202)
  const revoked = io('')
  expect(await cli(['revoke', 'alice'], revoked)).toBe(0)
  expect(localUsers()).toEqual([])
  expect((await prepare()).status).toBe(403)
  expect((await pool.query('SELECT revoked_at, ended_at FROM machine_grants WHERE id = $1', [again.grantId])).rows[0]).toMatchObject({
    revoked_at: expect.any(Date),
    ended_at: expect.any(Date),
  })

  // 别的机器 / 没带 token 都碰不到这台机器的确认端点
  expect((await fetch(`${base}/api/connector/grants/${again.code}`, { headers: { [CONNECTOR_TOKEN_HEADER]: 'x'.repeat(64) } })).status).toBe(401)
  sse.stop()
})
