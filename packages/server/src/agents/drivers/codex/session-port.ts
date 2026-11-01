// ---------- Codex 的会话端口 ----------
// 依据：codex 0.159.3 的 app-server schema（--experimental）与会话目录布局：
//   本机自己的记录 = $CODEX_HOME（缺省 ~/.codex）/sessions/YYYY/MM/DD/rollout-<时间>-<threadId>.jsonl（只追加），另有 state_*.sqlite 索引；
//   thread/resume 的实验字段 path =「从这个会话文件恢复，线程没在跑时忽略 threadId」。
// 所以下发时不碰 codex 自己的目录结构和索引：写到 connector 自管的 <Ramet 会话根>/codex/<threadId>.jsonl，驱动的 loadSession
// 发现这个文件就用 thread/resume {path}（codex 之后也往这个文件里追加），本机的记录以它为准。
// 只搬主线程：子代理是独立线程、各有各的 rollout，主线程的上下文里已经有子代理的结果，不搬只损失「看子代理的历史」。
// name：main.jsonl。

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validSessionId } from '../../session-types.js'
import { cliEnv, regularFile, sessionsRoot, type SessionPort } from '../session-port.js'

const MAIN = 'main.jsonl'

/** connector 自管的 rollout（下发写到这里，loadSession 有它就按路径恢复） */
export function ownRollout(sessionId: string): string {
  return join(sessionsRoot(), 'codex', `${sessionId}.jsonl`)
}

export function codexHome(env: Record<string, string> | undefined): string {
  return cliEnv(env, 'CODEX_HOME') ?? join(homedir(), '.codex')
}

/** 目录下的子目录名，倒序（YYYY / MM / DD 倒序 = 最近的先看） */
async function subdirsDesc(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
}

/** 在 codex 自己的 sessions/ 里按 threadId 找 rollout：按日期目录从近到远找，找到就停（老用户的 rollout 动辄上万个，不整棵遍历） */
async function findRollout(root: string, sessionId: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`
  const pick = async (dir: string): Promise<string | null> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const hit = entries.find((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(suffix))
    return hit ? join(dir, hit.name) : null
  }
  for (const y of await subdirsDesc(root)) {
    for (const m of await subdirsDesc(join(root, y))) {
      for (const d of await subdirsDesc(join(root, y, m))) {
        const hit = await pick(join(root, y, m, d))
        if (hit) return hit
      }
    }
  }
  return null
}

export function codexSessionPort(env: Record<string, string> | undefined): SessionPort {
  return {
    async list(sessionId) {
      if (!validSessionId(sessionId)) return []
      // 下发过来的那份一旦存在就是本机最新的（之后的回合都追加在它上面）
      const own = ownRollout(sessionId)
      const ownStat = await regularFile(own)
      if (ownStat) return [{ name: MAIN, size: ownStat.size, path: own }]
      const path = await findRollout(join(codexHome(env), 'sessions'), sessionId)
      const st = path ? await regularFile(path) : null
      return path && st ? [{ name: MAIN, size: st.size, path }] : []
    },
    target(sessionId, _cwd, name) {
      return validSessionId(sessionId) && name === MAIN ? ownRollout(sessionId) : null
    },
  }
}
