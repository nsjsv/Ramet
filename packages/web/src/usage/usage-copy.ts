// AI 使用量的界面文案（并进 COPY.usage）

export const USAGE_COPY = {
  tab: 'AI 使用量',
  tabDesc: '你的模型连接最近 30 天花了多少 token',
  scope:
    '只算花你模型连接（API key）的调用：Genet 对话、⌘J 快捷 AI、AI 块与 AI 属性，以及你当所有者的空间里成员叫空间 AI 的部分。机器上的 agent 和 ⌘J 本地通道用的是你自己的订阅，不在这里。',
  empty: '最近 30 天还没有用过',
  loading: '正在读取…',
  failed: '读取失败，请稍后再试',
  trend: '每天的 token',
  tiles: { calls: '调用', input: '输入', output: '输出', cache: '缓存命中' },
  bySource: '按来源',
  byModel: '按模型',
  byMember: '按成员',
  cols: { name: '名称', calls: '次数', tokens: 'token' },
  /** 柱子的悬停提示与读屏文字 */
  dayTip: (day: string, calls: number, tokens: string) => (calls > 0 ? `${day} · ${calls} 次 · ${tokens} token` : `${day} · 没有用`),
  chartLabel: (days: number) => `最近 ${days} 天每天的 token 用量`,
  space: {
    title: '空间 AI 用量（最近 30 天）',
    desc: '成员叫空间 AI 花的是你的模型连接。只有你能看到这里。',
  },
}
