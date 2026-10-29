import { Icon } from './icons'
import { avatarLook, type Person } from './people'

/** 头像（React 宿主：侧栏账号处、设置）。怎么画与对话气泡同一份规则（people.ts 的 avatarLook） */
export function Avatar({ person, size = 20 }: { person: Person | null; size?: number }) {
  const look = avatarLook(person)
  const style = {
    '--avatar-size': `${size}px`,
    ...(look.kind === 'initial' ? { '--avatar-bg': look.color } : {}),
  } as React.CSSProperties
  return (
    <span className={`avatar avatar-round is-${look.kind}`} style={style} title={look.kind === 'none' ? undefined : look.title} aria-hidden="true">
      {look.kind === 'image' ? (
        <img src={look.src} alt="" draggable={false} />
      ) : look.kind === 'initial' ? (
        look.text
      ) : (
        <Icon name="user" size={Math.round(size * 0.6)} />
      )}
    </span>
  )
}
