// ---------- 视图布局的界面登记：哪些布局已经有界面、各自的图标 ----------
// 只有登记在 READY_LAYOUTS 里的布局出现在「新建视图」与「布局」菜单里；数据模型认得、还没有界面的布局由内容区按表格画
// （更新的客户端写进来的、这里不认识的布局 parseView 本就读成表格）。视图标签、集合页历史、内容区分流（CollectionSurface）都读这里。
import type { CollectionLayout } from '@ramet/shared/collection-model'
import type { IconName } from '../icons'

/** 已经有界面的布局，按菜单里的顺序 */
export const READY_LAYOUTS = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'] as const satisfies readonly CollectionLayout[]
export type ReadyLayout = (typeof READY_LAYOUTS)[number]

export function isReadyLayout(layout: CollectionLayout): layout is ReadyLayout {
  return (READY_LAYOUTS as readonly CollectionLayout[]).includes(layout)
}

export const LAYOUT_ICON: Record<CollectionLayout, IconName> = {
  table: 'table',
  board: 'columns',
  list: 'list-bullet',
  gallery: 'gallery',
  calendar: 'calendar',
  timeline: 'timeline',
}

/** 按日期排布的布局：视图要有日期属性（dateBy），条目只画标题（工具栏不出「属性」） */
export function usesDate(layout: CollectionLayout): boolean {
  return layout === 'calendar' || layout === 'timeline'
}
