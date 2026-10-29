// ---------- 客户端诊断日志入口（排查环境相关的点了没反应）----------
// POST /api/debug/client-log { lines: string[] }：服务端 console 一行一条，docker logs 可读。
// 前端默认不采集，只有页面带 ?diag=1 或 localStorage['ramet:diag']='1' 才上报（见 web/…/debug-log.ts）。

import { Hono } from 'hono'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'

const MAX_LINES = 60
const MAX_LINE_LEN = 400

export function debugRoutes(pool: Pool) {
  const app = new Hono<AuthEnv>()
  app.use('*', requireAuth(pool))

  app.post('/api/debug/client-log', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { lines?: unknown } | null
    const lines = Array.isArray(body?.lines) ? body.lines.slice(0, MAX_LINES) : []
    const user = c.get('user')
    for (const line of lines) {
      if (typeof line !== 'string') continue
      console.log(`[client ${user.username}] ${line.slice(0, MAX_LINE_LEN)}`)
    }
    return c.json({ ok: true })
  })

  return app
}
