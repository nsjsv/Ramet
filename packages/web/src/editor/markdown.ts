// 粘贴 markdown 解析、markdown 输出写法、复制出去的纯文本、输入规则补缺。

import { editorViewOptionsCtx, inputRulesCtx, parserCtx, remarkStringifyOptionsCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { Schema, Slice } from '@milkdown/kit/prose/model'
import { EditorView } from '@milkdown/kit/prose/view'
import { findWrapping } from '@milkdown/kit/prose/transform'
import { $prose } from '@milkdown/kit/utils'
import { normalizeTopLevelLists } from './list-blocks'
import { pastedMarkdownLinks } from './collection-block'
import { upgradeMentions } from './mention-upgrade'
import { BLOCK_LINK_RE } from './block-link-paste'
import { selfId } from '../people'

// 逐行匹配常见 markdown 块语法（多行粘贴且命中才拦截，单行/普通文本走默认行为）
const MD_LINE_RE = /^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?|```|\[ \]\s+|\[x\]\s+|---+\s*$|\|.*\|)/

function looksLikeMarkdown(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 2) return false
  return lines.some((line) => MD_LINE_RE.test(line))
}

/** 裸 URL：单 token、无空白 */
const BARE_URL_RE = /^https?:\/\/[^\s]+$/

/** 粘贴裸 URL → 当场变链接，不等空格 / 回车：有选区 = 选区文字套成链接，
 * 无选区 = URL 本身作链接文字。代码块内不套，保持字面量；link mark 是 inclusive:false（link-mark.ts），
 * 粘贴后光标在链接之外，接着打的是普通文字。无选区的块链接（/page/:id?block=:bid）让给
 * blockLinkPaste 弹三选；有选区时仍套链接。返回是否接管 */
function linkifyPaste(view: EditorView, url: string): boolean {
  const { from, to, $from, $to } = view.state.selection
  const link = view.state.schema.marks.link
  const parent = $from.parent
  if (!link || !$from.sameParent($to) || !parent.isTextblock || parent.type.spec.code || !parent.type.allowsMarkType(link)) {
    return false
  }
  if (from === to && BLOCK_LINK_RE.test(url)) return false
  const label = from === to ? url : view.state.doc.textBetween(from, to, ' ')
  if (!label) return false
  const tr = view.state.tr.replaceWith(from, to, view.state.schema.text(label, [link.create({ href: url })]))
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + label.length)).scrollIntoView())
  return true
}

export function configPaste(ctx: Ctx) {
  ctx.update(editorViewOptionsCtx, (prev) => ({
      ...prev,
      handlePaste: (view: EditorView, event: ClipboardEvent): boolean => {
        const text = event.clipboardData?.getData('text/plain')
        if (!text || !looksLikeMarkdown(text)) {
          const url = text?.trim()
          return !!url && BARE_URL_RE.test(url) && view.editable && linkifyPaste(view, url)
        }
        // 代码块内粘贴保持原样
        if (view.state.selection.$from.parent.type.name === 'code_block') return false
        const node = ctx.get(parserCtx)(text)
        if (!node || node.childCount === 0) return false
        const { from, to } = view.state.selection
        // 顶层多条目 list 先拆成单条目兄弟块再入文（不变量：顶层 list 恰含 1 条目）；
        // 单次 dispatch = 单条 Yjs 事务 = 单个撤销步；order 续号由 listNormalize 随后兜底
        // 集合记号（复制集合块时剪贴板里的纯文本）一律进成链接视图块：粘贴不产生新的所有者（collection-block.ts）
        const content = pastedMarkdownLinks(normalizeTopLevelLists(node), view.state.schema)
        const tr = view.state.tr.replaceWith(from, to, content)
        upgradeMentions(tr) // @[…](page:…) / @[…](agent:…) 原文 / 降级链接升回 chip
        view.dispatch(tr)
        return true
      },
    }))
}

// markdown 输出的写法：无序列表记号用 `-`、分隔线用 `---`（mdast-util-to-markdown 默认 `*` / `***`）。
// 源码模式、导出、复制为 markdown 都经这一个序列化器，写法一致；解析方向两种写法都认。
export function configMarkdownOut(ctx: Ctx) {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const, rule: '-' as const }))
}

// 复制出去的纯文本。剪贴板的 text/plain：跨块 = markdown（粘到别的 markdown 编辑器 / 聊天框里结构不丢）；一个文本块里的一段字 = 纯文字
// （不带 ** 之类的记号，粘进地址栏 / 表单里就是那几个字）。text/html 仍是 PM 默认的 DOM 序列化，富文本粘贴不变。
// 切片拼不成合法文档（只选了几个嵌套条目这类开放切片）就退回 PM 默认的纯文字。
export function configClipboardText(ctx: Ctx) {
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    clipboardTextSerializer: (slice: Slice): string => {
      const content = slice.content
      const plain = (): string => content.textBetween(0, content.size, '\n\n')
      const first = content.firstChild
      if (!first || first.isInline || (content.childCount === 1 && first.isTextblock && slice.openStart > 0 && slice.openEnd > 0)) {
        return plain()
      }
      try {
        const doc = ctx.get(schemaCtx).topNodeType.createAndFill(null, content)
        return doc ? ctx.get(serializerCtx)(doc).trimEnd() : plain()
      } catch {
        return plain()
      }
    },
  }))
}

// markdown 输入规则补缺。@milkdown 7.22.2 预设实际接入 editor 的规则：
// - commonmark：标题 / 引用 / 无序有序列表 / 代码块 / hr + 行内码 / 加粗 / 斜体（_ 和 *）（mark）。
//   insertImageInputRule 官方定义了但没接进组合的 inputRules 数组，![alt](src) 实际上不转换，下方补上；
// - gfm：删除线（mark）/ |3x3| 表格 / 裸 "[ ] " 任务列表（正则只匹配 "[ ] " 且要求已在 list 内）。
// 补四条缺口（其余常见语法均已覆盖，不重复加），另替换一条预设规则（见 5）：
// 1) "- [ ] " / "* [ ] " 整串 → 待办项。正常逐字输入其实已可用（"- " 先被 bullet 规则吃掉、
//    "[ ] " 尾巴再被 gfm 规则转 checked）；本条只兜整串残留的场景
//    （IME 分段提交等导致 bullet 规则没先吃掉 "- " 时），正常路径下永不命中、互不干扰；
// 2) "[文字](url)" 打完 ")" → 链接（commonmark 无此规则）；
// 3) 裸 URL 后打空格 → 自动加 link mark（Enter 不触发是 input rules 机制限制，同上游）；
// 4) ">> " → user_message 块 = 用户消息块（chat-view.tsx 的消息约定）。必补：commonmark 的引用
//    规则是 /^\s*>\s$/（单个 ">" + 空格），"> > " 才命中；按消息约定敲的整串 ">> " 里第一个
//    ">" 后面跟的是第二个 ">"，整串谁都不匹配，只会得到字面量段落 ">> …"，文档里根本没有用户
//    消息块（"> " → blockquote、">> " → <p>&gt;&gt; …</p>）；
// 5) 行首 "---" / "___ " / "*** " → 分隔线，光标落到下一行（hrInputRule）。替换预设的 insertHrInputRule
//    （block-id.ts 的 commonmarkPreset 已滤掉）：它 replaceWith(段落起点, 光标, hr) 把整段换成 hr，
//    选区成了 hr 的 NodeSelection，出块选中态、没有新行，还得再点一下才能接着打字。
// 挂载方式：不能另建一个 inputRules() 插件，handleTextInput 经 someProp 分发，第一个插件
// （milkdown 内建）返回 false 后不会询问第二个，新插件会被整条遮蔽；必须把规则塞进
// inputRulesCtx（$inputRule 内部同款做法），由 core 统一合进那一个输入规则插件，撤销支持同样生效。
export const extraInputRules = $prose((ctx) => {
  const rules = buildMarkdownInputRules(ctx.get(schemaCtx))
  ctx.update(inputRulesCtx, (irs) => [...irs, ...rules])
  // 规则本体进 inputRulesCtx；$prose 必须产出插件，这里放个空壳占位
  return new Plugin({ key: new PluginKey('rametExtraInputRules') })
})

/** 分隔线：删掉已打的标记，hr 插在所在段落之前，段落（含标记后的余文）原样留作下一行、光标在其行首。
 * 段落前放不下 hr（如列表项的首段）就不转换，保持字面量 */
export function insertHrBefore(state: EditorState, start: number, end: number): Transaction | null {
  const hr = state.schema.nodes.hr
  const $start = state.doc.resolve(start)
  if (!hr || $start.parent.type !== state.schema.nodes.paragraph) return null
  const index = $start.index(-1)
  if (!$start.node(-1).canReplaceWith(index, index, hr)) return null
  const tr = state.tr.delete(start, end).insert($start.before(), hr.create())
  return tr.setSelection(TextSelection.create(tr.doc, start + 1))
}

function buildMarkdownInputRules(schema: Schema): InputRule[] {
  const rules: InputRule[] = [new InputRule(/^(?:---|___\s|\*\*\*\s)$/, (state, _match, start, end) => insertHrBefore(state, start, end))]
  const bulletList = schema.nodes.bullet_list
  const listItem = schema.nodes.list_item
  const linkMark = schema.marks.link
  const imageNode = schema.nodes.image
  const userMessage = schema.nodes.user_message
  const agentReply = schema.nodes.agent_reply
  const paragraph = schema.nodes.paragraph

  // ">> " 整串 → user_message 块 = 用户消息（chat-view.tsx 的消息约定）。必须补规则：commonmark
  // 的引用规则是 /^\s*>\s$/（单个 ">" + 空格），"> > " 才命中；按约定整串敲的 ">> " 里第一个
  // ">" 后面跟的是第二个 ">"，整串谁都不匹配，只会得到字面量段落。
  // 光标在消息块（user_message / agent_reply）末尾时同样要出顶层消息块，见下方 inMessage。
  if (userMessage && paragraph) {
    // 先删掉匹配的 ">>"（光标前恰为 ">> "）再决定落点：结构由节点构造保证，不走来回复用
    // findWrapping 的两次 wrap（位置换算与库版本相关）
    rules.push(
      new InputRule(/^>>\s$/, (state, _match, start, end) => {
        const tr = state.tr.delete(start, end)
        const $at = tr.doc.resolve(start)
        const range = $at.blockRange()
        if (!range) return null
        // 光标之后的块内剩余内容原样搬进新消息（同 commonmark 的 "> " 规则：转换只换形态不丢正文）。
        // 切到 $at.end()（当前文本块内容末尾）而不是 range.end：后者含块尾 token，会把整个块切进来
        const tail = tr.doc.slice(start, $at.end()).content
        // 发言人 = 本端登录用户（对话气泡按它画头像，见 message-blocks.ts 的 author）
        const msg = userMessage.create({ author: selfId() }, paragraph.create(null, tail.size > 0 ? tail : null))
        const parent = $at.depth > 1 ? $at.node($at.depth - 1) : null
        // 消息容器 = 用户消息块或 AI 回复块：光标常落在消息块末尾的空段上「接着说」，就地嵌进去
        // 会让这条消息挂在别的消息块里，chat 模式渲染不出来、doc-send 也认不出（只认顶层）。
        const inMessage = parent != null && (parent.type === userMessage || parent.type === agentReply)
        if (!inMessage) {
          // 光标显式落进新消息块的内层段落：不设的话 selection 按 replaceWith 映射到替换区末端
          // = 下一个块的起点，后续字符会写进下一个块（后面紧挨着 AI 回复块时最明显：新消息
          // 空着、字全跑进回复里）
          const replaced = tr.replaceWith(range.start, range.end, msg)
          return replaced.setSelection(TextSelection.near(replaced.doc.resolve(range.start + 2), 1))
        }
        // 消息容器内：把消息挪到该容器之后（顶层）。段落直接挂在容器下才有得挪；
        // 挂在 list 等更深层不猜，保持字面量
        const outer = 1
        if ($at.depth - 1 !== outer) return null
        // 容器只有这一个孩子 → 换掉整个容器（不能删出空容器）；否则删掉这个空段、
        // 把消息插到容器之后
        const onlyChild = $at.node(outer).childCount === 1
        if (onlyChild) return tr.replaceWith($at.before(outer), $at.after(outer), msg)
        const after = tr.mapping.map($at.after(outer), -1)
        tr.delete(range.start, range.end)
        tr.insert(after, msg)
        // 光标落进新消息块的段落：输入规则拦下这次输入后，后续字符要接着写进这条消息
        return tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1))
      }),
    )
  }

  if (bulletList && listItem) {
    // "- [ ] " / "* [ ] " 整串兜底：与 wrappingInputRule 同款先删匹配文本再包 bullet_list
    // （findWrapping 会顺带插入中间层 list_item），再照 gfm wrapInTaskListInputRule 给 list_item 打 checked
    rules.push(
      new InputRule(/^[-*+] \[(?<checked>[ x])\]\s$/, (state, match, start, end) => {
        const tr0 = state.tr.delete(start, end)
        const $start = tr0.doc.resolve(start)
        const range = $start.blockRange()
        const wrapping = range && findWrapping(range, bulletList)
        if (!range || !wrapping) return null
        const tr = tr0.wrap(range, wrapping)
        // findWrapping 返回外到内 [bullet_list, list_item]：包裹链插在原块起点 range.start，
        // bullet_list 开口占 range.start，list_item 紧随其后（range.start + 1，与嵌套深度无关）
        const li = tr.doc.nodeAt(range.start + 1)
        if (!li || li.type !== listItem) return null
        return tr.setNodeMarkup(range.start + 1, undefined, {
          ...li.attrs,
          checked: match.groups?.checked === 'x',
        })
      }),
    )
  }

  if (imageNode) {
    // ![alt](src "title")：正则取自官方 insertImageInputRule（加 $ 锚定，防长文左移误匹配）
    rules.push(
      new InputRule(/!\[(?<alt>[^\]\n]*)\]\((?<src>[^)\s]+)(?:\s+"(?<title>[^"]*)")?\)$/, (state, match, start, end) => {
        const { alt, src, title } = match.groups ?? {}
        if (!src) return null
        return state.tr.replaceWith(start, end, imageNode.create({ src, alt, title }))
      }),
    )
  }

  if (linkMark) {
    rules.push(
      // [文字](url)（支持可选 "标题"）：整段替换成带 link mark 的文字，保留位置上已有其它 mark
      new InputRule(/\[(?<text>[^\]\n]+)\]\((?<href>[^)\s]+)(?:\s+"(?<title>[^"]*)")?\)$/, (state, match, start, end) => {
        const { text, href, title } = match.groups ?? {}
        if (!text || !href) return null
        const marks = linkMark.create(title ? { href, title } : { href }).addToSet(state.doc.resolve(start).marks())
        return state.tr.replaceWith(start, end, schema.text(text, marks))
      }),
      // 裸 URL + 空格：只给 URL 本体加 mark。末尾的 \s 是刚打的字符（尚未入 doc），
      // 规则拦截后默认插入不再发生，需自己补插空格并确保它不带链接 mark
      new InputRule(/(^|\s)(?<url>https?:\/\/[^\s]+)\s$/, (state, match, start, end) => {
        const url = match.groups?.url
        if (!url) return null
        const urlStart = start + (match[1]?.length ?? 0)
        if (end <= urlStart) return null
        const tr = state.tr.addMark(urlStart, end, linkMark.create({ href: url }))
        tr.insertText(' ', end, end)
        tr.removeMark(end, end + 1, linkMark)
        return tr
      }),
    )
  }

  return rules
}
