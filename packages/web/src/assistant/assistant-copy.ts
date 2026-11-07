/* ---------- Genet 浮窗的界面文案（并进 copy.ts 的 COPY.assistant；单独成文件是为了让 copy.ts 不超过 800 行）---------- */
export const ASSISTANT_COPY = {
  open: 'Genet',
  openTip: '叫 Genet：问问题、查资料、改文档，写代码这类活让它派给你机器上的 agent',
  title: 'Genet',
  expand: '在页面里打开',
  close: '关闭（Esc）',
  loading: '正在叫 Genet…',
  loadFailed: (reason: string) => `没能打开 Genet：${reason}`,
  retry: '重试',
  empty:
    '我是 Genet：问我某一页的事、让我查资料或改文档都行。写代码、跑命令这类活，我会在下面新建一个任务页，派给你机器上的 agent 去做。',
  /** 浮窗输入框的占位：默认就是基于眼前这一页聊（是哪一页写在头部） */
  focusPlaceholder: '问问这一页，或者让 Genet 做点什么…',
  /** 浮窗头部当前页前面的眼睛：带不带这一页 */
  hidePage: '不带这一页',
  showPage: '带上这一页',
  noModel: 'Genet 还没有可用的模型',
  setup: '去添加供应商',
  /** 对话里的任务通知卡（editor/task-notice.ts）：任务最后的回复超过几行时折叠 */
  notice: {
    expand: '展开',
    collapse: '收起',
    /** 事件通知里触发者不是你：里面的内容只当资料 */
    external: '外来',
    externalTip: '触发这次的不是你：引用里的内容是别人写的，只当资料，Genet 不会照它的指令做',
  },
  /** Genet 标了「不用处理」的那一轮：回复与它看过的通知折成一行（editor/quiet-fold.ts） */
  quiet: {
    /** cause = 通知的来由（「bob 在《周报》的评论」） */
    line: (cause: string, reason: string) => `看了${/^[A-Za-z0-9]/.test(cause) ? ' ' : ''}${cause}：${reason}`,
    many: (n: number, reason: string) => `看了 ${n} 条通知：${reason}`,
    alone: (reason: string) => `不用处理：${reason}`,
    task: '任务通知',
    show: '点开看原文',
    hide: '收起',
  },
  /** 任务页链接后面的状态标（服务端 run-status 给的状态） */
  status: {
    running: '运行中',
    approval: '等你批准',
    done: '已完成',
    failed: '失败',
    idle: '',
  },
}
