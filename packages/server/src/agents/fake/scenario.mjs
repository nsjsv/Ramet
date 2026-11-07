// 假 agent 的剧本：按提示词里的触发词决定这一轮做什么，与协议无关。
// 协议编码层（claude.mjs = Claude Code 的 stream-json；codex.mjs = codex app-server；pi-rpc.mjs = pi / omp 的 rpc 模式）
// 把剧本发出的「动作」翻成各自协议的帧，剧本只认动作，不认协议字段。测试用；刻意写成纯 JS（在没有 tsx 的地方也能 node 直跑）。
//
// 触发词（含哪个词就走哪条；先后顺序即判定顺序，带队的三条最先）：
//   含「需要权限」 → 要一次审批，应答结果回显 'granted:<optionId|cancelled>'
//                  默认审批带命令预览（input.command）；另含「审批改文件」= 带 diff + 路径，「审批无预览」= 只有标题；
//                  「审批可总是」= 多一个「总是允许」选项（原生协议里是 permission_suggestions），再含「审批禁总是」= 同时声明
//                  不许给「总是」（suppress_always_allow_rule）；「审批默认拒」= 声明不许一键批准（default_to_no）
//   含「三十步」   → 32 个连续工具调用（每步 150ms），测运行条封顶与正文位置稳定
//   含「用工具」   → 两次工具调用 + 两次更新（含只有 status 的增量），再输出 'tool-done'（测过程事件合并与归档）
//   含「计划验收」 → 先报一份计划（读代码 进行中 / 写测试 待办），再报更新后的整份（读代码 完成 / 写测试 进行中），
//                  最后回 '计划好了'（测计划作为 run 原语整份替换，并随回复块的 plan 属性落盘）
//   含「markdown」 → 分片吐 markdown（标题/列表/加粗/行内代码/代码块），测轮次结束的块结构重写
//   含「慢慢来」   → 分 10 片慢速输出（测 stop 取消）
//   含「断线续」   → 先吐 before，睡 8 秒，再吐 after（测中心重启后续上；取消在睡眠里认）
//   含「报目录」   → 先回一行 `cwd:<新建会话时收到的 cwd>`（测工作区覆盖真的传到了 agent）
//   含「报 MCP」   → 回 `mcp:<name> <脚本名> <中心地址>`（测 read_page 真的随会话交到 agent）
//   含「报引用」   → 回 `res:<resource 块数>`（测 @/[[ 不整页粘贴：引用页正文不进 prompt）
//   含「回显提示词」→ 把收到的提示词文字包进代码块原样回复（测块引用解析：agent 拿到的是原块当前内容）
//   否则          → 输出 'turn:full|delta'（全文重放里同时含两问文本；增量只有最后一问）
//   含「失败」     → 以错误收尾（测本轮失败）；「失败一次」= 同一段提示词只失败第一次（测重试）
//   含「[Ramet 续跑]」→ 续跑说明（先于除带队外的所有触发词判定：说明里会带上失败原因、兜底的全文里有原来的消息）：
//                  一次工具调用（resume-tool）后回 `resumed@<会话 id> load:<恢复自哪个会话|no>`；另含「回显提示词」= 再把提示词包进代码块；
//                  另含「续跑慢」= 先吐 resume-before，睡 8 秒（认取消）再接着做（测远端续跑跨中心重启）
//   含「中途断开」 → 一次工具调用（mid-tool）+ 正文「写到一半」，然后以错误收尾（测续跑：中断前的步骤与半截正文）；
//                  另含「续跑慢」时失败原因里带上它（续跑说明会转述原因，假 agent 据此走慢路径）
//   含「进程退出」 → 一次工具调用（crash-tool）+ 正文「退出前」，然后 agent 进程直接退出（测续跑：适配器重启后先加载会话）
//   带队（/带队，测试靠 MCP 真调中心的 submit_plan / send_back；这几条都先于下面所有触发词判定，见 scenario-team.mjs）：
//   含「[Ramet 带队·出计划]」 → 计划轮：读用户消息里 `PLANFILE=<json 文件路径>`（文件内容 = submit_plan 的参数；多份用 `PLANFILE2=` 再交一次覆盖），
//                  经 MCP 调 submit_plan，回显 `plan-submitted` / `plan-error:<原因>`；没有 PLANFILE 则回 `no-plan`；`报工具` 回显组长此刻的 MCP 工具名
//   含「[Ramet 带队·组员]」 → 组员：任务编号取 `任务编号：<id>`，行为看「任务说明」里的词：`工作:慢<毫秒>`（慢速、认取消）/ `工作:出错`（错误收尾）/
//                  `工作:审批`（先要一次审批，回显 approved:<optionId|cancelled>）/ `工作:报目录`（回显 cwd:<会话目录>）/ `工作:报工具`（回显 MCP 工具名）；
//                  默认回 `delivered:<id>`（返工的是 `redelivered:<id>:<第几次>`，带前置结果的追加 ` pre:<前置任务 id>`）
//   含「[Ramet 带队·交叉审查]」 → 组长：回显每个任务的状态 `review:<id>=<已交付|出错|没有执行|已取消>;…`；目标里有 `SENDBACK=<id>x<次数>` 就经 MCP 连调那么多次 send_back，
//                  回显每次的结果 `sb:<outcome>:<output>`，被拒回显 `sb-error:<原因>`；`报工具` 回显组长此刻的 MCP 工具名；
//                  目标里有 `审查等待<毫秒>` = 审查完再睡这么久才收尾（认取消）
//   含「报工具」   → 回显本会话 MCP 的工具名 `tools:<a,b,c>`（测 submit_plan / send_back 只在带队组长的凭证里）
//   含「退出计划」 → 发 claude ExitPlanMode 形状的审批（带 exit-plan-bypass 选项）；答后只让 agent 自己切 mode
//                  （不推整套配置），回显 'plan-exit:<optionId>'
//   含「后台审批」 → 发一条审批但不等它，这一轮立刻正常结束（审批比 prompt 活得久：测 busy 含待批）
//   含「报后台审批」→ 回显那条后台审批的应答结果 'bg:<optionId|cancelled|pending>'（审批发出过而应答还在路上时最多等 1 秒：
//                  客户端写出应答和紧跟着的下一条 prompt 没有先后保证，不等会随机回 pending）
//   含「报视图」   → 回 `view:<用户消息行数>:<回复行数>@<会话 id>`（数提示词里 '>> ' / '> ' 开头的行：测重新生成时
//                  agent 看到的「视图」只有目标回复之前的内容；会话 id 证明重做新建了会话）
//   含「随手审批」 → 要一次审批（allow_once / reject_once），回显 `perm:<optionId|cancelled>`
//   含「报图片」   → 回显这一轮 prompt 里的图片块 `images:<块数>:<mimeType,…>`
//   含「随手工具」 → 发一个工具调用（不经审批），睡 3 秒（认取消）再回显 'tool-ran'（测 ⌘J 见到工具调用就中止）
//   提问（表单；协议层不支持表单时一律回显 `ask:unsupported`、不发）：
//   含「表单提问:<形状>」 → 按各家 agent 的形状发一张表单（形状见 ASK_SHAPES：claude / codex / opencode / omp / omp-select /
//                  omp-confirm / weird），带 toolCallId 的先发对应的工具调用；回显 `ask:<action>:<content JSON>`
//   含「表单撤回」 → 发一张表单，300ms 后撤回它，回显 `ask-withdrawn:<宿主的应答 action>`
//   含「表单超时」 → 发一张表单不等应答就收尾（omp 超时后不通知客户端）；「报表单超时」回显那张表单迟到的应答 `ask-late:<action|pending>`
//   含「随手慢」   → 约 20 秒慢速输出（认取消；测 ⌘J 的超时）
//   含「报会话」   → 回 `session:<会话 id> resumed:<恢复自哪个会话|no> prior:<此前已有的轮数>`（测原生驱动的 resume 只发新消息）
//   含「审批模式」 → 回 `perm-mode:<当前 mode> model:<当前模型>`（测切模式 / 切模型下一轮生效）
//   协议层声明了 caps.subagents / caps.questions 才认的（pi 没有子代理和多题提问）：
//   含「起子代理」 → 起一个子代理（Agent 工具），子代理里两步工具（带归属），回显 `subagent:<completed|stopped>`；
//                  「起子代理慢」= 每步 1.5 秒（留时间单独停掉这个子代理，主回合照常收尾）；
//                  「起子代理审批」= 子代理的第一步先要一次审批（审批的工具带归属），拒绝 / 取消就停在这一步，
//                  回显前多一行 `sub-perm:<optionId|cancelled>`
//   含「提问」（不含「表单提问」）→ 两道题（其中一道多选），回显 `answers:<答案 JSON>` / `answers:declined` / `answers:cancelled`；
//                  协议层声明 caps.secretQuestions 时多一道密码类的题（codex 的 isSecret）
//   协议层声明 caps.permissionProfiles 时：「需要权限」+「审批要权限」= 要的是权限（网络）而不是跑命令（codex 的 permissions 审批）
//
// 动作（io 由协议层提供）：
//   io.say(text, parentId?) / io.think(text, parentId?)        正文 / 思考分片；parentId = 归属的父工具（子代理）
//   io.toolStart(t) / io.toolUpdate(t)                          t = { id, name?, title?, kind?, status?, locations?, input?, output?,
//                                                               content?: [{text}|{diff:{path,old,new}}], meta?, parentId? }
//   io.plan(entries) / io.context({used,size,cost?,meta?}) / io.mode(modeId)
//   io.approve({ tool, options }) → optionId | null（null = 取消）；options = [{ id, name, kind, mode? }]
//   io.elicit(form) → { answer: Promise<{action, content}|null>, withdraw() }；io.caps.elicitForm 为假时不许调
//   io.task({ op: 'start'|'progress'|'end', id, toolId, ... }) / io.ask(questions)   只有原生协议有
// 一轮的结局（runTurn 的返回值）：{ stop: 'end_turn'|'cancelled', usage?, meta? } 或 { error: '<原因>' }。

