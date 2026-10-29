import type { Ctx } from '@milkdown/kit/ctx'
import { editorViewOptionsCtx } from '@milkdown/kit/core'

// 编辑器内点击 /page/ 链接 → 路由跳转（contenteditable 默认点击不导航）。
// 两条通道并存互不覆盖（不同 prop key）：
// - handleDOMEvents.click 拦 a 标签：行内链接（text + link mark）；
// - handleClickOn 接 page_ref 块（整行卡片，div 上没有 a，DOM click 拦不到）。
// 外链：普通点击直接新开标签。双击不开（detail>1，留给浏览器选词改链接文字）；光标进链接内用键盘 / 邻位点击。
/** 链接地址 → 站内路由（`/page/…`）或外链。同源绝对地址（「复制链接」拷的都是带 origin 的完整地址，
 * 粘进文档就是它）按站内链接走。悬浮栏（link-hover.ts）点地址也走这里 */
export function linkTarget(raw: string): { internal: boolean; href: string } {
  const href = raw.startsWith(`${location.origin}/page/`) ? raw.slice(location.origin.length) : raw
  return { internal: href.startsWith('/page/'), href }
}

export function configLinkNav(ctx: Ctx, navigate: (to: string) => void, openExternal: (href: string) => void) {
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    handleDOMEvents: {
      ...prev.handleDOMEvents,
      click: (_view, event) => {
        const a = (event.target as Element | null)?.closest('a')
        if (!a) return false
        const raw = a.getAttribute('href') ?? ''
        if (!raw) return false
        const { internal, href } = linkTarget(raw)
        if (!internal) {
          if (event.detail > 1) return false // 双击/三击：选词编辑，不开
          event.preventDefault()
          openExternal(href)
          return true
        }
        event.preventDefault()
        navigate(href)
        return true
      },
    },
    handleClickOn: (_view, _pos, node) => {
      // page_ref：整行卡片跳子页；block_ref（提及 chip）/ block_sync（同步块）：跳源页并定位到块；
      // page_mention（@ 页面引用 chip）：跳被提及的页面本身
      const pageId = node.attrs.pageId
      if (typeof pageId !== 'string' || !pageId) return false
      if (node.type.name === 'page_ref' || node.type.name === 'page_mention') {
        navigate(`/page/${pageId}`)
        return true
      }
      if (node.type.name === 'block_ref' || node.type.name === 'block_sync') {
        const blockId = node.attrs.blockId
        if (typeof blockId !== 'string' || !blockId) return false
        navigate(`/page/${pageId}?block=${blockId}`)
        return true
      }
      return false
    },
  }))
}
