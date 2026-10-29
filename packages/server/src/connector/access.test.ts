// ---------- connector 第二道闸：本地配置里谁能驱动这台机器 ----------
// checkActor 的口径（connector/access.ts）：缺 actor / 配置读不到 / 主人没钉住，一律拒绝（包括主人自己，宁可多拒绝）；
// 主人通过；本地授权名单里的人在 scope 匹配、未过期时通过；名单里的坏条目丢弃，手改文件写错不能放行任何人。
// pinOwner：中心告知的主人只在没钉过时写入，钉过的绝不改写。
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { checkActor, pinOwner, readConnectorConfig, writeConnectorConfig, type ConnectorConfig } from './access.js'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ramet-access-'))
  file = join(dir, 'connector.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-15T12:00:00Z')
const LATER = '2026-10-16T12:00:00Z'
const EARLIER = '2026-10-14T12:00:00Z'

const base = (extra: Partial<ConnectorConfig> = {}): ConnectorConfig => ({ token: 'tok', cloud: 'ws://center', ...extra })
const put = (config: unknown): void => writeFileSync(file, JSON.stringify(config))
const stored = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

// ---------- checkActor ----------

test('没带操作人：一律拒绝（缺 / 空串 / 不是字符串），连主人在场的配置也一样', () => {
  put(base({ ownerId: 'owner' }))
  for (const actor of [undefined, null, '', 0, 42, {}, ['owner']]) {
    const verdict = checkActor(file, actor, 'agent', NOW)
    expect(verdict, String(JSON.stringify(actor))).toMatchObject({ ok: false, reason: expect.stringContaining('没有带操作人') })
  }
})

test('配置读不到：文件不存在 / 不是 JSON / 缺 token → 拒绝', () => {
  expect(checkActor(join(dir, 'nope.json'), 'owner', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('读不到') })
  writeFileSync(file, '{ 不是 json')
  expect(checkActor(file, 'owner', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('读不到') })
  put({ cloud: 'ws://center', ownerId: 'owner' })
  expect(checkActor(file, 'owner', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('读不到') })
  put({ token: '', ownerId: 'owner' })
  expect(checkActor(file, 'owner', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('读不到') })
  put([1, 2, 3])
  expect(checkActor(file, 'owner', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('读不到') })
})

test('ownerId 没钉住：拒绝一切人，包括主人和名单里有授权的人', () => {
  put(base({ grants: [{ userId: 'ally', scopes: ['agent', 'machine'], expiresAt: LATER }] }))
  for (const actor of ['owner', 'ally', 'anyone']) {
    expect(checkActor(file, actor, 'agent', NOW), actor).toMatchObject({ ok: false, reason: expect.stringContaining('主人') })
  }
  // 空串的 ownerId 等于没有
  put({ token: 'tok', cloud: 'ws://center', ownerId: '' })
  expect(checkActor(file, '', 'agent', NOW).ok).toBe(false)
  expect(checkActor(file, 'owner', 'agent', NOW).ok).toBe(false)
})

test('主人通过（两种 scope 都行）；别人没在名单里就拒绝', () => {
  put(base({ ownerId: 'owner' }))
  expect(checkActor(file, 'owner', 'agent', NOW)).toEqual({ ok: true })
  expect(checkActor(file, 'owner', 'machine', NOW)).toEqual({ ok: true })
  expect(checkActor(file, 'stranger', 'agent', NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('不允许你使用') })
  expect(checkActor(file, 'stranger', 'machine', NOW).ok).toBe(false)
})

test('授权名单里的人：scope 匹配且未过期才通过；scope 不符、过期、恰好到期都拒绝', () => {
  put(base({
    ownerId: 'owner',
    grants: [
      { userId: 'agent-only', scopes: ['agent'], expiresAt: LATER },
      { userId: 'term-only', scopes: ['machine'], expiresAt: LATER },
      { userId: 'both', scopes: ['agent', 'machine'], expiresAt: LATER },
      { userId: 'stale', scopes: ['agent', 'machine'], expiresAt: EARLIER },
      { userId: 'now', scopes: ['agent'], expiresAt: new Date(NOW).toISOString() },
    ],
  }))
  expect(checkActor(file, 'agent-only', 'agent', NOW).ok).toBe(true)
  expect(checkActor(file, 'agent-only', 'machine', NOW).ok).toBe(false)
  expect(checkActor(file, 'term-only', 'machine', NOW).ok).toBe(true)
  expect(checkActor(file, 'term-only', 'agent', NOW).ok).toBe(false) // 只授权终端 / 文件时 agent 不可用，反之亦然
  expect(checkActor(file, 'both', 'agent', NOW).ok).toBe(true)
  expect(checkActor(file, 'both', 'machine', NOW).ok).toBe(true)
  expect(checkActor(file, 'stale', 'agent', NOW).ok).toBe(false)
  expect(checkActor(file, 'stale', 'machine', NOW).ok).toBe(false)
  expect(checkActor(file, 'now', 'agent', NOW).ok).toBe(false) // 到期时刻本身已经不算
  // 同一个人多条授权：任一条满足即可
  put(base({
    ownerId: 'owner',
    grants: [
      { userId: 'twice', scopes: ['agent'], expiresAt: EARLIER },
      { userId: 'twice', scopes: ['agent'], expiresAt: LATER },
    ],
  }))
  expect(checkActor(file, 'twice', 'agent', NOW).ok).toBe(true)
})

