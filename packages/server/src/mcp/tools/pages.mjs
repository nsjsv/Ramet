// ---------- 页面内容：read_page / edit_page ----------
// 读走「能看见」，写走「能改」，权限判定全在中心端点（page-read.ts / page-write.ts），这里只带凭证。
import { call, failure, reply } from '../lib.mjs'

/** 中心返回的 JSON → MCP 文本内容（页面按行读取的契约见 page-read.ts） */
function render(body, blockId) {
  const title = blockId ? `${body.title}（块 ${blockId}）` : body.title
  if (body.lines.length === 0) return `# ${title}\n(共 ${body.total} 行；本次范围为空)`
  const head = `# ${title}\n行 ${body.offset}–${body.offset + body.lines.length - 1}/${body.total}\n`
  return head + body.lines.map((line, i) => `${body.offset + i}\t${line}`).join('\n')
}

/** 正文里的引用记号可以原样当参数：`page:<页面id>` / `page:<页面id>#<块id>`（引用契约见 agents/refs.ts）。显式给的 blockId 优先 */
function target(pageId, blockId) {
  const m = /^page:([^#\s]+)(?:#(\S+))?$/.exec(pageId.trim())
  if (!m) return { pageId: pageId.trim(), blockId: blockId || undefined }
  return { pageId: m[1], blockId: blockId || m[2] || undefined }
}

async function readPage(args) {
  const { pageId, blockId } = target(String(args.pageId ?? ''), typeof args.blockId === 'string' ? args.blockId : undefined)
  const q = new URLSearchParams()
  if (typeof args.offset === 'number') q.set('offset', String(args.offset))
  if (typeof args.limit === 'number') q.set('limit', String(args.limit))
  if (blockId) q.set('block', blockId)
  const r = await call(`/api/pages/${encodeURIComponent(pageId)}/text?${q}`)
  // 404：不存在 / 不在你的空间 / 已进回收站（中心刻意不区分），对 AI 就是没有这个页面；页面读得到而块不在了是 block not found
  if (r.status === 404) {
    return reply(r.json?.error === 'block not found' ? `页面 ${pageId} 里没有块 ${blockId}（可能已被删除）。` : `没有找到页面 ${pageId}。`)
  }
  if (!r.ok) throw new Error(`读取页面失败：${r.status} ${r.raw}`)
  return reply(render(r.json, blockId))
}

async function editPage({ pageId, ops }) {
  const r = await call(`/api/pages/${encodeURIComponent(pageId)}/edit`, { method: 'POST', body: { ops } })
  // 404 / 403 / 400：页面不存在 / 不能改 / ops 不合法；中心失败时文档没被碰过（见 page-write.ts）
  if (!r.ok) return failure('写回失败', r)
  return reply(`已写回 ${pageId}（${ops.length} 个操作）。`)
}

export const tools = [
  {
    name: 'read_page',
    define: () => ({
      name: 'read_page',
      description:
        '读取一个 Ramet 页面，返回标题与指定范围内的行，行号从 1 开始。' +
        '正文里的引用这样写：page:<页面id> 是对另一个页面的引用；page:<页面id>「标题」是子页面；' +
        'page:<页面id>#<块id>「…」是对某一块的引用，「」里是这一轮发出时该块的内容。' +
        '读整页：pageId 填页面 id；只读某一块的最新内容：再填 blockId。pageId 也可以直接填正文里的 page: 记号（包括带 #块id 的）。',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: '页面 id，或正文里的 page:<页面id> / page:<页面id>#<块id> 记号' },
          blockId: { type: 'string', description: '只读这一块（块 id）；缺省读整页' },
          offset: { type: 'number', description: '从第几行开始（从 1 开始，缺省 1）' },
          limit: { type: 'number', description: '最多返回多少行（缺省 200，上限 400）' },
        },
        required: ['pageId'],
      },
    }),
    run: readPage,
  },
  {
    name: 'edit_page',
    define: () => ({
      name: 'edit_page',
      description:
        '修改一个 Ramet 页面，用法与自带的 edit 工具一样：先用 read_page 读出正文，再把要改的那段原文原样填进 old、换成的新文字填进 new。ops 按顺序在一个事务里生效，任何一项失败则整次调用都不写入。new 中单独一行写成 image:<uuid> 会插入一张已存在的图片，写成 page:<uuid> 会插入一个页面提及。' +
        'old 只能取自 read_page 读到的正文；对话里 page:<页面id>#<块id>「…」这样的块引用是引用记号，不是页面正文，别拿它去匹配。',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: '页面 id' },
          ops: {
            type: 'array',
            description: '要执行的操作，按顺序应用',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['replace'], description: '目前只有 replace' },
                old: {
                  type: 'string',
                  description: '要在文档里换掉的原文（必须原样、且全文恰好出现一次；出现多次请带上更多上下文）。空字符串 = 追加到文末。',
                },
                new: { type: 'string', description: '替换成的文字（markdown；单独一行 image:<uuid> 落图片，page:<uuid> 落页面提及）' },
              },
              required: ['op', 'old', 'new'],
            },
          },
        },
        required: ['pageId', 'ops'],
      },
    }),
    run: (args) => editPage({ pageId: String(args.pageId ?? ''), ops: args.ops ?? [] }),
  },
]
