// 类型来自官方包，运行时用同目录补丁版 JS（修 isSame 被后续 no-op 事务顶掉）。
// 升级 @milkdown/plugin-slash 后需重新生成补丁（见该 JS 头部说明）。
export { SlashProvider } from '@milkdown/plugin-slash'
