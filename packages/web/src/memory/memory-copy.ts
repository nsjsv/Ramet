/* ---------- 空间公共记忆的界面文案（并进 copy.ts 的 COPY.memory；单独成文件是为了让 copy.ts 不超过 800 行）---------- */
export const MEMORY_COPY = {
  sub: (space: string) => `「${space}」里所有 agent 共享`,
  loading: '加载中…',
  loadFailed: '记忆加载失败，请稍后再试',
  stats: (count: number, chars: number, max: number) => `${count} 条 · 合计 ${chars} / ${max} 字`,
  slim: '只留长期有效的，过时的及时删',
  nearFull: '快满了，删掉些不用的',
  full: '满了，先删掉些不用的',
  empty: '还没有记忆',
  emptyHint: '也可以在对话里敲「/记住 内容」',
  addPlaceholder: '一条只讲一件事…',
  add: '添加',
  adding: '添加中…',
  counter: (n: number, max: number) => `${n} / ${max}`,
  readOnly: '你在这个空间里是只读成员，只能查看记忆。',
  someone: '有人',
  by: (who: string) => `${who} 记下`,
  fromPage: '来自页面',
  remove: '删除这条记忆',
  confirmRemove: (text: string) => `删除这条记忆？删除后 agent 之后的每一轮都不会再带上它。\n\n${text.length > 120 ? `${text.slice(0, 120)}…` : text}`,
  addFailed: '添加失败，请重试',
  removeFailed: '删除失败，请重试',
  /** 输入框里的 `/记住 内容` */
  command: {
    usage: '用法：/记住 要记住的内容',
    saved: '已记住，这个空间里所有 agent 之后的每一轮都会带上',
    failed: '没有记下',
    noSpace: '这个页面不在任何空间里，没法记忆',
    readOnly: '只读成员不能添加记忆',
  },
  /** 斜杠菜单里的 Ramet 命令 */
  slash: { group: 'Ramet', label: '记住', hint: '把一句话记进这个空间的公共记忆（所有 agent 共享）' },
}
