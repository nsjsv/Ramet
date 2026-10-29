// ---------- 小型对称加密盒（AES-256-GCM）----------
// 给「用户自己填的第三方 API key」落库用。主密钥来自环境变量 RAMET_SECRET_KEY（32 字节，hex 或 base64），
// 不在数据库里：库泄露不等于 key 泄露。零依赖，node:crypto。
//
// 存储格式 = base64( iv(12) ‖ tag(16) ‖ 密文 )。aad（附加认证数据）绑定行归属（用户 id）：
// 密文被复制到别人的行里解不开，也不会被悄悄换成别人的 key。GCM 的 tag 保证篡改必抛。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/** 解析主密钥：64 位 hex 或解码后恰好 32 字节的 base64。格式不对返回 null（调用方当没设，并自己决定要不要警告） */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  const text = raw?.trim()
  if (!text) return null
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
  // base64 / base64url 都认；Buffer.from 对非法字符会静默忽略，所以先用字符集挡一道，再看长度
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    const buf = Buffer.from(text, 'base64')
    if (buf.length === KEY_LEN) return buf
  }
  return null
}

/** 读环境变量里的主密钥；设了但格式不对 → 警告一条（不回显值）并当没设 */
export function loadSecretKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.RAMET_SECRET_KEY
  const key = parseSecretKey(raw)
  if (!key && raw?.trim()) {
    console.warn('[secret] RAMET_SECRET_KEY 格式不对（需要 32 字节，hex 或 base64），按未配置处理；可用 `openssl rand -hex 32` 生成')
  }
  return key
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/** 解密；密文被改过 / aad 对不上 / 主密钥不对 都会抛（GCM 认证失败） */
export function decryptSecret(key: Buffer, blob: string, aad: string): string {
  const raw = Buffer.from(blob, 'base64')
  if (raw.length < IV_LEN + TAG_LEN) throw new Error('密文长度不对')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_LEN))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN))
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8')
}
