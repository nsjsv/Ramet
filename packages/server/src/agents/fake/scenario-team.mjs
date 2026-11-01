// 假 agent 剧本里的带队部分：计划轮 / 组员 / 组长交叉审查三种提示词（触发词说明见 scenario.mjs 文件头）。
// 带队靠 MCP 真调中心的 submit_plan / send_back，所以这里会拉起 Ramet 的 MCP 进程。

import { readFileSync } from 'node:fs'
import { CANCELLED, END, napCancellable } from './common.mjs'
import { mcpToolNames, toolText, withMcp } from './mcp.mjs'

const reportTools = async (io, s) => io.say('tools:' + ((await mcpToolNames(s)) ?? []).join(',') + '\n')

/** 处理了返回这一轮的结局，不是带队的提示词返回 null */
export async function handleTeam(io, s, text) {
  if (text.includes('[Ramet 带队·出计划]')) {
    // 全文重放里有历次的用户消息：只看最后一条 `/带队`
    const last = text.slice(Math.max(0, text.lastIndexOf('>> /带队')))
    const files = [last.match(/PLANFILE=(\S+)/)?.[1], last.match(/PLANFILE2=(\S+)/)?.[1]].filter(Boolean)
    if (files.length === 0) {
      io.say('no-plan\n')
      return END
    }
    for (const file of files) {
      const plan = JSON.parse(readFileSync(file, 'utf8'))
      const res = await withMcp(s, (c) => c.callTool({ name: 'submit_plan', arguments: plan }, undefined, { timeout: 120_000 }))
      io.say((res?.isError ? 'plan-error:' + toolText(res) : 'plan-submitted') + '\n')
    }
    if (text.includes('报工具')) await reportTools(io, s)
    return END
  }
  if (text.includes('[Ramet 带队·组员]')) {
    const taskId = text.match(/任务编号：(\S+)/)?.[1] ?? '?'
    const detail = (text.match(/任务说明：\n([\s\S]*?)(?:\n\n前置任务已经做完|\n\n你上一次交付的结果|$)/)?.[1] ?? '')
    const redo = text.match(/第 (\d+) 次返工/)?.[1]
    const pre = [...text.matchAll(/### 任务 (\S+)「/g)].map((m) => m[1])
    if (detail.includes('工作:出错')) return { error: '假组员按要求出错' }
    const slow = detail.match(/工作:慢(\d+)/)?.[1]
    if (slow && (await napCancellable(s, Number(slow)))) return CANCELLED
    if (detail.includes('工作:审批')) {
      const answer = await io.approve({
        tool: { id: 'w-' + taskId, title: '运行命令', kind: 'execute', input: { command: 'echo ' + taskId } },
        options: [
          { id: 'allow_once', name: '允许', kind: 'allow_once' },
          { id: 'reject_once', name: '拒绝', kind: 'reject_once' },
        ],
      })
      if (s.cancelled) return CANCELLED
      io.say('approved:' + (answer ?? 'cancelled') + '\n')
    }
    if (detail.includes('工作:报目录')) io.say('cwd:' + (s.cwd ?? '?') + '\n')
    if (detail.includes('工作:报工具')) await reportTools(io, s)
    io.say((redo ? `redelivered:${taskId}:${redo}` : `delivered:${taskId}`) + (pre.length > 0 ? ' pre:' + pre.join(',') : '') + '\n')
    return END
  }
  if (text.includes('[Ramet 带队·交叉审查]')) {
    const tail = text.slice(text.lastIndexOf('[Ramet 带队·交叉审查]'))
    const status = [...tail.matchAll(/### 任务 (\S+)「.*?」· 负责人 .*? · (已交付|出错|没有执行|已取消|没有做完)/g)].map((m) => `${m[1]}=${m[2]}`)
    io.say('review:' + status.join(';') + '\n')
    const back = tail.match(/SENDBACK=(\S+?)x(\d+)/)
    if (back) {
      for (let i = 0; i < Number(back[2]); i++) {
        const res = await withMcp(s, (c) => c.callTool({ name: 'send_back', arguments: { taskId: back[1], feedback: '请改进第 ' + (i + 1) + ' 版' } }, undefined, { timeout: 120_000 }))
        const body = toolText(res ?? { content: [] })
        io.say((res?.isError ? 'sb-error:' : 'sb:') + body.replace(/\n/g, ' ') + '\n')
      }
    }
    if (text.includes('报工具')) await reportTools(io, s)
    // 目标里有 `审查等待<毫秒>`：审查完不马上收尾（认取消），测试趁这段时间拿这一轮的凭证直接打端点
    const hold = tail.match(/审查等待(\d+)/)?.[1]
    if (hold && (await napCancellable(s, Number(hold)))) return CANCELLED
    return END
  }
  return null
}
