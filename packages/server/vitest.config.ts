import { defineConfig } from 'vitest/config'

// 测试文件并行：每个 worker 用自己的库（DATABASE_URL 的库名 + _w<池号>，见 src/test-db.ts），TRUNCATE 互不干扰。
// worker 数不跟核数走：每个文件自带连接池和 agent / connector 子进程，开太多会撞 Postgres 连接上限，30s 超时的用例也会被拖慢
const WORKERS = 6

export default defineConfig({
  test: {
    testTimeout: 30_000,
    maxWorkers: WORKERS,
    globalSetup: './src/test-db.ts',
    setupFiles: './src/test-db-env.ts',
    provide: { testDbWorkers: WORKERS },
  },
})
