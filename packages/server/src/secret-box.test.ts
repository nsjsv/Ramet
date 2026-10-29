import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, loadSecretKeyFromEnv, parseSecretKey } from './secret-box.js'

const key = randomBytes(32)

describe('secret-box', () => {
  it('加解密往返；同一明文每次密文不同（随机 IV）', () => {
    const a = encryptSecret(key, 'sk-ant-secret-1234', 'user-1')
    const b = encryptSecret(key, 'sk-ant-secret-1234', 'user-1')
    expect(a).not.toBe(b)
    expect(a).not.toContain('sk-ant')
    expect(decryptSecret(key, a, 'user-1')).toBe('sk-ant-secret-1234')
    expect(decryptSecret(key, b, 'user-1')).toBe('sk-ant-secret-1234')
  })

  it('密文被改一个字节必抛（GCM 认证）', () => {
    const blob = Buffer.from(encryptSecret(key, 'sk-ant-secret-1234', 'user-1'), 'base64')
    for (const pos of [0, 12, 28, blob.length - 1]) {
      const tampered = Buffer.from(blob)
      tampered[pos] = (tampered[pos] ?? 0) ^ 1
      expect(() => decryptSecret(key, tampered.toString('base64'), 'user-1')).toThrow()
    }
  })

  it('aad 对不上（密文被搬到别人的行）/ 主密钥不对 / 太短 都抛', () => {
    const blob = encryptSecret(key, 'sk-ant-secret-1234', 'user-1')
    expect(() => decryptSecret(key, blob, 'user-2')).toThrow()
    expect(() => decryptSecret(randomBytes(32), blob, 'user-1')).toThrow()
    expect(() => decryptSecret(key, 'AAAA', 'user-1')).toThrow()
  })

  it('主密钥解析：64 位 hex 与 32 字节 base64 都认，其它一律 null', () => {
    const hex = randomBytes(32).toString('hex')
    expect(parseSecretKey(hex)?.toString('hex')).toBe(hex)
    expect(parseSecretKey(hex.toUpperCase())?.length).toBe(32)
    const raw = randomBytes(32)
    expect(parseSecretKey(raw.toString('base64'))?.equals(raw)).toBe(true)
    expect(parseSecretKey(raw.toString('base64url'))?.equals(raw)).toBe(true)
    expect(parseSecretKey(`  ${hex}\n`)?.length).toBe(32)
    for (const bad of [undefined, '', '   ', 'short', hex.slice(1), `${hex}00`, randomBytes(16).toString('base64'), 'not base64 !!!']) {
      expect(parseSecretKey(bad)).toBeNull()
    }
  })

  it('环境变量格式不对：当没设，并警告（警告里不含密钥内容）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(loadSecretKeyFromEnv({ RAMET_SECRET_KEY: 'zzz-not-a-key' })).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('zzz-not-a-key')
      expect(loadSecretKeyFromEnv({})).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1) // 没设不警告
      expect(loadSecretKeyFromEnv({ RAMET_SECRET_KEY: randomBytes(32).toString('hex') })?.length).toBe(32)
    } finally {
      warn.mockRestore()
    }
  })
})
