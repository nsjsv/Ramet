// ---------- 随手 AI：用户的模型连接（校验 + 存取）----------
// 一个用户可存多套连接，选一套当当前连接。表结构见 db.ts 的 user_ai_connections / user_ai_settings。
// 这里管两件事：输入怎么校验与规范化（含 SSRF 校验入口），以及落库 / 读库。HTTP 外壳在 routes/quick.ts。
// key：AES-256-GCM 加密存（secret-box.ts），响应里只给后四位。

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { assertSafeUrlShape, UnsafeEndpointError, validateEndpoint, type Resolver } from './endpoint-guard.js'
import { decryptSecret, encryptSecret } from './secret-box.js'
import { KNOWN_ANTHROPIC_MODELS, OFFICIAL_ANTHROPIC_URL, type ModelConnection, type Protocol } from './quick.js'

export const CONNECTION_LIMIT = 10
export const NAME_MAX = 40
export const MODEL_MAX = 100
export const BASE_URL_MAX = 300
const KEY_MIN = 8
const KEY_MAX = 400

/** 用户输入有误（HTTP 400，message 直接给用户看） */
export class InputError extends Error {}

export type Channel = 'site' | 'local'

export type ConnectionRow = {
  id: string
  user_id: string
  name: string
  protocol: Protocol
  base_url: string | null
  model: string
  key_ciphertext: string
  key_last4: string
}

/** 对外形状：永不含 key，只有后四位 */
export type ConnectionView = {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string | null
  model: string
  keyLast4: string
}

export type Draft = { name: string; protocol: Protocol; baseUrl: string | null; model: string }

export function toView(row: ConnectionRow): ConnectionView {
  return { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url, model: row.model, keyLast4: row.key_last4 }
}

// ---------- 校验 ----------

export function parseProtocol(raw: unknown): Protocol {
  if (raw === 'anthropic' || raw === 'openai') return raw
  throw new InputError('协议只能是 anthropic 或 openai')
}

/**
 * 地址规范化（不含 DNS）：https、无用户名密码、无 ?# 参数；去结尾斜杠；
 *  - openai：去掉结尾的 /chat/completions（存「基址」，调用时再拼）；必填
 *  - anthropic：去掉结尾的 /v1/messages 或 /v1（SDK 自己会拼 /v1/messages）；填的就是官方地址则视同没填（null）
 */
export function normalizeBaseUrl(raw: unknown, protocol: Protocol): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new InputError('地址必须是字符串')
  const text = (raw ?? '').trim()
  if (!text) {
    if (protocol === 'openai') throw new InputError('OpenAI 兼容协议必须填写地址，例如 https://api.deepseek.com/v1')
    return null
  }
  if (text.length > BASE_URL_MAX) throw new InputError(`地址太长（最多 ${BASE_URL_MAX} 字）`)
  let url: URL
  try {
    url = assertSafeUrlShape(text)
  } catch (err) {
    throw new InputError(err instanceof UnsafeEndpointError ? err.message : '地址格式不对')
  }
  if (url.search || url.hash) throw new InputError('地址里不要带 ? 或 # 参数')
  let path = url.pathname.replace(/\/+$/, '')
  path = protocol === 'openai' ? path.replace(/\/chat\/completions$/i, '') : path.replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '')
  const out = `${url.origin}${path}`
  return protocol === 'anthropic' && out === OFFICIAL_ANTHROPIC_URL ? null : out
}

/** 模型名：anthropic + 官方地址只允许三个已知模型；其它自由填（必填、≤100 字、不含控制字符） */
export function validateModel(raw: unknown, protocol: Protocol, baseUrl: string | null): string {
  if (typeof raw !== 'string') throw new InputError('模型名必填')
  const model = raw.trim()
  if (!model) throw new InputError('模型名必填')
  if (protocol === 'anthropic' && !baseUrl) {
    if (!(KNOWN_ANTHROPIC_MODELS as readonly string[]).includes(model)) {
      throw new InputError(`官方地址只支持这几个模型：${KNOWN_ANTHROPIC_MODELS.join('、')}`)
    }
    return model
  }
  if (model.length > MODEL_MAX) throw new InputError(`模型名太长（最多 ${MODEL_MAX} 字）`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(model)) throw new InputError('模型名里不能有控制字符')
  return model
}

