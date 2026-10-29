// 集合的界面文案，并进 copy.ts 的 COPY.collection；单独成文件是为了让 copy.ts 不超过 800 行
import type { FilterOp, PropType, StatusGroup } from '@ramet/shared/collection-model'
import type { ColorName } from '@ramet/shared/md-dialect'

const TYPES: Record<PropType, string> = {
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
}

/** 筛选运算的叫法（按类型有不同说法的在 opLabel 里换） */
const OPS: Record<FilterOp, string> = {
  contains: '包含',
  not_contains: '不包含',
  eq: '等于',
  neq: '不等于',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  is: '是',
  is_not: '不是',
  in_group: '属于组',
  before: '早于',
  after: '晚于',
  empty: '为空',
  not_empty: '不为空',
  checked: '已勾选',
  unchecked: '未勾选',
}

const GROUPS: Record<StatusGroup, string> = { todo: '未开始', doing: '进行中', done: '已完成' }

const COLORS: Record<ColorName, string> = {
  gray: '灰',
  brown: '棕',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  purple: '紫',
  pink: '粉',
  red: '红',
}

export const COLLECTION_COPY = {
  /** 界面名（回收站条目、提及候选的类型说明） */
  label: '集合',
  newCollection: '新建集合',
  /** 页面树 section 头的 ＋：两项菜单 */
  addMenu: '新建页面 / 新建集合',
  createFailed: '新建集合失败',
  /** 集合页 / 集合块的状态 */
  loading: '加载中…',
  notFound: '集合不存在或无法加载',
  /** 写入失败（改值 / 建行 / 删行 / 拖动）：本地已回滚为服务端的状态 */
  writeFailed: '保存失败，已恢复为最新内容',
  dismiss: '知道了',
  noRows: '还没有行',
  newRow: '新建',
  loadMore: '加载更多',
  types: TYPES,
  ops: OPS,
  statusGroups: GROUPS,
  colors: COLORS,
  /** 视图标签 */
  views: {
    newTable: '表格',
    newBoard: '看板',
    add: '新建视图',
    layout: '布局',
    layouts: { table: '表格', board: '看板' },
    rename: '重命名',
    name: '视图名称',
    remove: '删除视图',
    lastOne: '至少要保留一个视图',
    confirmRemove: (name: string) => `删除视图「${name}」？行和属性不受影响。`,
    more: '视图设置',
  },
  /** 工具栏 */
  bar: {
    filter: '筛选',
    sort: '排序',
    group: '分组',
    props: '属性',
    count: (label: string, n: number) => (n > 0 ? `${label} ${n}` : label),
  },
  filter: {
    add: '添加筛选条件',
    empty: '没有筛选条件',
    value: '值',
    pick: '选择…',
    remove: '删除条件',
  },
  sort: {
    add: '添加排序',
    empty: '没有排序：可以拖动行手动排序',
    asc: '升序',
    desc: '降序',
    remove: '删除排序',
  },
  group: {
    none: '不分组',
    hint: '按状态或单选分组',
    empty: '没有可以分组的属性（先建一个状态或单选属性）',
    noValue: '无值',
  },
  props: {
    shown: '显示的属性',
    hidden: '隐藏的属性',
    add: '新建属性',
    show: '显示',
    hide: '隐藏',
    edit: '编辑属性',
    title: '名称',
    back: '返回',
  },
  /** 属性定义编辑（列菜单） */
  prop: {
    name: '属性名称',
    type: '类型',
    options: '选项',
    addOption: '添加选项',
    optionName: '选项名称',
    newOption: (n: number) => `选项 ${n}`,
    color: '颜色',
    removeOption: '删除选项',
    moveLeft: '左移',
    moveRight: '右移',
    hide: '在此视图中隐藏',
    remove: '删除属性',
    confirmRemove: (name: string) => `删除属性「${name}」？各行里的值会保留，恢复集合页的版本可以找回。`,
    readonlyType: '自动生成，不能编辑',
  },
  /** 单元格 */
  cell: {
    open: '打开',
    search: '搜索或新建选项…',
    searchPeople: '搜索成员…',
    create: (name: string) => `新建「${name}」`,
    clear: '清空',
    noMembers: '没有可选的成员',
    badNumber: '要填数字',
  },
  /** 行的选择与删除 */
  select: {
    count: (n: number) => `已选 ${n} 行`,
    all: '全选已加载的行',
    row: '选择这一行',
    remove: '删除',
    cancel: '取消',
    confirmRemove: (n: number) => `删除 ${n} 行？它们会移入回收站，可在回收站恢复。`,
    edit: '编辑属性',
    editPick: '改哪个属性',
    noEditable: '没有可批量编辑的属性',
    apply: '应用',
    checked: '勾选',
    unchecked: '取消勾选',
    duplicate: '复制',
    move: '移到…',
    movePick: '移到哪个集合',
    moveEmpty: '本空间没有别的集合',
    confirmMove: (n: number, title: string) =>
      `把 ${n} 行移到「${title}」？只有同名、同类型的属性会带过去（选项按名称对应），对不上的属性值会丢失。`,
  },
  drag: '拖动排序',
  /** 行手柄：点开菜单，拖动排序（无排序时） */
  handle: { tip: '点击打开菜单', tipDrag: '点击打开菜单，拖动排序', open: '打开', openTab: '在新标签页打开', copyLink: '复制链接' },
  /** 看板视图 */
  board: {
    needGroup: '看板按状态或单选分列',
    pickGroup: '选一个属性分列',
    add: '在这一列新建',
  },
  rowProps: '属性',
  /** 正文里的「集合」块与「链接视图」块（collection/block-view.tsx、editor/collection-block.ts） */
  embed: {
    publicHint: '集合暂不支持公开查看',
    loading: '加载中…',
    trashed: '集合在回收站',
    restore: '恢复',
    restoreFailed: '恢复失败',
    elsewhere: '集合已不在本页',
    unavailable: '无法加载这个集合',
    createFailed: '新建集合失败',
    removeBlock: '删除此块',
    noMove: '集合块不能挪到别的页面，可以在那边插入链接视图',
    name: '集合名称',
    linkTag: '链接视图',
    slashInline: '集合',
    slashInlineHint: '在这里新建一个集合（表格视图）',
    slashLink: '链接视图',
    slashLinkHint: '显示已有集合的一个视图',
    pick: '选择要链接的集合',
    pickEmpty: '这个空间还没有集合',
    pickNone: '没有匹配的集合',
    search: '搜索集合…',
  },
  fold: '折叠或展开这一组',
  /** 版本历史与「更新」流水里的属性 / 集合定义（collection-history） */
  history: {
    /** 属性定义还没到时属性项的占位名 */
    someProp: '属性',
    deletedProp: '已删除的属性',
    invalid: '（已失效的值）',
    yes: '是',
    no: '否',
    unnamed: '未命名',
    /** 人员：成员名单还没到 / 已不在这个空间 */
    loadingPerson: '…',
    unknownPerson: '已退出的成员',
    change: (name: string, from: string, to: string) => `${name}：${from} → ${to}`,
    set: (name: string, to: string) => `设置 ${name}：${to}`,
    clear: (name: string, from: string) => `清空 ${name}（原为 ${from}）`,
    touched: (name: string) => `改了 ${name}`,
    schema: {
      prop_add: (name: string) => `新增属性「${name}」`,
      prop_del: (name: string) => `删除属性「${name}」`,
      prop_edit: (name: string) => `修改属性「${name}」`,
      view_add: (name: string) => `新增视图「${name}」`,
      view_del: (name: string) => `删除视图「${name}」`,
      view_edit: (name: string) => `修改视图「${name}」`,
    },
    /** 行页面版本预览里的属性区 */
    snapshotProps: '这个版本的属性',
    differs: '与当前不同',
    empty: '空',
    /** 集合页的历史版本 */
    props: '属性',
    views: '视图',
    noProps: '没有属性',
    deleted: '已删除',
    filters: (n: number) => `筛选 ${n}`,
    sorts: (n: number) => `排序 ${n}`,
    grouped: '分组',
    restore: '恢复此版本',
    restoreHint: '恢复属性定义、视图和名称，行里的值不变',
  },
}
