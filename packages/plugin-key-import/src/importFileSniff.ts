// packages/plugin-key-import/src/importFileSniff.ts
// 文件内容快速嗅探工具。
// 设计缘由：导入页面需要在用户选完文件后立即判断"是不是加密的 bsv8 envelope"，
// 以决定是否显示密码输入框。嗅探必须使用真正的 JSON.parse + 形状判断，
// 不能用字符串精确匹配（pretty JSON、换行、空格都会破坏匹配）。

/** bsv8 envelope 形状判断：只判断必填字段类型，不依赖具体顺序或空格。 */
export function isBsv8KeyEnvelopeShape(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o["version"] !== "kek-v1") return false;
  if (o["kdf"] !== "argon2id") return false;
  if (o["cipher"] !== "xchacha20poly1305") return false;
  const kdfParams = o["kdf_params"];
  if (!kdfParams || typeof kdfParams !== "object") return false;
  if (typeof o["nonce_hex"] !== "string") return false;
  if (typeof o["ciphertext_hex"] !== "string") return false;
  return true;
}

/**
 * 判断文件内容是否像 bsv8 envelope —— 解析整个内容而不只是头部，
 * 所以 pretty JSON / 无空格 JSON 都能被正确识别。
 */
export function peekBsv8Envelope(bytes: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isBsv8KeyEnvelopeShape(parsed);
  } catch {
    return false;
  }
}
