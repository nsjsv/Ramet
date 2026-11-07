// ---------- Genet 派活时指定模型 / 思考程度 ----------
// Genet 说的是人话（「opus」「高」），agent 的配置项要的是选项值：这里按配置项的 category 找到那一项、宽松地对上一个选项。
// 选中的值经 setSessionConfig 写成任务页的页面级配置（与输入框里的 chip 同一条路：authorize、非主人留痕、落库都在那里），
// 所以任务页上的追问照样用这个模型，chip 显示的也是它。不用消息级覆盖：那个一轮结束就还原，追问会悄悄退回默认模型。
// 只认 model / thought_level 两类：权限模式（mode）从这里够不着，姿态只走受控的会话配置通道。
import { prepareSession, setSessionConfig } from './session-config.js'
import type { ManagerHost } from './manager-types.js'
import type { ConfigOption, ConfigOptionValue } from './types.js'

type User = { id: string; role: string }

export type DispatchCategory = 'model' | 'thought_level'
export type DispatchWant = { model?: string; effort?: string }
/** name = 配置项的名字（模型 / 推理强度…），value = 选中的那一档的显示名 */
export type DispatchApplied = Array<{ name: string; value: string }>
export type DispatchConfigured = { applied: DispatchApplied } | { error: string }

/** id = 配置项 id，value = 选项值，name = 选项的显示名 */
export type PickedOption = { id: string; value: string; name: string }

/** 列给 Genet 的可选值：value（name），它照着 value 重填就能对上 */
const listOf = (choices: ConfigOptionValue[]): string => choices.map((c) => `${c.value}（${c.name}）`).join('、')

/** 按 category 找配置项，再对选项：精确的 value → 不分大小写的 value / name → 不分大小写、唯一一个包含它的 value / name。
 *  多个都对得上算含糊（只列对上的那几个），一个都对不上列出全部 */
export function pickOption(options: ConfigOption[], category: DispatchCategory, want: string): PickedOption | { error: string } {
  const option = options.find((o) => o.category === category)
  if (!option || option.options.length === 0) {
    if (category === 'model') return { error: '这个 agent 不能选模型' }
    // 思考档位通常跟着模型走（有的模型没有）：有模型项时说「当前模型」，Genet 才知道换个模型也许就有
    return { error: options.some((o) => o.category === 'model') ? '当前模型不能调思考程度' : '这个 agent 不能调思考程度' }
  }
  const picked = (c: ConfigOptionValue): PickedOption => ({ id: option.id, value: c.value, name: c.name })
  const exact = option.options.find((c) => c.value === want)
  if (exact) return picked(exact)
  const w = want.toLowerCase()
  const same = option.options.filter((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w)
  const hits = same.length > 0 ? same : option.options.filter((c) => c.value.toLowerCase().includes(w) || c.name.toLowerCase().includes(w))
  if (hits.length === 1) return picked(hits[0]!)
  if (hits.length > 1) return { error: `「${want}」对得上好几个${option.name}：${listOf(hits)}，要说具体是哪一个` }
  return { error: `没有叫「${want}」的${option.name}，可选：${listOf(option.options)}` }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const WHAT: Record<DispatchCategory, string> = { model: '模型', thought_level: '思考程度' }

/** 派活的任务页上先把会话开起来（配置项要有会话才有），再按模型 → 思考程度的顺序改：
 *  思考档位随模型变，所以思考程度对的是换完模型之后 agent 报回来的配置项。
 *  任何一步不成都回 { error }（调用方删掉任务页）；开好的会话 seen 为空，接下来那一轮直接接着用它（runTurn 的 adopt） */
export async function configureDispatch(
  host: ManagerHost,
  pageId: string,
  user: User,
  agentId: string,
  want: DispatchWant,
): Promise<DispatchConfigured> {
  try {
    await prepareSession(host, pageId, agentId, user)
  } catch (err) {
    return { error: `会话开不起来：${message(err)}` }
  }
  // 会话镜像按 catalog id 记（resolve 出来的 id 就是它）：不再 resolve 一遍，机器使用权每一步由 setSessionConfig 自己判
  let options = host.mirror.configs(pageId, agentId)
  const applied: DispatchApplied = []
  const steps: Array<[DispatchCategory, string | undefined]> = [
    ['model', want.model],
    ['thought_level', want.effort],
  ]
  for (const [category, value] of steps) {
    if (!value) continue
    const picked = pickOption(options, category, value)
    if ('error' in picked) return picked
    try {
      options = await setSessionConfig(host, pageId, { agent: agentId, configId: picked.id, value: picked.value }, user)
    } catch (err) {
      return { error: `没能设成「${picked.name}」：${message(err)}` }
    }
    // agent 没抛错但没换过去（自己改回了别的值）：照实失败，不能让那一轮悄悄跑在别的模型上
    const now = options.find((o) => o.id === picked.id)
    if (now?.currentValue !== picked.value) return { error: `${now?.name ?? WHAT[category]}没能设成「${picked.name}」` }
    applied.push({ name: now.name, value: picked.name })
  }
  return { applied }
}
