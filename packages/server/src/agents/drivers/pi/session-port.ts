// ---------- pi / omp 的会话端口 ----------
// 两家的会话记录都在 Ramet 自己的目录里（session.ts：pi = <根>/pi/<id>.jsonl，--session 打开；omp = <根>/omp/<id>/，open_session 打开），
// 位置只由会话 id 决定、与 cwd 无关，所以两台机器同一套约定，下发时写回同一位置即可。
// - pi：一个文件，name = main.jsonl。
// - omp：整个会话目录（记录 + artifacts，子代理记录嵌在 artifacts 里），name = dir/<相对路径>；记录里 `blob:sha256:<hash>` 引用的
//   大块内容在 omp 的全局内容寻址库 <agent 目录>/blobs/<hash>，name = blobs/<hash>，写入时已存在且哈希一致就跳过。
//   agent 目录 = OMP_CODING_AGENT_DIR，缺省 ~/.omp/agent：照 pi 的 config.js（`${APP_NAME}_CODING_AGENT_DIR`，缺省 ~/<配置目录>/agent）
//   推到 omp（APP_NAME = omp、配置目录 .omp）；blob 库位置见 omp 的 session.md。omp 没装在本机，未实测，对不上时只是 blob 搬不过去。
// - 两家打开记录都看首行里的 cwd（pi 0.75 的 SessionManager.open 拿它当运行时工作目录、目录不存在时 rpc 模式直接退出；omp 与进程 cwd
//   不同就回 cancelled），而两台机器的工作目录几乎总是不同：写完之后把首行的 cwd 改成目标机器的工作目录（rewriteHeaderCwd）。

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validSessionId } from '../../session-types.js'
import {
  cliEnv,
  regularFile,
  relSegments,
  rewriteHeaderCwd,
  sessionsRoot,
  walkFiles,
  type SessionFile,
  type SessionPort,
} from '../session-port.js'

const MAIN = 'main.jsonl'
const DIR_PREFIX = 'dir/'
const BLOB_PREFIX = 'blobs/'
const BLOB_HASH = /^[0-9a-f]{64}$/
const BLOB_REF = /blob:sha256:([0-9a-f]{64})/g

const piFile = (sessionId: string): string => join(sessionsRoot(), 'pi', `${sessionId}.jsonl`)
const ompDir = (sessionId: string): string => join(sessionsRoot(), 'omp', sessionId)

export function piSessionPort(): SessionPort {
  return {
    async list(sessionId) {
      if (!validSessionId(sessionId)) return []
      const path = piFile(sessionId)
      const st = await regularFile(path)
      return st ? [{ name: MAIN, size: st.size, path }] : []
    },
    target(sessionId, _cwd, name) {
      return validSessionId(sessionId) && name === MAIN ? piFile(sessionId) : null
    },
    async afterImport(sessionId, cwd) {
      if (!validSessionId(sessionId) || !(await regularFile(piFile(sessionId)))) return
      await rewriteHeaderCwd(piFile(sessionId), cwd)
    },
  }
}

/** omp 的全局 blob 库 */
export function ompBlobDir(env: Record<string, string> | undefined): string {
  return join(cliEnv(env, 'OMP_CODING_AGENT_DIR') ?? join(homedir(), '.omp', 'agent'), 'blobs')
}

/** 记录里引用到的 blob（按出现顺序去重）。只扫 .jsonl：artifacts 里别的文件是工具产物，不是记录 */
async function blobRefs(files: Array<{ rel: string; path: string }>): Promise<string[]> {
  const seen = new Set<string>()
  for (const f of files) {
    if (!f.rel.endsWith('.jsonl')) continue
    const text = await readFile(f.path, 'utf8').catch(() => '')
    for (const m of text.matchAll(BLOB_REF)) if (m[1]) seen.add(m[1])
  }
  return [...seen]
}

export function ompSessionPort(env: Record<string, string> | undefined): SessionPort {
  return {
    async list(sessionId) {
      if (!validSessionId(sessionId)) return []
      const files = await walkFiles(ompDir(sessionId))
      // 没有记录（目录里没有 .jsonl）= 本机没有这个会话（同 PiSession.recorded）
      if (!files.some((f) => !f.rel.includes('/') && f.rel.endsWith('.jsonl'))) return []
      const out: SessionFile[] = files.map((f) => ({ name: DIR_PREFIX + f.rel, size: f.size, path: f.path }))
      const blobs = ompBlobDir(env)
      for (const hash of await blobRefs(files)) {
        const path = join(blobs, hash)
        const st = await regularFile(path)
        if (st) out.push({ name: BLOB_PREFIX + hash, size: st.size, path })
      }
      return out
    },
    target(sessionId, _cwd, name) {
      if (!validSessionId(sessionId)) return null
      if (name.startsWith(BLOB_PREFIX)) {
        const hash = name.slice(BLOB_PREFIX.length)
        return BLOB_HASH.test(hash) ? join(ompBlobDir(env), hash) : null
      }
      const segs = relSegments(name, DIR_PREFIX)
      return segs ? join(ompDir(sessionId), ...segs) : null
    },
    contentHash(name) {
      if (!name.startsWith(BLOB_PREFIX)) return null
      const hash = name.slice(BLOB_PREFIX.length)
      return BLOB_HASH.test(hash) ? hash : null
    },
    async afterImport(sessionId, cwd) {
      if (!validSessionId(sessionId)) return
      // 只改会话目录顶层的记录：open_session 读的是它们；artifacts 里子代理的记录不影响打开
      for (const f of await walkFiles(ompDir(sessionId))) {
        if (!f.rel.includes('/') && f.rel.endsWith('.jsonl')) await rewriteHeaderCwd(f.path, cwd)
      }
    },
  }
}
