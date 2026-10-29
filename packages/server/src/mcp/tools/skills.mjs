// ---------- skill：use_skill ----------
// 空间里的 skill（Agent Skills 开放标准：SKILL.md 说明 + scripts / references / assets）。agent 按工具说明里的索引
// （name + description）判断什么时候用；调用时中心给说明正文与文件清单，这里把文件同步到本机的缓存目录
// （这个进程就跑在 agent 所在的机器上，本机 agent 与 connector 两侧一样），agent 再用自己的终端去跑脚本、读资料，
// 终端命令照常走它自己的审批。不写任何 agent 的原生配置目录（~/.claude/skills 之类），缓存目录只属于 Ramet。
// 缓存按文件 sha256 增量：哈希一致且本地内容没被动过的不再下载（流量贵）。
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { call, download, failure, reply } from '../lib.mjs'

const INDEX_ITEM_MAX = 300
const INDEX_TOTAL_MAX = 8000

const cacheRoot = () => process.env.RAMET_SKILL_CACHE || join(homedir(), '.ramet', 'skills')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** 工具说明里的索引：每个 skill 一行（描述截短），总长封顶，超出的提示直接用名字调用 */
function indexText(skills) {
  const lines = []
  let used = 0
  for (const s of skills) {
    const desc = s.description.replace(/\s+/g, ' ')
    const line = `- ${s.name}：${desc.length > INDEX_ITEM_MAX ? `${desc.slice(0, INDEX_ITEM_MAX - 1)}…` : desc}`
    if (used + line.length > INDEX_TOTAL_MAX) {
      lines.push(`（还有 ${skills.length - lines.length} 个没列出，知道名字就直接调用）`)
      break
    }
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

async function readIfExists(path) {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

/** 把中心的文件清单同步到 dir：本地哈希一致的跳过，其余下载；清单里没有了的（自己写过的）删掉。返回下载个数 */
async function syncFiles(name, dir, files) {
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, '.ramet-manifest.json')
  let previous = {}
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8')).files ?? {}
  } catch {
    /* 第一次同步 */
  }
  const next = {}
  let downloaded = 0
  for (const f of files) {
    const target = resolve(dir, f.path)
    const rel = relative(dir, target)
    // 路径来自中心，本机再核一次，绝不写到缓存目录之外
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`skill 里有不安全的路径：${f.path}`)
    const local = await readIfExists(target)
    if (local && sha256(local) === f.sha256) {
      next[f.path] = f.sha256
      continue
    }
    const r = await download(`/api/ramet/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(f.path)}`)
    if (!r.ok) throw new Error(`下载 ${f.path} 失败（${r.status}）`)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.ramet-tmp`
    await writeFile(tmp, r.data)
    // 带 shebang 的脚本可直接执行
    if (r.data.subarray(0, 2).toString() === '#!') await chmod(tmp, 0o755)
    await rename(tmp, target)
    next[f.path] = sha256(r.data)
    downloaded++
  }
  for (const gone of Object.keys(previous)) {
    if (!(gone in next)) await rm(resolve(dir, gone), { force: true })
  }
  await writeFile(manifestPath, JSON.stringify({ files: next }))
  return downloaded
}

const kb = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`)

export const tools = [
  {
    name: 'use_skill',
    define: (caps) => ({
      name: 'use_skill',
      description:
        '加载一个 skill：用户为这个空间准备好的做事方法（说明，可能带脚本 / 参考资料）。' +
        '任务和下面某个 skill 的描述相符、或对话里出现 skill:<名字>（用户点名要用它）时，先调用它，再按返回的说明去做。' +
        '返回 skill 的说明正文；它的文件会同步到本机的一个目录（返回里给出路径），说明里的相对路径都相对这个目录，' +
        '需要跑脚本就用你自己的终端执行（照常需要批准）。可用的 skill：\n' +
        indexText(caps.skills ?? []),
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'skill 的名字（见上面的列表）' } },
        required: ['name'],
      },
    }),
    run: async (args) => {
      const name = String(args.name ?? '').trim()
      if (!name) return reply('请给出 skill 的名字。', true)
      const r = await call(`/api/ramet/skills/${encodeURIComponent(name)}`)
      if (!r.ok || !r.json) return failure(`加载 skill ${name} 失败`, r)
      const skill = r.json
      const dir = join(cacheRoot(), skill.spaceId, skill.name)
      try {
        await syncFiles(skill.name, dir, skill.files)
      } catch (err) {
        return reply(`skill ${name} 的文件没能同步到本机（${err instanceof Error ? err.message : String(err)}）。说明正文如下，没有文件可用：\n\n${skill.body}`, true)
      }
      const head = [`# skill：${skill.name}`, skill.description, '']
      if (skill.files.length > 0) {
        head.push(
          `文件已同步到：${dir}`,
          '说明里的相对路径都相对这个目录；要运行脚本，请用你自己的终端（例如先 cd 到这个目录），照常需要批准。',
          '',
          '文件：',
          ...skill.files.map((f) => `- ${f.path}（${kb(f.size)}）`),
          '',
        )
      }
      return reply(`${head.join('\n')}---\n${skill.body}`)
    },
  },
]
