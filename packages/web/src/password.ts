/* ---------- 密码规则 ----------
 * 与后端同一套规则（≥8 位）；确认一致只在前端校验。强制改密页与设置弹窗「账户」分页
 * 共用本函数，避免两处规则漂移。 */

export const PASSWORD_MIN = 8

export function passwordError(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (password !== confirm) return '两次输入的密码不一致'
  return null
}
