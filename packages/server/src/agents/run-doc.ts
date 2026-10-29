// ---------- 过程页的协同文档 ----------
// 步骤是正文里的块（`run_step`，每步一块，带块 id），块里放一行文字：用户能改的是这一份，进下一轮上下文的也是这一份。
// 工具输入输出 / diff / 子代理正文等完整详情只在不可变的 runs.record，按 sid 取（shared/run-model 的 entrySid）。
// 运行中的步骤走 SSE、不进 Yjs，收尾归档时（runs.ts 的 archiveRun）一次落成块。
// 页面顶部摘要与底部的最终输出由前端按 record 画，不进文档。

import * as Y from 'yjs'
import type { Block, Inline } from '@ramet/shared/markdown-blocks'
import { entrySid, stepLabel, type RunEntry } from '@ramet/shared/run-model'
import { materialize } from './markdown.js'
import type { RunRecordV1 } from './run-record.js'

/** 归档页标题：过程 · MM-DD HH:mm。进程本地时区（生产由 TZ 指定） */
export function runTitle(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `过程 · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 搜索索引里的过程页文字：正文（步骤的字 + 用户笔记）+ 最终输出（纯文本回合没有步骤，输出也要搜得到）。
 *  归档与存储钩子（collab.ts 的 syncContentText）共用这一个，口径不会漂 */
export function runSearchText(bodyText: string, record: unknown): string {
  const output =
    record && typeof record === 'object' && 'output' in record && typeof record.output === 'string' ? record.output.trim() : ''
  return [bodyText.trim(), output].filter(Boolean).join('\n')
}

/** 正文里还指着的过程页 id（agent_reply 的 run 属性）。空串不算 */
export function referencedRunIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>()
  const walk = (node: Y.XmlFragment | Y.XmlElement): void => {
    node.forEach((child) => {
      if (!(child instanceof Y.XmlElement)) return
      if (child.nodeName === 'agent_reply') {
        const run = child.getAttribute('run')
        if (typeof run === 'string' && run) ids.add(run)
      }
      walk(child)
    })
  }
  walk(doc.getXmlFragment('prosemirror'))
  return ids
}

/** 一个步骤块的全部内容（与 web 的 run_step schema 一一对应）。缺省的项不写：Yjs 缺 attr = 前端取默认值 */
export type StepSpec = {
  sid: string
  k: 'tool' | 'thought' | 'say'
  kind?: string
  status?: string
  t?: number
  end?: number
  parent?: string
  text: string
}

/** 步骤的一行字落成行内内容：换行是 hardbreak（折叠态的单行省略交给 CSS，不靠截断数据） */
function textInlines(text: string): Inline[] {
  const out: Inline[] = []
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (i > 0) out.push({ br: true })
      if (line) out.push({ text: line, marks: [] })
    })
  return out
}

export function stepBlock(spec: StepSpec): Block {
  const attrs: Record<string, unknown> = { sid: spec.sid, k: spec.k }
  if (spec.kind) attrs.kind = spec.kind
  if (spec.status) attrs.status = spec.status
  if (spec.t !== undefined) attrs.t = spec.t
  if (spec.end !== undefined) attrs.end = spec.end
  if (spec.parent) attrs.parent = spec.parent
  return { name: 'run_step', attrs, inlines: textInlines(spec.text) }
}

/** record 里的一条 → 步骤块内容。文字 = 这一行的字（工具是标题 / 路径，思考 / 说明是原文） */
export function specOfEntry(entry: RunEntry, index: number): StepSpec {
  return {
    sid: entrySid(entry, index),
    k: entry.k,
    ...(entry.k === 'tool'
      ? { kind: entry.kind, status: entry.status, ...(entry.parentId ? { parent: entry.parentId } : {}) }
      : {}),
    ...(entry.t !== undefined ? { t: entry.t } : {}),
    ...(entry.end !== undefined ? { end: entry.end } : {}),
    text: stepLabel(entry),
  }
}

export function stepBlocks(entries: RunEntry[]): Block[] {
  return entries.map((entry, index) => stepBlock(specOfEntry(entry, index)))
}

/** 标题 + 步骤块 + 末尾空段落（用户笔记的落脚处）。块经 materialize 写，顶层块自带块 id */
export function buildRunDoc(record: RunRecordV1): Y.Doc {
  const doc = new Y.Doc()
  const title = new Y.XmlElement('paragraph')
  doc.getXmlFragment('title').insert(0, [title])
  const titleText = new Y.XmlText()
  title.insert(0, [titleText])
  titleText.insert(0, runTitle(record.startedAt))
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => materialize(body, [...stepBlocks(record.entries), { name: 'paragraph', attrs: {} }]))
  return doc
}
