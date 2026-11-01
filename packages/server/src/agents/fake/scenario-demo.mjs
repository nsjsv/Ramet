// 假 agent 剧本里的「过程形状」部分：计划、成串的工具调用、markdown、慢速演示、换段
// （触发词说明见 scenario.mjs 文件头）。

import { CANCELLED, END, sleep } from './common.mjs'

/** 处理了返回这一轮的结局，不是这几种提示词返回 null */
export async function handleDemo(io, s, text) {
  if (text.includes('计划验收')) {
    s.turns += 1
    io.plan([
      { content: '读代码', priority: 'high', status: 'in_progress' },
      { content: '写测试', priority: 'medium', status: 'pending' },
    ])
    await sleep(150)
    io.plan([
      { content: '读代码', priority: 'high', status: 'completed' },
      { content: '写测试', priority: 'medium', status: 'in_progress' },
    ])
    await sleep(150)
    io.say('计划好了')
    return END
  }
  if (text.includes('三十步')) {
    // 先说一句，再连续 32 个工具调用（每个进行中 → 完成），最后一段正文；每步间隔 150ms，取消在任何一步后都认
    s.turns += 1
    io.say('开始逐个检查。')
    for (let i = 1; i <= 32; i++) {
      if (s.cancelled) return CANCELLED
      const id = `many-${i}`
      io.toolStart({ id, title: `读取 file-${i}.ts`, kind: 'read', status: 'in_progress', locations: [{ path: `src/file-${i}.ts` }] })
      await sleep(150)
      io.toolUpdate({ id, status: 'completed' })
    }
    io.say('三十二个文件都检查完了，没有发现问题。\n')
    return END
  }
  if (text.includes('用工具')) {
    // 两次调用：一次只有开始（全量），一次只带 status 的更新（增量），
    // 后者验合并（缺字段不能被默认值打回）。中间 sleep 留出「运行中接第二个 SSE 订阅」的窗口（订阅快照必须带已收集的步骤）
    io.toolStart({ id: 'call-1', title: '读 acp.ts', kind: 'read', status: 'pending', locations: [{ path: 'packages/server/src/agents/acp.ts' }] })
    await sleep(300)
    io.toolUpdate({ id: 'call-1', status: 'in_progress' })
    io.toolStart({ id: 'call-2', title: '跑测试', kind: 'execute', status: 'completed' })
    await sleep(300)
    io.toolUpdate({ id: 'call-1', status: 'completed' })
    io.say('tool-done\n')
    return END
  }
  if (text.includes('markdown')) {
    // 轮次计数照常推进：它是「增量还是全文重放」的判据，漏掉会让下一轮被误判成全量
    s.turns += 1
    // 逐片吐 markdown（流式阶段落成纯段落，轮次结束由服务端重写成块结构）
    for (const piece of ['# 标题\n', '\n', '- 第一项\n', '- 第二项\n', '\n', '**加粗**与`代码`\n', '\n', '[甲](https://a.dev)[乙](https://b.dev)\n', '\n', '```ts\n', 'const a = 1\n', '```\n']) {
      io.say(piece)
    }
    return END
  }
  if (text.includes('演示')) return showcase(io, s)
  if (text.includes('多段')) {
    // 换段 + 思考 + 用量：说一句 → 工具 → 只吐空白（不换段）→ 思考 → 失败的工具 → 新的一段
    io.think('先想想')
    io.say('我先看看')
    io.toolStart({ id: 'm-1', title: '读 doc.ts', kind: 'read', status: 'completed' })
    io.say('\n')
    io.think('再想想')
    io.toolStart({ id: 'm-2', title: '跑测试', kind: 'execute', status: 'pending' })
    io.toolUpdate({ id: 'm-2', status: 'failed', content: [{ text: '\n2 failed · doc.test.ts\n详情' }] })
    io.say('## 结论\n\n')
    io.say('**好了**')
    io.context({ used: 38000, size: 200000 })
    return { stop: 'end_turn', usage: { total: 1500, input: 1000, output: 200, cacheRead: 300 } }
  }
  return null
}

/** 慢速完整流程：思考 → 说一句 → 工具 → 思考 → 结构化的最后一段（实时 markdown / 换段 / 收回） */
async function showcase(io, s) {
  const say = async (str) => {
    for (const piece of str.match(/[\s\S]{1,5}/g)) {
      if (s.cancelled) return false
      io.say(piece)
      await sleep(55)
    }
    return true
  }
  io.think('先看看文档结构，再决定怎么改。')
  await sleep(900)
  if (!(await say('我先看看 `ReplyWriter` 怎么落块，再查收尾在哪条路径上。'))) return CANCELLED
  await sleep(500)
  io.toolStart({ id: 'd-1', title: '搜索 ReplyWriter', kind: 'search', status: 'in_progress' })
  await sleep(900)
  io.toolUpdate({ id: 'd-1', status: 'completed' })
  io.toolStart({ id: 'd-2', title: '读取 agents/doc.ts', kind: 'read', status: 'in_progress', locations: [{ path: 'packages/server/src/agents/doc.ts' }] })
  await sleep(900)
  io.toolUpdate({ id: 'd-2', status: 'completed' })
  for (const t of ['停止和出错两条出口', '都跳过了收尾，', '要挪到共用的地方；', '顺便确认 hash ', '落在最终结构上，', '再补测试。']) {
    io.think(t)
    await sleep(1200)
  }
  if (s.cancelled) return CANCELLED
  const final = '## 原因\n\n停止和出错两条出口都跳过了 `rewrite`。\n\n## 改动\n\n- 收尾挪到三条出口共用的 `finally`\n- 补了 **42** 个测试\n\n| 出口 | 结果 |\n| --- | --- |\n| 正常 | 结构化 |\n| 停止 | 结构化 |\n'
  if (!(await say(final))) return CANCELLED
  io.context({ used: 38000, size: 200000 })
  return { stop: 'end_turn', usage: { total: 13200, input: 9800, output: 1400, cacheRead: 2000, cacheWrite: 0 } }
}