test('grants 里的坏条目一律丢弃，手改文件写错不能放行任何人', () => {
  put({
    token: 'tok',
    cloud: 'ws://center',
    ownerId: 'owner',
    grants: [
      null,
      'ally',
      7,
      [],
      {},
      { userId: 'no-expiry', scopes: ['agent'] },
      { userId: 'no-scopes', expiresAt: LATER },
      { userId: 'string-scopes', scopes: 'agent', expiresAt: LATER },
      { userId: 'bad-scope', scopes: ['root', 'admin', 'AGENT'], expiresAt: LATER },
      { userId: 'bad-date', scopes: ['agent'], expiresAt: '很快' },
      { userId: 7, scopes: ['agent'], expiresAt: LATER },
      { userId: '', scopes: ['agent'], expiresAt: LATER },
      { userId: 'mixed', scopes: ['root', 'agent'], expiresAt: LATER },
    ],
  })
  for (const actor of ['no-expiry', 'no-scopes', 'string-scopes', 'bad-scope', 'bad-date', '7', '']) {
    expect(checkActor(file, actor, 'agent', NOW).ok, actor).toBe(false)
    expect(checkActor(file, actor, 'machine', NOW).ok, actor).toBe(false)
  }
  // 坏 scope 被筛掉后只剩合法的那个
  expect(checkActor(file, 'mixed', 'agent', NOW).ok).toBe(true)
  expect(checkActor(file, 'mixed', 'machine', NOW).ok).toBe(false)
  // 读出来的名单只剩形状合法的两条；日期解析不了的那条留着但永远过不了 checkActor（上面已断言）
  expect(readConnectorConfig(file)?.grants).toEqual([
    { userId: 'bad-date', scopes: ['agent'], expiresAt: '很快' },
    { userId: 'mixed', scopes: ['agent'], expiresAt: LATER },
  ])
  // grants 根本不是数组：当没有
  put({ token: 'tok', cloud: 'ws://center', ownerId: 'owner', grants: { userId: 'x', scopes: ['agent'], expiresAt: LATER } })
  expect(checkActor(file, 'x', 'agent', NOW).ok).toBe(false)
  expect(checkActor(file, 'owner', 'agent', NOW).ok).toBe(true)
})

test('每次判定都现读文件：外部进程改名单（授权 / 收回）立即生效，不缓存', () => {
  put(base({ ownerId: 'owner' }))
  expect(checkActor(file, 'ally', 'agent', NOW).ok).toBe(false)
  put(base({ ownerId: 'owner', grants: [{ userId: 'ally', scopes: ['agent'], expiresAt: LATER }] }))
  expect(checkActor(file, 'ally', 'agent', NOW).ok).toBe(true)
  put(base({ ownerId: 'owner' }))
  expect(checkActor(file, 'ally', 'agent', NOW).ok).toBe(false)
})

// ---------- pinOwner ----------

test('pinOwner：没钉过 → 写入主人并保留其余字段（token / cloud / 授权名单）', () => {
  const grants = [{ userId: 'ally', scopes: ['agent' as const], expiresAt: LATER }]
  put(base({ grants }))
  expect(pinOwner(file, 'owner')).toBe('pinned')
  expect(readConnectorConfig(file)).toEqual({ token: 'tok', cloud: 'ws://center', ownerId: 'owner', grants })
  expect(checkActor(file, 'owner', 'agent', NOW).ok).toBe(true)
})

test('pinOwner：钉过之后绝不改写 —— 同一个人 kept，换了人 conflict，文件原样', () => {
  put(base({ ownerId: 'owner' }))
  const before = readFileSync(file, 'utf8')
  expect(pinOwner(file, 'owner')).toBe('kept')
  expect(pinOwner(file, 'attacker')).toBe('conflict')
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(readConnectorConfig(file)?.ownerId).toBe('owner')
  expect(checkActor(file, 'attacker', 'agent', NOW).ok).toBe(false)
})

test('pinOwner：没有配置文件 / 配置坏了 → no-config，什么都不写', () => {
  expect(pinOwner(file, 'owner')).toBe('no-config')
  expect(() => statSync(file)).toThrow()
  writeFileSync(file, 'garbage')
  expect(pinOwner(file, 'owner')).toBe('no-config')
  expect(readFileSync(file, 'utf8')).toBe('garbage')
})

test('writeConnectorConfig：目录不存在会建；文件权限 0600（里面有 token）；读回一致', () => {
  const nested = join(dir, 'a', 'b', 'connector.json')
  const config = base({ ownerId: 'owner', grants: [{ userId: 'ally', scopes: ['agent', 'machine'], expiresAt: LATER }] })
  writeConnectorConfig(nested, config)
  expect(readConnectorConfig(nested)).toEqual(config)
  expect(statSync(nested).mode & 0o777).toBe(0o600)
  // 没有授权名单时不写空数组的歧义字段
  writeConnectorConfig(nested, base({ ownerId: 'owner' }))
  expect(stored(nested)).toEqual({ token: 'tok', cloud: 'ws://center', ownerId: 'owner' })
})