import { CANCELLED, END, sleep } from './common.mjs'
import { mcpToolNames } from './mcp.mjs'
import { handleDemo } from './scenario-demo.mjs'
import { handleTeam } from './scenario-team.mjs'

/** 每个会话独立的 config 状态（model / thinking 各两档 + mode） */
export function defaultConfigs() {
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1',
      options: [
        { value: 'm1', name: 'M1' },
        { value: 'm2', name: 'M2' },
      ],
    },
    {
      id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: process.env.FAKE_MODE ?? 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'bypassPermissions', name: 'Bypass permissions' },
      ],
    },
  ]
}

/** 会话状态：协议层建、剧本读写。mcp = [{ name, command, args, env: {名: 值} }]（各协议的 MCP 配置归一成这个形状） */
export function newSession({ id, cwd, mcp, foreign = false, configs = defaultConfigs() }) {
  return { id, cwd, mcp: mcp ?? [], configs, turns: 0, cancelled: false, foreign, stoppedTasks: new Set() }
}

/** 斜杠命令清单：命令名由启动参数 / 环境变量给（没给 = 不推命令）；withArg 时多一条带参命令，测命令参数透传 */
export function commandList(name, withArg) {
  if (!name) return []
  return [
    { name, description: name + ' 命令' },
    ...(withArg ? [{ name: name + '-arg', description: name + ' 带参命令', hint: '参数' }] : []),
  ]
}

