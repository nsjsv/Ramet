// vitest globalSetup：按 worker 数建好各自的测试库（已存在就跳过）。库名由 workerDbUrl 算，test-db-env.ts 共用
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'

/** 第 n 个 worker 的库：原库名 + _w<n>，其余连接参数不变 */
export function workerDbUrl(base: string, n: string | number): string {
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/^\//, '')}_w${n}`
  return url.toString()
}

export default async function setup(project: TestProject): Promise<void> {
  const base = process.env.DATABASE_URL
  // 没配就交给各测试文件自己的 fail-fast 报错
  if (!base) return
  const client = new Client({ connectionString: base })
  await client.connect()
  try {
    const workers = project.config.provide.testDbWorkers as number
    for (let n = 1; n <= workers; n++) {
      const name = new URL(workerDbUrl(base, n)).pathname.slice(1)
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      if (exists.rows.length === 0) await client.query(`CREATE DATABASE "${name}"`)
    }
  } finally {
    await client.end()
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDbWorkers: number
  }
}
