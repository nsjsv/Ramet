import { AUTOMATION_COPY } from './automation-copy'

/* ---------- AI 页（/ai：Genet / 任务 / 自动 / Skill / 记忆）的界面文案（并进 copy.ts 的 COPY.ai；单独成文件是为了让 copy.ts 不超过 800 行）---------- */
export const AI_COPY = {
  /** 侧栏入口 */
  nav: 'AI',
  /** 分页栏（这一页的标题）的无障碍名 */
  tabsLabel: 'AI',
  tabs: {
    genet: 'Genet',
    tasks: '任务',
    automations: '自动',
    skills: 'Skill',
    memory: '记忆',
  },
  tasks: {
    sub: 'Genet 派给机器上 agent 的活',
    empty: '还没有任务',
  },
  ...AUTOMATION_COPY,
  /** 定时器发出的消息（任务页上）：气泡顶上 / 署名行前的「定时」小标（editor/task-notice.ts 的 sentTag） */
  timers: {
    sentTag: '定时',
    sentTip: '定时器到点自动发出的',
  },
}
