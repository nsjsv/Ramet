// ---------- 外层 Claude Code 会话留下的环境变量 ----------
// 在 Claude Code 里（它的 Bash 工具 / `!` 命令）启动 server 或 connector 时，进程环境里带着外层会话的身份与通道：
// CLAUDECODE=1、会话 id、IPC socket / token、effort、防交互的 GIT_EDITOR=true 等。
// 这些只对外层会话有意义：带进拉起的 agent，claude 会把自己当成那个会话的子会话；带进用户终端，git commit 打不开编辑器；
// 被 connector 的 `start` 快照进 ~/.ramet/connector.env.json 还会一直留着。所以两个入口一启动就清掉。
// 只清会话专属的，settings.json 里 env 配的（CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 之类）是用户配置，照常保留。

/** Claude Code 给自己拉起的子进程打的标记：没有它就一个都不动（用户自己设的同名变量照常保留） */
const MARK = 'CLAUDECODE'
const NAMES = new Set([
  MARK,
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
])
const PREFIXES = ['CLAUDE_CODE_MESSAGING_']

/** 原地删掉外层 Claude Code 会话的变量；返回删了几个 */
export function dropOuterClaudeSession(env: NodeJS.ProcessEnv = process.env): number {
  if (!env[MARK]) return 0
  let n = 0
  for (const key of Object.keys(env)) {
    // GIT_EDITOR=true 是 Claude Code 为了不让 git 卡在编辑器上塞的；用户自己配的编辑器不会是 true
    const outer = NAMES.has(key) || PREFIXES.some((p) => key.startsWith(p)) || (key === 'GIT_EDITOR' && env[key] === 'true')
    if (!outer) continue
    delete env[key]
    n++
  }
  return n
}
