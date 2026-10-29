// 贴进来的是分享链接（YouTube 观看页、B 站视频页……），能放进 iframe 的是播放器地址，这里一处转换，插入时存转换后的地址
// （markdown 里的 `<iframe src>` 就是能直接用的地址）。只认 http(s) 与站内文件；音视频文件按扩展名走 <video> / <audio>。
// 认不出的网站原样放进沙箱 iframe（对方禁止被嵌入时浏览器会显示拒绝）。

export type EmbedKind = 'iframe' | 'video' | 'audio'
export type EmbedTarget = { kind: EmbedKind; src: string }

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/i

function parseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function youtubeId(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m)\./, '')
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  if (url.pathname === '/watch') return url.searchParams.get('v')
  const m = /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(url.pathname)
  return m?.[1] ?? null
}

/** 分享链接 → 嵌入目标；不是 http(s) 链接 = null */
export function toEmbed(raw: string): EmbedTarget | null {
  const text = raw.trim()
  if (/^\/api\/files\/[\w-]+/.test(text)) return { kind: VIDEO_EXT.test(text) ? 'video' : AUDIO_EXT.test(text) ? 'audio' : 'video', src: text }
  const url = parseUrl(text)
  if (!url) return null
  if (VIDEO_EXT.test(url.pathname)) return { kind: 'video', src: url.href }
  if (AUDIO_EXT.test(url.pathname)) return { kind: 'audio', src: url.href }
  const host = url.hostname.replace(/^www\./, '')

  const yt = youtubeId(url)
  if (yt) {
    const start = url.searchParams.get('t') ?? url.searchParams.get('start')
    const seconds = start ? parseInt(start, 10) : NaN
    return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${yt}${Number.isFinite(seconds) && seconds > 0 ? `?start=${seconds}` : ''}` }
  }
  if (host === 'bilibili.com' || host === 'm.bilibili.com') {
    const m = /\/video\/(BV[\w]+|av\d+)/i.exec(url.pathname)
    if (m) {
      const id = m[1]!
      const page = url.searchParams.get('p')
      const key = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`
      return { kind: 'iframe', src: `https://player.bilibili.com/player.html?${key}${page ? `&p=${page}` : ''}&autoplay=0` }
    }
  }
  if (host === 'vimeo.com') {
    const m = /^\/(\d+)/.exec(url.pathname)
    if (m) return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}` }
  }
  if (host === 'figma.com' && /^\/(file|design|proto|board)\//.test(url.pathname)) {
    return { kind: 'iframe', src: `https://www.figma.com/embed?embed_host=ramet&url=${encodeURIComponent(url.href)}` }
  }
  if (host === 'codepen.io') {
    const m = /^\/([^/]+)\/pen\/([^/?#]+)/.exec(url.pathname)
    if (m) return { kind: 'iframe', src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result` }
  }
  if (host === 'loom.com') {
    const m = /^\/share\/([\w-]+)/.exec(url.pathname)
    if (m) return { kind: 'iframe', src: `https://www.loom.com/embed/${m[1]}` }
  }
  return { kind: 'iframe', src: url.href }
}

/** 视频类网站的嵌入（按 16:9 画）；其它网页嵌入给固定高度 */
export function isVideoSite(src: string): boolean {
  return /^https:\/\/(www\.youtube-nocookie\.com|player\.bilibili\.com|player\.vimeo\.com|www\.loom\.com)\//.test(src)
}