const configValue = (s, id) => s.configs.find((c) => c.id === id)?.currentValue

/** 各家 agent 的提问形状（MCP elicitation 的 requestedSchema，见 agents/ask-form.ts 文件头） */
export const ASK_SHAPES = {
  claude: {
    toolCallId: 'ask-claude', message: '用哪个包管理器？',
    requestedSchema: { type: 'object', properties: {
      question_0: { type: 'string', title: '包管理器', oneOf: [{ const: 'npm', title: 'npm', description: '默认' }, { const: 'pnpm', title: 'pnpm' }] },
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer (optional).' },
      question_1: { type: 'array', title: '功能', description: '要哪些功能？', items: { anyOf: [{ const: 'lint', title: 'Lint' }, { const: 'test', title: 'Test' }] } },
    } },
  },
  codex: {
    toolCallId: 'ask-codex', message: 'Codex needs your input to continue.',
    requestedSchema: { type: 'object', required: ['env', 'token'], properties: {
      env: { type: 'string', title: '部署到哪？', oneOf: [{ const: 'staging', title: 'staging' }, { const: 'None of the above', title: 'None of the above' }] },
      env_note: { type: 'string', title: 'Additional answer or note', _meta: { codex: { questionId: 'env', role: 'user_note' } } },
      token: { type: 'string', title: 'API token', _meta: { codex: { isSecret: true } } },
    } },
  },
  opencode: {
    toolCallId: 'ask-opencode', message: 'Which package manager?',
    requestedSchema: { type: 'object', required: ['pm'], properties: {
      pm: { type: 'string', title: 'Package manager', oneOf: [{ const: 'bun', title: 'Bun' }, { const: 'npm', title: 'npm' }] },
      pm_custom: { type: 'string', title: 'Custom answer' },
    } },
  },
  omp: {
    message: '选一个方案',
    requestedSchema: { type: 'object', properties: {
      q0: { type: 'string', title: '方案', oneOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }], default: 'A' },
      q0__other: { type: 'string' },
      q1: { type: 'string', description: 'editor', default: 'line1\nline2' },
    } },
  },
  'omp-select': { message: 'Approve tool call: bash', requestedSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string', enum: ['Approve', 'Deny'] } } } },
  'omp-confirm': { message: '继续吗？', requestedSchema: { type: 'object', required: ['value'], properties: { value: { type: 'boolean' } } } },
  // 必填字段的类型认不出：客户端应直接回 cancel
  weird: { message: '怪表单', requestedSchema: { type: 'object', required: ['x'], properties: { x: { type: 'object' } } } },
}

