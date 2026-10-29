import type { PlanEntry, RunEntry, RunInfo, TeamState, TurnUsage } from '@ramet/shared/run-model'

/** 页面图标：emoji 字符或上传图片的文件 id（展示 URL 由 PageIcon 组件拼）。
 * emoji 优先、图片其次的派生在服务端 page-icon.ts，前端不重复判断 */
export type PageIcon = { kind: 'emoji'; value: string } | { kind: 'image'; value: string }

export interface Page {
  id: string
  parent_id: string | null
  title: string
  created_at: string
  /** 所属空间；null 仅见于迁移前的孤儿页 */
  space_id: string | null
  /** 创建者（老消息没记发言人时，对话气泡的头像回落到它）；旧缓存可能缺字段 */
  owner_id?: string | null
  /** 本页公开；子树跟随任一祖先的 published */
  published: boolean
  /** 页面判别：'doc' = 用户文档，'run' = agent 一轮工具调用过程的归档页（server agents/runs.ts），
   *  'skill' = 空间 skill（SKILL.md 正文，server skills.ts），'collection' = 集合页（没有正文，行 = 父页是它的 doc 页）。
   *  过程页只能跟着父文档的 publish_includes_runs 公开，skill 页和集合页恒不公开 */
  kind: 'doc' | 'run' | 'skill' | 'collection'
  /** 公开时是否连过程页一起公开（只对 doc 页有意义） */
  publish_includes_runs: boolean
  /** 未设图标为 null */
  icon: PageIcon | null
  /** false = 目录树自建文档：属于本空间，但不出现在页面树（子孙跟着排除）。旧缓存缺字段 = 在页面树里 */
  in_page_tree?: boolean
  /** true = 出现在「从模板新建」列表里；旧缓存缺字段 = 不是模板 */
  is_template?: boolean
  /** true = 全宽：正文铺满画面、不收 720 列；旧缓存缺字段 = 否 */
  full_width?: boolean
  /** 同父子页的顺序（侧栏拖拽，小数可插中间）；null = 没排过，排在有值之后。
   *  增量同步合并后按它重排（@ramet/shared/page-tree 的 comparePages）；旧缓存缺字段按 null */
  position?: number | null
}

/** 页面列表同步（GET /api/pages/sync）：full = 整表（首次 / 游标过旧 / 空间成员关系变了）；
 *  否则 up = 变过且我还看得见的页（现状），rm = 变过但已看不见的页 id（回收、删除、换到我不在的空间） */
export type PageSync =
  | { cursor: string; members: string; full: Page[] }
  | { cursor: string; members: string; up: Page[]; rm: string[] }

/** 导入结果：建了几页、上传了几个附件；roots = 落在目标位置的顶层新页 */
export interface ImportResult {
  pages: number
  files: number
  roots: string[]
}

export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  /** true = 临时密码建的号，首次登录被强制改密页拦住 */
  must_change_password: boolean
  /** 头像图片的 files.id；null = 没上传（login / me 带；setup 建号的响应不带，按 null 读） */
  avatar?: string | null
}

// ---------- agent 会话配置项（ACP session config options）----------
// 服务端把 ACP 的 select 变体归一成这个形状（boolean 变体在适配层丢弃）。
// category 决定 UI 摆哪个选择器：'model' = 模型，'thought_level' = 思考程度，其余忽略。

export type ConfigOptionValue = { value: string; name: string; description?: string | null }

export interface ConfigOption {
  id: string
  name: string
  category?: string | null
  currentValue: string
  options: ConfigOptionValue[]
}

/** 运行中排队发送的一条（服务端 agents/send-queue.ts 的 QueueView）：文字只是摘要，图片只给张数 */
export type QueueItem = { id: string; userId: string; username: string; agent: string; kind: 'message' | 'continue'; text: string; images: number; jump: boolean; at: string }

/** agent 的提问（ACP elicitation，form 模式），与服务端 agents/types.ts 的 AskForm 同口径。
 *  带 form 的审批 = 提问：选项固定是 accept（提交，带答案）/ decline（跳过） */
export type AskOption = { value: string; label: string; description?: string }
export type AskField = { key: string; title?: string; description?: string } & (
  | { kind: 'choice'; options: AskOption[]; multi: boolean; min?: number; max?: number; default?: string | string[] }
  | {
      kind: 'text'
      format?: 'email' | 'uri' | 'date' | 'date-time'
      minLength?: number
      maxLength?: number
      pattern?: string
      default?: string
      /** 密码类输入：用密码框 */
      secret?: boolean
    }
  | { kind: 'number'; integer: boolean; min?: number; max?: number; default?: number }
  | { kind: 'boolean'; default?: boolean }
)
export type AskForm = { message: string; fields: AskField[]; required: string[]; toolCallId?: string }
export type AskValue = string | number | boolean | string[]
export type AskContent = Record<string, AskValue>

/** 对话页给 agent 的 Ramet 工具档位（与服务端 agents/tool-profile.ts 同口径）：
 *  none = 只当 UI（不给工具，提示词只有文档正文）、minimal = 读写当前页、full = 全部（缺省） */
