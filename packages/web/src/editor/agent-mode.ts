// ---------- agent 的权限模式：显示文字、默认档、⇧Tab 轮换（纯函数，无 React / DOM） ----------
// 模式属于 agent：名称、说明、顺序都是它经 ACP 上报的（会话配置项里 category = mode 的那一项），只有 agent 没给名称 / 说明时才退回 COPY.modes.known 的兜底文案。
// ⇧Tab 的轮换顺序就是上报的选项顺序，跳过「跳过全部确认」档（posture.unrestricted）：危险档只能在菜单里明确选，不会被轮换途经。
// 顺序与 agent 自己 CLI 里 Shift+Tab 的循环一致。

import type { ConfigOption, ConfigOptionValue } from '../api'
import { COPY } from '../copy'

export const MODE_CATEGORY = 'mode'

/** 一个档位的显示文字：agent 给的名称 / 说明为准，缺哪项才用已核实档位的兜底文案，再缺就原样显示值 */
export function modeText(option: ConfigOptionValue): { t: string; d: string | null } {
  const known = COPY.modes.known[option.value]
  return { t: option.name || known?.t || option.value, d: option.description || known?.d || null }
}

/** 会话里的 mode 配置项（没有说明 agent 没把权限模式暴露成配置项） */
export function modeOptionOf(options: readonly ConfigOption[]): ConfigOption | undefined {
  return options.find((o) => o.category === MODE_CATEGORY)
}

/** 默认档：agent 有叫 `default` 的档位就是它，否则取上报的第一个。提示行只在离开默认档时出现 */
export function defaultModeValue(option: ConfigOption): string {
  return option.options.find((v) => v.value === 'default')?.value ?? option.options[0]?.value ?? ''
}

/** ⇧Tab 能轮到的档位（按 agent 上报顺序，去掉危险档） */
export function rotatableModes(option: ConfigOption, unrestricted: readonly string[]): ConfigOptionValue[] {
  return option.options.filter((v) => !unrestricted.includes(v.value))
}

/** 下一个档位的值：当前档之后的下一个可轮换档，到头回到第一个。当前在危险档（主人在菜单里选的）或不认识的档位时
 *  回到第一个可轮换档；可轮换的不足两个（没得转）返回 null */
export function nextModeValue(option: ConfigOption, current: string, unrestricted: readonly string[]): string | null {
  const list = rotatableModes(option, unrestricted)
  if (list.length < 2) return null
  const at = list.findIndex((v) => v.value === current)
  return list[(at + 1) % list.length]!.value
}
