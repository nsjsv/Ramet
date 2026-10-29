#!/usr/bin/env node
// 代码行数检查：任何代码文件不超过 800 行（不含注释与空行）。
// 统计 packages/*/src 下的 .ts/.tsx/.css/.mjs；有超限就列出并非零退出。用法：node scripts/code-lines.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIMIT = 800
const EXT = /\.(ts|tsx|css|mjs)$/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (EXT.test(name)) yield path
  }
}

export function codeLines(text) {
  const stripped = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  return stripped.split('\n').filter((line) => {
    const t = line.trim()
    return t && !t.startsWith('//')
  }).length
}

const over = []
for (const pkg of readdirSync('packages')) {
  let src
  try {
    src = statSync(join('packages', pkg, 'src')).isDirectory() ? join('packages', pkg, 'src') : null
  } catch {
    src = null
  }
  if (!src) continue
  for (const file of walk(src)) {
    const n = codeLines(readFileSync(file, 'utf8'))
    if (n > LIMIT) over.push([n, file])
  }
}
over.sort((a, b) => b[0] - a[0])
for (const [n, file] of over) console.log(`${n}\t${file}`)
if (over.length) {
  console.error(`${over.length} 个文件超过 ${LIMIT} 行（不含注释与空行）`)
  process.exit(1)
}
console.log(`全部 ≤ ${LIMIT} 行`)
