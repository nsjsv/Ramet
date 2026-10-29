// 空间 skill 的 REST 客户端（skill 库 / SkillHead / 斜杠菜单共用）

import { request } from './api'

/** 附件 / 导入体积的显示口径（skill 库与 SkillHead 共用；放这里而不是 SkillLibrary，那边是按需加载的页面） */
export const fmtSize = (n: number): string => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)

export type SkillSource = { type: 'zip' | 'folder' | 'github'; url?: string; at: string }

/** 列表项：files / bytes 是汇总（单个 skill 详情里 files 是清单） */
export interface SkillSummary {
  /** 页面 id（skill 就是一个页面，打开它 = /page/:id） */
  id: string
  spaceId: string
  name: string
  description: string
  extra: Record<string, unknown>
  source: SkillSource | null
  updatedAt: string
  title: string
  files: number
  bytes: number
}

export interface SkillFileInfo {
  path: string
  size: number
  sha256: string
}

export interface SkillDetail extends Omit<SkillSummary, 'files' | 'bytes'> {
  files: SkillFileInfo[]
  limits: { files: number; fileBytes: number; totalBytes: number; perImport: number }
}

export interface ImportResult {
  /** 成功的 skill 名；包里写错的那个没有名字，用 root（它所在的目录）指认 */
  name?: string
  root?: string
  status: 'created' | 'updated' | 'error'
  pageId?: string
  error?: string
}

const enc = encodeURIComponent
/** multipart 让浏览器自己生成 boundary：覆盖掉 request 默认的 JSON Content-Type */
const multipart = (form: FormData): RequestInit => ({ method: 'POST', body: form, headers: {} })

export const skillApi = {
  list: (spaceId: string) => request<SkillSummary[]>(`/api/skills?spaceId=${enc(spaceId)}`),
  get: (id: string) => request<SkillDetail>(`/api/skills/${id}`),
  create: (spaceId: string, name: string, description: string) =>
    request<{ pageId: string; name: string }>('/api/skills', { method: 'POST', body: JSON.stringify({ spaceId, name, description }) }),
  update: (id: string, patch: { name?: string; description?: string }) =>
    request<SkillSummary>(`/api/skills/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  importZip: (spaceId: string, file: File) => {
    const form = new FormData()
    form.append('spaceId', spaceId)
    form.append('kind', 'zip')
    form.append('file', file)
    return request<{ results: ImportResult[] }>('/api/skills/import', multipart(form))
  },
  /** 浏览器选的文件夹：每个文件带它在文件夹里的相对路径（webkitRelativePath，含最外层文件夹名） */
  importFolder: (spaceId: string, files: File[]) => {
    const form = new FormData()
    form.append('spaceId', spaceId)
    form.append('kind', 'folder')
    for (const f of files) {
      form.append('file', f)
      form.append('path', f.webkitRelativePath || f.name)
    }
    return request<{ results: ImportResult[] }>('/api/skills/import', multipart(form))
  },
  importGithub: (spaceId: string, github: string) =>
    request<{ results: ImportResult[] }>('/api/skills/import', { method: 'POST', body: JSON.stringify({ spaceId, github }) }),

  putFile: (id: string, path: string, data: Blob) =>
    request<SkillFileInfo>(`/api/skills/${id}/files?path=${enc(path)}`, { method: 'PUT', body: data, headers: {} }),
  deleteFile: (id: string, path: string) => request<{ ok: true }>(`/api/skills/${id}/files?path=${enc(path)}`, { method: 'DELETE' }),
  fileUrl: (id: string, path: string) => `/api/skills/${id}/files?path=${enc(path)}`,
}

// 斜杠菜单每次弹出都要这份列表：同一空间 30 秒内复用上一份，不为一个小 JSON 反复打服务端
const TTL_MS = 30_000
const cache = new Map<string, { at: number; list: SkillSummary[]; inflight?: Promise<SkillSummary[]> }>()

export function cachedSkills(spaceId: string): SkillSummary[] | null {
  return cache.get(spaceId)?.list ?? null
}

/** 取（必要时刷新）空间的 skill 列表。失败返回缓存里的旧值或空表：斜杠菜单没有 skill 不是错误 */
export function loadSkills(spaceId: string, force = false): Promise<SkillSummary[]> {
  const hit = cache.get(spaceId)
  if (hit && !force && (hit.inflight || Date.now() - hit.at < TTL_MS)) return hit.inflight ?? Promise.resolve(hit.list)
  const entry = hit ?? { at: 0, list: [] as SkillSummary[] }
  entry.inflight = skillApi
    .list(spaceId)
    .then((list) => {
      entry.list = list
      entry.at = Date.now()
      return list
    })
    .catch(() => entry.list)
    .finally(() => {
      delete entry.inflight
    })
  cache.set(spaceId, entry)
  return entry.inflight
}

/** 库里增删改之后让下一次取数重新来 */
export function invalidateSkills(spaceId: string): void {
  const hit = cache.get(spaceId)
  if (hit) hit.at = 0
}
