/* ---------- 守卫：「页面可见」的判定只在 page-visibility.ts ----------
 * 数服务端源码（不含 *.test.ts）里每个文件出现 space_members 的次数，与下面的登记表比：没登记却出现、次数对不上，都红。
 * 页面可见性（这页能不能看、看的人是什么角色、该通知谁）一律用 page-visibility.ts 的函数与片段：私人区、单页分享只改那一处，
 * 别处直接连 space_members 判页面，就是一条绕开它们的泄露路径。确实是空间级的成员判定，就在表里登记并写明理由。 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const NEEDLE = 'space_members'

/** 允许出现的文件、次数与理由（路径相对 src，用 /） */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'page-visibility.ts': { count: 6, why: '页面可见性的唯一出口（含文件头说明）' },
  'db.ts': { count: 4, why: 'DDL 与启动迁移：建表、补个人空间的 owner 成员行' },
  'clone.ts': { count: 2, why: '惰性补建个人空间的 owner 成员行' },
  'page-area-schema.ts': { count: 1, why: '一次性迁移：判断注册时得到的空间有没有别的成员' },
  'user-delete.ts': { count: 3, why: '删号善后：挑继任者、提为 owner' },
  'routes/spaces.ts': { count: 11, why: '成员与邀请管理' },
  'routes/pages.ts': { count: 1, why: 'roleInSpace：空间级角色（在空间里建页、清空回收站），页面级用 pageRole' },
  'routes/boards.ts': { count: 4, why: '目录树是空间资产，按空间角色管' },
  'memories.ts': { count: 1, why: '空间记忆的写入人必须是 owner / member' },
  'routes/memories.ts': { count: 1, why: '空间记忆 REST 的权限' },
  'routes/connectors.ts': { count: 1, why: '机器接入与批准按空间角色' },
  'routes/machines.ts': { count: 2, why: '机器列表与授权按空间角色' },
  'agents/machine-access.ts': { count: 1, why: '机器所在空间的成员' },
  'agents/connectors.ts': { count: 1, why: '成员接入机器时按确认人此刻的空间角色定状态' },
  'agents/project.ts': { count: 1, why: '项目面板：机器所在空间的成员' },
  'agents/manager.ts': { count: 1, why: '列出我所在各空间里在线的机器' },
  'agents/space-ai.ts': { count: 1, why: '空间 AI 只给这个空间的成员解析' },
  'routes/space-ai.ts': { count: 1, why: '空间 AI 的配置按空间角色' },
  'routes/ai-usage.ts': { count: 1, why: '空间 AI 的用量只给空间 owner' },
  'routes/page-shares.ts': { count: 2, why: '分享面板标出访客（对象不是成员）、我作为访客进得去的空间' },
  'routes/space-guests.ts': { count: 2, why: '人员目录（成员看全体成员）、访客列表（对象不是成员）' },
  'agents/guest-gate.ts': { count: 1, why: '访客不能在宿主空间的页上用 AI：页面所在空间的成员' },
  'agents/space-context.ts': { count: 5, why: '空间的约定只给成员：空间清单、派活的目标空间、任务页的目标空间' },
  'agents/space-ai-chat.ts': { count: 1, why: '和空间 AI 的直接对话页只给成员建（只读成员不建）' },
  'agents/genet-context.ts': { count: 1, why: 'Genet 眼前的空间只算用户是成员的空间' },
  'personal-memories-schema.ts': { count: 1, why: '一次性迁移：只有主人一个成员的空间里的记忆迁成个人记忆' },
  'page-sync.ts': { count: 1, why: '成员指纹：加入 / 退出空间时客户端整表重拉' },
  'inbox.ts': { count: 4, why: '机器待批准（空间 owner）、使用申请（申请人仍是成员）、定时失败（规则所在空间）' },
  'triggers/inbox-items.ts': { count: 1, why: '规则通知按规则所在空间' },
  'triggers/action-check.ts': { count: 1, why: '「发通知」的收件人必须是规则所在空间的成员' },
  'triggers/run-actions.ts': { count: 2, why: '「发通知」收件人、webhook 主人按规则所在空间' },
  'collections/store.ts': { count: 1, why: '人员属性的候选人 = 空间成员' },
  'edit-marks.ts': { count: 1, why: '编辑者头像只给本空间的成员 / 访客看' },
  'agents/test-kit.ts': { count: 1, why: '测试夹具：加成员' },
  'collections/test-kit.ts': { count: 1, why: '测试夹具：加成员' },
  'preview-fixtures.ts': { count: 1, why: '预览夹具：加成员' },
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : []
  })
}

function occurrences(text: string): number {
  return text.split(NEEDLE).length - 1
}

describe('页面可见性只有一个出口', () => {
  const found = new Map(
    sources(ROOT)
      .map((path) => [relative(ROOT, path).split(sep).join('/'), occurrences(readFileSync(path, 'utf8'))] as const)
      .filter(([, n]) => n > 0),
  )

  it('space_members 只出现在登记过的文件里', () => {
    const stray = [...found.keys()].filter((file) => !ALLOWED[file])
    expect(stray, '页面可见性请用 page-visibility.ts 的函数 / 片段；确是空间级判定就在 ALLOWED 里登记并写明理由').toEqual([])
  })

  it('登记过的文件里出现次数与登记的一致', () => {
    const drift = Object.entries(ALLOWED)
      .filter(([file, { count }]) => (found.get(file) ?? 0) !== count)
      .map(([file, { count }]) => `${file}: 登记 ${count}，实际 ${found.get(file) ?? 0}`)
    expect(drift, '新加的是页面可见性就改用 page-visibility.ts；是空间级判定就改登记的次数').toEqual([])
  })
})
