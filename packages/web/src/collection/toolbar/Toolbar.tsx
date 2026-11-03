/* ---------- 视图工具栏：筛选 / 排序 / 分组 / 属性 ----------
 * 按钮上带当前条数；viewer 全部禁用（服务端那条连接本就只读，入口在这里关掉）。
 * 不分组的布局（画廊、日历、时间线，见 layoutGroups）分组按钮禁用，悬停说明原因：写了 groupBy 解析时也会被忽略。
 * 日历 / 时间线的条目只画标题，不出「属性」（选了显示哪些属性也看不到）。 */
import type * as Y from 'yjs'
import { findProp, layoutGroups, type CollectionSchema, type CollectionView } from '@ramet/shared/collection-model'
import { COPY } from '../../copy'
import { Icon, type IconName } from '../../icons'
import { usesDate } from '../layouts'
import { Popover, usePopover } from '../popover'
import { FilterMenu } from './FilterMenu'
import { GroupMenu, PropsMenu, SortMenu } from './menus'

const C = COPY.collection.bar

type Props = { doc: Y.Doc; schema: CollectionSchema; view: CollectionView; readOnly: boolean; spaceId: string | null }

type Which = 'filter' | 'sort' | 'group' | 'props'

export default function Toolbar({ doc, schema, view, readOnly, spaceId }: Props) {
  const [anchor, open, close] = usePopover()
  const which = anchor?.dataset.menu as Which | undefined
  const groupName = view.groupBy ? findProp(schema, view.groupBy)?.name : undefined
  const groupOff = !layoutGroups(view.layout)
  const button = (id: Which, icon: IconName, label: string, on: boolean) => (
    <button
      type="button"
      data-menu={id}
      className={'cl-bar-btn' + (on ? ' is-on' : '')}
      disabled={readOnly || (id === 'group' && groupOff)}
      title={id === 'group' && groupOff ? C.noGroup(COPY.collection.views.layouts[view.layout]) : undefined}
      aria-expanded={which === id}
      onClick={(e) => open(e.currentTarget)}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  )
  return (
    <div className="cl-bar">
      {button('filter', 'filter', C.count(C.filter, view.filter.all.length), view.filter.all.length > 0)}
      {button('sort', 'sort', C.count(C.sort, view.sorts.length), view.sorts.length > 0)}
      {button('group', 'group', groupName ? `${C.group}：${groupName}` : C.group, view.groupBy !== null)}
      {!usesDate(view.layout) && button('props', 'eye', C.props, false)}
      {anchor && which && !readOnly && (
        <Popover anchor={anchor} onClose={close} className="cl-bar-pop">
          {which === 'filter' && <FilterMenu doc={doc} schema={schema} view={view} spaceId={spaceId} />}
          {which === 'sort' && <SortMenu doc={doc} schema={schema} view={view} />}
          {which === 'group' && <GroupMenu doc={doc} schema={schema} view={view} onDone={close} />}
          {which === 'props' && <PropsMenu doc={doc} schema={schema} view={view} />}
        </Popover>
      )}
    </div>
  )
}
