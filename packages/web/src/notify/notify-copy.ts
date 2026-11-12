/* ---------- 系统通知设置的文案（并进 copy.ts 的 COPY.notify；单独成文件是为了 copy.ts 不超过 800 行）---------- */
import type { ChannelReason } from './notify-model'

export const NOTIFY_COPY = {
  tab: '通知',
  tabDesc: '在这台设备上接收系统通知',
  card: '这台设备',
  toggle: '接收系统通知',
  toggleDesc: '有人 @你、回复你，agent 等你批准、提问或做完时，弹系统通知。你正在用 Ramet 时不弹，这期间的事也不会事后补弹。',
  state: '现在',
  test: '发一条测试通知',
  testing: '发送中…',
  testOk: '已发出，留意系统通知',
  reason: {
    insecure: '要用 https 打开 Ramet，浏览器才允许通知',
    'ios-install': '在 iPhone / iPad 上，要先用 Safari 的「分享 → 添加到主屏幕」，再从主屏幕打开 Ramet 开启通知',
    unsupported: '这个浏览器不支持系统通知',
    disabled: '没有开启',
    denied: '浏览器拒绝了 Ramet 的通知权限。到地址栏左侧的站点设置里把「通知」改成允许，再回来打开',
    'not-granted': '浏览器的通知权限被重置了，请重新打开开关',
    push: '推送已开启：关掉所有 Ramet 标签页也能收到（浏览器本身要开着；手机上浏览器关了也能收到）',
    'no-push': '这个浏览器不支持推送：只在有 Ramet 标签页开着时弹通知',
    'push-unavailable': '这台设备用不了推送（关掉标签页后收不到），改为只在有 Ramet 标签页开着时弹通知',
    'push-failing': '服务器最近没能推送到这台设备，暂时改为只在有 Ramet 标签页开着时弹通知',
    'push-pending': '正在登记推送…',
  } satisfies Record<ChannelReason, string>,
  /** 推送失败的详细原因（浏览器 / 服务端给的） */
  detail: (text: string) => `原因：${text}`,
}
