/* 分享面板的界面文案（顶栏「分享」）。合进 copy.ts 的 COPY.sharing */
export const SHARING_COPY = {
  invite: '邀请',
  inviteName: '用户名',
  invitePlaceholder: '输入用户名',
  inviteBtn: '邀请',
  inviteHint: '空间外的人会成为访客：只看得到这一页和它的子页',
  guest: '访客',
  people: '有权限的人',
  level: { edit: '可编辑', view: '只读' } as const,
  levelLabel: '权限',
  owner: (name: string) => `${name} · 主人`,
  everyone: '空间成员 · 按各自的空间角色',
  inherited: (title: string | null) => (title ? `继承自《${title}》` : '继承自上级页面'),
  remove: '移除',
  leave: '退出',
  web: '发布到网上',
  failed: '操作失败',
  loading: '加载中…',
}

/* 空间设置的「访客」卡（share/GuestsCard.tsx） */
export const GUESTS_COPY = {
  titleBare: '访客',
  title: (n: number) => `访客（${n}）`,
  policy: '成员可以邀请访客',
  policyDesc: '关掉后只有你能把页面分享给空间外的人；已经给出的分享不受影响',
  empty: '没有访客。把页面分享给空间外的人，他们就会出现在这里',
  loading: '加载中…',
  untitled: '无标题',
  pages: (titles: string[], privateCount: number) =>
    [titles.length ? titles.map((t) => `《${t}》`).join('、') : '', privateCount ? `${privateCount} 个私人页` : ''].filter(Boolean).join(' · '),
  remove: '移出空间',
  removeConfirm: '确认移出',
  removeTip: (name: string) => `收回分享给「${name}」的全部页面`,
  loadFailed: '访客列表加载失败',
  failed: '操作失败',
}