export function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new InputError('名称必填')
  const name = raw.trim()
  if (name.length > NAME_MAX) throw new InputError(`名称太长（最多 ${NAME_MAX} 字）`)
  return name
}

/** key 会被放进 HTTP 头，只收可见 ASCII（挡掉换行 / 空白，防头注入） */
export function validateApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('API key 必填')
  const key = raw.trim()
  if (key.length < KEY_MIN || key.length > KEY_MAX) throw new InputError(`API key 长度不对（${KEY_MIN}–${KEY_MAX} 位）`)
  if (!/^[\x21-\x7e]+$/.test(key)) throw new InputError('API key 里不能有空格、换行或非 ASCII 字符')
  return key
}

export type DraftInput = { name?: unknown; protocol?: unknown; baseUrl?: unknown; model?: unknown }

/** 把用户输入与已有值合并后整体校验（形状层，不含 DNS）。base 为空 = 新建，字段都必填 */
export function parseDraft(input: DraftInput, base?: Draft): Draft {
  const protocol = base ? base.protocol : parseProtocol(input.protocol)
  const baseUrl = normalizeBaseUrl(input.baseUrl !== undefined ? input.baseUrl : base?.baseUrl, protocol)
  return {
    name: validateName(input.name !== undefined ? input.name : base?.name),
    protocol,
    baseUrl,
    model: validateModel(input.model !== undefined ? input.model : base?.model, protocol, baseUrl),
  }
}

/** 自定义地址的 DNS 层校验（保存 / 测试 / 每次请求前都会调）。不通过抛 InputError，说明原因 */
export async function checkEndpoint(baseUrl: string | null, resolve?: Resolver): Promise<void> {
  if (!baseUrl) return
  try {
    await validateEndpoint(baseUrl, { resolve })
  } catch (err) {
    throw new InputError(err instanceof UnsafeEndpointError ? err.message : '地址校验失败')
  }
}

// ---------- 读写 ----------

const COLUMNS = 'id, user_id, name, protocol, base_url, model, key_ciphertext, key_last4'

export async function listConnections(pool: Pool, userId: string): Promise<ConnectionRow[]> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM user_ai_connections WHERE user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  return rows
}

export async function getConnection(pool: Pool, userId: string, id: string): Promise<ConnectionRow | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM user_ai_connections WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return rows[0] ?? null
}

export type AiSettingsRow = { channel: Channel; activeConnectionId: string | null; localAgent: string | null }

export async function getSettings(pool: Pool, userId: string): Promise<AiSettingsRow> {
  const { rows } = await pool.query<{ channel: Channel; active_connection_id: string | null; local_agent: string | null }>(
    'SELECT channel, active_connection_id, local_agent FROM user_ai_settings WHERE user_id = $1',
    [userId],
  )
  const row = rows[0]
  return { channel: row?.channel ?? 'site', activeConnectionId: row?.active_connection_id ?? null, localAgent: row?.local_agent ?? null }
}

export async function activeConnection(pool: Pool, userId: string): Promise<ConnectionRow | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `SELECT ${COLUMNS.split(', ').map((c) => `c.${c}`).join(', ')}
       FROM user_ai_settings s JOIN user_ai_connections c ON c.id = s.active_connection_id
      WHERE s.user_id = $1 AND c.user_id = $1`,
    [userId],
  )
  return rows[0] ?? null
}

export async function countConnections(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM user_ai_connections WHERE user_id = $1', [userId])
  return rows[0]?.n ?? 0
}