const ALLOW_REJECT = [
  { id: 'allow_once', name: '允许', kind: 'allow_once' },
  { id: 'reject_once', name: '拒绝', kind: 'reject_once' },
]
export const approveOptions = () => ALLOW_REJECT.map((o) => ({ ...o }))

/** 跨会话的进程级状态（同一个 agent 进程里多个会话共用） */
const failedOnce = new Set()
let bgOutcome = null
let bgAsked = false
let lateAsk = null

/** 续跑说明：确认一步再回会话 id 与是否经过加载（证明接着的是原来那个会话） */
async function resumeTurn(io, s, text) {
  s.turns += 1
  if (text.includes('续跑慢')) {
    io.say('resume-before\n')
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (s.cancelled) return CANCELLED
      await sleep(100)
    }
  }
  io.toolStart({ id: 'resume-tool', title: '确认中断那一步', kind: 'read', status: 'in_progress' })
  io.toolUpdate({ id: 'resume-tool', status: 'completed' })
  io.say(`resumed@${s.id} load:${s.resumedFrom ?? 'no'}\n`)
  if (text.includes('回显提示词')) io.say('````\n' + text + '\n````\n')
  return END
}

/** 一轮：text = 提示词文字（各文字块以换行拼接），blocks = 提示词块（{type:'text'|'image'|'resource', mimeType?}） */
export async function runTurn(io, s, text, blocks) {
  s.cancelled = false // 新一轮重置取消标记（取消只作用于在飞轮次）
  const team = await handleTeam(io, s, text)
  if (team) return team
  if (text.includes('[Ramet 续跑]')) return resumeTurn(io, s, text)
  if (text.includes('中途断开') || text.includes('进程退出')) {
    const crash = text.includes('进程退出')
    const id = crash ? 'crash-tool' : 'mid-tool'
    io.toolStart({ id, title: '读 notes.md', kind: 'read', status: 'in_progress', locations: [{ path: 'notes.md' }] })
    io.toolUpdate({ id, status: 'completed' })
    io.say(crash ? '退出前' : '写到一半')
    // 留时间让宿主收下上面的事件（进程一退，没读走的帧就没了）
    await sleep(200)
    if (crash) process.exit(1)
    return { error: '假 agent 中途断开' + (text.includes('续跑慢') ? '（续跑慢）' : '') }
  }
  if (text.includes('报工具')) {
    io.say('tools:' + ((await mcpToolNames(s)) ?? []).join(',') + '\n')
    return END
  }
  if (text.includes('失败')) {
    const once = text.includes('失败一次')
    if (!once || !failedOnce.has(text)) {
      failedOnce.add(text)
      return { error: '假 agent 按要求失败' }
    }
  }
  if (text.includes('报图片')) {
    const imgs = blocks.filter((b) => b.type === 'image')
    io.say(`images:${imgs.length}:${imgs.map((b) => b.mimeType).join(',')}\n`)
    return END
  }
  const asks = await handleAsk(io, text)
  if (asks) return asks
  if (text.includes('随手审批')) {
    const answer = await io.approve({
      tool: { id: 'q1', title: '运行命令', kind: 'execute', input: { command: 'rm -rf /tmp/x' } },
      options: approveOptions(),
    })
    io.say('perm:' + (answer ?? 'cancelled') + '\n')
    return END
  }
  if (text.includes('随手工具')) {
    io.toolStart({ id: 'q-tool', title: '读文件', kind: 'read', status: 'in_progress' })
    const until = Date.now() + 3000
    while (Date.now() < until) {
      if (s.cancelled) return CANCELLED
      await sleep(50)
    }
    io.say('tool-ran\n')
    return END
  }
  if (text.includes('随手慢')) {
    const until = Date.now() + 20000
    while (Date.now() < until) {
      if (s.cancelled) return CANCELLED
      io.say('s')
      await sleep(100)
    }
    return END
  }
  if (text.includes('退出计划')) {
    const answer = await io.approve({
      tool: { id: 'plan-1', title: '退出计划模式', kind: 'switch_mode' },
      options: [
        { id: 'exit-plan-bypass', name: '跳过全部确认并开始', kind: 'allow_always', mode: 'bypassPermissions' },
        { id: 'exit-plan-default', name: '逐步确认并开始', kind: 'allow_once', mode: 'default' },
        { id: 'reject', name: '继续规划', kind: 'reject_once' },
      ],
    })
    if (s.cancelled || answer === null) return CANCELLED
    const to = { 'exit-plan-bypass': 'bypassPermissions', 'exit-plan-default': 'default' }[answer]
    if (to) {
      // 真 agent 的 ExitPlanMode 就是这样：只有 agent 自己切 mode，不推整套配置
      const opt = s.configs.find((c) => c.id === 'mode')
      if (opt) opt.currentValue = to
      io.mode(to)
    }
    io.say('plan-exit:' + answer + '\n')
    return END
  }
  if (text.includes('报后台审批')) {
    for (let i = 0; i < 100 && bgOutcome === null && bgAsked; i++) await sleep(10)
    io.say('bg:' + (bgOutcome ?? 'pending') + '\n')
    return END
  }
  if (text.includes('后台审批')) {
    // 不 await：这一轮立刻正常结束，审批还挂着（答复到达时只记下结果）
    bgAsked = true
    void io.approve({ tool: { id: 'bg-1', title: '后台任务', kind: 'execute' }, options: approveOptions() }).then((answer) => {
      bgOutcome = answer ?? 'cancelled'
    })
    io.say('bg-started\n')
    return END
  }
  if (text.includes('报视图')) {
    s.turns += 1 // 轮次计数照常推进：它是「增量还是全文重放」的判据
    const lines = text.split('\n')
    io.say(`view:${lines.filter((l) => l.startsWith('>> ')).length}:${lines.filter((l) => l.startsWith('> ')).length}@${s.id}\n`)
    return END
  }
  if (text.includes('需要权限')) {
    const tool = text.includes('审批改文件')
      ? {
          id: 't1', title: '修改 src/app.ts', kind: 'edit',
          locations: [{ path: 'src/app.ts', line: 12 }],
          content: [{ diff: { path: 'src/app.ts', old: 'const port = 3000', new: 'const port = Number(process.env.PORT ?? 3000)' } }],
        }
      : text.includes('审批无预览')
        ? { id: 't1', title: '写文件', kind: 'edit' }
        : { id: 't1', title: '运行命令', kind: 'execute', input: { command: 'npm test -- --run', description: '跑一遍单元测试' } }
    // 原生协议才有的「要权限」审批（codex 的 item/permissions/requestApproval）：其它协议不认这个词
    if (io.caps.permissionProfiles && text.includes('审批要权限')) Object.assign(tool, { title: '访问网络', kind: 'fetch', permissions: { network: true }, input: undefined })
    const options = approveOptions()
    if (text.includes('审批可总是')) options.splice(1, 0, { id: 'allow_always', name: '总是允许', kind: 'allow_always' })
    if (text.includes('审批禁总是')) tool.suppressAlways = true
    if (text.includes('审批默认拒')) tool.defaultToNo = true
    const answer = await io.approve({ tool, options })
    if (s.cancelled) return CANCELLED
    io.say('granted:' + (answer ?? 'cancelled') + '\n')
    return END
  }
  const demo = await handleDemo(io, s, text)
  if (demo) return demo
  return handleTail(io, s, text, blocks)
}

