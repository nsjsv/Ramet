import { Hono } from 'hono'
import * as Y from 'yjs'
import type { Pool } from 'pg'
import { requireAuth, type AuthEnv } from '../auth.js'
import { extractTitle, loadDocFromDb } from '../collab.js'
import { clonePageIntoPersonalSpace } from '../clone.js'
import { bookmarkUrl, type LinkPreview } from '../link-preview.js'
import { pageCoverOf, type CoverColumns } from '../page-cover.js'
import { linkPreviewCache } from './link-preview.js'
import { rowIcon, type PageIcon } from '../page-icon.js'

// 公开端点:匿名可读已发布子树的元数据与内容,登录用户可克隆进自己的个人空间。
// 注意:这里不挂全局 requireAuth —— 两个 GET 就是设计给匿名用的;只有 clone 单路由挂鉴权。

// 公开闸门(三个端点共用):页面 id 不存在或自己与任一祖先都没公开 → 打不上(调用方 404)。
// WITH RECURSIVE 沿 parent 链一次上溯全祖先;UNION 去重保证脏数据环时递归终止。
// 发布语义 = 发布页面即发布整棵子树(子页共享祖先的公开态,无需逐个判)。
// 过程页(kind='run')多一道:self 恒不 published(DB 约束),只有祖先显式勾了
// publish_includes_runs 才跟着公开 —— 过程里有本地路径与命令,默认不外泄。
// 集合:祖先链(anc 从自身起,含自身)上有集合页就不公开 —— 集合页与它的行即使祖先已公开也不能匿名访问
// (公开页暂不渲染集合内容)。所有公开读路径共用这一个谓词
const IS_PUBLIC = `WITH RECURSIVE anc AS (
  SELECT id, parent_id, published, kind, publish_includes_runs FROM live_pages WHERE id = $1
  UNION
  SELECT p.id, p.parent_id, p.published, p.kind, p.publish_includes_runs FROM live_pages p JOIN anc ON p.id = anc.parent_id
) SELECT 1 FROM anc, (SELECT kind FROM live_pages WHERE id = $1) t
  WHERE anc.published AND (t.kind <> 'run' OR anc.publish_includes_runs)
    AND NOT EXISTS (SELECT 1 FROM anc a2 WHERE a2.kind = 'collection') LIMIT 1`
const SELECT_PAGE_META = 'SELECT id, title, kind, icon_emoji, icon_file_id FROM live_pages WHERE id = $1'
// 子树元数据按页面列表同序展示;子孙全公开(祖先闸已过),无需逐个判 published ——
// 只有过程页要问父页的开关($1 复用:该父页是否连过程一起公开)。开关只放行过程页:
// skill 页、集合页不随它进公开树(集合页不进,它的行也就不会被遍历到)
const SELECT_CHILDREN_META =
  `SELECT id, title, kind, icon_emoji, icon_file_id FROM live_pages WHERE parent_id = $1
     AND (kind = 'doc' OR (kind = 'run' AND (SELECT publish_includes_runs FROM live_pages WHERE id = $1)))
   ORDER BY created_at, id`

const SELECT_RUN = `SELECT p.title, p.parent_id, r.record FROM runs r JOIN live_pages p ON p.id = r.page_id
  WHERE r.page_id = $1`
const SELECT_PARENT_TITLE = 'SELECT id, title FROM live_pages WHERE id = $1'
const SELECT_LAYOUT = 'SELECT full_width, cover_kind, cover_value, cover_y FROM live_pages WHERE id = $1'

type PageMetaRow = { id: string; title: string; kind: string; icon_emoji: string | null; icon_file_id: string | null }

// 公开子树节点(递归同构;children 按 created_at, id 稳定排序)。
// icon 走与登录端同一个派生契约(公开页的树与标题上方都要显示页面图标)。
// kind:页面判别(公开树里只有 doc 与 run)。前端据此只给 doc 页摆「克隆到我的空间」——复制只带 doc 页(clone.ts 的 COPYABLE)
type PublicNode = { id: string; title: string; kind: string; icon: PageIcon | null; children: PublicNode[] }

// notify:树变更广播回调(克隆成功后调,与 pages/spaces 族同语义);getLiveDoc:内存活文档查找
// (公开 doc 与克隆取内容优先用活文档,测试可不传走 DB 重建分支)
// 正文里有没有指向 url 的书签块 / 网页提及(任意深度:列表 / 分栏 / 折叠块里也算;
// 提及是行内节点,也可能嵌在文本的 delta 里)
const LINK_NODES = new Set(['bookmark', 'link_mention'])
function hasLinkNode(node: Y.XmlFragment | Y.XmlElement, url: string): boolean {
  const hit = (el: Y.XmlElement): boolean => (LINK_NODES.has(el.nodeName) && el.getAttribute('url') === url) || hasLinkNode(el, url)
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement && hit(child)) return true
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: unknown }>) if (op.insert instanceof Y.XmlElement && hit(op.insert)) return true
    }
  }
  return false
}

