/* ---------- 权限模式与机器主人（纯函数，不起服务）----------
 * 「跳过全部确认」只能由机器主人进入；所有会把会话送进该档、或在该档下执行的入口
 * （set-config / answer / run）走同一个 authorize()。表里没有的 agent，mode 不可改。 */
import { expect, test } from 'vitest'
import { agentPosture, authorize, ForbiddenError, ModeUnsupportedError } from './posture.js'

const admin = { id: 'u-admin', role: 'admin' }
const member = { id: 'u-member', role: 'user' }
const pairer = { id: 'u-pairer', role: 'user' }

const local = (id: string) => ({ local: { id, label: id, command: 'x' } })
/** agentId 是 connector 上报的原始 id（不带 c:<connectorId>: 前缀） */
const remote = (agentId: string, ownerId: string | null) => ({
  remote: { connectorId: 'c1', agentId, defaultCwd: '/', ownerId },
})

const setMode = (value: string) => ({ kind: 'set-config', category: 'mode', value }) as const

test('set-config：非主人把 mode 设成「跳过全部确认」→ Forbidden；主人可以；其它值谁都行', () => {
  expect(() => authorize(member, local('claude'), setMode('bypassPermissions'))).toThrow(ForbiddenError)
  expect(() => authorize(admin, local('claude'), setMode('bypassPermissions'))).not.toThrow()
  expect(() => authorize(member, local('claude'), setMode('plan'))).not.toThrow()
  expect(() => authorize(member, local('codex'), setMode('agent-full-access'))).toThrow(ForbiddenError)
  expect(() => authorize(admin, local('codex'), setMode('agent-full-access'))).not.toThrow()
})

test('set-config：表外 agent 改 mode → ModeUnsupported；非 mode 类配置不受影响', () => {
  for (const id of ['gemini', 'pi', 'my-custom-agent']) {
    expect(() => authorize(admin, local(id), setMode('whatever'))).toThrow(ModeUnsupportedError)
    expect(() => authorize(admin, local(id), { kind: 'set-config', category: 'model', value: 'x' })).not.toThrow()
    expect(() => authorize(admin, local(id), { kind: 'set-config', category: undefined, value: 'x' })).not.toThrow()
  }
  // omp / opencode 没有免审批档，mode 可改、没有要拦的值
  expect(() => authorize(member, local('omp'), setMode('plan'))).not.toThrow()
  expect(() => authorize(member, local('opencode'), setMode('build'))).not.toThrow()
})

test('answer：选项会把会话切进该档（elevating）时非主人 → Forbidden；取消 / 普通选项不拦', () => {
  for (const optionId of ['exit-plan-bypass', 'exit-plan-clear-bypass']) {
    expect(() => authorize(member, local('claude'), { kind: 'answer', optionId })).toThrow(ForbiddenError)
    expect(() => authorize(admin, local('claude'), { kind: 'answer', optionId })).not.toThrow()
  }
  expect(() => authorize(member, local('claude'), { kind: 'answer', optionId: 'exit-plan-default' })).not.toThrow()
  expect(() => authorize(member, local('claude'), { kind: 'answer', optionId: null })).not.toThrow()
  // 同名选项在表外 agent 上不认（不猜）；codex 没有 elevating 选项
  expect(() => authorize(member, local('gemini'), { kind: 'answer', optionId: 'exit-plan-bypass' })).not.toThrow()
  expect(() => authorize(member, local('codex'), { kind: 'answer', optionId: 'exit-plan-bypass' })).not.toThrow()
})

test('run：会话此刻在该档且发起人不是主人 → Forbidden（带可读原因）；主人、其它 mode、表外 agent 都放行', () => {
  expect(() => authorize(member, local('claude'), { kind: 'run', mode: 'bypassPermissions' })).toThrow(/只有机器主人能发起/)
  expect(() => authorize(admin, local('claude'), { kind: 'run', mode: 'bypassPermissions' })).not.toThrow()
  expect(() => authorize(member, local('claude'), { kind: 'run', mode: 'default' })).not.toThrow()
  expect(() => authorize(member, local('claude'), { kind: 'run', mode: undefined })).not.toThrow()
  expect(() => authorize(member, local('gemini'), { kind: 'run', mode: 'bypassPermissions' })).not.toThrow()
})

test('机器主人：本机 agent = admin；connector agent = 配对人，admin 也不是（老 connector 没有主人 → 谁都不是）', () => {
  const owned = remote('claude', pairer.id)
  expect(agentPosture(pairer, owned).owner).toBe(true)
  expect(agentPosture(member, owned).owner).toBe(false)
  expect(agentPosture(admin, owned).owner).toBe(false)
  expect(() => authorize(pairer, owned, setMode('bypassPermissions'))).not.toThrow()
  expect(() => authorize(admin, owned, setMode('bypassPermissions'))).toThrow(ForbiddenError)
  expect(() => authorize(member, owned, { kind: 'answer', optionId: 'exit-plan-bypass' })).toThrow(ForbiddenError)

  const legacy = remote('claude', null)
  expect(agentPosture(admin, legacy).owner).toBe(false)
  expect(() => authorize(admin, legacy, { kind: 'run', mode: 'bypassPermissions' })).toThrow(ForbiddenError)

  // 本机 agent：admin 是主人，普通用户不是
  expect(agentPosture(admin, local('claude')).owner).toBe(true)
  expect(agentPosture(member, local('claude')).owner).toBe(false)
})

test('catalog posture：表内 agent 给出可改 mode 与「跳过全部确认」的值；表外不可改；原型链上的名字不命中', () => {
  expect(agentPosture(member, local('claude'))).toEqual({ owner: false, modes: true, unrestricted: ['bypassPermissions'] })
  expect(agentPosture(admin, local('codex'))).toEqual({ owner: true, modes: true, unrestricted: ['agent-full-access'] })
  expect(agentPosture(member, local('omp'))).toEqual({ owner: false, modes: true, unrestricted: [] })
  expect(agentPosture(member, local('gemini'))).toEqual({ owner: false, modes: false, unrestricted: [] })
  // agent id 是部署方 / connector 给的字符串：constructor / toString 之类不能命中 Object.prototype
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect(agentPosture(admin, local(id)).modes).toBe(false)
    expect(() => authorize(admin, local(id), setMode('x'))).toThrow(ModeUnsupportedError)
  }
  // connector 上的 agent 按 connector 上报的原始 id 查表，不是 catalog id
  expect(agentPosture(pairer, remote('claude', pairer.id)).modes).toBe(true)
  expect(agentPosture(pairer, remote('c1:claude', pairer.id)).modes).toBe(false)
})
