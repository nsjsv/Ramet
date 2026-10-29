/* ---------- TG 图床客户端（MarSeventh/CloudFlare-ImgBed） ----------
 * 只管和图床说话（上传 / 回读），不碰数据库；队列、校验、断路器在 imgbed-sync.ts。
 *
 * 配置（缺一 = 功能关闭，读入口照旧本地出）：
 * - RAMET_IMGBED_URL：上传、回读、健康探测用。用 workers.dev 而不是展示域名：域名的账户级 WAF 会质询
 *   HTTP/1.1，而 Node fetch 就是 HTTP/1.1
 * - RAMET_IMGBED_TOKEN：图床后台建的 API Token（upload 权限），走 Authorization: Bearer
 * - RAMET_IMGBED_PUBLIC_URL：302 的目标（自定义展示域名；workers.dev 在大陆被 DNS 污染），缺省同 URL
 *
 * 上传参数是硬约束：serverCompress=false 让图床对所有图片走 TG sendDocument（不压缩，原字节进 TG），
 * 任何一份都不许被 TG 压缩（不可逆）；autoRetry=false 不让它悄悄换渠道；
 * uploadNameType=origin 用请求里给的文件名（uuid，不可枚举，与本地同一条权限边界）。 */

export type ImgbedConfig = { url: string; token: string; publicUrl: string }

const UPLOAD_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, '')
}

// 超时与关停共用一个信号：dispose 时在飞的请求立刻断，不让关停等满一分钟
function within(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

export function imgbedFromEnv(env: NodeJS.ProcessEnv = process.env): ImgbedConfig | null {
  const url = trimSlash(env.RAMET_IMGBED_URL ?? '')
  const token = env.RAMET_IMGBED_TOKEN?.trim() ?? ''
  if (!url || !token) return null
  return { url, token, publicUrl: trimSlash(env.RAMET_IMGBED_PUBLIC_URL ?? '') || url }
}

/** 上传一份字节，回图床的访问路径（`/file/ramet/<name>`）。非 2xx / 返回形状不对一律抛错 */
export async function uploadToBed(cfg: ImgbedConfig, data: Buffer, name: string, type: string, signal?: AbortSignal): Promise<string> {
  const qs = new URLSearchParams({
    uploadChannel: 'telegram',
    serverCompress: 'false',
    autoRetry: 'false',
    uploadNameType: 'origin',
    uploadFolder: 'ramet',
    returnFormat: 'default',
  })
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type }), name)
  const res = await fetch(`${cfg.url}/upload?${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}` },
    body: form,
    signal: within(UPLOAD_TIMEOUT_MS, signal),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`上传 ${res.status}: ${text.slice(0, 200)}`)
  let src: unknown
  try {
    src = (JSON.parse(text) as Array<{ src?: unknown }>)[0]?.src
  } catch {
    // 落到下面统一报形状不对
  }
  if (typeof src !== 'string' || !src.startsWith('/file/')) throw new Error(`上传返回形状不对: ${text.slice(0, 200)}`)
  return src
}

/** 从图床读回一份（回读校验 / 健康探测）。不带 Referer：图床的防盗链只看 Referer，服务端请求不受它影响 */
export async function fetchFromBed(cfg: ImgbedConfig, path: string, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<Buffer> {
  const res = await fetch(`${cfg.url}${path}`, { signal: within(timeoutMs, signal) })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`读取 ${res.status}`)
  }
  return Buffer.from(await res.arrayBuffer())
}
