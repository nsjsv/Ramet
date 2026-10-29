// ---------- 项目面板的 git 只读调用（connector 侧）----------
// 只读：只跑 status / diff / ls-files / rev-parse，不做暂存、撤销、提交、推送。
// 执行方式：execFile（不经 shell）、参数数组、cwd = 工作区 root（已 realpath）、超时、输出上限。
// 防仓库配置执行外部程序：
//   - diff 一律带 --no-ext-diff --no-textconv（diff.external / diff.<driver>.command / textconv 都不会被调用）；
//   - 每次调用都带 -c core.fsmonitor=false（status / diff 会按 core.fsmonitor 起仓库配置里写的外部程序）；
//   - GIT_TERMINAL_PROMPT=0（不弹凭据提问）、GIT_OPTIONAL_LOCKS=0（status 不为刷新索引抢 index.lock，别和用户的 git 操作打架）、
//     GIT_LITERAL_PATHSPECS=1；继承来的 GIT_DIR / GIT_WORK_TREE / GIT_EXTERNAL_DIFF 等一律丢掉。
// 已知局限：clean/smudge 过滤器（filter.<name>.clean）是 git 计算工作区状态时必须调用的，没法在不改变结果的前提下关掉；
// 它们来自这台机器的 git 配置 / 仓库配置，属于机器主人自己的信任范围。

import { execFile } from 'node:child_process'
import { DIFF_MAX_BYTES, FILES_MAX, STATUS_MAX_FILES, type GitFile, type GitMark, type GitStatusReply } from '../agents/project-types.js'

const GIT_TIMEOUT_MS = 15_000

/** 会把 git 引到别的仓库 / 别的外部程序上去的环境变量：继承来的一律丢掉（git 只看 cwd 这个工作区） */
const STRIP_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_EXTERNAL_DIFF',
]

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of STRIP_ENV) delete env[key]
  // 路径参数一律按字面理解（文件名以 ':' 开头不能被当成 pathspec 魔法）
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
}

/** 所有调用共用的前置参数（见文件头） */
const BASE = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false']

type GitRun = { code: number; stdout: string; truncated: boolean }

/** 跑一条 git。非零退出码不抛（调用方按 code 判断：status 在非仓库里是 128，diff --no-index 有差异是 1）；
 *  找不到 git / 超时 / 起不来抛。输出超过 maxBytes 被截断并标 truncated（子进程会被杀） */
export function runGit(cwd: string, args: string[], maxBytes: number): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...BASE, ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: maxBytes,
        encoding: 'buffer',
        windowsHide: true,
        env: gitEnv(),
      },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''))
        if (!err) return resolve({ code: 0, stdout: out.toString('utf8'), truncated: false })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: 0, stdout: out.toString('utf8'), truncated: true })
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout: out.toString('utf8'), truncated: false })
        if (e.killed || e.signal) return reject(new Error('git 执行超时'))
        reject(new Error(e.code === 'ENOENT' ? '这台机器上没有 git' : `git 执行失败：${e.message}`))
      },
    )
  })
}

/** root 在 git 工作区里就回它相对仓库顶层的前缀（顶层本身 = ''，子目录 = 'sub/dir/'）；不在（不是仓库 / 没有 git）= null */
export async function repoPrefix(root: string): Promise<string | null> {
  try {
    const res = await runGit(root, ['rev-parse', '--show-prefix'], 4096)
    return res.code === 0 ? res.stdout.trim() : null
  } catch {
    return null
  }
}

/** 暂存区 / 工作区两个状态字符 → 一个标记（冲突 > 工作区 > 暂存区） */
function markOf(x: string, y: string): GitMark {
  if (x === '?' && y === '?') return '?'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'U'
  const c = y !== ' ' ? y : x
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R' || c === 'C') return 'R'
  return 'M' // M / T（类型变化）都算修改
}

type Branch = Pick<GitStatusReply, 'branch' | 'detached' | 'ahead' | 'behind'>

/** `## main...origin/main [ahead 1, behind 2]` / `## No commits yet on main` / `## HEAD (no branch)` / `## main` */
function parseBranch(line: string): Branch {
  const text = line.slice(3)
  if (text.startsWith('HEAD (no branch)')) return { branch: null, detached: true }
  for (const lead of ['No commits yet on ', 'Initial commit on ']) {
    if (text.startsWith(lead)) return { branch: text.slice(lead.length) || null }
  }
  const name = text.split('...')[0] ?? ''
  const ahead = /ahead (\d+)/.exec(text)?.[1]
  const behind = /behind (\d+)/.exec(text)?.[1]
  return { branch: name || null, ...(ahead ? { ahead: Number(ahead) } : {}), ...(behind ? { behind: Number(behind) } : {}) }
}

