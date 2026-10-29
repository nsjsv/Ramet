// ---------- 机器授权：网页端的 REST（登录用户）----------
// GET    /api/spaces/:id/machines              空间里的机器列表（成员可读；只给 id / 机器名 / 主人名 / 在线 / 我的授权与申请，不泄露别的）
//                                              → [{id, name, owner, online, mine, grant:{id, scopes, expiresAt}|null, request, requestId}]
// POST   /api/machines/:id/requests            成员申请使用（{scopes, note}）；GET 主人看申请；DELETE 主人拒绝 / 申请人撤回
// POST   /api/machines/:id/grants              只有机器主人能发起授权（重输密码 + 手输用户名与机器名 + 勾范围 + 确认已读后果）
//                                              body {password, username, machineName, scopes, days?, acknowledged, userId?}：
//                                              给了 userId 就是授权给这个人，username 是手输的确认（必须与他的用户名完全一致）；
//                                              没给就按 username 找人。days 缺省 7，范围 1..30。
//                                              → 201 {grantId, code, expiresAt, confirmExpiresAt, command}：待确认授权 + 一次性确认码
//                                              （只返回这一次）；要在那台机器上敲 command 确认才生效（15 分钟内）
// GET    /api/machines/:id/grants              主人看授权列表（含待确认 / 生效 / 已过期 / 已收回）
// DELETE /api/machines/:id/grants/:gid         主人收回，或被授权人自己放弃（收回即断：取消在飞的轮次、作废凭证、通知机器）
// GET    /api/machines/:id/usage               主人看使用记录（只记非主人；分页）
// 谁能用机器的判定在 agents/machine-access.ts，授权表的写入口在 agents/machine-grants.ts，这里只是 HTTP 外壳。
// 还在等空间 owner 批准（status='pending'）的机器不在空间里出现：列表只给接入人自己看到它（带 status:'pending'），
// 别人申请使用 404，主人创建授权 409。
// 主人是 connectors.owner_id。空间 owner、全局 admin 都不是主人，对授权类写操作一律 403。
// 机器上的确认 / 本机收回走 connector token 认证的端点（routes/connector-grants.ts）。

import { Hono, type Context } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, verifyPassword, type AuthEnv } from '../auth.js'
import type { ConnectorHub } from '../agents/hub.js'
import type { MachineScope } from '../agents/machine-access.js'
import {
  GRANT_DAYS_DEFAULT,
  GRANT_DAYS_MAX,
  MACHINE_SCOPES,
  PendingGrantExists,
  RequestExists,
  USAGE_LIMIT_DEFAULT,
  createGrant,
  createRequest,
  grantOwnerOf,
  listGrants,
  listRequests,
  listUsage,
  requestOwnerOf,
  resolveRequest,
  revokeGrant,
  type Disconnect,
} from '../agents/machine-grants.js'
import { FailureLimiter } from '../rate-limit.js'

type SpaceRole = 'owner' | 'member' | 'viewer'
type Machine = { id: string; name: string; spaceId: string; ownerId: string | null; role: SpaceRole | null; status: 'pending' | 'approved' }

/** 重输密码：窗口内失败这么多次后一律拒绝（连正确密码也拒） */
const PASSWORD_MAX_FAILURES = 5
const PASSWORD_WINDOW_MS = 15 * 60_000
const NOTE_MAX = 200

const SELECT_MACHINE = `SELECT c.id, c.name, c.space_id, c.owner_id, c.status, m.role
  FROM connectors c LEFT JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $2 WHERE c.id = $1`
const SELECT_SPACE_ROLE = 'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2'
// 空间里的机器列表：LATERAL 取我此刻的有效授权（一人一机至多一条，万一有多条取最晚到期的）。
// 只列已批准的，外加我自己的 pending（别人的 pending 整行不返回）
const SELECT_SPACE_MACHINES = `SELECT c.id, c.name, c.status, u.username AS owner, COALESCE(c.owner_id = $2, false) AS mine,
    g.id AS grant_id, g.scopes AS grant_scopes, g.expires_at AS grant_expires_at,
    (SELECT r.id FROM machine_access_requests r WHERE r.connector_id = c.id AND r.user_id = $2 AND r.resolved_at IS NULL LIMIT 1) AS request_id
  FROM connectors c
  LEFT JOIN users u ON u.id = c.owner_id
  LEFT JOIN LATERAL (
    SELECT id, scopes, expires_at FROM machine_grants
    WHERE connector_id = c.id AND user_id = $2 AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND expires_at > now()
    ORDER BY expires_at DESC LIMIT 1
  ) g ON true
  WHERE c.space_id = $1 AND (c.status = 'approved' OR c.owner_id = $2) ORDER BY c.created_at, c.id`
