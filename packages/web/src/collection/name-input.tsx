// ---------- 失焦 / Enter 才提交的名字输入（属性名、选项名、视图名、集合块名、关联的反向属性名共用） ----------
// 每个键一笔协同增量会把改名拆成一串版本，所以只在失焦或 Enter 时写；外部值变了（别人改了名）且自己没在打字时跟着变。
import { useEffect, useState } from 'react'

/** 失焦或 Enter 才提交的名字输入；外部值变了（别人改了名）且自己没在打字时跟着变 */
export function NameInput({
  value,
  onCommit,
  placeholder,
  autoFocus,
  className,
}: {
  value: string
  onCommit: (name: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() && draft !== value) onCommit(draft)
    else setDraft(value)
  }
  return (
    <input
      className={'cl-name-input' + (className ? ` ${className}` : '')}
      value={draft}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
    />
  )
}
