/* ---------- UI 图标唯一来源（一张路径表）----------
 * 统一画法：24 viewBox、fill none、stroke currentColor、strokeWidth 2、圆端点；实心形状（点、手柄）
 * 在路径里自带 fill="currentColor" stroke="none"。颜色继承文字色，深浅主题自动跟随。
 * React 用 <Icon name>，ProseMirror 小部件 / 字符串拼的 DOM 用 iconSvg(name)，两者画同一张表。
 * 页面 emoji / 图片图标是用户内容，不走这里（PageIcon.tsx）。伪元素里画不了内联 SVG 的地方
 * （页面链接、块提及、附件、无图标页占位）用 base.css 的 --page-icon 掩膜，形状与下面的 file 相同。
 * 折叠箭头的展开旋转（.chev.open）由 CSS transform 做，这里只画朝右箭头。 */

const DOT = 'fill="currentColor" stroke="none"'

const PATHS = {
  /** 折叠箭头（树行 / section 头 / 块菜单「转换」）：朝右 */
  chevron: '<path d="M9 5l7 7-7 7"/>',
  /** 下拉 caret（工作区切换器） */
  caret: '<path d="M6 9l6 6 6-6"/>',
  /** 侧栏收起：面板框 + 分隔线 + 朝左箭头；展开（折叠态）箭头反向 */
  'panel-collapse': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M16 9.5l-3.5 2.5 3.5 2.5"/>',
  'panel-expand': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="M12.5 9.5l3.5 2.5-3.5 2.5"/>',
  /** 项目面板（右侧面板）：面板框 + 右侧分隔线；刷新 */
  'panel-right': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 7"/>',
  /** ⋯ 行菜单；⋮ 顶栏「更多操作」 */
  more: `<circle cx="5" cy="12" r="1.2" ${DOT}/><circle cx="12" cy="12" r="1.2" ${DOT}/><circle cx="19" cy="12" r="1.2" ${DOT}/>`,
  'more-vertical': `<circle cx="12" cy="5" r="1.2" ${DOT}/><circle cx="12" cy="12" r="1.2" ${DOT}/><circle cx="12" cy="19" r="1.2" ${DOT}/>`,
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  /** 上一处 / 上级目录；下一处 */
  'arrow-up': '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
  /** ⇄ 查找条「替换」 */
  swap: '<path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cog: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  /** 目录 / 文件 glyph：lucide 原样，与 --page-icon 同一套（同槽位里大小 / 重心对得上） */
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  /** 过程时间线的条目类型：读 / 搜 / 想 / 改 / 终端 */
  read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  think: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  /** 公式（斜杠菜单）：Σ */
  sigma: '<path d="M18 5H6l6 7-6 7h12"/>',
  /** 提示框五种外观（callout.ts）：说明 / 提示 / 重要 / 警告 / 危险 */
  'callout-note': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  'callout-tip': '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  'callout-important': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v4M12 14h.01"/>',
  'callout-warning': '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  'callout-caution': '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z"/><path d="M12 8v4M12 16h.01"/>',
  /** 折叠块 / 分栏 / 目录 / 嵌入（斜杠菜单） */
  toggle: '<path d="M8 6l6 4-6 4z" fill="currentColor" stroke="none"/><path d="M16 18H8M18 14h-4"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  toc: '<path d="M4 6h16M8 12h12M12 18h8"/>',
  embed: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
  /** 表格（斜杠菜单） */
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  /** 键盘（设置「快捷键」页） */
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  /** 新标签打开（端口预览） */
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  say: '<path d="M3.75 4.5h16.5v11.25H10.5l-4.5 3.75v-3.75H3.75z"/>',
  step: '<circle cx="12" cy="12" r="4"/>',
  /** 用量标签前的「这一轮」记号：三条长短不一的横线 */
  run: '<path d="M4 6h10M4 12h16M4 18h7"/>',
  /** 重试 / 重新生成：顺时针回转箭头 */
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  /** 代码块「自动换行」：一行折回下一行 */
  wrap: '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="M16 16l-2 2 2 2"/><path d="M3 18h7"/>',
  quote: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  /** 收藏：空心 / 实心星 */
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
  'star-fill': '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="currentColor"/>',
  /** 收件箱（侧栏入口）：lucide inbox */
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  /** `@` 大菜单分类 / 设置导航：agent（机器人）、成员（两个人）、连接器（插头）、恢复（回转箭头）、登出 */
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  /** Skill 库：拼图块 */
  memory: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M10 2v8l3-3 3 3V2"/>',
  skill: '<path d="M19.4 11a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2h-3a2 2 0 1 0-4 0H5a2 2 0 0 0-2 2v3a2 2 0 1 1 0 4v3a2 2 0 0 0 2 2h3a2 2 0 1 1 4 0h3a2 2 0 0 0 2-2v-3a2 2 0 1 1 2-2Z"/>',
  /** 块类型（斜杠菜单 / 框选工具栏「转换成」）：圆点列表、编号列表、待办、引用块、代码块、分隔线、图片、附件 */
  'list-bullet': `<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3" ${DOT}/><circle cx="4.5" cy="12" r="1.3" ${DOT}/><circle cx="4.5" cy="18" r="1.3" ${DOT}/>`,
  'list-number': '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9"/><path d="M4 9h3"/><path d="M6.5 19H4c0-1.2 2.5-1.8 2.5-3.2 0-.8-.7-1.3-1.4-1.3-.6 0-1 .3-1.2.7"/>',
  todo: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m3.5 17 2 2 4-4"/><path d="M14 7.5h7M14 17h7"/>',
  blockquote: '<path d="M4 5v14"/><path d="M9 7h11M9 12h11M9 17h7"/>',
  'code-block': '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  divider: '<path d="M3 12h18"/><path d="M8 6.5h8M8 17.5h8" stroke-opacity=".35"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  /** 随手 AI（⌘J）：星芒 */
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4"/><path d="M5 17v4M7 19H3"/>',
  /** 清除格式（框选工具栏） */
  'clear-format': '<path d="M4 7V4h16v3"/><path d="M5 20h6"/><path d="M13 4 8 20"/><path d="m15 15 5 5"/><path d="m20 15-5 5"/>',
  /** 停止：实心圆角方块（发送钮在运行中的形态） */
  stop: `<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" ${DOT}/>`,
  /** 顶栏 ⋮ 菜单：导出 zip（下载）/ 全宽（左右撑开） */
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  'full-width': '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
  /** 正文（块菜单「转换」）：T */
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  /** 集合的属性类型 / 工具栏（collection/） */
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  'select-one': '<circle cx="12" cy="12" r="9"/><path d="m8.5 10.5 3.5 3.5 3.5-3.5"/>',
  tags: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1" fill="currentColor"/>',
  status: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  checkbox: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
  sort: '<path d="m3 8 4-4 4 4M7 4v16M21 16l-4 4-4-4M17 20V4"/>',
  group: '<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2M2 2l20 20"/>',
  /** 块手柄 6 点（实心；按触达目标定的 14×16 方框，见 BOX） */
  handle:
    `<circle cx="4.5" cy="3" r="1.6" ${DOT}/><circle cx="9.5" cy="3" r="1.6" ${DOT}/>` +
    `<circle cx="4.5" cy="8" r="1.6" ${DOT}/><circle cx="9.5" cy="8" r="1.6" ${DOT}/>` +
    `<circle cx="4.5" cy="13" r="1.6" ${DOT}/><circle cx="9.5" cy="13" r="1.6" ${DOT}/>`,
}

export type IconName = keyof typeof PATHS

/** 不是 24 方格的图 */
const BOX: Partial<Record<IconName, string>> = { handle: '0 0 14 16' }

/** 非 React DOM 用：SVG 字符串。属性与 <Icon> 是同一套 */
export function iconSvg(name: IconName, width = 16, height = width): string {
  return (
    `<svg width="${width}" height="${height}" viewBox="${BOX[name] ?? '0 0 24 24'}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  )
}

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={BOX[name] ?? '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  )
}
