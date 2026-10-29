/* ---------- emoji → Twemoji 图片地址（唯一入口） ----------
 * 页面图标的 emoji 不用系统字体画（各平台外观不一、旧系统缺字），统一渲染成自托管的 Twemoji SVG
 * （vite.config.ts 把 @twemoji/svg 拷到 /twemoji/，nginx 永久缓存，单个约 0.4KB gzip）。
 * 文件名规则同 Twemoji 官方 grabTheRightIcon：码点小写十六进制用 '-' 连接；序列里没有 ZWJ（200d）
 * 时先剥掉 fe0f（变体选择符），有 ZWJ 则原样保留。Twemoji 15 没有的新 emoji 请求会 404，
 * 调用方在 <img> 的 onerror 里退回文本字符。 */

const VS16 = 0xfe0f
const ZWJ = 0x200d

export function twemojiName(emoji: string): string {
  let points = Array.from(emoji, (ch) => ch.codePointAt(0) ?? 0)
  if (!points.includes(ZWJ)) points = points.filter((p) => p !== VS16)
  return points.map((p) => p.toString(16)).join('-')
}

export function twemojiUrl(emoji: string): string {
  return `/twemoji/${twemojiName(emoji)}.svg`
}
