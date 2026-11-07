// ---------- Ramet MCP 进程的公共部分（纯 JS，connector 那台机器只有 node）----------
// 只有两个环境变量：中心地址与一把凭证（page-read.ts 签发，绑着哪一页上的哪个 agent）。
// 工具按模块拆在 ./tools/*.mjs，每个模块导出 tools: [{ name, define(caps), run(args, caps) }]；
// 入口 ramet.mjs 向中心问这把凭证能用哪些工具（GET /api/ramet/tools）再决定列出哪些。

export const url = process.env.RAMET_PAGE_URL
export const token = process.env.RAMET_PAGE_TOKEN

export const auth = () => ({ authorization: `Bearer ${token}` })

/** 打中心的 JSON 端点。会等很久的端点（审批、叫别的 agent）中心会先发头、定时吐空白保活，
 *  所以统一按文本读完再 trim 解析 */
export async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...auth(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = (await res.text()).trim()
  let json = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    /* 非 JSON（网关错误页等）：留给调用方按 raw 报 */
  }
  return { status: res.status, ok: res.ok, json, raw }
}

/** MCP 文本结果 */
export const reply = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

/** 外来事件之后 Genet 动手前弹的审批被拒了（中心回 { rejected: true }，见 routes/ramet-consent.ts）：告诉模型没做 */
export const declined = (r) => (r.json?.rejected ? reply(`用户没同意，这一步没有执行。${r.json.message ? `（${r.json.message}）` : ''}`) : null)

/** 中心报错：HTTP 失败，或先发头保活之后写在 JSON 里的 error（那时状态恒为 200） */
export const broken = (r) => !r.ok || !r.json || typeof r.json.error === 'string'

/** 中心 4xx/5xx 的错误文案：带上中心给的原因 */
export const failure = (what, r) => reply(`${what}：${r.json?.error ?? r.json?.message ?? (r.raw || r.status)}`, true)

/** 取中心的二进制端点（skill 文件），返回字节，不走 JSON 解析 */
export async function download(path) {
  const res = await fetch(`${url}${path}`, { headers: auth() })
  return { status: res.status, ok: res.ok, data: Buffer.from(await res.arrayBuffer()) }
}