export type ToolProfile = 'none' | 'minimal' | 'full'

export function isToolProfile(v: unknown): v is ToolProfile {
  return v === 'none' || v === 'minimal' || v === 'full'
}

/** 执行端目录列表（工作区选择器），形状与服务端 agents/dirs.ts 一致。路径是执行端 realpath 后的绝对路径，
 *  前端不拼路径（connector 可能跑在 Windows） */
export type DirListing = {
  path: string
  parent: string | null
  dirs: Array<{ name: string; path: string }>
  truncated: boolean
}

/** 回收站条目 = 被删子树的根（一次删除 = 一条）；停靠空间的条目按 space_id 前端过滤 */
export interface TrashEntry {
  id: string
  title: string
  space_id: string | null
  /** 原位置：父页（活页面）或 null（空间顶层） */
  parent_id?: string | null
  kind?: Page['kind']
  /** 回收时刻（now()::text，与 created_at 同一格式，relativeTime 可直接吃） */
  deleted_at: string
  icon: PageIcon | null
  /** 随它一起进回收站的子孙 doc 页数 */
  descendants?: number
}

// ---------- 空间与邀请 ----------

export type SpaceRole = 'owner' | 'member' | 'viewer'
/** GET /api/spaces 对 admin 也只回自己参与的空间，所以只有成员角色 */
export type MySpaceRole = SpaceRole

export const SPACE_ROLE_LABELS: Record<SpaceRole, string> = {
  owner: '所有者',
  member: '成员',
  viewer: '只读',
}

export interface Space {
  id: string
  name: string
  owner_id: string
  is_personal: boolean
  created_at: string
  my_role: MySpaceRole
}

export interface SpaceMember {
  user_id: string
  username: string
  role: SpaceRole
  created_at: string
  /** 头像图片的 files.id；null = 没上传 */
  avatar: string | null
}

export interface SpaceInvite {
  token: string
  role: 'member' | 'viewer'
  created_by: string
  created_at: string
}

export interface InvitePreview {
  space_name: string
  space_id: string
  role: 'member' | 'viewer'
  created_by_username: string
  created_at: string
}

/** 删号会发生什么（GET /api/admin/users/:id/delete-impact）：只有数量。
 *  有别的成员的空间转给他们（transferSpaces），只有他一人的空间连同页面删除（purgeSpaces / purgePages） */
export interface DeleteImpact {
  transferSpaces: number
  purgeSpaces: number
  purgePages: number
}

/** 公开子树元数据（匿名可达）：children 同构递归 */
export interface PublicPageTree {
  id: string
  title: string
  /** 页面判别（公开树里只有 doc 与过程页）：只有 doc 页能克隆（复制只带 doc 页） */
  kind: Page['kind']
  icon: PageIcon | null
  children: PublicPageTree[]
}

/** 一轮 run 的 record。时间线按它画，不写进页面正文 */
export interface RunRecord {
  v: 1
  agent: string
  parentId: string
  replyId: string
  startedAt: number
  ms?: number
  outcome: 'end' | 'cancelled' | 'error'
  usage?: TurnUsage
  context?: { used: number; size: number }
  entries: RunEntry[]
  /** 运行期完整用量/上下文/停止原因/ACP 元数据（老记录没有）；顶层 usage/context 优先于它 */
  info?: RunInfo
  /** agent 最后一份计划清单（ACP plan）；没报过计划的轮次没有。回复里的计划卡读回复块的 plan 属性，不读这里 */
  plan?: PlanEntry[]
  /** 带队（/带队）的团队计划与每个任务的状态 / 时段 / 结果摘要；不是带队的轮次没有。过程页的「带队」一节读它 */
  team?: TeamState
  /** 最终 AI 回复正文（文本-only 的轮次也归档）；不进可编辑时间线 */
  output?: string
}

export interface RunDetail {
  record: RunRecord
  page: { id: string; title: string }
  parent: { id: string; title: string } | null
}

/** 公开页文档：data = Yjs 全量状态的 base64。过程页另带 run，时间线按它画 */
export interface PublicPageDoc {
  title: string
  data: string
  /** 页面全宽（与编辑页同一列宽）；旧服务端缺字段 = 否 */
  full_width?: boolean
  run?: RunRecord
  parent?: { id: string; title: string } | null
}

// ---------- 页面快照（版本历史） ----------

export interface PageSnapshot {
  id: string
  /** 快照时的页面标题（取自 Y.Doc title fragment） */
  title: string
  origin: 'auto' | 'manual'
  created_at: string
}

/** 详情：data = Y.encodeStateAsUpdate 全量状态的 base64 */
export interface PageSnapshotDetail extends PageSnapshot {
  data: string
}

// ---------- 页面更新流水 ----------

export type UpdateSummaryKind = 'edit' | 'add' | 'del' | 'title' | 'create'

/** 集合页的属性定义 / 视图变化 */
export type UpdateSchemaOp = 'prop_add' | 'prop_del' | 'prop_edit' | 'view_add' | 'view_del' | 'view_edit'

