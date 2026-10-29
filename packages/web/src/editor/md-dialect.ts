/* ---------- 方言识别接进 milkdown 的解析管线 ----------
 * markdown 写法与结构的识别只在 @ramet/shared/md-dialect 定义一次（服务端 AI 落块 / edit_page / 导入同一份）。
 * 这里包成 remark 插件挂进 remarkPluginsCtx：粘贴、源码模式写回与高亮、打开页的解析都经过它，
 * 方言节点（rametMark 等）再由各节点 / mark 的 parseMarkdown 认领。
 * Editor 与 PublicPage 都要 .use（两处插件表保持一致）。 */
import type { RemarkPluginRaw } from '@milkdown/kit/transformer'
import { $remark } from '@milkdown/kit/utils'
import { remarkRametDialect } from '@ramet/shared/md-dialect'

export const rametDialect = $remark('rametDialect', () => remarkRametDialect as unknown as RemarkPluginRaw<Record<string, never>>)
