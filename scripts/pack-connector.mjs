#!/usr/bin/env node
// ---------- 打 connector 安装包：别的机器 `npm i -g <地址>/dl/ramet-connector.tgz` 就能用，不带源码 ----------
// 用法（仓库根目录）：node scripts/pack-connector.mjs [输出目录]（默认 dist/connector；部署时输出到 packages/web/dist/dl）
// 包里只有：
//   connector.mjs   入口：packages/server/src/connector/cli.ts 连同用到的 server / shared 代码与纯 JS 依赖，打成一个压缩文件
//   mcp/ramet.mjs   agent 的「手」（stdio MCP）。page-read.ts 按「入口同级的 mcp/ramet.mjs」找它，目录结构不能变
//   package.json    bin = ramet-connector；依赖只剩没法打进去的：按路径拉起的 ACP 适配器、原生模块 node-pty（可选）
// 版本号是 1.0.0-<时间戳>.g<提交>，`ramet-connector status` / `--version` 能看出装的是哪次打的包。
// esbuild 不是直接依赖（tsx / vite 带进来的），刻意不往 package.json 里加：改依赖清单会让 server 环境镜像重建。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'packages/server')
const out = resolve(process.argv[2] ?? join(root, 'dist/connector'))

/** 与 agents/registry.ts 的自动检测对齐：claude / codex 用包内适配器（pi 要 bun，太偏，不带；没带的检测时自动跳过） */
const ADAPTERS = ['@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp']
const OPTIONAL = ['@lydell/node-pty']

/** 锁成中心此刻装着的版本（中心与 connector 跑同一套适配器） */
function installedVersion(name) {
  for (const dir of [join(server, 'node_modules'), join(root, 'node_modules')]) {
    const file = join(dir, name, 'package.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).version
  }
  throw new Error(`找不到 ${name}：先 npm ci`)
}

function versionStamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let commit = ''
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    // 没有 git：只用时间戳
  }
  return `1.0.0-${stamp}${commit ? `.g${commit}` : ''}`
}

// 打进去的 CJS 依赖（pg、ws……）会调 require：ESM 产物里没有，补一个
const banner = { js: "import{createRequire as __rametRequire}from'node:module';const require=__rametRequire(import.meta.url);" }
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  external: [...OPTIONAL, 'pg-native'],
  logLevel: 'warning',
}

const stage = mkdtempSync(join(tmpdir(), 'ramet-connector-'))
try {
  await build({
    ...common,
    entryPoints: [join(server, 'src/connector/cli.ts')],
    outfile: join(stage, 'connector.mjs'),
    // cli.ts 没有 hashbang：npm 的 bin 在 unix 上要靠它
    banner: { js: `#!/usr/bin/env node\n${banner.js}` },
  })
  await build({
    ...common,
    entryPoints: [join(server, 'src/mcp/ramet.mjs')],
    outfile: join(stage, 'mcp/ramet.mjs'),
    banner,
  })

  const version = versionStamp()
  const pkg = {
    name: 'ramet-connector',
    version,
    description: 'Ramet connector：把本机 agent 接进 Ramet',
    private: true,
    license: 'UNLICENSED',
    type: 'module',
    bin: { 'ramet-connector': 'connector.mjs' },
    engines: { node: '>=22' },
    dependencies: Object.fromEntries(ADAPTERS.map((name) => [name, installedVersion(name)])),
    optionalDependencies: Object.fromEntries(OPTIONAL.map((name) => [name, installedVersion(name)])),
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  mkdirSync(out, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim()
  // 固定文件名，网页给出的安装命令不用跟着版本变（nginx 对 /dl/ 回 max-age=0，npm 每次都会重新校验；
  // 如果前面有 CDN，边缘缓存要在部署后清掉）
  const target = join(out, 'ramet-connector.tgz')
  renameSync(join(out, packed.split('\n').pop()), target)
  console.log(`connector 安装包 ${version} → ${target}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}
