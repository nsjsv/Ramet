import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { Pool } from 'pg'
import { withTransaction } from './db.js'
import { myPersonalSpaceId } from './clone.js'
import { isIconSourceMime, SELECT_ICON_SOURCE_MIME } from './page-icon.js'
import { isHttpsRequest } from './request-proto.js'
import { deleteImpact, deleteUserAccount } from './user-delete.js'

// 用 type 而非 interface：pg 的 query<T> 要求隐式索引签名，interface 给不了
type UserRow = {
  id: string
  username: string
  password: string
  role: 'admin' | 'user'
  must_change_password: boolean
  avatar_file_id: string | null
}

// admin 列表用，永不带 password
type PublicUserRow = { id: string; username: string; role: 'admin' | 'user'; created_at: string }

// 会话上下文里挂的用户，声明 Variables 才能让 c.get('user') 带类型。avatar 是头像图片的 files.id，没上传为 null
export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  must_change_password: boolean
  avatar: string | null
}
// 需要登录态的路由统一用这个 Env
export type AuthEnv = { Variables: { user: AuthUser } }

// ---------- SQL 常量 ----------

const SELECT_SESSION_USER = `SELECT u.id, u.username, u.role, u.must_change_password, u.avatar_file_id
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = $1`
/** 导出给机器人客户端用（认领跨 server 重启的回合时中心只有 user_id，没有浏览器 cookie） */
export const INSERT_SESSION = 'INSERT INTO sessions (token, user_id) VALUES ($1, $2)'
export const DELETE_SESSION = 'DELETE FROM sessions WHERE token = $1'
const SELECT_USER_BY_NAME =
  'SELECT id, username, password, role, must_change_password, avatar_file_id FROM users WHERE username = $1'
const SELECT_ALL_USERS = 'SELECT id, username, role, created_at FROM users ORDER BY created_at, id'
const INSERT_USER =
  'INSERT INTO users (id, username, password, role, must_change_password) VALUES ($1, $2, $3, $4, $5)'
const SET_AVATAR = 'UPDATE users SET avatar_file_id = $1 WHERE id = $2'
// 改密与解除强制改密同一语句，不会出现密码换了但 flag 还挂着的半态
const CHANGE_PASSWORD = 'UPDATE users SET password = $1, must_change_password = false WHERE id = $2'
// admin 重置密码：与建号同款临时密码语义，一并置 flag，目标用户下次登录被强制改密
const RESET_PASSWORD = 'UPDATE users SET password = $1, must_change_password = true WHERE id = $2'
// 改密后吊销该用户其余会话、保留当前会话：临时密码走不可信渠道（部署可能无 TLS），
// 若被他人抢先登录，那条平行会话不能因改密而继续存活 30 天
const DELETE_OTHER_SESSIONS = 'DELETE FROM sessions WHERE user_id = $1 AND token <> $2'
const SELECT_USER_EXISTS = 'SELECT 1 FROM users WHERE id = $1'
const COUNT_USERS = 'SELECT COUNT(*)::int AS n FROM users'
const ADOPT_ORPHAN_PAGES = 'UPDATE pages SET owner_id = $1 WHERE owner_id IS NULL'

// ---------- 密码 ----------

// scrypt 参数固定（salt 16B、keylen 64B），不做 KDF 配置项
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

// 登录反枚举的哑哈希：用户不存在时也跑一次等价 scrypt，垫平响应时差
const DUMMY_PASSWORD_HASH = hashPassword('ramet-timing-equalizer')

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  // timingSafeEqual 要求等长（否则抛错），先比长度，只泄露长度可接受
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// ---------- 用户名 ----------

// 上限 50（中文按码元算也够用）；trim 后非空才合法，堵纯空格名
export const USERNAME_MAX = 50

// setup 与建号共用：合法返回 trim 后的名字，非法返回 null
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && name.length <= USERNAME_MAX ? name : null
}

// ---------- 临时密码 ----------

// admin 建号时服务端生成的 10 位临时密码，剔除易混淆字符 0O1lI，字母表 57 位
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
// 取模偏差闸：256 不是 57 的整数倍，只接受 byte < 228（57*4），其余重抽，保证概率严格均匀
const TEMP_PASSWORD_MAX = Math.floor(256 / TEMP_PASSWORD_ALPHABET.length) * TEMP_PASSWORD_ALPHABET.length

