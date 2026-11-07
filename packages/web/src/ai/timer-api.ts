/* ---------- 时区上报（服务端 PUT /api/me/time-zone）----------
 * 定时规则按用户的时区算「每天 9 点」；规则本身的增删改查在 automation-api.ts。 */

import { request } from '../api'

const setTimeZone = (timeZone: string) =>
  request<{ timeZone: string }>('/api/me/time-zone', { method: 'PUT', body: JSON.stringify({ timeZone }) }).then((r) => r.timeZone)

const TZ_KEY = 'ramet:tz'

/** 把浏览器的时区报给服务端（定时器按它算「每天 9 点」）。只在变了时报：上次报成功的记在 localStorage，
 *  带上账号 id——同一个浏览器换了账号，新账号也得报一次。失败只记日志：报不上就按服务器时区算，下次打开再试 */
export function reportTimeZone(userId: string): void {
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return
  }
  if (!tz) return
  const stamp = `${userId} ${tz}`
  try {
    if (localStorage.getItem(TZ_KEY) === stamp) return
  } catch {
    // 读不了本地存储（隐私模式）：照报，代价只是每次打开多一个请求
  }
  setTimeZone(tz).then(
    () => {
      try {
        localStorage.setItem(TZ_KEY, stamp)
      } catch {
        // 记不下就下次再报
      }
    },
    (err: unknown) => console.error('time zone report failed:', err),
  )
}
