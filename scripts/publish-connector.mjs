#!/usr/bin/env node
// ---------- 把 connector 发到 npm（包名 @nsjsv/ramet）：.github/workflows/npm.yml 在每次推送时调，内容没变就跳过 ----------
// 用法（仓库根目录）：node scripts/publish-connector.mjs [--dry-run] [--force]
//   --force：内容没变也发新版（npm 新登记的 Trusted Publisher 要实际发布一次才算验证通过，平时用不到）
//   打包（pack-connector.mjs 的 packConnector）→ 拉 npm 上的最新版逐文件比对（package.json 不比 version / gitHead）
//   → 一样就跳过；不一样就版本 patch +1（npm 上低于 0.1.0 或还没有这个包时从 0.1.0 起）、npm publish。
// 认证走 npm 的 Trusted Publishing（GitHub Actions 的 OIDC，npm 自己识别），仓库里和 CI 里都没有令牌；
// 在别处跑只有 --dry-run 有意义。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, packConnector } from './pack-connector.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force')
const FIRST = '0.1.0'

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** npm 上的最新版本；包还不存在回 null，其它错误往上抛。
 *  不用 npm view：registry 前面的 CDN 会把元数据（连同 404）缓存几分钟，两次推送挨得近时读到旧的 latest，
 *  算出的新版本号撞上刚发的那版，这次的改动就发不出去。带个查询串让 CDN 回源 */
async function latestVersion() {
  const url = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2f')}?t=${Date.now()}`
  // 要完整元数据：精简版（accept: application/vnd.npm.install-v1+json）在 CDN 上另有一份缓存，查询串绕不过去
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`查 npm 上的最新版失败：HTTP ${res.status}`)
  const latest = (await res.json())['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error('npm 返回的元数据里没有 latest')
  return latest
}

function files(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)))
    .sort()
}

/** 发出去的东西会不会和 npm 上那一版不同（版本号、gitHead 不算） */
function differs(stage, published) {
  const a = files(stage)
  const b = files(published)
  if (a.join('\n') !== b.join('\n')) return true
  const manifest = (dir) => {
    const { version: _v, gitHead: _g, ...rest } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return JSON.stringify(rest)
  }
  if (manifest(stage) !== manifest(published)) return true
  return a.some((f) => f !== 'package.json' && !readFileSync(join(stage, f)).equals(readFileSync(join(published, f))))
}

function nextVersion(latest) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest ?? '')
  if (!m) return FIRST
  const [major, minor, patch] = m.slice(1).map(Number)
  if (major === 0 && minor < 1) return FIRST
  return `${major}.${minor}.${patch + 1}`
}

async function publish(work) {
  const stage = join(work, 'stage')
  await packConnector({ stage, version: FIRST })
  const latest = await latestVersion()
  if (latest) {
    npm(['pack', `${PACKAGE_NAME}@${latest}`, '--silent', '--pack-destination', work], work)
    execFileSync('tar', ['-xzf', join(work, `${PACKAGE_NAME.replace(/^@/, '').replace('/', '-')}-${latest}.tgz`), '-C', work])
    if (!force && !differs(stage, join(work, 'package'))) {
      console.log(`== connector 与 npm 上的 ${PACKAGE_NAME}@${latest} 相同，跳过发布`)
      return
    }
  }
  const version = nextVersion(latest)
  const pkgFile = join(stage, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.version = version
  pkg.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)
  if (dryRun) {
    console.log(`== [dry-run] 会发布 ${PACKAGE_NAME}@${version}（npm 上最新 ${latest ?? '无'}），包内文件：`)
    for (const f of files(stage)) console.log(`   ${f}`)
    return
  }
  npm(['publish', '--access', 'public'], stage)
  console.log(`== 已发布 ${PACKAGE_NAME}@${version}（上一版 ${latest ?? '无'}）`)
}

const work = mkdtempSync(join(tmpdir(), 'ramet-publish-'))
try {
  await publish(work)
} catch (err) {
  // npm 的报错在 stderr 里，原样打最后几行就够看出原因（403 令牌、E404、网络……），不要整个错误对象
  const detail = String(err.stderr ?? '').trim().split('\n').filter((l) => !l.startsWith('npm notice')).slice(-6).join('\n')
  console.error(`✗ connector 发布失败：${err.message.split('\n')[0]}${detail ? `\n${detail}` : ''}`)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