// linkPreview:书签元信息抓取(缺省不开公开端点,测试按需注入)
export function publicRoutes(
  pool: Pool,
  notify?: () => void,
  getLiveDoc?: (docName: string) => Y.Doc | undefined,
  linkPreview?: LinkPreview,
) {
  const app = new Hono<AuthEnv>()

  // 公开闸门:打不上(不存在/未公开)一律同响应,不泄露存在性
  async function isPublic(id: string): Promise<boolean> {
    return (await pool.query(IS_PUBLIC, [id])).rows.length > 0
  }

  // 取页面内容:内存有活文档(协同中)直接用;否则 DB 重建(快照+重放,含标题播种)—— 同 pages.captureDoc
  async function resolveDoc(docName: string): Promise<Y.Doc> {
    return getLiveDoc?.(docName) ?? (await loadDocFromDb(pool, docName))
  }

  // 子树元数据:BFS 全部子孙组树;visited 防环(同 pages.ts 删页,脏数据环不能死循环)
  async function buildTree(rootId: string): Promise<PublicNode | null> {
    const root = (await pool.query<PageMetaRow>(SELECT_PAGE_META, [rootId])).rows[0]
    if (!root) return null
    const nodes = new Map<string, PublicNode>([
      [root.id, { id: root.id, title: root.title, kind: root.kind, icon: rowIcon(root), children: [] }],
    ])
    const queue = [root.id]
    for (let i = 0; i < queue.length; i++) {
      const parent = nodes.get(queue[i]!)!
      const { rows } = await pool.query<PageMetaRow>(SELECT_CHILDREN_META, [queue[i]!])
      for (const child of rows) {
        if (nodes.has(child.id)) continue
        const node: PublicNode = { id: child.id, title: child.title, kind: child.kind, icon: rowIcon(child), children: [] }
        nodes.set(child.id, node)
        queue.push(child.id)
        parent.children.push(node)
      }
    }
    return nodes.get(root.id)!
  }

  app.get('/api/public/pages/:id', async (c) => {
    const id = c.req.param('id')
    if (!(await isPublic(id))) return c.json({ error: 'page not found' }, 404)
    const tree = await buildTree(id)
    // 闸门过了页面却查不到(并发删):与未公开同响应
    if (!tree) return c.json({ error: 'page not found' }, 404)
    return c.json(tree)
  })

  app.get('/api/public/pages/:id/doc', async (c) => {
    const id = c.req.param('id')
    if (!(await isPublic(id))) return c.json({ error: 'page not found' }, 404)
    const doc = await resolveDoc(`page:${id}`)
    // data 走 base64:Yjs update 是二进制,JSON 只能带字符串(与快照详情同约定)。
    // 过程页再带 record:时间线按它画,不在正文里
    const run = (await pool.query<{ title: string; parent_id: string | null; record: unknown }>(SELECT_RUN, [id])).rows[0]
    const parent = run?.parent_id && (await isPublic(run.parent_id))
      ? ((await pool.query<{ id: string; title: string }>(SELECT_PARENT_TITLE, [run.parent_id])).rows[0] ?? null)
      : null
    // 全宽与封面是页面版式:公开页与编辑页同一列宽、同一张封面(封面只在这里带,子树节点不带,省字节)
    const layout = (await pool.query<{ full_width: boolean } & CoverColumns>(SELECT_LAYOUT, [id])).rows[0]
    return c.json({
      title: extractTitle(doc),
      data: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
      full_width: layout?.full_width ?? false,
      cover: layout ? pageCoverOf(layout) : null,
      ...(run ? { run: run.record, parent } : {}),
    })
  })

  // 公开页里书签卡 / 网页提及的元信息:匿名可调,所以只抓「这个公开页正文里真有的那个地址」,
  // 否则就是一个任何人都能用的开放抓取代理。页面不公开 / 没有这张书签同响应 404
  app.get('/api/public/pages/:id/link-preview', async (c) => {
    const id = c.req.param('id')
    const url = bookmarkUrl(c.req.query('url'))
    if (!linkPreview || !url || !(await isPublic(id))) return c.json({ error: 'not found' }, 404)
    const doc = await resolveDoc(`page:${id}`)
    if (!hasLinkNode(doc.getXmlFragment('prosemirror'), url)) return c.json({ error: 'not found' }, 404)
    const meta = await linkPreview.get(url)
    c.header('cache-control', linkPreviewCache(meta))
    return c.json(meta)
  })

  // 克隆公开子树进克隆者个人空间:唯一写面,落点只在自己空间,无越权路径。
  // 单路由挂 requireAuth:匿名 401,登录后才走到闸门(未公开/不存在 404 不泄露)。
  // 收集/解析/事务落库全在 clonePageIntoPersonalSpace
  app.post('/api/public/pages/:id/clone', requireAuth(pool), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!(await isPublic(id))) return c.json({ error: 'page not found' }, 404)
    const newRootId = await clonePageIntoPersonalSpace(pool, user.id, id, getLiveDoc)
    // null = 个人空间拿不到(用户行消失,实践中不可达)或根页在闸门与事务之间被并发删 —— 后者
    // 与未公开同响应 404,不回 201 空对象让前端拿到 undefined id
    if (!newRootId) return c.json({ error: 'page not found' }, 404)
    notify?.()
    return c.json({ id: newRootId }, 201)
  })

  return app
}