/** `git status --porcelain=v1 -z -b` 的输出 → 分支 + 文件。prefix = root 相对仓库顶层的前缀：porcelain 的路径永远相对顶层，
 *  这里剥掉它让路径相对 root。条数超过 STATUS_MAX_FILES 的部分不要并标 truncated */
export function parseStatus(stdout: string, prefix: string): Pick<GitStatusReply, 'files' | 'truncated'> & Branch {
  const records = stdout.split('\0')
  let branch: Branch = { branch: null }
  const files: GitFile[] = []
  let truncated = false
  const strip = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!
    if (!rec) continue
    if (rec.startsWith('## ')) {
      branch = parseBranch(rec)
      continue
    }
    const x = rec[0] ?? ' '
    const y = rec[1] ?? ' '
    const path = strip(rec.slice(3))
    // 重命名 / 复制：下一条记录是来源路径
    const from = x === 'R' || x === 'C' || y === 'R' || y === 'C' ? strip(records[++i] ?? '') : undefined
    if (files.length >= STATUS_MAX_FILES) {
      truncated = true
      continue
    }
    files.push({ path, mark: markOf(x, y), staged: x !== ' ' && x !== '?', ...(from ? { from } : {}) })
  }
  return { ...branch, files, truncated }
}

/** 工作区 git 状态（分支 + 未提交的改动）。不是仓库 → repo: false */
export async function gitStatus(root: string): Promise<GitStatusReply> {
  const prefix = await repoPrefix(root)
  if (prefix === null) return { op: 'git-status', repo: false, branch: null, files: [], truncated: false }
  // -uall：未跟踪的目录展开成文件（改动列表要逐文件看 diff）；pathspec `.` 只看 root 之下
  const res = await runGit(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--', '.'], 8 * 1024 * 1024)
  if (res.code !== 0) return { op: 'git-status', repo: false, branch: null, files: [], truncated: false }
  const parsed = parseStatus(res.stdout, prefix)
  return { op: 'git-status', repo: true, ...parsed, truncated: parsed.truncated || res.truncated }
}

/** 仓库文件清单（已跟踪 + 未跟踪但没被忽略）；不是仓库 → null（调用方改走遍历）。相对 root，`/` 分隔 */
export async function gitFiles(root: string): Promise<{ files: string[]; truncated: boolean } | null> {
  if ((await repoPrefix(root)) === null) return null
  const res = await runGit(root, ['ls-files', '-co', '--exclude-standard', '-z'], 16 * 1024 * 1024)
  if (res.code !== 0) return null
  const seen = new Set<string>()
  let truncated = res.truncated
  for (const name of res.stdout.split('\0')) {
    if (!name) continue
    if (seen.size >= FILES_MAX) {
      truncated = true
      break
    }
    seen.add(name)
  }
  return { files: [...seen], truncated }
}

/** path（相对 root、已校验）是不是已被 git 跟踪 */
async function tracked(root: string, path: string): Promise<boolean> {
  return (await runGit(root, ['ls-files', '--error-unmatch', '--', path], 4096)).code === 0
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--relative']

/** 单文件（path）或全部已跟踪文件的未提交改动（unified diff）。HEAD 不存在（还没提交过）退回暂存区 + 工作区两份。
 *  未跟踪文件用 --no-index 对 /dev/null 现算（git diff 默认看不到它们） */
export async function gitDiff(root: string, path: string | undefined): Promise<{ diff: string; truncated: boolean }> {
  if ((await repoPrefix(root)) === null) return { diff: '', truncated: false }
  if (path && !(await tracked(root, path))) {
    // 对 /dev/null 比较：有差异时退出码是 1（不是错误）。路径已被调用方限定在 root 之内
    const res = await runGit(root, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', path], DIFF_MAX_BYTES)
    return { diff: res.stdout, truncated: res.truncated }
  }
  const spec = path ? ['--', path] : []
  const head = await runGit(root, ['diff', ...DIFF_FLAGS, 'HEAD', ...spec], DIFF_MAX_BYTES)
  if (head.code === 0) return { diff: head.stdout, truncated: head.truncated }
  // 没有 HEAD：新仓库。暂存的 + 没暂存的分开取，拼在一起
  const staged = await runGit(root, ['diff', '--cached', ...DIFF_FLAGS, ...spec], DIFF_MAX_BYTES)
  const rest = await runGit(root, ['diff', ...DIFF_FLAGS, ...spec], DIFF_MAX_BYTES)
  const diff = staged.stdout + rest.stdout
  return diff.length > DIFF_MAX_BYTES
    ? { diff: diff.slice(0, DIFF_MAX_BYTES), truncated: true }
    : { diff, truncated: staged.truncated || rest.truncated }
}
