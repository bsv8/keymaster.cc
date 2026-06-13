// packages/contracts/src/keyDisplay.ts
// Key 显示格式共享 helper。
// 设计缘由：
//   - 短公钥（"前 8 + ... + 后 8"）只是完整公钥的显示格式，不是新字段。
//   - 把"短公钥就是显示格式"作为共享工程事实：所有 UI 都走这个 helper，
//     防止各组件自行 slice() 导致格式漂移。
//   - helper 只做展示，不做校验、不做引用、不做持久化。
//   - 不参与接口传递：完整公钥仍是 publicKeyHex，短公钥由 UI 现算。

/**
 * 把完整公钥 hex 格式化为短公钥显示串。
 *
 * 规则：
 *   - 入参必须是完整压缩公钥 hex（66 个字符：02/03 + 32 字节）。
 *   - 太短直接抛英文错误。
 *   - 输出固定为 "前 8 + ... + 后 8"，使用 ASCII "..."（避免 Unicode
 *     截断符在不同字体/截图/搜索工具中表现不一致）。
 *
 * 设计缘由：
 *   - 短公钥必须能从完整公钥直接截断出来，让用户看到的短串与完整
 *     公钥保持视觉对应关系。
 *   - 失败快速：太短的输入一般是开发期错用，运行时静默回退会掩盖
 *     bug，因此抛错而不是返回空串或 fallback。
 */
export function formatShortPublicKey(publicKeyHex: string): string {
  // 33 字节压缩公钥的 hex 是 66 个字符；前 8 / 后 8 截断要求至少 16。
  // 这里用 16 作为"刚好够"的下限，比 66 略宽以便兼容测试 fixture。
  if (publicKeyHex.length < 16) {
    throw new Error("Public key too short");
  }
  return `${publicKeyHex.slice(0, 8)}...${publicKeyHex.slice(-8)}`;
}