export function generateTempPassword(): string {
  const chars: string[] = []
  while (chars.length < 10) {
    for (const byte of randomBytes(10 - chars.length)) {
      if (byte < TEMP_PASSWORD_MAX) chars.push(TEMP_PASSWORD_ALPHABET[byte % TEMP_PASSWORD_ALPHABET.length]!)
    }
  }
  return chars.join('')
}

// ---------- 会话 ----------

export const SESSION_COOKIE = 'ramet_session'
// 30 天，过期即重新登录，不做滚动续期
const SESSION_MAX_AGE = 30 * 24 * 3600

// Hono 请求与 ws 裸升级请求共用这一个解析，不引 cookie 库
function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const raw = part.slice(eq + 1).trim()
    let value = raw
    try {
      // 畸形 % 序列会让 decodeURIComponent 抛 URIError：按原值兜底，会话查询 miss 走 401，不能变 500
      value = decodeURIComponent(raw)
    } catch {
      // 保留原值
    }
    jar[part.slice(0, eq).trim()] = value
  }
  return jar
}

/** https 进来的请求，会话 cookie 带 Secure（只经 TLS 发送）；http（开发环境、80 端口的兼容路径）照旧不带，否则浏览器根本不回传 */
const cookieAttrs = (c: Context): string => `Path=/; HttpOnly; SameSite=Lax${isHttpsRequest(c) ? '; Secure' : ''}`

function setSessionCookie(c: Context, token: string): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(c)}; Max-Age=${SESSION_MAX_AGE}`)
}

function clearSessionCookie(c: Context): void {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs(c)}; Max-Age=0`)
}

// 登录与 setup 共用的会话创建
async function startSession(c: Context, pool: Pool, userId: string): Promise<void> {
  const token = randomBytes(32).toString('hex')
  await pool.query(INSERT_SESSION, [token, userId])
  setSessionCookie(c, token)
}

async function userFromCookieHeader(pool: Pool, header: string | undefined): Promise<AuthUser | null> {
  const token = parseCookies(header)[SESSION_COOKIE]
  if (!token) return null
  const { rows } = await pool.query<UserRow>(SELECT_SESSION_USER, [token])
  const row = rows[0]
  return row
    ? {
        id: row.id,
        username: row.username,
        role: row.role,
        must_change_password: row.must_change_password,
        avatar: row.avatar_file_id,
      }
    : null
}

// ws 升级路径用，从裸 http 请求里解析会话
export async function userFromRequest(pool: Pool, req: IncomingMessage): Promise<AuthUser | null> {
  return userFromCookieHeader(pool, req.headers.cookie)
}

// ---------- 中间件 ----------

export function requireAuth(pool: Pool): MiddlewareHandler<AuthEnv> {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = await userFromCookieHeader(pool, c.req.header('cookie'))
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    c.set('user', user)
    await next()
  })
}

export function requireAdmin(pool: Pool): MiddlewareHandler<AuthEnv> {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = await userFromCookieHeader(pool, c.req.header('cookie'))
    // 未登录 401、登录但非 admin 403，分开返回，前端好区分跳转
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    c.set('user', user)
    await next()
  })
}

// ---------- 认证路由 ----------

