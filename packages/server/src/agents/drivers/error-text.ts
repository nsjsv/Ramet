// ---------- 报错文案 ----------

/** 有的错误把对端给的详情挂在 `.data` 上（JSON-RPC 的 error.data：起 MCP 工具进程失败、脚本路径不存在等），
 *  只回 `message`（对端往往就一句 "Internal error"）会让红条没有信息，所以两者拼成一句。connector 写日志也用它。 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (!('data' in err)) return err.message
  const data: unknown = err.data
  if (data === undefined) return err.message
  const detail = typeof data === 'string' ? data : JSON.stringify(data)
  return detail ? `${err.message}：${detail}` : err.message
}