/** 新建；用户还没有当前连接时顺手设成当前（第一次添加就能直接用） */
export async function insertConnection(
  pool: Pool,
  userId: string,
  draft: Draft,
  apiKey: string,
  secretKey: Buffer,
): Promise<ConnectionRow> {
  const id = randomUUID()
  const { rows } = await pool.query<ConnectionRow>(
    `INSERT INTO user_ai_connections (id, user_id, name, protocol, base_url, model, key_ciphertext, key_last4)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [id, userId, draft.name, draft.protocol, draft.baseUrl, draft.model, encryptSecret(secretKey, apiKey, userId), apiKey.slice(-4)],
  )
  await pool.query(
    `INSERT INTO user_ai_settings (user_id, active_connection_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET active_connection_id = COALESCE(user_ai_settings.active_connection_id, EXCLUDED.active_connection_id),
           updated_at = now()`,
    [userId, id],
  )
  return rows[0] as ConnectionRow
}

/** 编辑：apiKey 给了就换，没给保持原样 */
export async function updateConnection(
  pool: Pool,
  userId: string,
  id: string,
  draft: Draft,
  newKey: { apiKey: string; secretKey: Buffer } | null,
): Promise<ConnectionRow | null> {
  const { rows } = await pool.query<ConnectionRow>(
    `UPDATE user_ai_connections
        SET name = $3, base_url = $4, model = $5,
            key_ciphertext = COALESCE($6, key_ciphertext), key_last4 = COALESCE($7, key_last4), updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
    [
      id,
      userId,
      draft.name,
      draft.baseUrl,
      draft.model,
      newKey ? encryptSecret(newKey.secretKey, newKey.apiKey, userId) : null,
      newKey ? newKey.apiKey.slice(-4) : null,
    ],
  )
  return rows[0] ?? null
}

/** 删除；删的是当前连接时，自动改选最早的一套（没有就留空） */
export async function deleteConnection(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM user_ai_connections WHERE id = $1 AND user_id = $2', [id, userId])
  if (!rowCount) return false
  await pool.query(
    `UPDATE user_ai_settings
        SET active_connection_id = (SELECT id FROM user_ai_connections WHERE user_id = $1 ORDER BY created_at, id LIMIT 1), updated_at = now()
      WHERE user_id = $1 AND active_connection_id IS NULL`,
    [userId],
  )
  return true
}

/** 改通道 / 改当前连接 / 改本地通道的 agent。字段 undefined 表示不动；activeConnectionId、localAgent 为 null 表示清空 */
export async function saveSettings(
  pool: Pool,
  userId: string,
  patch: { channel?: Channel; activeConnectionId?: string | null; localAgent?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO user_ai_settings (user_id, channel, active_connection_id, local_agent)
     VALUES ($1, COALESCE($2::text, 'site'), $3::text, $5::text)
     ON CONFLICT (user_id) DO UPDATE
       SET channel = COALESCE($2::text, user_ai_settings.channel),
           active_connection_id = CASE WHEN $4::boolean THEN $3::text ELSE user_ai_settings.active_connection_id END,
           local_agent = CASE WHEN $6::boolean THEN $5::text ELSE user_ai_settings.local_agent END,
           updated_at = now()`,
    [
      userId,
      patch.channel ?? null,
      patch.activeConnectionId ?? null,
      patch.activeConnectionId !== undefined,
      patch.localAgent ?? null,
      patch.localAgent !== undefined,
    ],
  )
}

/** 解出可直接调用的连接。主密钥缺失 / 密文解不开（主密钥换过、被篡改）时抛 KeyUnreadableError */
export class KeyUnreadableError extends Error {}

export function openConnection(row: ConnectionRow, secretKey: Buffer | null): ModelConnection {
  if (!secretKey) throw new KeyUnreadableError('服务器没有配置 RAMET_SECRET_KEY，已保存的 key 读不出来')
  try {
    return {
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: decryptSecret(secretKey, row.key_ciphertext, row.user_id),
    }
  } catch {
    throw new KeyUnreadableError('已保存的 API key 解不开（服务器密钥变过），请到设置里重新填写')
  }
}
