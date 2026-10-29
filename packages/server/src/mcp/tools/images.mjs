// ---------- 图片：read_image ----------
import { auth, reply, url } from '../lib.mjs'

async function readImage({ fileId }) {
  const res = await fetch(`${url}/api/files/${encodeURIComponent(fileId)}/ai`, { headers: auth() })
  // 404：没有这张图（不存在 / 不是图片，中心刻意不区分）
  if (res.status === 404) return reply(`没有这张图：${fileId}。`)
  // 413：太大（中心按 1.5MB 闸拒绝），说明原因，别把大图塞进上下文
  if (res.status === 413) return reply(`图片太大，中心拒绝返回（${(await res.json()).error ?? fileId}）。`)
  if (!res.ok) throw new Error(`读取图片失败：${res.status} ${await res.text()}`)
  const body = await res.json()
  // 图片内容块（base64 + mime）。中心保证不会太大（超 1.5MB 直接 413），这里不再截断
  return { content: [{ type: 'image', data: body.data, mimeType: body.mime }] }
}

export const tools = [
  {
    name: 'read_image',
    define: () => ({
      name: 'read_image',
      description: '读取文档里一张图片的内容（返回图片本身）。文档正文里的图片只显示为编号 image:<uuid>，想看内容再用这个工具取。',
      inputSchema: {
        type: 'object',
        properties: { fileId: { type: 'string', description: '图片的文件 id（正文里 image: 后面的 uuid）' } },
        required: ['fileId'],
      },
    }),
    run: (args) => readImage({ fileId: String(args.fileId ?? '') }),
  },
]
