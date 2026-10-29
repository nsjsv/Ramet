import { describe, expect, test } from 'vitest'
import { toEmbed } from './embed-url'

// 分享链接转成能放进 iframe 的播放器地址；只认 http(s) 与站内文件。

describe('toEmbed', () => {
  test('YouTube 观看页 / 短链 / shorts → nocookie 播放器，带起始秒数', () => {
    expect(toEmbed('https://www.youtube.com/watch?v=abc123&t=42')).toEqual({ kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/abc123?start=42' })
    expect(toEmbed('https://youtu.be/xyz')?.src).toBe('https://www.youtube-nocookie.com/embed/xyz')
    expect(toEmbed('https://youtube.com/shorts/s1')?.src).toBe('https://www.youtube-nocookie.com/embed/s1')
  })

  test('B 站视频页 → 播放器（分 P 带上，不自动播放）', () => {
    expect(toEmbed('https://www.bilibili.com/video/BV1xx411c7mD?p=2')?.src).toBe('https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&p=2&autoplay=0')
  })

  test('Vimeo / Figma / CodePen / Loom', () => {
    expect(toEmbed('https://vimeo.com/76979871')?.src).toBe('https://player.vimeo.com/video/76979871')
    expect(toEmbed('https://www.figma.com/design/KEY/Name')?.src).toContain('figma.com/embed?embed_host=ramet&url=')
    expect(toEmbed('https://codepen.io/u/pen/abc')?.src).toBe('https://codepen.io/u/embed/abc?default-tab=result')
    expect(toEmbed('https://www.loom.com/share/id9')?.src).toBe('https://www.loom.com/embed/id9')
  })

  test('音视频文件按扩展名；站内文件', () => {
    expect(toEmbed('https://x.com/a.mp4')?.kind).toBe('video')
    expect(toEmbed('https://x.com/a.mp3')?.kind).toBe('audio')
    expect(toEmbed('/api/files/0b1c')?.src).toBe('/api/files/0b1c')
  })

  test('不是 http(s) 链接：null', () => {
    expect(toEmbed('javascript:alert(1)')).toBeNull()
    expect(toEmbed('随便几个字')).toBeNull()
  })

  test('认不出的网站原样嵌入', () => {
    expect(toEmbed('https://example.com/page')).toEqual({ kind: 'iframe', src: 'https://example.com/page' })
  })
})
