import { createHash } from 'node:crypto'
import { cpSync, createReadStream, existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** 页面图标的 emoji 统一渲染成 Twemoji SVG（src/emoji.ts），文件取自 @twemoji/svg：
 * 构建时整包拷到 dist/twemoji/（nginx 永久缓存，见 nginx.conf），dev 由中间件直接从 node_modules 出。
 * 选择器能选到任何 emoji，所以包里的 SVG 要整包带上，不能只拷用得到的。 */
function twemojiAssets(): Plugin {
  const dir = (): string => dirname(createRequire(import.meta.url).resolve('@twemoji/svg/package.json'))
  let outDir = 'dist'
  return {
    name: 'ramet-twemoji-assets',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use('/twemoji', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? ''
        const file = join(dir(), name)
        // 只放行 <码点>.svg：拒绝路径穿越，缺文件交给前端 onerror 退回文本
        if (!/^[0-9a-f-]+\.svg$/.test(name) || !existsSync(file)) return next()
        res.setHeader('Content-Type', 'image/svg+xml')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      cpSync(dir(), join(outDir, 'twemoji'), {
        recursive: true,
        filter: (src) => !src.endsWith('package.json') && !/\.(md|txt)$/i.test(src) && !/LICENSE/i.test(src),
      })
    },
  }
}

/** 发版提示（src/UpdateNotice.tsx）用的版本号：最终 index.html（已注入带哈希的入口脚本 / 样式 / modulepreload）的内容哈希，
 * 写进页面的 <meta name="ramet-build"> 和 dist/version.json。前端代码没变时构建是确定的，哈希不变，只改 server 的部署不会误报 */
function buildVersion(): Plugin {
  let outDir = 'dist'
  let id = ''
  return {
    name: 'ramet-build-version',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir)
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        id = createHash('sha256').update(html).digest('hex').slice(0, 12)
        return [{ tag: 'meta', attrs: { name: 'ramet-build', content: id }, injectTo: 'head' }]
      },
    },
    writeBundle() {
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ id }) + '\n')
    },
  }
}

/** 首屏必用、升级不频繁的第三方库各自成 chunk，业务代码改了这些文件名不变，老用户只重下业务 chunk。
 * 只认这四组（按包名，取路径里最后一个 node_modules 之后的包），其余返回 undefined 交给 Rollup。
 * 坑：Rollup 会把组内模块的全部静态依赖（不看 tree-shaking）一并吸进组里，已按需 import() 的库
 *（mermaid / katex / lowlight / xterm / emoji-mart / @codemirror 等）只要被组内模块静态 import 一下就成了首屏依赖。所以：
 * - micromark-extension-math 不进组：它的 lib/html.js 静态 import katex（只用语法扩展，html 部分本来会被摇掉）；
 * - 依赖 lodash-es 的四个 milkdown 插件（连同只做转导出的 @milkdown/kit）不进组：它们 import 的是 lodash-es 总入口，
 *   进组会把 mermaid 要用的那一大截 lodash 拖进首屏；
 * - @milkdown/plugin-collab 进 yjs 组：它依赖 y-prosemirror，放 pm 组会让 vendor-pm 与 vendor-yjs 互相导入。
 * 改分组后要核对 index.html 的 modulepreload 与 yjs 份数。 */
const VENDOR_GROUPS: [string, RegExp][] = [
  ['vendor-react', /^(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)$/],
  ['vendor-yjs', /^(yjs|lib0|y-prosemirror|y-protocols|y-indexeddb|@hocuspocus\/[^/]+|@milkdown\/plugin-collab)$/],
  ['vendor-pm', /^(prosemirror-[^/]+|@milkdown\/(?!kit$|plugin-(?:listener|block|slash|tooltip)$)[^/]+|@floating-ui\/[^/]+)$/],
  ['vendor-md', /^(micromark(?!-extension-math$)[^/]*|mdast-[^/]+|unified|remark-[^/]+|vfile[^/]*|unist-[^/]+)$/],
]

function vendorChunk(id: string): string | undefined {
  const at = id.lastIndexOf('/node_modules/')
  if (at < 0) return undefined
  const m = id.slice(at + '/node_modules/'.length).match(/^(@[^/]+\/[^/]+|[^/]+)/)
  if (!m) return undefined
  return VENDOR_GROUPS.find(([, re]) => re.test(m[1]!))?.[0]
}

export default defineConfig({
  plugins: [react(), twemojiAssets(), buildVersion()],
  build: {
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3789',
      '/collab': { target: 'ws://localhost:3789', ws: true },
      // 网页终端（server routes/pty-socket.ts）：WebSocket
      '/term': { target: 'ws://localhost:3789', ws: true },
      // 本地 connector（/connector 与 /connector/pair）：dev 下 --cloud 给前端地址，终端打印的确认链接 /connect/:code 才落在前端
      '/connector': { target: 'ws://localhost:3789', ws: true },
    },
  },
})