export type UpdateSummaryItem =
  | {
      kind: UpdateSummaryKind
      /** 块文字预览（服务端截 ~80 字符）；create 恒为空串 */
      text: string
    }
  /** 集合的行改了一个属性：原始值（null = 空；字符串截 ~80 字符），名字与值的文字按当前属性定义解读 */
  | { kind: 'prop'; prop: string; from: unknown; to: unknown }
  /** 集合页的属性定义 / 视图变化：text = 名字（删除取旧名） */
  | { kind: 'schema'; op: UpdateSchemaOp; text: string }

/** 一条更新 = 一条快照 vs 其上一条的块级差异摘要（服务端已按时间倒序） */
export interface UpdateEntry {
  id: string
  title: string
  origin: 'auto' | 'manual'
  created_at: string
  /** 老快照/未知编辑者为 null */
  author_id: string | null
  author_username: string | null
  /** user = 这个人打的；agent = AI 写的（名字用 actor_agent 去目录里对） */
  actor: 'user' | 'agent'
  /** catalog id；actor 为 user 时为 null */
  actor_agent: string | null
  /** 服务端每条截 20 项；summary_total 是截断前的真实项数 */
  summary: UpdateSummaryItem[]
  summary_total: number
}

/** 上次编辑的一条标记（整页或某块）；人名 / 头像在 EditMarks.users 里 */
export interface EditMark {
  /** ISO 时间 */
  at: string
  /** 删号后为 null */
  user_id: string | null
  /** user = 这个人改的；agent = AI 写的（名字用 actor_agent 去目录里对） */
  actor: 'user' | 'agent'
  actor_agent: string | null
}

/** GET /api/pages/:id/edit-marks：整页 + 全部块的上次编辑（进页面预取，edit-marks-store.ts） */
export interface EditMarks {
  /** avatar 为 null = 没上传，或编辑者已不在该页所在空间（头像只给有共同空间的人看） */
  users: Record<string, { username: string; avatar: string | null }>
  /** 老页面没有精确记录时是最新一条版本快照；都没有为 null */
  page: EditMark | null
  /** 块 id → 标记；没有记录的块不在里面 */
  blocks: Record<string, EditMark>
}

// ---------- 树：目录树注册行 + 空间派生的页面树 ----------
// GET /api/boards 一次回扁平三数组（目录树行 / 目录 / 条目），前端按 parent_id / folder_id 组树。
// boards 表只登记「空间目录树」一行（一空间至多一行），按需惰性落库。
// 页面树不是实体：它是该空间 pages 按 parent_id 组成的森林，没有行、不可建、不可删。
// 两棵树的名字固定为「页面树」「目录树」，不存储。

export interface Board {
  id: string
  /** 目录树必属一个空间（无游离目录树） */
  space_id: string
  created_at: string
}

/** 虚拟目录：目录树内嵌套（parent_id），删除走服务端级联（子目录与条目挂载一起消失） */
export interface BoardFolder {
  id: string
  board_id: string
  parent_id: string | null
  name: string
  position: number | null
  created_at: string
}

/** 挂进目录的条目。kind=page：item_id = 页面 id，带 title/icon（垃圾箱页不入树，服务端过滤）；
 *  kind=file：item_id = 文件 id，带 name/mime。(kind, item_id) 全局唯一 = 单一归属 */
export interface BoardItem {
  id: string
  board_id: string
  /** null = 挂在目录树顶层（根级条目）；非空 = 所属目录 id */
  folder_id: string | null
  kind: 'page' | 'file'
  item_id: string
  created_at: string
  title: string | null
  icon: PageIcon | null
  name: string | null
  mime: string | null
}

export interface BoardsPayload {
  boards: Board[]
  folders: BoardFolder[]
  items: BoardItem[]
}

/** 会话失效回调：AuthProvider 注册，任意请求 401 时清本地态回登录页 */
let onUnauthorized: (() => void) | null = null

// ---------- agent 交互层 ----------

/** 权限姿态（GET /api/agents）：owner = 当前用户是不是这台机器的（connector）主人；
 *  modes = 该 agent 的 mode 项能不能改（表外 agent 不可改）；unrestricted = 「跳过全部确认」档的
 *  mode 值。服务端是唯一判定方，前端只据此禁用/隐藏。 */
export interface AgentPosture {
  owner: boolean
  modes: boolean
  unrestricted: string[]
}

export interface AgentInfo {
  id: string
  label: string
  logo?: string
  /** 缺省 = 未提供（ConnectorSummary.agents 复用本形状但不带姿态） */
  posture?: AgentPosture
  /** 我对这台机器有 machine 范围的使用权（接入人或有效授权）：项目面板入口的依据；本机 agent 恒为 false。
   *  缺省 = 未提供（ConnectorSummary.agents 不带） */
  machine?: boolean
}