export function authRoutes(pool: Pool) {
  const app = new Hono()

  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return c.json({ error: 'username and password required' }, 400)
    }
    // 库里存的名字都是 trim 过的，这里对齐，输入带首尾空格也能命中
    const { rows } = await pool.query<UserRow>(SELECT_USER_BY_NAME, [body.username.trim()])
    const found = rows[0]
    // 用户不存在与密码错误同响应，不泄露账号是否存在
    if (!found) {
      verifyPassword(body.password, DUMMY_PASSWORD_HASH)
      return c.json({ error: 'invalid username or password' }, 401)
    }
    if (!verifyPassword(body.password, found.password)) {
      return c.json({ error: 'invalid username or password' }, 401)
    }
    // 登录即确保个人空间存在（幂等）。页面树是空间派生的视图，目录树行在该空间首次写入时按需落库，这里不预建
    await myPersonalSpaceId(pool, found.id)
    // 带着旧 token 来登录就作废旧 token，再发新 token
    const old = parseCookies(c.req.header('cookie'))[SESSION_COOKIE]
    if (old) await pool.query(DELETE_SESSION, [old])
    await startSession(c, pool, found.id)
    return c.json({
      id: found.id,
      username: found.username,
      role: found.role,
      must_change_password: found.must_change_password,
      avatar: found.avatar_file_id,
    })
  })

  app.post('/api/auth/logout', async (c) => {
    const token = parseCookies(c.req.header('cookie'))[SESSION_COOKIE]
    if (token) await pool.query(DELETE_SESSION, [token])
    clearSessionCookie(c)
    return c.json({})
  })

  app.get('/api/auth/me', requireAuth(pool), (c) => {
    const { id, username, role, must_change_password, avatar } = c.get('user')
    return c.json({ id, username, role, must_change_password, avatar })
  })

  // 设置 / 清除自己的头像：{ file_id: string | null }。图片先走 POST /api/files 上传，这里只认
  // 已存在的图片文件（同页面图标的图片源校验，否则必然破图）；null 回到默认头像
  app.put('/api/auth/avatar', requireAuth(pool), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { file_id?: unknown } | null
    const fileId = body?.file_id
    if (fileId !== null && typeof fileId !== 'string') return c.json({ error: 'file_id required' }, 400)
    if (fileId !== null) {
      const mime = (await pool.query<{ mime: string }>(SELECT_ICON_SOURCE_MIME, [fileId])).rows[0]?.mime
      if (!isIconSourceMime(mime)) return c.json({ error: 'avatar file not found', message: '头像必须是已上传的图片' }, 400)
    }
    await pool.query(SET_AVATAR, [fileId, c.get('user').id])
    return c.json({ avatar: fileId })
  })

  // 改密同时翻 must_change_password，任何已登录用户可改自己的
  app.post('/api/auth/change-password', requireAuth(pool), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { new_password?: unknown } | null
    // 与 setup 同一套规则：至少 8 位
    if (typeof body?.new_password !== 'string' || body.new_password.length < 8) {
      return c.json({ error: 'password must be at least 8 characters' }, 400)
    }
    await pool.query(CHANGE_PASSWORD, [hashPassword(body.new_password), c.get('user').id])
    // 吊销同用户其余会话，当前会话保留（前端改完直接进主应用）
    const current = parseCookies(c.req.header('cookie'))[SESSION_COOKIE]
    if (current) await pool.query(DELETE_OTHER_SESSIONS, [c.get('user').id, current])
    return c.json({})
  })

  // ---------- setup 路由（公开，首启建首个 admin） ----------

  app.get('/api/setup/status', async (c) => {
    const { rows } = await pool.query<{ n: number }>(COUNT_USERS)
    return c.json({ needed: (rows[0]?.n ?? 0) === 0 })
  })

  app.post('/api/setup/admin', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null
    if (typeof body?.password !== 'string') {
      return c.json({ error: 'password required' }, 400)
    }
    if (body.password.length < 8) {
      return c.json({ error: 'password must be at least 8 characters' }, 400)
    }
    const username = normalizeUsername(body.username)
    if (!username) return c.json({ error: 'invalid username' }, 400)
    const user = await createInitialAdmin(pool, username, body.password)
    if (!user) return c.json({ error: 'setup already completed' }, 403)
    // 成功即登录，与 login 走同一条会话创建路径
    await startSession(c, pool, user.id)
    return c.json({ ...user, must_change_password: false }, 201)
  })

  return app
}

// ---------- 初始化 ----------

// setup 并发闸：事务级咨询锁，事务结束即解锁。光靠事务内复查防不住并发，
// READ COMMITTED 下两个并发事务都能读到空表再各插一个。先抢锁再复查，后到者阻塞到前者提交，复查见非空即返回 null。
const SETUP_LOCK = 'SELECT pg_advisory_xact_lock(87241596)'

// 建 admin 账号并收编存量无主页面，同一事务。users 非空返回 null（调用方转 403），
// 并发 setup 由 SETUP_LOCK 串行化，不会建出第二个账号。
async function createInitialAdmin(
  pool: Pool,
  username: string,
  password: string,
): Promise<{ id: string; username: string; role: 'admin' } | null> {
  return withTransaction(pool, async (client) => {
    await client.query(SETUP_LOCK)
    const { rows } = await client.query<{ n: number }>(COUNT_USERS)
    if ((rows[0]?.n ?? 0) > 0) return null
    const id = randomUUID()
    await client.query(INSERT_USER, [id, username, hashPassword(password), 'admin', false])
    await client.query(ADOPT_ORPHAN_PAGES, [id])
    return { id, username, role: 'admin' as const }
  })
}

