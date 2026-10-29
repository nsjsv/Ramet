/* ---------- 带队里的 agent 显示名：在当前目录（我能用的）里查 ----------
 * 目录里没有（负责人我用不了、机器离线、公开页没拉目录）返回 undefined，调用方回落到计划里记下的名字（TeamTask.label）。 */
import { agentList } from '../default-agent'

export const agentLabel = (agentId: string): string | undefined => agentList().find((a) => a.id === agentId)?.label