/** 本地 connector（托管云拓扑）：出站连中心的 agent 宿主机；online 来自中心进程内状态 */
export interface ConnectorSummary {
  id: string
  name: string
  agents: AgentInfo[]
  online: boolean
  created_at: string
  last_seen_at: string | null
  /** pending = 成员接入、等空间所有者批准（任何人都用不了）；approved = 已在空间里生效 */
  status: 'pending' | 'approved'
  /** 接入人的用户名；老 connector / 账号已删 = null */
  owner: string | null
  /** 我是不是接入人 */
  mine: boolean
}

/** 浏览器确认配对页（/connect/:code）看到的待接入机器：connector 申请时自报的信息，不含任何凭据 */
export interface ConnectPreview {
  /** 校验码（XXXX-XXXX），与机器终端里打印的对照 */
  code: string
  name: string
  defaultCwd: string
  agents: Array<{ id: string; label: string }>
  expiresAt: string
}

/** 搜索命中：跳转只需 id，snippet 供下拉预览 */
export interface SearchHit {
  id: string
  title: string
  snippet?: string
  icon: PageIcon | null
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

/** 不走 request() 的直连请求（SSE 流等）遇到 401 时通知登录态失效 */
export function notifyUnauthorized(): void {
  onUnauthorized?.()
}

/** 历史（版本列表 / 更新流水）一页条数：两个面板共用，服务端上限 200 */
export const HISTORY_PAGE = 50

/** 历史窗口查询串：limit 是服务端窗口契约（版本永不删除，没有「全量」这条路），before/around 互斥 */
function historyQuery({ limit, before, around }: { limit: number; before?: string; around?: string }): string {
  const q = new URLSearchParams({ limit: String(limit) })
  // created_at 是 'YYYY-MM-DD HH:MM:SS.ffffff+00'，URLSearchParams 会把空格/+ 正确编码
  if (before) q.set('before', before)
  if (around) q.set('around', around)
  return q.toString()
}

/** request() 的失败：带 HTTP status，调用方才能区分 404（已处理完，静默）与 403/409（要给人看）。
 *  message 优先取服务端的人话。 */
export class ApiError extends Error {
  status: number
  /** 服务端的短码（body.error，如 'conflict' / 'machine offline'）：同一个状态码下要分情况处理时用 */
  code: string
  constructor(message: string, status: number, code = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    // REST 端点都是按需重拉：响应不带缓存头会被浏览器启发式缓存，刷新后拿到陈旧 200，统一禁掉
    cache: 'no-store',
    ...init,
  })
  // 401 = 会话无效/过期；登录接口除外（那里的 401 是密码错，由表单展示）
  if (res.status === 401 && path !== '/api/auth/login') {
    onUnauthorized?.()
    throw new ApiError(`${init?.method ?? 'GET'} ${path} → 401`, 401)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
    // message 是人话（如「该页面已有 agent 正在生成」），error 是短码（busy/unknown agent）；
    // 展示层直接用 err.message，优先给人话
    throw new ApiError(
      body?.message ?? body?.error ?? `${init?.method ?? 'GET'} ${path} → ${res.status}`,
      res.status,
      body?.error ?? '',
    )
  }
  // 空响应体（如部分 DELETE 返回空串）容错为 {}
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

/** 收藏（只有自己可见）：对象 = 整页（blockId null）或一个块。gone = 原块 / 原页看不到了，text 是存档 */
export interface FavoriteView {
  id: string
  pageId: string
  /** 所在页的空间：侧栏只列当前空间的收藏（null = 归不了位的老收藏，哪儿都不列） */
  spaceId: string | null
  blockId: string | null
  blockType: string
  text: string
  title: string
  gone: boolean
  createdAt: string
}

/** 反向链接：哪些页面 / 块引用了本页（kind：mention 提及 · quote 块提及 · sync 同步块 · link 站内链接） */
export interface BacklinkBlock {
  blockId: string
  text: string
  kind: 'mention' | 'quote' | 'sync' | 'link'
  /** 被引用的块（'' = 整页） */
  targetBlockId: string
}
export interface Backlink {
  pageId: string
  title: string
  blocks: BacklinkBlock[]
}

export interface ExportPage {
  id: string
  parentId: string | null
  title: string
  createdAt: string
  /** Yjs 全量状态（base64） */
  state: string
}

export const api = {
  listPages: () => request<Page[]>('/api/pages'),
  /** 增量同步页面列表：cursor / members 是上一次响应带回的（没有就整表） */
  syncPages: (since: { cursor: string; members: string } | null) =>
    request<PageSync>(
      since
        ? `/api/pages/sync?${new URLSearchParams({ since: since.cursor, members: since.members }).toString()}`
        : '/api/pages/sync',
    ),
  createPage: (
    parent_id: string | null = null,
    space_id?: string | null,
    opts?: { in_page_tree?: boolean; title?: string },
  ) =>
    request<Page>('/api/pages', {
      method: 'POST',
      // space_id 缺省（undefined）由服务端落到个人空间。in_page_tree false = 目录树自建文档，不进页面树。
      // title：服务端建页时就把标题写进库与文档（`[[新名字` 直接建页用，省得客户端再补两步）
      body: JSON.stringify({ parent_id, space_id, in_page_tree: opts?.in_page_tree, title: opts?.title }),
    }),
  /** 导入 markdown（.md / .zip；文件夹由调用方先打成 zip）：multipart，不走 JSON request() */
  importMarkdown: async (spaceId: string, file: Blob, name: string, parentId: string | null): Promise<ImportResult> => {
    const form = new FormData()
    form.append('file', file, name)
    if (parentId) form.append('parent', parentId)
    const res = await fetch(`/api/spaces/${spaceId}/import`, { method: 'POST', body: form })
    if (res.status === 401) onUnauthorized?.()
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(body?.error ?? `导入失败（${res.status}）`, res.status)
    }
    return (await res.json()) as ImportResult
  },
  /** 从模板新建：复制模板页（连子页）到目标空间 / 父页下 */
  instantiateTemplate: (templateId: string, spaceId: string, parentId: string | null) =>
    request<{ id: string }>(`/api/pages/${templateId}/instantiate`, {
      method: 'POST',
      body: JSON.stringify({ space_id: spaceId, parent_id: parentId }),
    }),
  setTemplate: (id: string, on: boolean) =>
    request<Page>(`/api/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ is_template: on }) }),
  /** 全宽开关（页面属性：协作者与公开页同看；viewer 403） */
  setFullWidth: (id: string, on: boolean) =>
    request<Page>(`/api/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ full_width: on }) }),
  renamePage: (id: string, title: string) =>
    request<Page>(`/api/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  /** 挪父级/排序（树上拖拽）：同空间 + 防环校验在服务端（parent 不可见/跨空间 400，自环 400）；
   *  index = 目标父页子列表落点下标（缺省 = 服务端不重排，保持原 position） */
  movePage: (id: string, parent_id: string | null, index?: number) =>
    request<Page>(
      `/api/pages/${id}`,
      { method: 'PATCH', body: JSON.stringify(index === undefined ? { parent_id } : { parent_id, index }) },
    ),
  /** 设/换/清页面图标。icon = null 即移除；服务端校验（emoji 长度、图片必须存在且是图片），
   *  失败抛错（400），调用方原样展示 err.message */
  setPageIcon: (id: string, icon: PageIcon | null) =>
    request<Page>(`/api/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ icon }) }),
  /** 彻底删除（物理清内容与版本历史）：回收站里的「永久删除」与 link-watcher 的自动清理走这里。
   *  用户删页走 trashPage（可恢复） */
  deletePage: (id: string) =>
    request<{ deleted: string[] }>(`/api/pages/${id}`, { method: 'DELETE' }),
  /** 移入回收站（软删）：正文与版本历史原样保留，可由 listTrash/restorePage 找回 */
  trashPage: (id: string) =>
    request<{ trashed: string[] }>(`/api/pages/${id}/trash`, { method: 'POST' }),
  /** 回收站条目（整棵被删子树的根）；服务端按可见性给全量，前端按当前空间筛 */
  listTrash: () => request<TrashEntry[]>('/api/pages/trash'),
  /** 恢复条目及其整棵子树 */
  restorePage: (id: string) =>
    request<{ restored: string[] }>(`/api/pages/${id}/restore`, { method: 'POST' }),
  /** 清空某空间的回收站（物理删除该空间全部条目） */
  emptyTrash: (spaceId: string) =>
    request<{ purged: string[] }>(`/api/pages/trash?space_id=${encodeURIComponent(spaceId)}`, {
      method: 'DELETE',
    }),
  /** 块文本快照（区块链接「提及」用）；无权限/块已删 → 服务端 404 → request 抛错 */
  fetchBlockText: (pageId: string, blockId: string) =>
    request<{ text: string }>(`/api/pages/${pageId}/blocks/${blockId}`),

  /** 导出：这一页和它的子页（活的文档页）的 Yjs 全量状态，前端用编辑器自己的序列化转 markdown */
  exportPage: (pageId: string) =>
    request<{ pages: ExportPage[]; truncated: boolean }>(`/api/pages/${pageId}/export`),
  listFavorites: () => request<FavoriteView[]>('/api/favorites'),
  /** 收藏一页（不传 blockId）或一个块；幂等 */
  addFavorite: (pageId: string, blockId?: string) =>
    request<{ id: string }>('/api/favorites', { method: 'POST', body: JSON.stringify({ pageId, blockId }) }),
  removeFavorite: (id: string) => request<unknown>(`/api/favorites/${id}`, { method: 'DELETE' }),
  backlinks: (pageId: string) => request<{ backlinks: Backlink[]; total: number }>(`/api/pages/${pageId}/backlinks`),

  /** 触发 agent 继续生成。team = 计划 id：带队的执行轮（开工），服务端先同步预检再 202（team/team-send.ts） */
  continuePage: (id: string, agent?: string, team?: string) =>
    request<unknown>(`/api/pages/${id}/continue`, { method: 'POST', body: JSON.stringify({ agent, ...(team ? { team } : {}) }) }),

  /** 中止 agent 运行（SSE status 切 running 时可用） */
  stopPage: (id: string) => request<unknown>(`/api/pages/${id}/stop`, { method: 'POST' }),

  /** 停止 agent 在 ACP 终端里跑的一条命令（只停这条，不停整轮）。{ ok: false } = 没有这条在跑的命令 */
  stopCommand: (id: string, terminalId: string) =>
    request<{ ok: boolean }>(`/api/pages/${id}/stop-command`, { method: 'POST', body: JSON.stringify({ terminalId }) }),

  /** 重新生成/重试：原地重跑该回复。404 回复不存在、400 无前置用户消息/agent 不可用、409 页面忙 */
  regenerate: (pageId: string, replyId: string) =>
    request<unknown>(`/api/pages/${pageId}/replies/${replyId}/regenerate`, { method: 'POST' }),

  /** 回答 agent 权限审批。requestId 只在单个 agent 进程内唯一（两个 agent 都有 perm-0），
   *  身份是 agentId + requestId；optionId = null 表示拒绝/取消。
   *  提问（带 form）：optionId = 'accept' + content（答案）/ 'decline'（跳过）；答案不合表单 → 400，message 是原因 */
  respondPermission: (id: string, agentId: string, requestId: string, optionId: string | null, content?: AskContent) =>
    request<unknown>(`/api/pages/${id}/permission`, {
      method: 'POST',
      body: JSON.stringify({ agentId, requestId, optionId, ...(content ? { content } : {}) }),
    }),

  /** 运行中排队发送：在跑时发的消息先排着，这一轮正常结束后由服务端写进文档并发起下一轮。
   *  message = 带文字 / 图片（文件地址）；continue = 文档模式（消息已在文档里，只继续）。页面空着时服务端直接发 */
  enqueue: (id: string, body: { agent: string; kind: 'message' | 'continue'; text?: string; images?: string[] }) =>
    request<{ item: QueueItem }>(`/api/pages/${id}/queue`, { method: 'POST', body: JSON.stringify(body) }),
  /** 撤回自己排的（文字 / 图片还给输入框） */
  withdrawQueued: (id: string, itemId: string) => request<{ text: string; images: string[] }>(`/api/pages/${id}/queue/${itemId}`, { method: 'DELETE' }),
  /** 立即发送自己排的：在跑就停下当前这一轮后马上发 */
  sendQueuedNow: (id: string, itemId: string) => request<unknown>(`/api/pages/${id}/queue/${itemId}/now`, { method: 'POST' }),

  /** 切换会话配置项（模型/思考程度等）；返回该会话最新的完整配置项集合 */
  setAgentConfig: (id: string, body: { agent: string; configId: string; value: string }) =>
    request<{ options: ConfigOption[] }>(`/api/pages/${id}/agent-config`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 预备会话：选 agent 时调一次，好让模型/思考程度等配置项立刻可选（结果走 SSE，不取返回值） */
  prepareAgent: (id: string, agent: string) =>
    request<{ options: ConfigOption[] }>(`/api/pages/${id}/agent-prepare`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),

  /** 列该 agent 执行端的目录（工作区选择器）；path 省略 = 当前生效工作区 */
  listAgentDirs: (id: string, params: { agent: string; path?: string }) =>
    request<DirListing>(
      `/api/pages/${id}/agent-dirs?agent=${encodeURIComponent(params.agent)}` +
        (params.path ? `&path=${encodeURIComponent(params.path)}` : ''),
    ),

  /** 指定/清除工作区（cwd 空串 = 回到执行端默认）；返回生效值。会话作废/重建由服务端按 cwd 判定 */
  setAgentCwd: (id: string, body: { agent: string; cwd: string }) =>
    request<{ cwd: string }>(`/api/pages/${id}/agent-cwd`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 本页的工具档位（页面级，协作者共享；结果也经 SSE 的 tool_profile 事件广播）。换档后下一轮服务端新建会话、全文重放 */
  setAgentTools: (id: string, profile: ToolProfile) =>
    request<{ ok: true }>(`/api/pages/${id}/agent-tools`, {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),

  /** 记住本页的来源（页面级，协作者共享；结果也经 SSE 的 choice 事件广播） */
  setAgentChoice: (id: string, agent: string) =>
    request<{ ok: true }>(`/api/pages/${id}/agent-choice`, {
      method: 'POST',
      body: JSON.stringify({ agent }),
    }),

  /** 全文搜索（侧栏搜索框）；includeAgent = 连 agent 工具调用过程页一起搜（默认不搜） */
  search: (q: string, includeAgent = false) =>
    request<SearchHit[]>(
      `/api/search?q=${encodeURIComponent(q)}${includeAgent ? '&include=agent' : ''}`,
    ),

  /** agent 列表（本机 + 在线 connector） */
  listAgents: () => request<AgentInfo[]>('/api/agents'),

  // ---------- 本地 connector（设置 → 连接器） ----------

  /** 浏览器确认配对（connector start 打印的 /connect/:code）：待接入机器的信息；链接无效 / 已用 / 机器已断开 → 404 */
  connectPreview: (code: string) => request<ConnectPreview>(`/api/connect/${encodeURIComponent(code)}`),
  /** 确认接入 spaceId（owner / member）：我成为机器主人；成员接入是 pending，要空间所有者批准。token 经机器自己的连接下发，这里拿不到 */
  confirmConnect: (code: string, spaceId: string) =>
    request<{ connectorId: string; spaceId: string; status: 'pending' | 'approved' }>(
      `/api/connect/${encodeURIComponent(code)}/confirm`,
      { method: 'POST', body: JSON.stringify({ spaceId }) },
    ),
  /** 拒绝：机器上的命令收到后退出 */
  rejectConnect: (code: string) => request<unknown>(`/api/connect/${encodeURIComponent(code)}/reject`, { method: 'POST' }),
  listConnectors: (spaceId: string) =>
    request<ConnectorSummary[]>(`/api/connectors?space=${encodeURIComponent(spaceId)}`),
  revokeConnector: (id: string) => request<unknown>(`/api/connectors/${id}`, { method: 'DELETE' }),
  /** 空间所有者批准成员接入的机器（pending → approved） */
  approveConnector: (id: string) => request<unknown>(`/api/connectors/${id}/approve`, { method: 'POST' }),
  /** 空间所有者拒绝（= 删除并断开） */
  rejectConnector: (id: string) => request<unknown>(`/api/connectors/${id}/reject`, { method: 'POST' }),

  /** 历史版本列表（倒序分页）；limit 必带：服务端窗口有上限，版本永不删除所以没有「全量」这条路。
   *  before = 上一页最后一条的 created_at（续拉更早）；around = 以该快照为中心的窗口（时钟跳转定位）。
   *  窗口比展示多一条：调用方把最后一条留作最旧展示行的对比基线 */
  listSnapshots: (id: string, params: { limit: number; before?: string; around?: string }) =>
    request<PageSnapshot[]>(`/api/pages/${id}/snapshots?${historyQuery(params)}`),
  getSnapshot: (id: string, sid: string) =>
    request<PageSnapshotDetail>(`/api/pages/${id}/snapshots/${sid}`),
  /** 手动存版；viewer 会被服务端 403 */
  createSnapshot: (id: string) =>
    request<PageSnapshot>(`/api/pages/${id}/snapshots`, { method: 'POST' }),
  /** 更新流水（快照链相邻对的块级 diff 摘要，倒序）；viewer 可读。limit 必带；
   *  before = 上一页最后一条的 created_at（续拉更早） */
  listUpdates: (id: string, params: { limit: number; before?: string }) =>
    request<UpdateEntry[]>(`/api/pages/${id}/updates?${historyQuery(params)}`),
  /** 整页 + 全部块的上次编辑；viewer 可读 */
  editMarks: (id: string) => request<EditMarks>(`/api/pages/${id}/edit-marks`),
  /** 公开/收回公开；仅空间 owner（其余 403）。
   *  includeRuns = 公开时是否连 agent 工具调用过程页一起公开（默认否，过程里有本地路径与命令） */
  setPublished: (id: string, published: boolean, includeRuns?: boolean) =>
    request<Page>(`/api/pages/${id}/publish`, {
      method: 'PATCH',
      body: JSON.stringify(includeRuns === undefined ? { published } : { published, includeRuns }),
    }),

  // ---------- 公开页（免登录） ----------

  publicTree: (id: string) => request<PublicPageTree>(`/api/public/pages/${id}`),
  publicDoc: (id: string) => request<PublicPageDoc>(`/api/public/pages/${id}/doc`),
  /** 过程页的 record（时间线）。404 = 不可见 */
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  /** 克隆公开子树进自己个人空间；返回新根页面 id。需登录（匿名 401） */
  clonePublicPage: (id: string) =>
    request<{ id: string }>(`/api/public/pages/${id}/clone`, { method: 'POST' }),

  listSpaces: () => request<Space[]>('/api/spaces'),
  createSpace: (name: string) =>
    request<Space>('/api/spaces', { method: 'POST', body: JSON.stringify({ name }) }),
  renameSpace: (id: string, name: string) =>
    request<Space>(`/api/spaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteSpace: (id: string) => request<unknown>(`/api/spaces/${id}`, { method: 'DELETE' }),
  listSpaceMembers: (id: string) => request<SpaceMember[]>(`/api/spaces/${id}/members`),
  /** 改成员角色（member ⇄ viewer），owner 才行；owner 的角色不可改 */
  setSpaceMemberRole: (id: string, userId: string, role: 'member' | 'viewer') =>
    request<SpaceMember>(`/api/spaces/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  /** 按用户名直接拉人进空间（不走邀请链接）：404 没这个用户，409 已经是成员 */
  addSpaceMember: (id: string, username: string, role: 'member' | 'viewer') =>
    request<SpaceMember>(`/api/spaces/${id}/members`, { method: 'POST', body: JSON.stringify({ username, role }) }),
  /** userId = 自己即退出空间（viewer/member 可用）；移除他人需 owner */
  removeSpaceMember: (id: string, userId: string) =>
    request<unknown>(`/api/spaces/${id}/members/${userId}`, { method: 'DELETE' }),
  createInvite: (id: string, role: 'member' | 'viewer') =>
    request<SpaceInvite>(`/api/spaces/${id}/invites`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),
  listSpaceInvites: (id: string) => request<SpaceInvite[]>(`/api/spaces/${id}/invites`),
  revokeInvite: (token: string) => request<unknown>(`/api/invites/${token}`, { method: 'DELETE' }),
  invitePreview: (token: string) => request<InvitePreview>(`/api/invites/${token}`),
  acceptInvite: (token: string) =>
    request<{ space_id: string; role: 'member' | 'viewer' }>(`/api/invites/${token}/accept`, {
      method: 'POST',
    }),

  // ---------- admin：账号管理（admin 看不到别人的空间，只拿删号影响的数量） ----------

  adminDeleteImpact: (userId: string) => request<DeleteImpact>(`/api/admin/users/${userId}/delete-impact`),

  login: (username: string, password: string) =>
    request<User>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
  changePassword: (new_password: string) =>
    request<unknown>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ new_password }),
    }),
  me: () => request<User>('/api/auth/me'),
  /** 设置 / 清除自己的头像：fileId = 已上传的图片（POST /api/files），null = 回到默认头像 */
  setAvatar: (fileId: string | null) =>
    request<{ avatar: string | null }>('/api/auth/avatar', { method: 'PUT', body: JSON.stringify({ file_id: fileId }) }),
  setupStatus: () => request<{ needed: boolean }>('/api/setup/status'),
  setupAdmin: (username: string, password: string) =>
    request<User>('/api/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // ---------- 树 ----------

  /** 我是成员的空间的目录树。目录树行按需惰性落库（新空间 0 行），页面树无实体、无端点 */
  listBoards: () => request<BoardsPayload>('/api/boards'),
  /** 惰性补建该空间目录树行：幂等（新建 201 / 已存在 200），viewer 403、非成员 404 */
  createDirTree: (spaceId: string) =>
    request<{ board: Board }>(`/api/spaces/${spaceId}/dir-tree`, { method: 'POST' }),
  /** 删目录树：整棵树里挂的页面移入回收站（可恢复），文件条目只脱挂；回被回收的页面 id 集 */
  deleteBoard: (id: string) => request<{ trashed: string[] }>(`/api/boards/${id}`, { method: 'DELETE' }),
  /** parent_id 省略 = 根目录；parent 必须属于同一目录树（服务端校验） */
  createFolder: (boardId: string, parent_id: string | null, name: string) =>
    request<BoardFolder>(`/api/boards/${boardId}/folders`, {
      method: 'POST',
      body: JSON.stringify({ parent_id, name }),
    }),
  /** 改名 / 挪父级+排序（树上拖拽）。换父的防环（父落进自己子树）服务端递归 CTE 兜底；
   *  index = 目标父目录子列表落点下标（缺省 = 不重排，保持原 position） */
  renameFolder: (id: string, name: string) =>
    request<BoardFolder>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  moveFolder: (id: string, parent_id: string | null, index?: number) =>
    request<BoardFolder>(
      `/api/folders/${id}`,
      { method: 'PATCH', body: JSON.stringify(index === undefined ? { parent_id } : { parent_id, index }) },
    ),
  /** 删目录：子树里挂的页面移入回收站（可恢复），文件条目只脱挂；回被回收的页面 id 集 */
  deleteFolder: (id: string) => request<{ trashed: string[] }>(`/api/folders/${id}`, { method: 'DELETE' }),
  /** 挂载条目（kind=page|file，item_id = 本体 id）。已挂他处 = 移动（服务端 UPDATE folder_id） */
  attachItem: (folderId: string, kind: 'page' | 'file', item_id: string) =>
    request<BoardItem>(`/api/folders/${folderId}/items`, {
      method: 'PUT',
      body: JSON.stringify({ kind, item_id }),
    }),
  /** 挂载到目录树顶层（folder_id NULL 根级条目），语义同 attachItem */
  attachItemRoot: (boardId: string, kind: 'page' | 'file', item_id: string) =>
    request<BoardItem>(`/api/boards/${boardId}/items`, {
      method: 'PUT',
      body: JSON.stringify({ kind, item_id }),
    }),
  /** 条目移动/排序（拖拽）：folder_id null = 目录树顶层根级；index = 同目录条目列表落点下标
   *  （缺省 = 不重排保持原 position，纯挪目录） */
  moveItem: (id: string, folder_id: string | null, index?: number) =>
    request<BoardItem>(`/api/folder-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(index === undefined ? { folder_id } : { folder_id, index }),
    }),
  /** 脱挂（页面/文件本体不受影响） */
  detachItem: (id: string) => request<unknown>(`/api/folder-items/${id}`, { method: 'DELETE' }),
}
