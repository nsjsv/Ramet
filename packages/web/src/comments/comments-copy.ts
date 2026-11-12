/* ---------- 评论的界面文案（并进 copy.ts 的 COPY.comments；单独成文件是为了 copy.ts 不超过 800 行）---------- */
export const COMMENTS_COPY = {
  /** 框选菜单按钮 / 顶栏按钮 */
  add: '评论',
  topbar: (n: number) => (n > 0 ? `评论（${n} 条未解决）` : '评论'),
  drawer: '评论',
  open: '未解决',
  resolvedGroup: '已解决',
  empty: '还没有评论',
  /** 抽屉空态：按这页开着的评论种类说怎么评论 */
  emptyHint: (inline: boolean, page: boolean) =>
    inline && page ? '选中正文里的文字可以就地评论，也可以在页面底部参与讨论。' : inline ? '选中正文里的文字可以就地评论。' : '在页面底部参与讨论。',
  discussion: '讨论',
  resolvedFold: (n: number) => `已解决 ${n} 条`,
  placeholder: '写评论，@ 提及成员或 Genet，Enter 发送，Shift+Enter 换行…',
  replyPlaceholder: '回复，Enter 发送…',
  pagePlaceholder: '参与讨论，@ 提及成员或 Genet，Enter 发送…',
  send: '发送',
  reply: '回复',
  resolve: '解决',
  reopen: '重新打开',
  edit: '编辑',
  save: '保存',
  cancel: '取消',
  remove: '删除',
  confirmRemove: '删除这条评论？',
  edited: '已编辑',
  /** 代回复（收件箱「代回复」进来）：草稿流式写进评论框，本人改完再发 */
  drafting: '正在起草回复…',
  draftStop: '停止',
  /** 交给模型的要求：回复一个串 / 正文里被 @ 了，在那一段上新开一条评论 */
  draftInstruction: '以我的口吻起草一条回复。',
  draftMentionInstruction: '别人在这段正文里 @了我，以我的口吻起草一条评论回应。',
  /** 串太长、交给模型时中间省略掉的那几条 */
  draftOmitted: (n: number) => `（中间省略 ${n} 条评论）`,
  draftResolved: '这个评论串已经解决了，重新打开后再回复。',
  draftGone: '要回复的评论或正文已经不在了。',
  draftNoText: '那一段没有文字，没法在上面评论。',
  draftNoInline: '这一页没有开划词评论，没法在正文上起草回复。',
  /** 评论里 @Genet 之后那条评论下面的状态 */
  callWaiting: 'Genet 正在处理…',
  callDone: 'Genet 看过了，没有回在这里',
  callFailed: (reason: string) => `Genet 没能处理：${reason || '出错了'}`,
  callOpen: '去对话里看',
  deleted: '评论已删除',
  deletedUser: '已注销用户',
  orphan: '原文已删除',
  pageThread: '整页讨论',
  resolvedBy: (name: string) => `${name} 已解决`,
  replies: (n: number) => `${n} 条回复`,
  /** 右侧收起的卡片里，长串中间折起来的那几条 */
  moreReplies: (n: number) => `还有 ${n} 条回复`,
  tooLong: (max: number) => `评论最多 ${max} 字`,
  failed: '操作失败，请重试',
  loadFailed: '评论加载失败',
  /** 顶栏 ⋮ 菜单里的「评论」项与它的子菜单开关（页面属性，对所有人生效） */
  switches: '评论',
  inlineSwitch: '划词评论',
  inlineSwitchHint: '选中正文文字就地评论（对所有人生效；关闭后已有评论保留，重新打开即恢复）',
  pageSwitch: '底部讨论',
  pageSwitchHint: '正文下方的整页讨论区（对所有人生效；关闭后已有讨论保留，重新打开即恢复）',
  switchFailed: '切换评论开关失败，请重试',
}
