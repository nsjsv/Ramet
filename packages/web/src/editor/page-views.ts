/* ---------- 各页正文编辑器视图的取法 ----------
 * 编辑器会话建好后在这里登记怎么取这页的正文视图（同 memory/remember.ts 的 bindPageSpace），拿不到编辑器的代码按页取：
 * 带队计划卡的「开工」往这页写一条消息（team/team-send.ts），Genet 浮窗打开时看当前页选中了哪一块（assistant/position.ts）。 */
import type { EditorView } from '@milkdown/kit/prose/view'

const views = new Map<string, () => EditorView | undefined>()

/** 登记这页正文视图的取法，返回注销函数（重复登记时旧的注销不会误删新的） */
export function bindPageView(pageId: string, get: () => EditorView | undefined): () => void {
  views.set(pageId, get)
  return () => {
    if (views.get(pageId) === get) views.delete(pageId)
  }
}

/** 这页活着的正文视图（没登记 / 已销毁 = undefined） */
export function pageView(pageId: string): EditorView | undefined {
  const view = views.get(pageId)?.()
  return view && !view.isDestroyed ? view : undefined
}
