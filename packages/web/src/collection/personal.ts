// ---------- 视图的个人状态（本机记忆）：日历翻到哪个月、时间线的刻度与左缘日期 ----------
// 这些是「怎么看」不是「看什么」：写进集合文档会每点一次就多一个集合页版本、别人的视图也跟着变，所以只记在 localStorage，键带视图 id。
// 读出来的值由调用方校验（别的版本 / 手改的脏值按缺省处理）。

export function readPersonal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePersonal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    console.error(err) // 隐私模式 / 配额满：只是不记住，不影响查看
  }
}
