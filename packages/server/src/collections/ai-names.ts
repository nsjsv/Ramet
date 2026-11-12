// ---------- 给 agent 看的叫法：属性类型、视图布局（同界面上菜单里的说法，agent 转述给用户时对得上） ----------

import type { CollectionLayout, PropType } from '@ramet/shared/collection-model'

export const TYPE_NAMES: Record<PropType, string> = {
  text: '文本',
  number: '数字',
  select: '单选',
  multi_select: '多选',
  status: '状态',
  date: '日期',
  checkbox: '复选框',
  url: '链接',
  person: '人员',
  created_time: '创建时间',
  edited_time: '编辑时间',
  email: '邮箱',
  phone: '电话',
  created_by: '创建者',
  edited_by: '最后编辑者',
  unique_id: '自动编号',
  files: '文件与媒体',
  relation: '关联',
  rollup: '汇总',
  formula: '公式',
  button: '按钮',
  ai: 'AI 属性',
}

export const LAYOUT_NAMES: Record<CollectionLayout, string> = { table: '表格', board: '看板', list: '列表', gallery: '画廊', calendar: '日历', timeline: '时间线' }
