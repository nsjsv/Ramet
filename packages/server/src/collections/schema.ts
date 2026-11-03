// 集合自动编号的表（幂等 DDL，由 db.ts 拼进启动时执行的 DDL 串尾部）。
// 单独成文件是为了 db.ts 不超过行数闸门；这里不 import 任何东西，db.ts 求值 DDL 串时不会碰到循环引用。
//
// 编号是服务端派生数据（不是用户内容，不进行文档）：取号只在 collections/store.ts 的 assignNumbers，
// 集合定义里有「自动编号」属性时才取（加属性时老行按创建先后补号，所以不能建行就取）。
// collections.next_number = 下一个号，只增不减：删行、行挪走都不回收号码。
// collection_row_numbers = 行在某个集合里的号。行挪走后 collection_id 对不上即视为没有编号（窗口按 parent_id 连接），
// 在新集合取号时整行覆盖；挪回来之前还没被覆盖的话，原来的号还在。页面物理删除随外键清掉
export const COLLECTION_NUMBERS_DDL = `
ALTER TABLE collections ADD COLUMN IF NOT EXISTS next_number INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS collection_row_numbers (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  UNIQUE (collection_id, n)
);
`
