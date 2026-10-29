// ---------- 新集合页的初始文档 ----------
// 集合页文档 page:<cid>：title 片段放集合名（与普通新建页同一个 newPageDoc），正文片段不用（集合页没有正文），
// Y.Map('collection') 放属性定义与视图（形状与解读见 @ramet/shared/collection-model）。
// 初始带一个「状态」属性（三组各一个默认选项）和一个表格视图；「名称」是隐含属性，不在 props 里。
// 建集合时这份文档不可能有活连接，所以直接生成整份状态（调用方 writeDocState 落盘），同 create_page。
//
// 哪些层是 Y.Map 是并发语义的一部分：props / 每个属性 / options / views / 每个视图 / widths 是 Y.Map，
// 各字段各自后写为准、两个人同时加选项能合并；选项本身、筛选、排序、shown 是普通值，整体替换。

import * as Y from 'yjs'
import {
  COLLECTION_VERSION,
  newShortId,
  newStatusOptions,
  newView,
  type PropJson,
  type ViewJson,
} from '@ramet/shared/collection-model'
import { newPageDoc } from '../agents/markdown.js'

const STATUS_PROP_NAME = '状态'
const TABLE_VIEW_NAME = '表格'

/** 先挂进父 map 再填：与 newPageDoc 里先并入文档再写 Y.XmlText 同一个习惯 */
function childMap(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  parent.set(key, map)
  return map
}

function writeProp(props: Y.Map<unknown>, id: string, json: PropJson): void {
  const prop = childMap(props, id)
  prop.set('name', json.name)
  prop.set('type', json.type)
  prop.set('pos', json.pos)
  if (!json.options) return
  const options = childMap(prop, 'options')
  for (const [optionId, option] of Object.entries(json.options)) options.set(optionId, option)
}

function writeView(views: Y.Map<unknown>, id: string, json: ViewJson): void {
  const view = childMap(views, id)
  const { widths, ...settings } = json
  for (const [key, value] of Object.entries(settings)) view.set(key, value)
  const widthMap = childMap(view, 'widths')
  for (const [propId, width] of Object.entries(widths)) widthMap.set(propId, width)
}

/** 新集合页的整份文档（标题 + 「状态」属性 + 默认表格视图） */
export function newCollectionDoc(title: string): Y.Doc {
  const doc = newPageDoc(title, [])
  doc.transact(() => {
    const root = doc.getMap<unknown>('collection')
    root.set('v', COLLECTION_VERSION)
    writeProp(childMap(root, 'props'), newShortId(), {
      name: STATUS_PROP_NAME,
      type: 'status',
      pos: 0,
      options: newStatusOptions(),
    })
    writeView(childMap(root, 'views'), newShortId(), newView(TABLE_VIEW_NAME, 'table', 0))
  })
  return doc
}