/** 表单提问 / 撤回 / 超时，以及原生协议才有的多题提问 */
async function handleAsk(io, text) {
  if (/表单提问|表单撤回|表单超时/.test(text) && !io.caps.elicitForm) {
    io.say('ask:unsupported\n')
    return END
  }
  const shape = text.match(/表单提问:([\w-]+)/)?.[1]
  if (shape && ASK_SHAPES[shape]) {
    const form = ASK_SHAPES[shape]
    // 真 agent（claude / codex / opencode）先发工具调用，提问挂在它上面
    if (form.toolCallId) io.toolStart({ id: form.toolCallId, title: form.message, kind: 'other', status: 'pending' })
    const r = await io.elicit(form).answer
    if (form.toolCallId) io.toolUpdate({ id: form.toolCallId, status: 'completed' })
    io.say('ask:' + (r?.action ?? 'error') + ':' + JSON.stringify(r?.content ?? null) + '\n')
    return END
  }
  if (text.includes('表单撤回')) {
    const ask = io.elicit(ASK_SHAPES.opencode)
    await sleep(300)
    ask.withdraw()
    const r = await ask.answer
    io.say('ask-withdrawn:' + (r?.action ?? 'error') + '\n')
    return END
  }
  if (text.includes('报表单超时')) {
    for (let i = 0; i < 100 && lateAsk === null; i++) await sleep(10)
    io.say('ask-late:' + (lateAsk ?? 'pending') + '\n')
    return END
  }
  if (text.includes('表单超时')) {
    void io.elicit(ASK_SHAPES['omp-select']).answer.then((r) => {
      lateAsk = r?.action ?? 'error'
    })
    io.say('ask-timeout\n')
    return END
  }
  if (io.caps.questions && /(?<!表单)提问/.test(text)) {
    const answers = await io.ask([
      {
        question: '用哪个包管理器？', header: '包管理器', multiSelect: false,
        options: [{ label: 'npm', description: '默认' }, { label: 'pnpm', description: '更快' }],
      },
      {
        question: '要哪些功能？', header: '功能', multiSelect: true,
        options: [{ label: 'Lint', description: '代码检查' }, { label: 'Test', description: '单元测试' }, { label: 'Docs', description: '文档' }],
      },
      // 密码类的题（codex 的 isSecret）：只有声明了 caps.secretQuestions 的协议才问
      ...(io.caps.secretQuestions ? [{ question: 'API token？', header: 'Token', multiSelect: false, secret: true, options: [] }] : []),
    ])
    if (answers === null) return CANCELLED
    io.say('answers:' + (answers.declined ? 'declined' : JSON.stringify(answers)) + '\n')
    return END
  }
  return null
}

