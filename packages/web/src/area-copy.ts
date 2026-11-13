/* 私人区的界面文案（侧栏两栏、换区确认、页头标记）。合进 copy.ts 的 COPY.area */
export const AREA_COPY = {
  /** 侧栏两栏的名字：公共 = 空间成员都看得到（原「页面树」），私人 = 只有我 */
  publicTree: '公共',
  privateTree: '私人',
  publicMenu: '在公共区新建',
  privateMenu: '在私人区新建',
  privateEmpty: '只有你看得到这里的页',
  /** 别人私人区里分享给我的页（侧栏一栏、面包屑） */
  sharedTree: '分享给我的',
  sharedCrumb: '分享给你的',
  sharedBy: (who: string | null) => (who ? `${who} 分享给你的` : '别人分享给你的'),
  /** 页头标记 */
  privateBadge: '只有你能看到',
  /** 顶层页行上的换区按钮 */
  toPrivate: '挪进私人区',
  toPublic: '挪回公共区',
  confirmToPrivate: (title: string) => `把「${title}」挪进你的私人区？之后空间里的其他人都看不到这一页和它的子页。`,
  confirmToPublic: (title: string) => `把「${title}」挪回公共区？之后空间成员都能看到这一页和它的子页。`,
  privatizeForbidden: '只有页面的创建人和空间 owner 能把公共页挪进私人区',
  moveFailed: '换区失败',
  /** 页面被挪进别人的私人区、分享被收回、或我已不在这个空间：打开着的那一页 */
  gone: '这一页已经看不到了：它可能被挪进了别人的私人区、分享给你的权限被收回了，或者你已经不在这个空间里。',
}
