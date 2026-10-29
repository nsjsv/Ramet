// ---------- 测试基础设施 ----------
// TRUNCATE 全表：表名现查，新增表不用逐个改测试文件里的清单（手写清单会在新增带外键的表时当场失败）。
//
// 重试死锁（40P01）：多个 worker 并行时偶发互删同一批表的死锁，被中止的一方重试必成功（对方事务此时已结束）。
// 这是并行测试的固有竞争，重试收在这里，不让每个测试文件各写一遍。
// 不要改用 advisory lock 收口：session 级锁在死锁重试时会重复上锁，finally 只解一层，泄漏后会拖垮后续所有 hook。

import { crc32, deflateRawSync } from 'node:zlib'
import type { Pool } from 'pg'
import { createConnector, type CreatedConnector } from './agents/connectors.js'
import type { ConnectorAgentInfo } from './agents/protocol.js'
import { writeConnectorConfig } from './connector/access.js'
import { cloudOrigin } from './connector/pair.js'

const DEADLOCK_RETRIES = 5
const RETRY_DELAY_MS = 100

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function isDeadlock(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === '40P01'
}

// 外键边（子表 → 父表），只看 public 下的普通表
const FK_EDGES = `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
  FROM pg_constraint c
  JOIN pg_class rc ON rc.oid = c.conrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
  WHERE c.contype = 'f' AND rn.nspname = 'public'`

// 没有外键、但写入时会去锁 pages 的表（按 doc_name 文本关联页面，见 collab.ts 的 APPEND_UPDATE），逻辑上也是 pages 的子表
const LOGICAL_EDGES = [
  { child: 'yjs_updates', parent: 'pages' },
  { child: 'yjs_documents', parent: 'pages' },
  // 变更日志（page-sync.ts）方向相反：pages 上的触发器改完 pages 行才写 page_changes，
  // 所以清库也要先锁 pages、后锁 page_changes（排成 pages 的父）；清理先删日志、后写 floor，同理
  { child: 'pages', parent: 'page_changes' },
  { child: 'page_changes', parent: 'page_changes_floor' },
]

/** 子表在前、父表在后（被引用的排在所有引用它的表之后）。
 *  TRUNCATE 按清单顺序逐表上排他锁，而服务端的写入（如协同增量：先写 yjs_updates，再 FOR SHARE 锁 pages 行）
 *  都是先子表后父表。清单若先锁父表，收尾时会与上一用例还没落地的写入互等成环（40P01），
 *  被挑中的往往是服务端一侧（未处理的拒绝，进程退出码 1）。按同一方向上锁就不会成环 */
function childrenFirst(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const parents = new Map<string, Set<string>>()
  for (const t of tables) parents.set(t, new Set())
  for (const { child, parent } of edges) {
    if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent)
  }
  // 反向拓扑：一张表要等所有引用它的子表都排好才能出列
  const children = new Map<string, Set<string>>()
  for (const t of tables) children.set(t, new Set())
  for (const [child, ps] of parents) for (const p of ps) children.get(p)!.add(child)
  const out: string[] = []
  const placed = new Set<string>()
  const ready = tables.filter((t) => children.get(t)!.size === 0)
  while (ready.length) {
    const t = ready.shift()!
    out.push(t)
    placed.add(t)
    for (const p of parents.get(t)!) {
      if ([...children.get(p)!].every((c) => placed.has(c))) ready.push(p)
    }
  }
  // 外键成环（理论上没有）：剩下的原样补在后面
  for (const t of tables) if (!placed.has(t)) out.push(t)
  return out
}

export async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )
  if (!rows.length) return
  const { rows: edges } = await pool.query<{ child: string; parent: string }>(FK_EDGES)
  const strip = (name: string): string => name.replace(/^"|"$/g, '')
  const ordered = childrenFirst(
    rows.map((r) => r.tablename),
    [...edges.map((e) => ({ child: strip(e.child), parent: strip(e.parent) })), ...LOGICAL_EDGES],
  )
  const names = ordered.map((t) => `"${t}"`).join(', ')
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`)
      return
    } catch (err) {
      if (attempt >= DEADLOCK_RETRIES || !isDeadlock(err)) throw err
      await delay(RETRY_DELAY_MS)
    }
  }
}

/** 造一个 zip：路径 -> 内容。路径原样写进包（含不安全的，用来测拒绝），method 选存储或 deflate */
export function makeZip(entries: Record<string, string | Buffer>, method: 'deflate' | 'store' = 'deflate'): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const packed = method === 'deflate' ? deflateRawSync(data) : data
    const nameBuf = Buffer.from(name)
    const crc = crc32(data) >>> 0
    const code = method === 'deflate' ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(code, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(code, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

/** 跳过浏览器确认，直接建一台 connector（与确认路径同一个 createConnector：状态按 ownerId 此刻的空间角色定，
 *  owner 为 approved，member 为 pending）。给了 tokenFile + cloud 就把本地配置（token / 中心 / 主人）一并写好，
 *  之后 runConnector / cli 不带 --repair 直接用它连。配对流程本身见 connect-pair.test.ts */
export async function provisionConnector(
  pool: Pool,
  opts: { spaceId: string; ownerId: string; name: string; agents?: ConnectorAgentInfo[]; cloud?: string; tokenFile?: string },
): Promise<CreatedConnector> {
  const created = await createConnector(pool, opts.spaceId, opts.ownerId, opts.name, opts.agents ?? [])
  if (!created) throw new Error(`${opts.ownerId} 不是空间 ${opts.spaceId} 的 owner / member，建不了机器`)
  if (opts.tokenFile && opts.cloud) {
    writeConnectorConfig(opts.tokenFile, { token: created.token, cloud: cloudOrigin(opts.cloud), ownerId: opts.ownerId })
  }
  return created
}