/** 起一个子代理：Agent 工具 + 子代理生命周期 + 子代理里的两步工具（都带归属） */
async function subagent(io, s, text) {
  const n = s.turns + 1
  const toolId = `toolu_agent_${n}`
  const taskId = `task-${n}`
  const description = '查收尾出口'
  const prompt = '找出 run-finalize 的收尾出口'
  const stepMs = text.includes('起子代理慢') ? 1500 : 30
  s.turns += 1
  io.toolStart({ id: toolId, name: 'Agent', title: description, kind: 'think', status: 'in_progress', input: { description, prompt, subagent_type: 'Explore' } })
  io.task({ op: 'start', id: taskId, toolId, description, subagentType: 'Explore', prompt })
  io.say('子代理：开始查找。', toolId)
  const steps = [
    { name: 'Read', title: '读取 run-finalize.ts', kind: 'read', input: { file_path: 'src/run-finalize.ts' }, result: '共 80 行' },
    { name: 'Bash', title: 'grep -n finally', kind: 'execute', input: { command: 'grep -n finally src/run-finalize.ts' }, result: '12: finally {' },
  ]
  const stopped = () => s.stoppedTasks.has(taskId)
  let done = 0
  let permAnswer = null
  for (const [i, st] of steps.entries()) {
    if (s.cancelled || stopped()) break
    const id = `${toolId}_s${i + 1}`
    io.toolStart({ id, name: st.name, title: st.title, kind: st.kind, status: 'in_progress', input: st.input, parentId: toolId })
    if (i === 0 && text.includes('起子代理审批')) {
      const answer = await io.approve({ tool: { id, name: st.name, title: st.title, kind: st.kind, input: st.input, parentId: toolId }, options: approveOptions() })
      permAnswer = answer ?? 'cancelled'
      if (!answer?.startsWith('allow')) {
        io.toolUpdate({ id, status: 'failed', content: [{ text: 'blocked by user' }], parentId: toolId })
        break
      }
    }
    const until = Date.now() + stepMs
    while (Date.now() < until && !s.cancelled && !stopped()) await sleep(20)
    if (s.cancelled || stopped()) {
      io.toolUpdate({ id, status: 'failed', content: [{ text: 'stopped' }], parentId: toolId })
      break
    }
    io.toolUpdate({ id, status: 'completed', content: [{ text: st.result }], parentId: toolId })
    done += 1
    io.task({ op: 'progress', id: taskId, toolId, description, subagentType: 'Explore', toolUses: done, lastTool: st.name })
  }
  const outcome = s.cancelled || stopped() ? 'stopped' : 'completed'
  const summary = outcome === 'completed' ? '收尾只有 close() 一条出口' : '子代理已停止'
  io.task({ op: 'end', id: taskId, toolId, status: outcome, summary, toolUses: done })
  io.toolUpdate({ id: toolId, status: outcome === 'completed' ? 'completed' : 'failed', content: [{ text: summary }], output: { status: outcome, summary } })
  if (s.cancelled) return CANCELLED
  if (permAnswer !== null) io.say(`sub-perm:${permAnswer}\n`)
  io.say(`subagent:${outcome}\n`)
  return END
}

