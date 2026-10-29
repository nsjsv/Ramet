// ---------- 写文件的中心侧小工具：记「随手 AI 写了哪个文件」，以及改动页「谁改的」的合并 ----------
// write 帧本身的授权、转发在 routes/project.ts（machine 范围 + 页面可写）；这里只管 quick_writes 这张表：
// 写成功后记一行（page + 机器 + 工作区 + 相对路径 + 谁），改动页读 git-status 时凭它把随手 AI 写的和 agent 改的 / 用户自己改的分开。

import type { Pool } from 'pg'
import type { GitFile } from './project-types.js'

const INSERT_QUICK_WRITE = `INSERT INTO quick_writes (page_id, connector_id, root, path, user_id) VALUES ($1, $2, $3, $4, $5)`
// 这些路径上最近一次随手 AI 落盘的时间（毫秒）。限定页面 + 机器 + 工作区：同一个路径在别的机器 / 别的工作区上是另一个文件
const SELECT_QUICK_AT = `SELECT path, (extract(epoch FROM max(at)) * 1000)::float8 AS at
  FROM quick_writes
  WHERE page_id = $1 AND connector_id = $2 AND root = $3 AND path = ANY($4::text[])
  GROUP BY path`

export function recordQuickWrite(pool: Pool, pageId: string, connectorId: string, root: string, path: string, userId: string): Promise<unknown> {
  return pool.query(INSERT_QUICK_WRITE, [pageId, connectorId, root, path, userId])
}

/** 改动文件里哪些最近被随手 AI 写过：路径 → 时间（毫秒） */
export async function quickWrittenAt(pool: Pool, pageId: string, connectorId: string, root: string, paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map()
  const { rows } = await pool.query<{ path: string; at: number }>(SELECT_QUICK_AT, [pageId, connectorId, root, paths])
  return new Map(rows.map((r) => [r.path, r.at]))
}

/** 每个改动文件的作者标记：随手 AI 的写入比 agent 的那一轮更近是 'quick'，否则是 agent（catalog id），都没有就不带 by（前端标「你」）。
 *  只合并 by，其余字段原样 */
export function withAuthors(
  files: GitFile[],
  agents: Map<string, { agent: string; at: number }>,
  quick: Map<string, number>,
): Array<GitFile & { by?: string }> {
  return files.map((f) => {
    const a = agents.get(f.path)
    const q = quick.get(f.path)
    if (q !== undefined && (!a || q > a.at)) return { ...f, by: 'quick' }
    return a ? { ...f, by: a.agent } : f
  })
}
