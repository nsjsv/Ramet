/* ---------- emoji 选择器（emoji-mart）----------
 * 只在页面图标弹层打开时才挂载，库本体、数据、精灵图都是点开才加载（不进主包）：
 * - 库：动态 import('emoji-mart')，独立 chunk；
 * - 数据：@emoji-mart/data 的 twitter 集（带精灵图坐标），?url 让 vite 当静态资源输出（不进 JS、nginx 可 gzip），用 fetch 取；
 * - 精灵图：自托管的 Twemoji 64px 表（public/twemoji-sprite-64.png，版本须与 sets/15 配套的 15.0.1 一致），
 *   与页面里各处显示用的 Twemoji 同一套美术。
 * 选择器是 Web Component（shadow DOM），样式只能走它公开的外部入口：
 * ① 宿主元素的尺寸写在 page-icon.css（它自带 `:host{width:min-content}`，不覆盖就缩成一小条、每行 5 个）；
 * ② CSS 变量 --rgb-background / --rgb-color / --rgb-accent 要 'r, g, b' 三元组，吃不了 var(--surface)，
 *    所以由 applyTheme 从站点令牌取计算值写上去，明暗切换时重写。明暗判据 theme:'auto' 与 dark.css 同为系统设置。
 * 搜索：库自带的关键词是英文，中文词表（emoji-zh.json）在 loadData 里并进去，见 emoji-search.ts。 */

import { useEffect, useRef, useState } from 'react'
import dataUrl from '@emoji-mart/data/sets/15/twitter.json?url'
import i18nUrl from '@emoji-mart/data/i18n/zh.json?url'
import zhKeywordsUrl from './emoji-zh.json?url'
import { addZhKeywords, type EmojiMartData, type ZhKeywords } from './emoji-search'

const SPRITE_URL = '/twemoji-sprite-64.png'

/** 站点令牌 → 'r, g, b'：借一个探针元素让浏览器算出 var() 的实际颜色 */
function rgbOf(token: string, scope: HTMLElement): string | null {
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  scope.appendChild(probe)
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(probe).color)
  probe.remove()
  return m ? `${m[1]}, ${m[2]}, ${m[3]}` : null
}

/** 让选择器的底色 / 文字 / 强调色跟站点一致（否则自带的深色底比弹层还深，像卡片套卡片） */
function applyTheme(el: HTMLElement): void {
  const vars: Array<[string, string]> = [
    ['--rgb-background', '--surface'],
    ['--rgb-color', '--ink'],
    ['--rgb-accent', '--accent'],
  ]
  for (const [prop, token] of vars) {
    const rgb = rgbOf(token, el)
    if (rgb) el.style.setProperty(prop, rgb)
  }
}

/** 选择器数据：twitter 集 + 中文搜索词（库自带的关键词全是英文）。词表取不到就退回纯英文搜索，不拖垮选择器 */
async function loadData(): Promise<unknown> {
  const [data, zh] = await Promise.all([
    fetch(dataUrl).then((res) => res.json() as Promise<EmojiMartData>),
    fetch(zhKeywordsUrl)
      .then((res) => res.json() as Promise<ZhKeywords>)
      .catch(() => null),
  ])
  return zh ? addZhKeywords(data, zh) : data
}

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  // 回调走 ref：选择器只建一次，父组件重渲染（busy / error 变化）不该把它拆了重建
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let el: HTMLElement | null = null
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => el && applyTheme(el)
    void (async () => {
      try {
        const [{ Picker }, i18n] = await Promise.all([
          import('emoji-mart'),
          fetch(i18nUrl).then((res) => res.json() as Promise<unknown>),
        ])
        if (cancelled || !hostRef.current) return
        el = new Picker({
          data: loadData,
          i18n,
          locale: 'zh',
          set: 'twitter',
          emojiVersion: 15,
          getSpritesheetURL: () => SPRITE_URL,
          theme: 'auto',
          previewPosition: 'none',
          skinTonePosition: 'search',
          dynamicWidth: true,
          onEmojiSelect: (picked: { native?: string }) => {
            if (picked.native) pickRef.current(picked.native)
          },
        }) as unknown as HTMLElement
        hostRef.current.appendChild(el)
        applyTheme(el)
        dark.addEventListener('change', retheme)
      } catch (err) {
        console.error(err)
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      dark.removeEventListener('change', retheme)
      el?.remove()
    }
  }, [])

  return failed ? <div className="icon-picker-error">表情库加载失败，可在下方粘贴 emoji</div> : <div className="icon-picker-host" ref={hostRef} />
}