/** 余下的触发词与缺省回复 */
async function handleTail(io, s, text, blocks) {
  if (io.caps.subagents && text.includes('起子代理')) return subagent(io, s, text)
  if (text.includes('慢慢来')) {
    for (let i = 0; i < 10; i++) {
      if (s.cancelled) return CANCELLED
      io.say(`piece${i}\n`)
      await sleep(150)
    }
    return END
  }
  if (text.includes('断线续')) {
    // 8 秒窗口给「关掉中心再拉起」留时间。睡眠里认取消，别把 after 吐出去。
    io.say('before\n')
    const until = Date.now() + 8000
    while (Date.now() < until) {
      if (s.cancelled) return CANCELLED
      await sleep(100)
    }
    if (s.cancelled) return CANCELLED
    io.say('after\n')
    return END
  }
  if (text.includes('报 MCP')) {
    // 收到的 MCP 配置回显：只回工具名、脚本名、中心地址与环境变量名
    // （回复会落进文档正文，那是别人能读到的地方，凭证值/日志不进去）
    const one = s.mcp[0]
    const env = one?.env ?? {}
    const url = env.RAMET_PAGE_URL ?? '?'
    io.say(`mcp:${one?.name ?? 'none'} ${(one?.args?.[0] ?? '?').split('/').pop()} ${url} env:${Object.keys(env).join(',')}\n`)
    return END
  }
  if (text.includes('报 mcp 命令')) {
    // MCP 配置里的 command/args 原样回显：验「命令是执行端自己拼的」
    // （本地 agent 拿到的必须是中心进程的 process.execPath 与仓库里那份脚本；connector 拿到的必须是它自己的）
    const one = s.mcp[0]
    io.say(`cmd:${one?.command ?? '?'} args:${(one?.args ?? []).join(',')}\n`)
    return END
  }
  if (text.includes('回显提示词')) {
    // 提示词原样包进代码块（四个反引号，正文里的三引号围栏不会提前闭合）：落文档后逐字保留，测 agent 拿到的内容
    io.say('````\n' + text + '\n````\n')
    return END
  }
  if (text.includes('报引用')) {
    // 提示词里 resource 块的数量：被 @ 的页面正文不进 prompt
    io.say('res:' + blocks.filter((b) => b.type === 'resource').length + '\n')
    return END
  }
  if (text.includes('报会话')) {
    io.say(`session:${s.id} resumed:${s.resumedFrom ?? 'no'} prior:${s.turns}\n`)
    s.turns += 1
    return END
  }
  if (text.includes('审批模式')) {
    io.say(`perm-mode:${configValue(s, 'mode')} model:${configValue(s, 'model')}\n`)
    s.turns += 1
    return END
  }
  // 首轮必是全文重放（新会话）；后续同一会话的轮次是增量
  s.turns += 1
  const cfg = s.configs.map((c) => `${c.id}=${c.currentValue}`).join(' ')
  if (text.includes('报目录')) io.say('cwd:' + (s.cwd ?? '?') + '\n')
  io.say('turn:' + (s.turns === 1 ? 'full' : 'delta') + (cfg ? ' ' + cfg : '') + '\n')
  return END
}
