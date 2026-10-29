/* ---------- 项目面板的 REST 客户端（server routes/project.ts）----------
 * 项目面板浏览 agent 所在机器上的工作区（文件树 / 文件内容 / git 改动），只读；唯一的写是 write（随手 AI 收下代码改写）。
 * 中心只转发，每个请求都可能因为机器不在线（409）/ connector 太旧（409）/ 没有授权（403）/ 路径被 connector 拒绝（400）失败：
 * request() 抛 ApiError，message 已是服务端的人话，直接展示即可；status 用来区分机器的问题与这个路径的问题。 */

import { request } from '../api'

/** 单个文件的改动标记：M 修改 · A 新增 · D 删除 · R 重命名 · U 冲突 · ? 未跟踪 */
export type GitMark = 'M' | 'A' | 'D' | 'R' | 'U' | '?'

/** link = 指向工作区外 / 已失效的符号链接（不可展开、不可打开）；link: true = 指向工作区内的符号链接 */
export interface TreeEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size?: number
  link?: true
  git?: GitMark
}

export interface ProjectInfo {
  machine: { id: string; name: string; owner: string | null; online: boolean }
  /** 这个页面上这个 agent 的生效工作区（执行端的绝对路径） */
  root: string
  /** false = 工作区不是 git 仓库，或这次没取到（离线 / 版本太旧 / 出错，见 error） */
  repo: boolean
  branch: string | null
  detached?: boolean
  ahead?: number
  behind?: number
  /** connector 声明的能力；没有 'project' = 版本太旧 */
  caps: string[]
  canUse: true
  /** 取分支时失败的原因（工作区目录不存在等） */
  error?: string
}

export interface TreeResult {
  path: string
  entries: TreeEntry[]
  truncated: boolean
}

export interface ReadResult {
  path: string
  size: number
  binary: boolean
  text: string
  truncated: boolean
  /** 文件全部字节的 sha256。读全了的文本文件才有（二进制 / 超 1MB 截断的没有 = 不能就地修改）；写回时当 baseHash */
  hash?: string
}

export interface WriteResult {
  /** 实际写到的文件（符号链接解开后，相对工作区） */
  path: string
  /** 写完之后的 sha256：下一次写回的 baseHash */
  hash: string
}

export interface FilesResult {
  files: string[]
  truncated: boolean
}

export interface ChangedFile {
  path: string
  mark: GitMark
  staged: boolean
  /** 重命名 / 复制的来源 */
  from?: string
  /** 本页哪个 agent（catalog id）改过它；'quick' = 随手 AI 在代码查看器里写的；没有 = 用户自己改的 */
  by?: string
}

export interface StatusResult {
  repo: boolean
  branch: string | null
  detached?: boolean
  ahead?: number
  behind?: number
  files: ChangedFile[]
  truncated: boolean
}

export interface DiffResult {
  path?: string
  diff: string
  truncated: boolean
}

const base = (pageId: string, agent: string, endpoint: string): string =>
  `/api/pages/${pageId}/project${endpoint}?agent=${encodeURIComponent(agent)}`

const withPath = (path: string): string => `&path=${encodeURIComponent(path)}`

export const projectApi = {
  info: (pageId: string, agent: string) => request<ProjectInfo>(base(pageId, agent, '')),
  tree: (pageId: string, agent: string, path: string) =>
    request<TreeResult>(base(pageId, agent, '/tree') + withPath(path)),
  read: (pageId: string, agent: string, path: string) =>
    request<ReadResult>(base(pageId, agent, '/read') + withPath(path)),
  files: (pageId: string, agent: string) => request<FilesResult>(base(pageId, agent, '/files')),
  status: (pageId: string, agent: string) => request<StatusResult>(base(pageId, agent, '/git-status')),
  diff: (pageId: string, agent: string, path: string) =>
    request<DiffResult>(base(pageId, agent, '/git-diff') + withPath(path)),
  /** 写回一个已存在的文本文件（随手 AI 收下改写时用）。需要页面可写 + 对这台机器有 machine 授权；
   *  409 且 code 'conflict' = 读到之后文件被改过（baseHash 不符），要重新打开 */
  write: (pageId: string, agent: string, path: string, baseHash: string, content: string) =>
    request<WriteResult>(base(pageId, agent, '/write'), { method: 'POST', body: JSON.stringify({ path, baseHash, content }) }),
}
