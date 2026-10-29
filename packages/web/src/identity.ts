export interface Identity {
  name: string
  color: string
}

// 6 色调色板，协作光标标签用
const PALETTE = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#0091ff', '#8e4ec6']

/** 登录用户名 → 光标身份：按用户名稳定取色，同一账号在任何浏览器颜色一致 */
export function cursorIdentity(username: string): Identity {
  let hash = 0
  for (let i = 0; i < username.length; i++) hash = (hash * 31 + username.charCodeAt(i)) | 0
  return { name: username, color: PALETTE[(hash >>> 0) % PALETTE.length]! }
}

/** 别人经 awareness 广播来的身份是不可信输入：名字非空、颜色是 #rrggbb 才收（颜色进内联 background-color） */
export function isIdentity(v: unknown): v is Identity {
  return (
    typeof v === 'object' &&
    v !== null &&
    'name' in v &&
    typeof v.name === 'string' &&
    v.name !== '' &&
    'color' in v &&
    typeof v.color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(v.color)
  )
}
