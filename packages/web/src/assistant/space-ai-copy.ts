/* ---------- 空间 AI 的界面文案（并进 copy.ts 的 COPY.spaceAi）---------- */
export const SPACE_AI_COPY = {
  /** 空间设置里的卡片 */
  card: '空间 AI',
  connection: '模型连接',
  connectionDesc: '空间成员在对话里 @ 它就能叫起来，费用走你这个连接，不限次数',
  off: '不启用',
  noConnections: '你还没有添加模型连接，先去添加一个',
  addConnection: '去添加',
  name: '名字',
  nameDesc: '成员在 @ 菜单和回复里看到的名字',
  nameInvalid: (max: number) => `名字要有 1–${max} 个字`,
  save: '保存',
  saved: '已保存',
  saveFailed: '保存失败',
  loading: '加载中…',
  loadFailed: '读取空间 AI 设置失败',
  status: '状态',
  enabled: (name: string) => `已启用 · ${name}`,
  disabled: '未启用',
  memberHint: '只有空间所有者能设置',
  /** 点名 / 续聊的是空间 AI，而它在这个空间里没启用（服务端只回「agent 不可用」，前端按空间列表说清楚） */
  notEnabled: '这个空间还没有启用空间 AI',
  /** 发送时没有能回落的 agent，但这个空间的 AI 是开着的：它只在被 @ / 被选成来源时才用 */
  callHint: (name: string) => `没有可用的 agent：在消息里 @${name}，或在来源里选它`,
  /** 来源 chip：只剩只能点名的空间 AI 时还没选来源 */
  pickSource: '选择来源',
  /** 侧栏页面树上方的一行 */
  row: { off: '未启用', tip: (name: string) => `和 ${name} 对话，看这个空间的记忆和 Skill` },
  /** 空间 AI 页（/spaces/:id/ai） */
  hub: {
    tabs: { chat: '对话', memory: '记忆', skills: 'Skill' },
    tabsLabel: (name: string, space: string) => `${space} 的 ${name}`,
    notFound: '找不到这个空间，或者你不是它的成员',
    privateNote: '这段对话在你的私人区，只有你看得到；它建的、改的页面在空间的公共区里',
    empty: (name: string) => `和 ${name} 说点什么：它能查找、整理和修改这个空间公共区里的页面`,
    off: '这个空间还没有启用空间 AI',
    enable: '去启用',
    askOwner: '请空间所有者在空间设置里启用',
    viewer: '只读成员不能和空间 AI 对话；这个空间的记忆和 Skill 照样能看',
    failed: '打开对话失败，请稍后再试',
  },
}
