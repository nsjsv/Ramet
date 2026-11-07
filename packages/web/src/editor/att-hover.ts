/* ---------- 消息附件的悬停：token ⇄ 卡片互相高亮，行内摆法下弹预览，点图看大图 ----------
 * 宿主（对话输入卡的 dock、对话视图根）各挂一次委托监听。一个「单元」（[data-att-unit]：输入卡 / 一条用户消息）里，
 * 第 i 个 token（ATT_TOKEN，DOM 序 = 文档序）与第 i 张卡片（.att-card，attItemsOf 的次序）是同一个附件。
 * token 是叶子原子节点的 DOM：PM 对没有 contentDOM 的节点忽略 DOM 变动，直接改 class 不会被当成内容变动重读。
 * 预览只在行内摆法（[data-att-layout="inline"]）下出：托盘摆法的细节已经在卡片上。文件引用的完整路径走 data-tip，这里不弹。 */
import { ATT_TOKEN } from './att-cards'
import { openLightbox } from './media'

const UNIT = '[data-att-unit]'
const CARD = '.att-card'

let peek: HTMLDivElement | null = null

function peekEl(): HTMLDivElement {
  if (!peek) {
    peek = document.createElement('div')
    peek.className = 'att-peek'
    peek.setAttribute('aria-hidden', 'true')
    document.body.append(peek)
  }
  return peek
}

function hidePeek(): void {
  peek?.classList.remove('is-on')
}

/** 图片的原图地址（灯箱要 canonical：display 版它自己换）；还在上传的本地预览没有 */
function canonical(img: HTMLImageElement): string | null {
  const src = img.getAttribute('src') ?? ''
  return src.startsWith('/api/files/') ? src.replace(/\/display$/, '') : null
}

/** 默认在 token 上方居中，上方放不下翻到下方，左右夹在视口里 */
function place(box: HTMLElement, token: HTMLElement): void {
  const r = token.getBoundingClientRect()
  const w = box.offsetWidth
  const h = box.offsetHeight
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8)
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
}

function showPeek(token: HTMLElement): void {
  const box = peekEl()
  const img = token.querySelector('img')
  if (token.classList.contains('img-wrap') && img) {
    const big = document.createElement('img')
    big.alt = ''
    // 大图还没解码出尺寸时量到的高度是 0，加载完按真实尺寸再摆一次（否则浮层往下长、压住 token）
    big.addEventListener('load', () => {
      if (box.firstChild === big) place(box, token)
    })
    big.src = img.src
    box.replaceChildren(big)
  } else if (token.classList.contains('block-ref') && token.textContent) {
    const quote = document.createElement('div')
    quote.className = 'att-peek-quote'
    quote.textContent = token.textContent
    box.replaceChildren(quote)
  } else return
  box.classList.add('is-on')
  place(box, token)
}

export function wireAttHover(host: HTMLElement): () => void {
  let hot: { unit: Element; i: number } | null = null

  const clear = (): void => {
    if (hot) hot.unit.querySelectorAll('.is-att-hot').forEach((n) => n.classList.remove('is-att-hot'))
    hot = null
    hidePeek()
  }

  const onOver = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null
    const token = target?.closest<HTMLElement>(ATT_TOKEN) ?? null
    const card = token ? null : (target?.closest<HTMLElement>(CARD) ?? null)
    const unit = (token ?? card)?.closest(UNIT) ?? null
    if (!unit || !(token ?? card)) return clear()
    const list = [...unit.querySelectorAll<HTMLElement>(token ? ATT_TOKEN : CARD)]
    const i = list.indexOf((token ?? card)!)
    if (hot && hot.unit === unit && hot.i === i) return
    clear()
    hot = { unit, i }
    unit.querySelectorAll(ATT_TOKEN)[i]?.classList.add('is-att-hot')
    unit.querySelectorAll(CARD)[i]?.classList.add('is-att-hot')
    if (token && token.closest('[data-att-layout]')?.getAttribute('data-att-layout') === 'inline') showPeek(token)
  }

  const onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null
    const img = target?.closest(`${CARD}, ${ATT_TOKEN}`)?.querySelector('img')
    const src = img ? canonical(img) : null
    if (!src || e.button !== 0) return
    clear()
    openLightbox(src)
  }

  host.addEventListener('mouseover', onOver)
  host.addEventListener('mouseleave', clear)
  host.addEventListener('click', onClick)
  // 用户滚动时元素会走开，预览不跟着飘（只认滚轮：对话流式输出的自动滚动不该把高亮收掉）
  window.addEventListener('wheel', clear, { passive: true })
  return () => {
    clear()
    host.removeEventListener('mouseover', onOver)
    host.removeEventListener('mouseleave', clear)
    host.removeEventListener('click', onClick)
    window.removeEventListener('wheel', clear)
  }
}
