/** 随机 uuid v4。crypto.randomUUID 仅安全上下文（HTTPS / localhost）可用，http 明文访问（手机真机调试走 LAN IP）没有它，
 * 调用方（编辑器补块 id、集合乐观新建行）抛 TypeError 会断掉整条链路，所以必须兜底。 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  buf[6] = (buf[6]! & 0x0f) | 0x40 // version 4
  buf[8] = (buf[8]! & 0x3f) | 0x80 // variant 10
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
