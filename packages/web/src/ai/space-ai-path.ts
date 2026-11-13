/* 空间 AI 页的地址（侧栏那一行、Genet 页旧地址的转跳、空间 AI 页自己的分页共用；页面本身懒加载，地址单放一个小文件） */

/** 分页 = ''（对话）/ memory / skills */
export const spaceAiPath = (spaceId: string, tab = ''): string => `/spaces/${encodeURIComponent(spaceId)}/ai${tab ? `/${tab}` : ''}`
