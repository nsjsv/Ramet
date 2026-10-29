// 页面 / 集合在所属空间里是否只读：只有 viewer 只读，空间列表还没到时按可写处理。
// 只决定给不给编辑入口，真正的判定在服务端。整页和正文里的集合块共用（集合块按集合所在空间算）。
import type { Space } from './api'

export function spaceReadOnly(spaces: readonly Space[] | null, spaceId: string | null | undefined): boolean {
  const space = spaceId ? spaces?.find((s) => s.id === spaceId) : undefined
  return space?.my_role === 'viewer'
}
