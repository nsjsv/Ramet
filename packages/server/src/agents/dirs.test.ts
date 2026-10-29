/* ---------- 执行端目录列举（工作区选择器用）----------
 * 只回目录、名排序、parent/绝对路径由执行端算（前端不拼路径）、软链到目录算目录、
 * 封顶截断（带宽约束）、坏路径给可读原因（选择器要显示给人看）。 */

import { expect, test } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { listDirs, MAX_DIRS } from './dirs.js'

test('listDirs：只回目录、按名排序、parent 与绝对路径由执行端算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ramet-dirs-'))
  await mkdir(join(root, 'beta'))
  await mkdir(join(root, 'alpha'))
  await writeFile(join(root, 'file.txt'), 'x')
  await symlink(join(root, 'beta'), join(root, 'link'))

  const listing = await listDirs(root)
  expect(listing.path).toBe(root)
  expect(listing.parent).toBe(dirname(root))
  expect(listing.truncated).toBe(false)
  // 文件不算工作区；软链到目录算（软链到文件的不是）
  expect(listing.dirs.map((d) => d.name)).toEqual(['alpha', 'beta', 'link'])
  expect(listing.dirs[0]!.path).toBe(join(root, 'alpha'))
  // 带 .. 的输入也解析成解析后的绝对路径
  expect((await listDirs(join(root, 'beta', '..'))).path).toBe(root)
})

test('listDirs：超过 MAX_DIRS 截断并标记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ramet-many-'))
  await Promise.all(
    Array.from({ length: MAX_DIRS + 3 }, (_, i) => mkdir(join(root, `d${String(i).padStart(3, '0')}`))),
  )
  const listing = await listDirs(root)
  expect(listing.dirs.length).toBe(MAX_DIRS)
  expect(listing.truncated).toBe(true)
})

test('listDirs：不存在/不是目录给可读原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ramet-bad-'))
  await writeFile(join(root, 'f'), 'x')
  await expect(listDirs(join(root, 'nope'))).rejects.toThrow(/不存在/)
  await expect(listDirs(join(root, 'f'))).rejects.toThrow(/不是目录/)
})
