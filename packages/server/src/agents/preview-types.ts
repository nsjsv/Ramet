// ---------- 端口预览：中心 ↔ connector 之间的帧形状、上限与两端共用的小工具 ----------
// 预览 = 把 connector 所在机器上的开发服务器（127.0.0.1:<端口>）经 connector 的 WSS 中继转给浏览器看。
// 中心不碰用户机器的网络，只鉴权、转发字节；connector 只连 127.0.0.1:<该预览登记的端口>（帧里没有主机名字段，
// 也不接受），每个 http / ws 帧都按 previewId 找到共享记录，用记录里的共享人（actor）再过一遍本机名单（machine 范围）。
// 帧本身都是 machine 范围的驱动帧（protocol.ts 的 DRIVEN_SCOPE），署名人是共享人：预览对页面读者开放的依据是主人显式共享。

/** hello 里的能力标记：老 connector 没有 → 中心对它回 409，不发预览帧 */
export const PREVIEW_CAP = 'preview'

export const PREVIEW_PORT_MIN = 1024
export const PREVIEW_PORT_MAX = 65535
/** 每台机器同时共享的预览上限（中心与 connector 各查一次） */
export const PREVIEW_MAX_PER_MACHINE = 5
/** 单个请求体上限（超了拒绝，不转发） */
export const PREVIEW_REQ_BODY_MAX = 10 * 1024 * 1024
/** 单个响应体上限（声明超了直接拒绝；没声明长度的流式响应超了就截断并掐掉连接） */
export const PREVIEW_RES_BODY_MAX = 50 * 1024 * 1024
/** 这台机器上同时在转的 HTTP 请求 / WebSocket 连接上限（中心与 connector 各查一次） */
export const PREVIEW_MAX_INFLIGHT = 32
export const PREVIEW_MAX_WS = 8
/** 响应 / 请求体按这个大小切片（原始字节数；上链路时 base64，约 +33%） */
export const PREVIEW_CHUNK_BYTES = 64 * 1024
/** 单条 WebSocket 消息上限 */
export const PREVIEW_WS_MSG_MAX = 1024 * 1024
/** 上游多久不给响应头就放弃（开发服务器首次编译可能很慢，但不能无限等） */
export const PREVIEW_HEADER_TIMEOUT_MS = 60_000
/** 响应体 / 连接多久一个字节都没动就放弃 */
export const PREVIEW_IDLE_TIMEOUT_MS = 5 * 60_000
/** 中心给 connector 多留的时间：connector 自己的超时先触发并带着原因回来 */
export const PREVIEW_CENTER_GRACE_MS = 15_000

/** 一对一对的头（保序、允许重复，set-cookie 不会被合并） */
export type HeaderPairs = Array<[string, string]>

/** 预览请求允许的方法 */
export const PREVIEW_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

// ---------- 校验 ----------

export function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PREVIEW_PORT_MIN && value <= PREVIEW_PORT_MAX
}

/** 预览入口路径：以单个 `/` 开头（`//host`、`/\host` 浏览器会当成别的主机，即开放重定向），不含空白 / 控制字符 / 反斜杠 */
export function validPreviewPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2000 && /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(value)
}

/** 转发给上游的请求目标（path + query）：以 `/` 开头、不含空白 / 控制字符（含的话 Node 会抛错，或者被拿来走私请求） */
export function validRequestTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192 && /^\/[^\s\u0000-\u001f\u007f]*$/.test(value)
}

// ---------- cookie：Ramet 自己的 cookie 不能出现在预览里 ----------
// cookie 不分端口：同主机的预览源会收到 Ramet 的登录 cookie。所以转发给机器的请求里必须剥掉 Ramet 的（`ramet_` 前缀：
// 登录会话 `ramet_session`、预览会话 `ramet_pv`，以后新增的也自动覆盖）；预览响应想设置同名 cookie（覆盖登录态 / 会话固定）也一律丢掉。

export const isRametCookieName = (name: string): boolean => name.trim().toLowerCase().startsWith('ramet_')

/** 请求的 Cookie 头：去掉 Ramet 的，其余原样保留；剩下空的返回 null（连头一起不发） */
export function stripRametCookies(header: string): string | null {
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !isRametCookieName(part.split('=')[0] ?? ''))
  return kept.length > 0 ? kept.join('; ') : null
}

/** 响应的一条 Set-Cookie 是不是在设 Ramet 的 cookie */
export const setsRametCookie = (setCookie: string): boolean => isRametCookieName(setCookie.split('=')[0] ?? '')

// ---------- 头 ----------

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
])
export const isHopHeader = (name: string): boolean => HOP_BY_HOP.has(name.toLowerCase())

/** 头的数量 / 大小上限（防止一个请求把帧撑到离谱） */
export const PREVIEW_HEADERS_MAX = 100
export const PREVIEW_HEADERS_BYTES = 64 * 1024

/** 校验一份来自对端的头：形状对、数量与大小在限内，不合格返回 null */
export function cleanPairs(value: unknown): HeaderPairs | null {
  if (!Array.isArray(value) || value.length > PREVIEW_HEADERS_MAX) return null
  const out: HeaderPairs = []
  let bytes = 0
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') return null
    bytes += item[0].length + item[1].length
    if (bytes > PREVIEW_HEADERS_BYTES) return null
    out.push([item[0], item[1]])
  }
  return out
}

/** 合法的 WebSocket 关闭码（`ws` 的 close() 对不合法的码直接抛错） */
export function wsCloseCode(code: unknown): number {
  if (typeof code !== 'number' || !Number.isInteger(code)) return 1000
  if (code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)) return code
  return code >= 3000 && code <= 4999 ? code : 1000
}

/** connector 拒绝 / 失败（登记阶段）：message 是人话；forbidden 表示署名人不被允许（回 err code='forbidden'） */
export class PreviewDenied extends Error {
  constructor(
    message: string,
    readonly forbidden = false,
  ) {
    super(message)
  }
}
