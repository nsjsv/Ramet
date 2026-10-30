// ---------- 子页在父页正文里的入口 ----------
// 页面树里挂在某个文档页下的页，父页正文里必须有指向它的子页面块（page_ref），否则就是一个在父页里点不进去的
// 幽灵子页。空间顶层页和目录树条目本身就是入口，不需要。服务端凡是改父子关系的写路径都走这里：
// 先改库再补入口；补不上由调用方把库改回原样并报错。摘旧父页里的入口失败只记日志 —— 多一个指向已挪走页面的块
// 不会让谁找不到页面，而 link-watcher 的结构守卫保证摘入口不会级联删掉已改挂别处的页。
import type { Pool } from 'pg'
import * as Y from 'yjs'
import type { DocWriter } from './collab.js'

export type EntryPage = { id: string; title: string; icon_emoji: string | null; icon_file_id: string | null }
type Writer = { write: DocWriter; user: { id: string; role: string } }

const SELECT_KIND = 'SELECT kind FROM live_pages WHERE id = $1'
const SELECT_ENTRY_PAGE = 'SELECT id, title, icon_emoji, icon_file_id FROM live_pages WHERE id = $1'

/** 父页正文末尾补一个子页面块（已有同页的就不重复）。块形状与编辑器 page_ref 节点同口径：
 *  title / icon 是快照，编辑器按页面列表刷新；没标题就不写，落节点默认值 */
export function appendPageRef(frag: Y.XmlFragment, page: EntryPage): void {
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i)
    if (el instanceof Y.XmlElement && el.nodeName === 'page_ref' && el.getAttribute('pageId') === page.id) return
  }
  const el = new Y.XmlElement('page_ref')
  el.setAttribute('pageId', page.id)
  if (page.title) el.setAttribute('title', page.title)
  const icon = page.icon_emoji ? `emoji:${page.icon_emoji}` : page.icon_file_id ? `image:${page.icon_file_id}` : null
  if (icon) el.setAttribute('icon', icon)
  frag.insert(frag.length, [el])
}

/** 摘掉正文顶层指向 pageId 的子页面块（降序删免位移） */
export function removePageRefs(frag: Y.XmlFragment, pageId: string): void {
  const doomed: number[] = []
  for (let i = 0; i < frag.length; i++) {
    const el = frag.get(i)
    if (el instanceof Y.XmlElement && el.nodeName === 'page_ref' && el.getAttribute('pageId') === pageId) doomed.push(i)
  }
  for (const i of doomed.reverse()) frag.delete(i, 1)
}

/** 这对父子要不要入口：只有文档页挂在文档页下才要。集合的行不进正文；集合页自己在父页里的块由集合模块维护；
 *  过程页 / skill 页不是页面树里的普通子页 */
export async function needsEntry(pool: Pool, parentId: string | null, childKind: string): Promise<boolean> {
  if (!parentId || childKind !== 'doc') return false
  return (await pool.query<{ kind: string }>(SELECT_KIND, [parentId])).rows[0]?.kind === 'doc'
}

/** 在父页正文里补入口；写不进去就抛错（调用方回滚库里的父子关系） */
export async function linkInParent(pool: Pool, w: Writer, parentId: string, pageId: string): Promise<void> {
  const page = (await pool.query<EntryPage>(SELECT_ENTRY_PAGE, [pageId])).rows[0]
  if (!page) throw new Error(`page ${pageId} not found`)
  await w.write(`page:${parentId}`, w.user, (doc, origin) => {
    doc.transact(() => appendPageRef(doc.getXmlFragment('prosemirror'), page), origin)
  }, 'user')
}

/** 页离开旧父页后摘掉那边的入口（库里的父子关系必须已经改好）。只摘文档父页里的；失败只记日志 */
export async function unlinkFromParent(pool: Pool, w: Writer, parentId: string | null, pageId: string): Promise<void> {
  if (!parentId) return
  try {
    if ((await pool.query<{ kind: string }>(SELECT_KIND, [parentId])).rows[0]?.kind !== 'doc') return
    await w.write(`page:${parentId}`, w.user, (doc, origin) => {
      doc.transact(() => removePageRefs(doc.getXmlFragment('prosemirror'), pageId), origin)
    }, 'user')
  } catch (err) {
    console.error('[page-entry] unlink from old parent failed', parentId, pageId, err)
  }
}