const SELECT_PASSWORD = 'SELECT password FROM users WHERE id = $1'
const SELECT_USER_BY_ID = 'SELECT id, username FROM users WHERE id = $1'
const SELECT_USER_BY_NAME = 'SELECT id, username FROM users WHERE username = $1'

function parseScopes(raw: unknown): MachineScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out = new Set<MachineScope>()
  for (const item of raw) {
    if (!MACHINE_SCOPES.includes(item as MachineScope)) return null
    out.add(item as MachineScope)
  }
  return [...out]
}

export function machinesRoutes(
  pool: Pool,
  // inbox：使用申请出现 / 被处理（主人的收件箱里多一条 / 少一条），只是去重拉的信号
  deps: { hub: ConnectorHub; disconnect: Disconnect; notify?: () => void; inbox?: () => void },
) {
  const app = new Hono<AuthEnv>()
  const auth = requireAuth(pool)
  const limiter = new FailureLimiter(PASSWORD_MAX_FAILURES, PASSWORD_WINDOW_MS)

  async function loadMachine(id: string, userId: string): Promise<Machine | null> {
    const { rows } = await pool.query<{
      id: string
      name: string
      space_id: string
      owner_id: string | null
      status: 'pending' | 'approved'
      role: SpaceRole | null
    }>(SELECT_MACHINE, [id, userId])
    const row = rows[0]
    return row
      ? { id: row.id, name: row.name, spaceId: row.space_id, ownerId: row.owner_id, role: row.role, status: row.status }
      : null
  }

  /** 非主人的统一拒绝：看得到这台机器的人（空间成员）403，其余 404（不泄露存在性） */
  function refuse(c: Context<AuthEnv>, machine: Machine | null): Response {
    // 别人还在等批准的机器对我来说不存在（只有接入人自己知道它在）
    const hidden = machine?.status === 'pending' && machine.ownerId !== c.get('user').id
    if (machine && !hidden && machine.role) {
      return c.json({ error: 'forbidden', message: '只有这台机器的主人能做这件事' }, 403)
    }
    return c.json({ error: 'machine not found' }, 404)
  }

  /** 只有机器主人能过（owner_id 为空的老 connector 没有主人，谁都不是）：过了返回机器，不过返回响应 */
  async function asOwner(c: Context<AuthEnv>): Promise<Machine | Response> {
    const machine = await loadMachine(c.req.param('id') ?? '', c.get('user').id)
    return machine && machine.ownerId === c.get('user').id ? machine : refuse(c, machine)
  }

  app.get('/api/spaces/:id/machines', auth, async (c) => {
    const user = c.get('user')
    const spaceId = c.req.param('id')
    // 列举类：对所有人（含全局 admin）只含自己是成员的空间
    const role = (await pool.query(SELECT_SPACE_ROLE, [spaceId, user.id])).rows[0]
    if (!role) return c.json({ error: 'space not found' }, 404)
    const { rows } = await pool.query<{
      id: string
      name: string
      status: 'pending' | 'approved'
      owner: string | null
      mine: boolean
      grant_id: string | null
      grant_scopes: MachineScope[] | null
      grant_expires_at: Date | null
      request_id: string | null
    }>(SELECT_SPACE_MACHINES, [spaceId, user.id])
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        // pending 表示我接入的、还在等空间管理员批准（只有接入人自己看得到），此时没有授权 / 申请可言
        status: r.status,
        owner: r.owner,
        online: deps.hub.online(r.id),
        mine: r.mine,
        // grant.id / requestId 只是我自己的那条（被授权人放弃 / 申请人撤回要用），别人的看不到
        grant:
          r.grant_id && r.grant_scopes && r.grant_expires_at
            ? { id: r.grant_id, scopes: r.grant_scopes, expiresAt: r.grant_expires_at.toISOString() }
            : null,
        request: r.request_id !== null,
        requestId: r.request_id,
      })),
    )
  })

  // ---------- 使用申请 ----------

  app.post('/api/machines/:id/requests', auth, async (c) => {
    const user = c.get('user')
    const machine = await loadMachine(c.req.param('id'), user.id)
    // 不在这台机器所在的空间里（全局 admin 也一样）：看不到它
    if (!machine || !machine.role) return c.json({ error: 'machine not found' }, 404)
    // 还没被批准的机器不在空间里出现，对谁（含接入人自己）都按不存在处理
    if (machine.status === 'pending') return c.json({ error: 'machine not found' }, 404)
    if (machine.role === 'viewer') return c.json({ error: 'forbidden', message: '只读成员不能申请使用机器' }, 403)
    if (machine.ownerId === user.id) return c.json({ error: 'own machine', message: '这是你自己的机器' }, 400)
    const body = (await c.req.json().catch(() => null)) as { scopes?: unknown; note?: unknown } | null
    const scopes = parseScopes(body?.scopes)
    if (!scopes) return c.json({ error: 'scopes required', message: 'scopes 要从 agent / machine 里至少选一个' }, 400)
    const note = body?.note === undefined ? '' : body.note
    if (typeof note !== 'string' || note.length > NOTE_MAX) return c.json({ error: 'invalid note', message: `备注最多 ${NOTE_MAX} 字` }, 400)
    try {
      const created = await createRequest(pool, { connectorId: machine.id, userId: user.id, scopes, note })
      deps.inbox?.()
      return c.json({ id: created.id, scopes: created.scopes, note: created.note, createdAt: created.createdAt }, 201)
    } catch (err) {
      if (err instanceof RequestExists) return c.json({ error: 'request exists', message: err.message }, 409)
      throw err
    }
  })

  app.get('/api/machines/:id/requests', auth, async (c) => {
    const machine = await asOwner(c)
    if (machine instanceof Response) return machine
    return c.json(await listRequests(pool, machine.id))
  })

  // 主人拒绝，或申请人自己撤回；其余人 403 / 404
  app.delete('/api/machines/:id/requests/:rid', auth, async (c) => {
    const user = c.get('user')
    const machine = await loadMachine(c.req.param('id'), user.id)
    if (!machine) return refuse(c, null)
    const request = await requestOwnerOf(pool, c.req.param('rid'), machine.id)
    if (machine.ownerId !== user.id && request?.userId !== user.id) return refuse(c, machine)
    if (!request?.open || !(await resolveRequest(pool, c.req.param('rid'), machine.id))) return c.json({ error: 'request not found' }, 404)
    deps.inbox?.()
    return c.json({})
  })

  // ---------- 授权 ----------

  app.post('/api/machines/:id/grants', auth, async (c) => {
    const user = c.get('user')
    const machine = await asOwner(c)
    if (machine instanceof Response) return machine
    // 还在等空间管理员批准的机器不能授权给任何人（先于密码校验，免得白输一次密码）
    if (machine.status === 'pending') {
      return c.json({ error: 'machine pending', message: '这台机器还在等空间管理员批准，批准后才能授权给别人' }, 409)
    }

    // 形状先校验（不碰密码，不消耗限速额度）
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'invalid body' }, 400)
    const scopes = parseScopes(body.scopes)
    if (!scopes) return c.json({ error: 'scopes required', message: 'scopes 要从 agent / machine 里至少选一个' }, 400)
    const days = body.days === undefined ? GRANT_DAYS_DEFAULT : body.days
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > GRANT_DAYS_MAX) {
      return c.json({ error: 'invalid days', message: `有效期要 1 到 ${GRANT_DAYS_MAX} 天` }, 400)
    }
    if (body.acknowledged !== true) return c.json({ error: 'acknowledgement required', message: '需要确认已读后果' }, 400)
    if (typeof body.password !== 'string' || !body.password) return c.json({ error: 'password required' }, 400)
    if (typeof body.username !== 'string' || !body.username) return c.json({ error: 'username required' }, 400)
    if (typeof body.machineName !== 'string' || !body.machineName) return c.json({ error: 'machineName required' }, 400)
    if (body.userId !== undefined && typeof body.userId !== 'string') return c.json({ error: 'invalid userId' }, 400)

    // 重输登录密码，先过限速再验：失败太多次连正确密码也拒。放在其余判断（用户是否存在等）之前，没验过密码的人探不到任何东西
    const wait = limiter.blockedFor(user.id)
    if (wait > 0) {
      const retryAfterSec = Math.ceil(wait / 1000)
      return c.json(
        { error: 'too many attempts', message: `密码错误次数太多，请 ${Math.ceil(retryAfterSec / 60)} 分钟后再试`, retryAfterSec },
        429,
        { 'Retry-After': String(retryAfterSec) },
      )
    }
    const me = (await pool.query<{ password: string }>(SELECT_PASSWORD, [user.id])).rows[0]
    if (!me || !verifyPassword(body.password, me.password)) {
      limiter.fail(user.id)
      return c.json({ error: 'wrong password', message: '登录密码不对' }, 403)
    }
    limiter.reset(user.id)

    // 手输确认：机器名完全一致，被授权人的用户名完全一致（给了 userId 就是那个人，没给就按用户名找）
    if (body.machineName !== machine.name) return c.json({ error: 'machine name mismatch', message: '机器名和这台机器对不上' }, 400)
    const grantee = (
      await pool.query<{ id: string; username: string }>(
        body.userId !== undefined ? SELECT_USER_BY_ID : SELECT_USER_BY_NAME,
        [body.userId ?? body.username],
      )
    ).rows[0]
    if (!grantee || grantee.username !== body.username) {
      return c.json({ error: 'username mismatch', message: '用户名和被授权的人对不上' }, 400)
    }
    if (grantee.id === user.id) return c.json({ error: 'cannot grant yourself', message: '不能授权给自己' }, 400)
    const role = (await pool.query<{ role: SpaceRole }>(SELECT_SPACE_ROLE, [machine.spaceId, grantee.id])).rows[0]?.role
    if (role !== 'owner' && role !== 'member') {
      return c.json({ error: 'grantee not a member', message: '被授权的人必须是这个空间的成员（只读成员不行）' }, 400)
    }

    try {
      const created = await createGrant(pool, { connectorId: machine.id, userId: grantee.id, scopes, days, grantedBy: user.id })
      deps.inbox?.() // 此人对这台机器的未处理申请，随授权创建一并算处理过了
      return c.json(
        {
          grantId: created.id,
          // 一次性确认码：只在这里返回这一次，库里只有哈希
          code: created.code,
          expiresAt: created.expiresAt.toISOString(),
          confirmExpiresAt: created.confirmExpiresAt.toISOString(),
          // 安装包的命令名（scripts/pack-connector.mjs）；源码里跑的人换成 npm run connector -w packages/server --
          command: `ramet-connector grant confirm ${created.code}`,
        },
        201,
      )
    } catch (err) {
      if (err instanceof PendingGrantExists) return c.json({ error: 'pending grant exists', message: err.message }, 409)
      throw err
    }
  })

  app.get('/api/machines/:id/grants', auth, async (c) => {
    const machine = await asOwner(c)
    if (machine instanceof Response) return machine
    return c.json(await listGrants(pool, machine.id))
  })

  // 主人收回 / 取消待确认的，或被授权人自己放弃；其余人 403 / 404。收回即断（disconnect）
  app.delete('/api/machines/:id/grants/:gid', auth, async (c) => {
    const user = c.get('user')
    const machine = await loadMachine(c.req.param('id'), user.id)
    if (!machine) return refuse(c, null)
    const grant = await grantOwnerOf(pool, c.req.param('gid'), machine.id)
    if (machine.ownerId !== user.id && grant?.userId !== user.id) return refuse(c, machine)
    if (!grant || !(await revokeGrant(pool, machine.id, c.req.param('gid'), deps.disconnect))) {
      return c.json({ error: 'grant not found' }, 404)
    }
    deps.notify?.()
    return c.json({})
  })

  app.get('/api/machines/:id/usage', auth, async (c) => {
    const machine = await asOwner(c)
    if (machine instanceof Response) return machine
    const before = c.req.query('before')
    if (before !== undefined && !/^\d+$/.test(before)) return c.json({ error: 'invalid before' }, 400)
    const limitRaw = c.req.query('limit')
    const limit = limitRaw === undefined ? USAGE_LIMIT_DEFAULT : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1) return c.json({ error: 'invalid limit' }, 400)
    return c.json(await listUsage(pool, machine.id, before ?? null, limit))
  })

  return app
}

