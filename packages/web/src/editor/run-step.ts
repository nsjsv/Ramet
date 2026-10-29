/* ---------- run_step：过程页里的一个步骤（顶层块） ----------
 * 过程页正文里每个步骤是一个块，继承改 / 删 / 拖 / 引用 / 收藏（块 id 由 ensureBlockIds 补，服务端建页时就写，
 * 见 server agents/run-doc.ts）。块里是这一行的字，用户能改的是这一份，进下一轮上下文的也是这一份；
 * 工具输入输出 / diff / 子代理正文等完整详情只在 runs.record，按 `sid` 取（@ramet/shared/run-model 的 entrySid）。
 *
 * attrs：id（块 id）/ sid（指向 record 的那一条；空 = 用户新加的）/ k（tool | thought | say）/ kind（工具类型）/
 * status / t、end（相对本轮开始的毫秒，数字）/ parent（子代理调用的父步骤 sid）。都只进节点 attrs（Yjs 属性）。
 * 呈现：run-step-view.ts 的 nodeView（图标 · 动词 · 文字 · 用时 · 引用 / 展开）+ styles/run-step.css；toDOM 只管
 * 剪贴板 / 历史预览这类静态序列化（data-* 带全部 attrs）。content 是 inline*（thought / say 的换行是 hardbreak），不带格式。
 *
 * markdown：没有自然语法，toMarkdown 降级成一行普通段落（`{动词} {文字}`），不接 parseMarkdown —— 过程页不开源码
 * 模式，其它页粘贴进来的步骤块在源码模式里降级成段落，只是文字。应用内复制粘贴走 parseDOM，保住步骤身份。
 * Editor / PublicPage 必须 .use（协同对端与公开页出现未注册节点会整页解析失败）。 */

import { $nodeSchema } from '@milkdown/kit/utils'
import { stepVerb } from '@ramet/shared/run-model'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (raw: string | null): number | null => (raw !== null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null)

export const runStepSchema = $nodeSchema('run_step', () => ({
  group: 'block',
  content: 'inline*',
  marks: '',
  defining: true,
  attrs: {
    id: { default: '' },
    sid: { default: '' },
    k: { default: 'tool' },
    kind: { default: '' },
    status: { default: '' },
    t: { default: null },
    end: { default: null },
    parent: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div[data-run-step]',
      getAttrs: (dom) => {
        const el = dom as HTMLElement
        return {
          sid: el.getAttribute('data-sid') ?? '',
          k: el.getAttribute('data-k') ?? 'tool',
          kind: el.getAttribute('data-kind') ?? '',
          status: el.getAttribute('data-status') ?? '',
          t: num(el.getAttribute('data-t')),
          end: num(el.getAttribute('data-end')),
          parent: el.getAttribute('data-parent') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => {
    const { sid, k, kind, status, t, end, parent } = node.attrs
    const attrs: Record<string, string> = { class: 'run-step', 'data-run-step': '', 'data-k': str(k) }
    if (sid) attrs['data-sid'] = str(sid)
    if (kind) attrs['data-kind'] = str(kind)
    if (status) attrs['data-status'] = str(status)
    if (parent) attrs['data-parent'] = str(parent)
    if (typeof t === 'number') attrs['data-t'] = String(t)
    if (typeof end === 'number') attrs['data-end'] = String(end)
    return ['div', attrs, 0]
  },
  parseMarkdown: { match: () => false, runner: () => {} },
  toMarkdown: {
    match: (node) => node.type.name === 'run_step',
    runner: (state, node) => {
      state.openNode('paragraph')
      state.addNode('text', undefined, `${stepVerb(str(node.attrs.k), str(node.attrs.kind))} `)
      state.next(node.content)
      state.closeNode()
    },
  },
}))
