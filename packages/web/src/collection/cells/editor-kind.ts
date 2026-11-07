/* ---------- 一个属性用哪种编辑器（表格、看板卡片、行页面属性区、批量栏共用的唯一判定，CellEditor 按它渲染） ----------
 * inline = 就地输入框（Enter / 失焦提交）；popover = 贴着格子的弹层；toggle = 点一下即切换；none = 系统生成，不能改。
 * 关联（正向与反向）都是行选择器：反向关联虽然不存值（isComputedProp），却能改 —— store 换算成源集合那几行的增删。
 * 纯函数单独成文件：CellEditor 牵着上传、弹层等一串界面模块，判定本身要能在单测里直接跑。 */
import { isComputedProp, isReverseRelation, TITLE_PROP_ID, type CollectionProp } from '@ramet/shared/collection-model'

export type EditorKind = 'inline' | 'popover' | 'toggle' | 'none'

export function editorKind(prop: CollectionProp): EditorKind {
  if (prop.id === TITLE_PROP_ID) return 'inline'
  if (prop.type === 'relation') return 'popover'
  if (isComputedProp(prop)) return 'none'
  switch (prop.type) {
    case 'ai':
    case 'text':
    case 'number':
    case 'url':
    case 'email':
    case 'phone':
      return 'inline'
    case 'select':
    case 'multi_select':
    case 'status':
    case 'person':
    case 'date':
    case 'files':
      return 'popover'
    case 'checkbox':
      return 'toggle'
    case 'created_time':
    case 'edited_time':
    case 'created_by':
    case 'edited_by':
    case 'unique_id':
    case 'rollup':
    case 'formula':
    case 'button':
      return 'none'
  }
}

/** 批量栏能改的属性：反向关联不行 —— 每行的值不一样，「整体替换成同一份」要按每行各自换算成增删，
 *  而同一组源行写给好几行在「只能关联一行」时自相矛盾；在格子里逐行改 */
export function bulkEditable(prop: CollectionProp): boolean {
  return editorKind(prop) !== 'none' && !isReverseRelation(prop)
}

/** 弹层编辑器选一次就算改完（单选、状态：点一下即选中并关闭）；多选、人员、文件、日期可以接着改，批量栏要「应用」按钮 */
export function pickOnce(prop: CollectionProp): boolean {
  return prop.type === 'select' || prop.type === 'status'
}
