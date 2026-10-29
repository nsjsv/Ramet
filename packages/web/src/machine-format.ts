import { COPY } from './copy'
import type { MachineScope, MachineUsage } from './machine-api'

/* ---------- 机器授权界面的纯展示函数（范围名 / 剩余时间 / 使用记录的人话）---------- */

const C = COPY.machines

/** 范围的短名，固定顺序（agent 在前）：「agent、终端 / 文件」 */
export function scopesLabel(scopes: readonly MachineScope[]): string {
  return (['agent', 'machine'] as const)
    .filter((s) => scopes.includes(s))
    .map((s) => C.scopeShort[s])
    .join('、')
}

/** 还剩多久到期：天 / 小时 / 分钟三档，已过 = 已过期 */
export function leftLabel(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now
  if (!Number.isFinite(ms) || ms <= 0) return C.left.expired
  const minutes = Math.ceil(ms / 60_000)
  if (minutes >= 60 * 24) return C.left.days(Math.ceil(minutes / (60 * 24)))
  if (minutes >= 60) return C.left.hours(Math.ceil(minutes / 60))
  return C.left.minutes(minutes)
}

/** 绝对时间（悬停提示 / 到期时刻）：10月23日 14:30 */
export function clockLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

/** 毫秒 → mm:ss（倒计时；负数按 0） */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** connector 的 agent id 是 `c:<connectorId>:<原生 id>`，记录里只给人看原生那段 */
function nativeAgent(id: string): string {
  return id.replace(/^c:[^:]+:/, '')
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 使用记录一行的人话：verb 是动作，detail 是补充（命令单独给，好用等宽字体显示） */
export function usageText(u: Pick<MachineUsage, 'action' | 'detail'>): { verb: string; detail: string; code: string } {
  const d = u.detail
  if (u.action === 'run') {
    const agent = nativeAgent(str(d.agent))
    const parts = [agent, d.redo ? C.use.redo : '', d.via === 'run_agent' ? C.use.viaRunAgent : '', str(d.task), str(d.cwd)].filter(Boolean)
    return { verb: C.use.run, detail: parts.join(' · '), code: '' }
  }
  if (u.action === 'answer') {
    const name = str(d.optionName)
    const verb = name ? C.use.answerPick(name) : d.optionId === null ? C.use.deny : C.use.answer
    return { verb, detail: str(d.title), code: str(d.command) }
  }
  if (u.action === 'config') {
    return { verb: C.use.config, detail: `${str(d.configId)} → ${str(d.value)}`, code: '' }
  }
  if (u.action === 'files') {
    const op = str(d.op)
    const verb = op === 'read' ? C.use.fileRead : op === 'diff' ? C.use.fileDiff : C.use.fileOpen
    return { verb, detail: str(d.path), code: '' }
  }
  if (u.action === 'terminal') {
    // 只记打开 / 关闭，每一行输入不记
    const closing = str(d.op) === 'close'
    return { verb: closing ? C.use.termClose : C.use.termOpen, detail: closing ? '' : str(d.root), code: '' }
  }
  if (u.action === 'preview') {
    // 只记共享 / 停止共享，预览的请求本身不记（太多）
    const stopping = str(d.op) === 'stop'
    return { verb: stopping ? C.use.previewStop : C.use.previewShare, detail: typeof d.port === 'number' ? `:${d.port}` : '', code: '' }
  }
  if (u.action === 'quick') {
    // 随手 AI 的本地通道：只记任务类型，不记正文
    return { verb: C.use.quick, detail: [nativeAgent(str(d.agent)), str(d.kind)].filter(Boolean).join(' · '), code: '' }
  }
  return { verb: C.use.unknown(String(u.action)), detail: '', code: '' }
}
