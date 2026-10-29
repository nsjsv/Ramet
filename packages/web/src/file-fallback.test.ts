import { describe, expect, test } from 'vitest'
import { directUrl } from './file-fallback'

const ID = '0f8c2b6e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'

describe('directUrl', () => {
  test('站内文件三种地址都改成 ?direct=1', () => {
    expect(directUrl(`/api/files/${ID}`)).toBe(`/api/files/${ID}?direct=1`)
    expect(directUrl(`/api/files/${ID}/display`)).toBe(`/api/files/${ID}/display?direct=1`)
    expect(directUrl(`/api/files/${ID}/icon`)).toBe(`/api/files/${ID}/icon?direct=1`)
  })

  test('已带 direct 的不再改（本地也坏了不能来回打转）', () => {
    expect(directUrl(`/api/files/${ID}?direct=1`)).toBeNull()
    expect(directUrl(`/api/files/${ID}/display?direct=1`)).toBeNull()
  })

  test('外链、AI 取图路径、非 uuid 一律不碰', () => {
    expect(directUrl('https://img.example.com/file/ramet/x.png')).toBeNull()
    expect(directUrl(`/api/files/${ID}/ai`)).toBeNull()
    expect(directUrl('/api/files/not-a-uuid')).toBeNull()
    expect(directUrl('')).toBeNull()
  })
})
