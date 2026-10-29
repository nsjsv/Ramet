/* ---------- 开工失败的原因翻译成给人看的话 ----------
 * POST /continue {team} 与 PATCH / cancel 的错误码（服务端 routes/agents.ts、agents/team-plan.ts）多数自带人话 message，直接用；
 * 只有短码没有人话的（invalid team、page not found）和需要补一句怎么办的（leader mismatch）在这里翻译。 */
import { ApiError } from '../api'
import { COPY } from '../copy'

const P = COPY.team.plan

export function startErrorText(err: unknown, leaderName: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'leader mismatch') return P.leaderMismatch(leaderName)
    if (err.code === 'invalid team') return P.invalidTeam
    if (err.status === 404 && err.code === 'page not found') return P.noWrite
  }
  return err instanceof Error && err.message ? err.message : P.startFailed
}
