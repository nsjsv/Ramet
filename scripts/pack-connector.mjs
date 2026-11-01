#!/usr/bin/env node
// ---------- 打 connector 安装包（npm 包 `@nsjsv/ramet`）：别的机器 `npm i -g @nsjsv/ramet` 就能用，不带源码 ----------
// 用法（仓库根目录）：node scripts/pack-connector.mjs [输出目录]（默认 dist/connector）→ 输出目录/ramet.tgz，
// 版本号 0.0.0-local.<时间戳>，一眼能和 npm 上的正式版分开。正式版走 publish-connector.mjs（复用这里的 packConnector）。
// 包里只有：
//   connector.mjs   入口：packages/server/src/connector/cli.ts 连同用到的 server / shared 代码与纯 JS 依赖，打成一个压缩文件
//   mcp/ramet.mjs   agent 的「手」（stdio MCP）。page-read.ts 按「入口同级的 mcp/ramet.mjs」找它，目录结构不能变
//   extension/ramet-mcp.mjs  pi 驱动用 -e 加载的扩展（按会话注册上面那个 MCP）。drivers/pi/session.ts 按「入口同级的 extension/」找它
//   package.json    bin = ramet；依赖只剩没法打进去的原生模块 node-pty（可选）
//   README.md / LICENSE
// 产物与版本号无关（版本运行时从 package.json 读），同样的源码打出同样的字节：发布脚本靠这一点判断要不要发新版。
// esbuild 不是直接依赖（tsx / vite 带进来的），刻意不往 package.json 里加：改依赖清单会让 server 环境镜像重建。

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'packages/server')

// 不带 scope 的 ramet 发不上去：npm 的防仿冒规则嫌它和 ramda / ret / raven 太像。命令名不受影响，仍是 ramet
export const PACKAGE_NAME = '@nsjsv/ramet'
const BIN = 'ramet'
const REPO = 'https://github.com/nsjsv/Ramet'

/** 打不进去的原生模块：connector 的机器上自己装，装不上就没有那项能力（终端） */
const OPTIONAL = ['@lydell/node-pty']

/** 锁成中心此刻装着的版本 */
function installedVersion(name) {
  for (const dir of [join(server, 'node_modules'), join(root, 'node_modules')]) {
    const file = join(dir, name, 'package.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).version
  }
  throw new Error(`找不到 ${name}：先 npm ci`)
}

function localVersion() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `0.0.0-local.${stamp}`
}

const README = `# ${PACKAGE_NAME}

[Ramet](${REPO}) 的连接器：把这台机器上的 agent CLI（Claude Code / Codex / pi / omp）接进 Ramet 中心。
只走出站 WebSocket，不需要公网端口；登录凭据不离开中心，agent 经短期凭证读写页面。

\`\`\`bash
npm i -g @nsjsv/ramet             # 国内网络可加 --registry=https://registry.npmmirror.com
ramet start --cloud https://<中心地址>
\`\`\`

终端会打印一条配对链接，在浏览器里核对校验码、选好空间确认后，转为后台服务（开机 / 登录自启、断线自动重连）。
之后用 \`ramet status\` / \`ramet logs -f\` / \`ramet stop\` 管理，\`ramet start --repair\` 重新配对，\`ramet --help\` 看全部命令。

要求 Node.js 22 以上。许可证 AGPL-3.0。
`

/** 在 stage 目录里放好整个包（不打 tgz）；version / gitHead 由调用方定 */
export async function packConnector({ stage, version, gitHead }) {
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
  await build({
    ...common,
    entryPoints: [join(server, 'src/agents/drivers/pi/extension/ramet-mcp.mjs')],
    outfile: join(stage, 'extension/ramet-mcp.mjs'),
  })

  const pkg = {
    name: PACKAGE_NAME,
    version,
    description: 'Ramet 连接器：把本机的 agent CLI 接进 Ramet',
    keywords: ['ramet', 'agent', 'claude-code', 'codex', 'mcp'],
    homepage: REPO,
    repository: { type: 'git', url: `git+${REPO}.git` },
    bugs: `${REPO}/issues`,
    license: 'AGPL-3.0-only',
    type: 'module',
    bin: { [BIN]: 'connector.mjs' },
    engines: { node: '>=22' },
    optionalDependencies: Object.fromEntries(OPTIONAL.map((name) => [name, installedVersion(name)])),
    ...(gitHead ? { gitHead } : {}),
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(join(stage, 'README.md'), README)
  copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
}

async function main() {
  const out = resolve(process.argv[2] ?? join(root, 'dist/connector'))
  const stage = mkdtempSync(join(tmpdir(), 'ramet-pack-'))
  try {
    const version = localVersion()
    await packConnector({ stage, version })
    mkdirSync(out, { recursive: true })
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim()
    const target = join(out, `${BIN}.tgz`)
    renameSync(join(out, packed.split('\n').pop()), target)
    console.log(`connector 安装包 ${version} → ${target}`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
