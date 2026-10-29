// ---------- 从 GitHub 公开仓库取 skill 包 ----------
// 只认 github.com 的仓库链接，地址由 owner / repo / ref 三个校验过的字段自己拼，绝不把用户给的 URL 原样去请求
// （服务端请求用户可控地址 = SSRF）。下载走 codeload 的 zip：一次请求拿到整仓，和上传 zip 同一条解包路径。
// 基址可由 GITHUB_CODELOAD_URL 指到镜像（国内服务器直连 GitHub 常不通），测试也靠它指到本地假服务。

import { readZip, type ZipEntry } from './zip-read.js'
import { SkillError } from './skill-md.js'

export type GithubTarget = { owner: string; repo: string; ref: string; subdir: string }

const NAME_RE = /^[A-Za-z0-9_.-]+$/
const MAX_ZIP_BYTES = 10 * 1024 * 1024
const TIMEOUT_MS = 60_000

/** `https://github.com/o/r` · `/tree/<ref>[/<子目录>]` · `/blob/<ref>/<路径>`（取其目录）· `o/r` 简写。
 *  ref 取 tree/blob 后的第一段（带斜杠的分支名无法和子目录区分，这种情况请直接给 zip）；缺省 = 默认分支 */
export function parseGithubUrl(input: string): GithubTarget {
  const raw = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  let parts: string[]
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) parts = raw.split('/')
  else {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      throw new SkillError('不是有效的 GitHub 仓库链接')
    }
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) throw new SkillError('目前只支持 github.com 的仓库链接')
    parts = url.pathname.split('/').filter(Boolean)
  }
  const [owner, repo, mode, ref, ...rest] = parts
  if (!owner || !repo || !NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new SkillError('链接里要有 仓库所有者/仓库名')
  if (mode === undefined) return { owner, repo, ref: '', subdir: '' }
  if ((mode !== 'tree' && mode !== 'blob') || !ref || !NAME_RE.test(ref)) throw new SkillError('只支持仓库主页、/tree/分支/目录 或 /blob/分支/路径 形式的链接')
  // blob 指向文件：取它所在目录（链到 SKILL.md 就是导入这一个 skill）
  const dir = mode === 'blob' ? rest.slice(0, -1) : rest
  if (dir.some((seg) => seg === '..' || seg === '.')) throw new SkillError('目录不合法')
  return { owner, repo, ref, subdir: dir.join('/') }
}

/** 读响应体，超过上限立刻中止（不先把整包读进内存再判） */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new SkillError(`仓库压缩包超过 ${limit / 1024 / 1024}MB，换成只含 skill 的子目录链接或上传 zip`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

export async function fetchGithub(target: GithubTarget): Promise<{ entries: ZipEntry[]; subdir: string }> {
  const base = (process.env.GITHUB_CODELOAD_URL || 'https://codeload.github.com').replace(/\/+$/, '')
  const url = `${base}/${target.owner}/${target.repo}/zip/${target.ref || 'HEAD'}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new SkillError(`连不上 GitHub（服务器到 GitHub 的网络可能不通，可改为上传 zip）：${why}`)
  }
  if (res.status === 404) throw new SkillError('找不到这个仓库或分支（只支持公开仓库）')
  if (!res.ok) throw new SkillError(`GitHub 返回 ${res.status}`)
  const entries = readZip(await readCapped(res, MAX_ZIP_BYTES))
  // codeload 的包把整仓放在 `<repo>-<ref>/` 一层里：剥掉它，子目录才按仓库内路径算
  const top = new Set(entries.map((e) => e.path.split('/')[0]))
  const wrapper = top.size === 1 ? [...top][0]! : ''
  const stripped = wrapper ? entries.filter((e) => e.path.includes('/')).map((e) => ({ ...e, path: e.path.slice(wrapper.length + 1) })) : entries
  return { entries: stripped, subdir: target.subdir }
}
