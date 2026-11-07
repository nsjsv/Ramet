// ---------- 行属性值 → 一行文字（服务端：自动化的事件载荷、{{row.属性名}}、通知里「状态：进行中 → 完成」） ----------
// 读值一律经 readValue / rowValue（与表格同口径）：类型对不上、选项已删的读不出 = 「（已失效的值）」，空值 = 空串。
// 名字类的（人名、关联行的标题）由调用方查好放进 ctx（一次查齐，这里不碰库）。公式 / 汇总不写：它们的值不在行里，
// 要按窗口现算，自动化用不上。前端的同类函数在 web/src/collection/value-text.ts（多了汇总 / 公式与格式化的日期）。

import {
  fileList,
  findOption,
  formatNumber,
  idList,
  readValue,
  rowValue,
  TITLE_NAME,
  type CollectionProp,
  type CollectionRow,
  type CollectionSchema,
  type PropValue,
} from '@ramet/shared/collection-model'

export const INVALID = '（已失效的值）'

export type TextCtx = {
  /** 用户 id → 显示名；查不到写「已不在空间的人」 */
  name(userId: string): string | undefined
  /** 关联到的行 id → 标题；查不到写「已不在的行」 */
  title(pageId: string): string | undefined
}

/** 算出来的值（公式、汇总）与没有值的按钮：不写 */
export function textless(prop: CollectionProp): boolean {
  return prop.type === 'formula' || prop.type === 'rollup' || prop.type === 'button'
}

/** 一个读出来的值 → 文字（多值用「、」连） */
export function shownText(prop: CollectionProp, value: PropValue, ctx: TextCtx): string {
  switch (prop.type) {
    case 'select':
    case 'status':
      return findOption(prop, String(value))?.name || '（未命名）'
    case 'multi_select':
      return (idList(value) ?? []).map((id) => findOption(prop, id)?.name || '（未命名）').join('、')
    case 'person':
    case 'created_by':
    case 'edited_by':
      return (idList(value) ?? []).map((id) => ctx.name(id) ?? '已不在空间的人').join('、')
    case 'relation':
      return (idList(value) ?? [])
        .map((id) => {
          const title = ctx.title(id)
          return title === undefined ? '已不在的行' : title || '无标题'
        })
        .join('、')
    case 'checkbox':
      return value === true ? '是' : '否'
    case 'date':
      return String(value).replace('/', ' → ')
    case 'unique_id':
      return typeof value === 'number' ? formatNumber(prop, value) : String(value)
    case 'files':
      return (fileList(value) ?? []).map((f) => f.name).join('、')
    default:
      return String(value)
  }
}

/** 一个原始值（行文档 props 里的，或改之前的旧值）→ 文字；空 = ''，读不出 = INVALID */
export function rawText(prop: CollectionProp, raw: unknown, ctx: TextCtx): string {
  if (raw === undefined || raw === null || raw === '') return ''
  const value = readValue(prop, raw)
  return value === undefined ? INVALID : shownText(prop, value, ctx)
}

/** 整行：属性名 → 文字（名称在最前；公式 / 汇总不写；空值写空串） */
export function rowTexts(schema: CollectionSchema, row: CollectionRow, ctx: TextCtx): Record<string, string> {
  const out: Record<string, string> = { [TITLE_NAME]: row.title }
  for (const prop of schema.props) {
    if (textless(prop) || prop.name === TITLE_NAME) continue
    const value = rowValue(row, prop)
    out[prop.name] = value === undefined ? '' : shownText(prop, value, ctx)
  }
  return out
}

/** 这些值里提到的用户与关联行（调用方一次查齐名字 / 标题） */
export function referenced(schema: CollectionSchema, rows: Array<Record<string, unknown>>): { users: Set<string>; pages: Set<string> } {
  const users = new Set<string>()
  const pages = new Set<string>()
  for (const props of rows) {
    for (const prop of schema.props) {
      const kind = prop.type === 'person' ? users : prop.type === 'relation' ? pages : null
      if (!kind) continue
      for (const id of idList(readValue(prop, props[prop.id])) ?? []) kind.add(id)
    }
  }
  return { users, pages }
}
