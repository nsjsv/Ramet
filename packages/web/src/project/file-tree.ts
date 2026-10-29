/* ---------- 文件树的纯函数：展开的目录压成行、文件名 → 高亮语言、大小文案 ---------- */

import type { TreeEntry } from './project-api'

export type DirState = { status: 'loading' | 'ok' | 'error'; entries: TreeEntry[]; truncated: boolean; error?: string }

export type TreeRow =
  | { kind: 'entry'; path: string; depth: number; entry: TreeEntry; open: boolean }
  /** 目录的附注行：加载中 / 失败 / 空目录 / 条数被截断 */
  | { kind: 'note'; path: string; depth: number; text: 'loading' | 'empty' | 'truncated' | { error: string } }

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

/** 把已加载的目录按展开状态压成一列行（根目录 '' 一定展开）。没加载过的展开目录显示「加载中」 */
export function flattenTree(dirs: ReadonlyMap<string, DirState>, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    const state = dirs.get(dir)
    if (!state || state.status === 'loading') {
      rows.push({ kind: 'note', path: dir, depth, text: 'loading' })
      return
    }
    if (state.status === 'error') {
      rows.push({ kind: 'note', path: dir, depth, text: { error: state.error ?? '' } })
      return
    }
    if (state.entries.length === 0) rows.push({ kind: 'note', path: dir, depth, text: 'empty' })
    for (const entry of state.entries) {
      const path = joinPath(dir, entry.name)
      const open = entry.type === 'dir' && expanded.has(path)
      rows.push({ kind: 'entry', path, depth, entry, open })
      if (open) walk(path, depth + 1)
    }
    if (state.truncated) rows.push({ kind: 'note', path: dir, depth, text: 'truncated' })
  }
  walk('', 0)
  return rows
}

/** 展开状态下需要（重新）加载的目录：根 + 所有展开的 */
export function loadedDirs(expanded: ReadonlySet<string>): string[] {
  return ['', ...expanded]
}

/** 文件大小：B / KB / MB（一位小数） */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 扩展名 → code-langs 里认识的语言名（找不到 = ''，不高亮）。文件名本身也能决定（Dockerfile / Makefile） */
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile' }
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', lua: 'lua', r: 'r', pl: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown',
  toml: 'ini', ini: 'ini', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff',
}

export function langOfPath(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]!
  const dot = name.lastIndexOf('.')
  return dot > 0 || (dot === 0 && name.length > 1) ? (BY_EXT[name.slice(dot + 1)] ?? '') : ''
}

/** 路径拆成「目录/」+「文件名」（改动列表里目录淡、文件名深） */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i === -1 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}
