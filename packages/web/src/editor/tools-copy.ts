/* ---------- 工具档位（对话页给 agent 哪一档 Ramet 工具）的界面文案，并进 copy.ts 的 COPY.tools（单独成文件，同 team-copy.ts）---------- */
import type { ToolProfile } from '../api'

export const TOOLS_COPY = {
  title: '工具档位',
  /** chip 上的短名 */
  label: { full: '完整工具', minimal: '精简工具', none: '无工具' } satisfies Record<ToolProfile, string>,
  /** 菜单项：按摆放顺序 */
  options: [
    { value: 'full', name: '完整', hint: '全部 Ramet 工具：读写页面、搜索、建页、记忆、叫别的 agent、skill、带队' },
    { value: 'minimal', name: '精简', hint: '只读写当前页（read_page / read_image / edit_page）' },
    { value: 'none', name: '无', hint: 'Ramet 只当界面：不给工具，提示词只有文档正文' },
  ] satisfies Array<{ value: ToolProfile; name: string; hint: string }>,
  note: '本页所有 agent 共用；换档后下一轮新建会话、全文重放',
  failed: '改工具档位失败',
}
