// ---------- zip 读取 ----------
// 存储 / deflate 两种方式都读对；目录项与 macOS 杂物跳过；不安全路径（绝对、..、盘符）报错而不是被悄悄规整；
// 超过条数 / 解压总量上限报错；不是 zip 报错。

import { expect, test } from 'vitest'
import { makeZip } from './test-helpers.js'
import { readZip, safePath, ZipError } from './zip-read.js'

const text = (entries: Array<{ path: string; data: Buffer }>): Record<string, string> =>
  Object.fromEntries(entries.map((e) => [e.path, e.data.toString('utf8')]))

test('deflate 与 store 都读得对（含中文路径与内容）', () => {
  const files = { 'a/SKILL.md': '---\nname: x\n---\n正文', 'a/scripts/run.sh': '#!/bin/sh\necho 你好\n', 'b.txt': '' }
  for (const method of ['deflate', 'store'] as const) {
    expect(text(readZip(makeZip(files, method)))).toEqual(files)
  }
})

test('目录项与 __MACOSX / .DS_Store 跳过', () => {
  const zip = makeZip({ 'a/': '', 'a/x.txt': 'x', '__MACOSX/a/._x.txt': 'junk', 'a/.DS_Store': 'junk' })
  expect(text(readZip(zip))).toEqual({ 'a/x.txt': 'x' })
})

test('不安全路径报错：绝对路径、.. 穿越、盘符、空段', () => {
  for (const bad of ['/etc/passwd', '../evil.txt', 'a/../../evil.txt', 'C:/win.txt', 'a//b.txt']) {
    expect(() => readZip(makeZip({ [bad]: 'x' })), bad).toThrow(ZipError)
  }
  expect(safePath('./a\\b/c.txt')).toBe('a/b/c.txt')
  expect(() => safePath('a/../b')).toThrow(ZipError)
})

test('上限与非 zip', () => {
  expect(() => readZip(Buffer.from('not a zip at all, definitely'))).toThrow(/不是有效的 zip/)
  expect(() => readZip(makeZip({ 'a.txt': 'x', 'b.txt': 'y' }), { entries: 1, bytes: 1000 })).toThrow(/太多/)
  expect(() => readZip(makeZip({ 'a.txt': 'x'.repeat(100) }), { entries: 10, bytes: 50 })).toThrow(/太大/)
})