// ---------- admin 路由 ----------

// dropConnectors：删号时他接入的机器已在库里删掉，这里断开它们的在线连接（注入 hub.closeOne；测试可不传）
// notify：删号改了空间归属 / 删了空间，广播页面树变化（注入 notifyPagesChanged；测试可不传）
export function adminRoutes(
  pool: Pool,
  dropConnectors?: (connectorIds: string[], reason: string) => void,
  notify?: () => void,
) {
  const app = new Hono<AuthEnv>()

  app.use('/api/admin/*', requireAdmin(pool))

  app.get('/api/admin/users', async (c) => {
    return c.json((await pool.query<PublicUserRow>(SELECT_ALL_USERS)).rows)
  })

  // 删号预览：会转交 / 删除几个空间、删掉多少页面。只给数量，admin 看不到别人的内容
  app.get('/api/admin/users/:id/delete-impact', async (c) => {
    const id = c.req.param('id')
    if (!(await pool.query(SELECT_USER_EXISTS, [id])).rows[0]) {
      return c.json({ error: 'user not found' }, 404)
    }
    return c.json(await deleteImpact(pool, id))
  })

  app.post('/api/admin/users', async (c) => {
    // 只收 { username, role? }，body 里多带的 password 直接忽略；
    // 初始密码由服务端生成临时密码，仅在本次 201 响应里返回一次
    const body = (await c.req.json().catch(() => null)) as { username?: unknown; role?: unknown } | null
    const username = normalizeUsername(body?.username)
    if (!username) return c.json({ error: 'username required' }, 400)
    const role = body?.role === undefined ? 'user' : body.role
    if (role !== 'user' && role !== 'admin') return c.json({ error: 'invalid role' }, 400)
    const id = randomUUID()
    const tempPassword = generateTempPassword()
    try {
      // 临时密码建的号 must_change_password=true，首次登录被强制改密
      await pool.query(INSERT_USER, [id, username, hashPassword(tempPassword), role, true])
    } catch (err) {
      // 23505 = unique_violation，并发建号由唯一约束兜底，比先查后插稳
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'username already exists' }, 409)
      }
      throw err
    }
    return c.json({ id, username, role, password: tempPassword }, 201)
  })

  app.post('/api/admin/users/:id/password', async (c) => {
    // 请求体为空（{} 即可，不收 password）：服务端生成同款 10 位临时密码，
    // 置 must_change_password=true，仅在本次 200 响应里返回一次
    const tempPassword = generateTempPassword()
    // 改密置 flag 与吊销会话同一事务：中途失败整体回滚，
    // 最坏是重置没发生（旧密码旧会话原样），不会出现密码已换但旧会话还挂着
    return withTransaction(pool, async (client) => {
      const result = await client.query(RESET_PASSWORD, [hashPassword(tempPassword), c.req.param('id')])
      if (!result.rowCount) return c.json({ error: 'user not found' }, 404)
      // 吊销目标用户全部会话，重置自己时保留调用者当前会话。
      // 解析不出 token 就按无保留会话全吊销，空串不等于任何真实 token，也不会 500
      const current = parseCookies(c.req.header('cookie'))[SESSION_COOKIE]
      await client.query(DELETE_OTHER_SESSIONS, [c.req.param('id'), current ?? ''])
      return c.json({ password: tempPassword })
    })
  })

  app.delete('/api/admin/users/:id', async (c) => {
    const me = c.get('user')
    const id = c.req.param('id')
    // 不能删自己：admin 是账号体系最后的兜底
    if (id === me.id) return c.json({ error: 'cannot delete yourself' }, 400)
    // 删号善后同一事务（user-delete.ts）：名下空间转给剩余成员或物理删除，admin 不接手任何内容；
    // 他接入的机器同一事务删掉（授权随外键级联），提交后断开在线连接；空间归属变了，广播让在线成员重拉
    const dropped = await withTransaction(pool, (client) => deleteUserAccount(client, id))
    dropConnectors?.(dropped, '主人账号已删除')
    notify?.()
    return c.json({})
  })

  return app
}
