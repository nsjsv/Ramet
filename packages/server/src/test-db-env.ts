// vitest setupFiles:在测试文件 import db.ts 之前把 DATABASE_URL 换成本 worker 的库（见 test-db.ts）
import { workerDbUrl } from './test-db.js'

const base = process.env.DATABASE_URL
const pool = process.env.VITEST_POOL_ID
if (base && pool) process.env.DATABASE_URL = workerDbUrl(base, pool)
