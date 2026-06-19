// packages/plugin-key-import/src/importFileSniff.ts
// 文件 / 文本内容快速嗅探工具。
// 设计缘由：导入页面需要在用户选完文件或粘贴文本后立即判断"是不是加密的 bsv8 envelope"，
// 以决定是否显示密码输入框。嗅探必须使用真正的 JSON.parse + 形状判断，
// 不能用字符串精确匹配（pretty JSON、换行、空格都会破坏匹配）。
//
// 硬切换 012（施工单 001）：JSON 文件与 JSON 文本必须共用同一套"是否像 envelope"的
// 嗅探逻辑；不再让文件和文本各自复制一份 JSON.parse + shape 判断。

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
 * 从 JSON 字符串中嗅探"是否像 bsv8 envelope"——只判断形状，不做私钥提取。
 * 设计缘由：文本模式下的导入材料与文件模式共用同一套形状判断，不应各自
 * 复制一份 JSON.parse + shape 判断。
 */
export function peekBsv8EnvelopeText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return isBsv8KeyEnvelopeShape(parsed);
  } catch {
    return false;
  }
}

/**
 * 判断文件内容是否像 bsv8 envelope —— 解析整个内容而不只是头部，
 * 所以 pretty JSON / 无空格 JSON 都能被正确识别。
 */
export function peekBsv8EnvelopeBytes(bytes: Uint8Array): boolean {
  return peekBsv8EnvelopeText(new TextDecoder().decode(bytes));
}

/**
 * 旧 API 兼容别名：原文件 bytes 嗅探入口名仍叫 `peekBsv8Envelope`。
 * 详见插件 key-import 的 ImportPage / FirstTimeImportWizard 既有调用。
 */
export const peekBsv8Envelope = peekBsv8EnvelopeBytes;