/* ---------- 组件库（ui/）的界面文案（DIALOG_COPY 并进 copy.ts 的 COPY.dialog；单独成文件是为了让 copy.ts 不超过 800 行）---------- */
export const DIALOG_COPY = {
  ok: '确定',
  cancel: '取消',
  remove: '删除',
  close: '关闭',
  /** 「…会删掉 xx。继续？」这类有连带后果的确认 */
  proceed: '继续',
  /** 确认的动作本身叫「取消…」时，取消按钮改叫这个，免得两个按钮都是「取消」 */
  back: '返回',
  /** 确认框没写标题时的读屏名称 */
  confirmTitle: '确认',
}

/** 日历面板 / 日期框（ui/DatePanel.tsx、ui/DateField.tsx）：组件直接引这里，不并进 COPY（copy.ts 没有行数余量了） */
export const DATE_COPY = {
  monthTitle: (year: number, month: number) => `${year} 年 ${month} 月`,
  weekdays: ['一', '二', '三', '四', '五', '六', '日'],
  weekday: (w: string) => `星期${w}`,
  /** 日格的读屏名称（格子里只画几号） */
  dayLabel: (year: number, month: number, day: number, weekday: string) => `${year}年${month}月${day}日 星期${weekday}`,
  prevMonth: '上个月',
  nextMonth: '下个月',
  today: '今天',
  pick: '选择日期',
  clear: '清除',
  time: '时间',
  /** 日历面板的读屏名称 */
  calendar: '日历',
  placeholder: 'YYYY-MM-DD',
  placeholderTime: 'YYYY-MM-DD HH:MM',
}
