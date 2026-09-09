// 初始化错误区与 Fatal 页面共用的纯脱敏器。
//
// 该文件不依赖 DOM、React 或业务服务；所有文本在进入 UI/Clipboard 之前
// 先经过这里。递归序列化有深度、条数和总长度上限，循环对象也不会触发
// 二次异常。

export interface DiagnosticSnapshotInput {
  /** 稳定阶段标识。 */
  phase: string;
  /** 稳定错误码。 */
  code: string;
  /** 公开关联 ID。 */
  incidentId: string;
  /** 当前回滚确认结果。 */
  rollback?: string;
  /** 面向开发者的错误摘要。 */
  message?: unknown;
  /** 可选 JavaScript stack。 */
  stack?: unknown;
  /** 额外结构化信息。 */
  details?: unknown;
  /** 应用版本；未提供时不虚构。 */
  appVersion?: string;
  /** 诊断生成时间；只接受调用方提供的展示值并再次脱敏。 */
  occurredAt?: string;
  /** 脱敏规则版本。 */
  redactionVersion?: string;
}

const SECRET_NAME = /password|passphrase|secret|token|authorization|cookie|credential|private.?key|wif|mnemonic|session.?key|access.?key/i;
const PRIVATE_HEX = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/giu;
const WIF = /(?<![A-Za-z0-9])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![A-Za-z0-9])/gu;
const MNEMONIC = /\b(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b/giu;
const LONG_TOKEN = /(?<![A-Za-z0-9])[A-Za-z0-9_-]{48,}(?![A-Za-z0-9])/gu;
const ABSOLUTE_PATH = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/var\/|\/tmp\/)[^\s"'<>)]*/gu;
const URL = /https?:\/\/[^\s"'<>]+/giu;
const PUBLIC_IDENTIFIER_NAME = /bucket.?id|public.?key|request.?id|lease.?id|session.?id|transaction.?id|incident.?id/i;

const MAX_DEPTH = 5;
const MAX_ITEMS = 80;
const MAX_TEXT = 12_000;

function truncate(value: string, limit = 256): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function truncateIdentifier(value: string): string {
  const normalized = sanitizeDiagnosticText(value);
  return normalized.length <= 14 ? normalized : `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

function redactUrl(value: string): string {
  try {
    const url = new globalThis.URL(value);
    return `${url.protocol}//${url.host || "(unknown-host)"}`;
  } catch {
    return "<redacted-url>";
  }
}

/** 对普通字符串执行 URL、路径、私钥形状和长 token 脱敏。 */
export function sanitizeDiagnosticText(input: string): string {
  let value = truncate(String(input), MAX_TEXT);
  value = value.replace(URL, (url) => redactUrl(url));
  value = value.replace(WIF, "<redacted-wif>");
  value = value.replace(MNEMONIC, "<redacted-mnemonic>");
  value = value.replace(PRIVATE_HEX, "<redacted-private-hex>");
  value = value.replace(ABSOLUTE_PATH, "<redacted-path>");
  value = value.replace(LONG_TOKEN, (token) => token.length > 96 ? "<redacted-token>" : `${token.slice(0, 6)}…${token.slice(-4)}`);
  // 处理未被 URL 正则捕获的常见 query/header 形式。
  value = value.replace(/\b(?:password|passphrase|secret|token|authorization|cookie|sessionToken|secretAccessKey)\b\s*[:=]\s*[^\s,;]+/giu, (pair) => `${pair.split(/[:=]/u)[0]}=<redacted>`);
  return truncate(value, MAX_TEXT);
}

function safeValue(value: unknown, depth: number, seen: WeakSet<object>, state: { items: number }): unknown {
  if (state.items >= MAX_ITEMS) return "<truncated-items>";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (typeof value === "bigint") return "<bigint>";
  if (typeof value === "function" || typeof value === "symbol") return `<${typeof value}>`;
  if (value instanceof Error) {
    state.items += 1;
    return {
      name: sanitizeDiagnosticText(value.name),
      message: sanitizeDiagnosticText(value.message),
      ...(value.stack ? { stack: sanitizeDiagnosticText(value.stack) } : {})
    };
  }
  if (typeof value !== "object") return "<unsupported>";
  if (seen.has(value)) return "<circular>";
  if (depth >= MAX_DEPTH) return "<max-depth>";
  seen.add(value);
  state.items += 1;
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => safeValue(item, depth + 1, seen, state));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS)) {
      if (SECRET_NAME.test(key)) output[key] = "<redacted>";
      else if (PUBLIC_IDENTIFIER_NAME.test(key) && typeof item === "string") output[key] = truncateIdentifier(item);
      else output[key] = safeValue(item, depth + 1, seen, state);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/** 有界、可复制的 JSON 诊断文本；不会直接 JSON.stringify 未知 cause。 */
export function sanitizeDiagnosticValue(value: unknown): string {
  try {
    const normalized = safeValue(value, 0, new WeakSet<object>(), { items: 0 });
    return truncate(JSON.stringify(normalized, null, 2) ?? "<empty>", MAX_TEXT);
  } catch {
    return "<diagnostic-unavailable>";
  }
}

/** 构造初始化/Fatal 共用的标准诊断块。 */
export function buildDiagnosticText(input: DiagnosticSnapshotInput): string {
  const lines = [
    "Keymaster 脱敏诊断",
    `阶段: ${sanitizeDiagnosticText(input.phase)}`,
    `错误码: ${sanitizeDiagnosticText(input.code)}`,
    `关联 ID: ${sanitizeDiagnosticText(input.incidentId)}`,
    ...(input.rollback ? [`回滚: ${sanitizeDiagnosticText(input.rollback)}`] : []),
    ...(input.appVersion ? [`应用版本: ${sanitizeDiagnosticText(input.appVersion)}`] : []),
    ...(input.occurredAt ? [`时间: ${sanitizeDiagnosticText(input.occurredAt)}`] : []),
    ...(input.redactionVersion ? [`脱敏规则: ${sanitizeDiagnosticText(input.redactionVersion)}`] : []),
    ...(input.message !== undefined ? [`摘要: ${sanitizeDiagnosticText(typeof input.message === "string" ? input.message : sanitizeDiagnosticValue(input.message))}`] : []),
    ...(input.stack !== undefined && input.stack !== "" ? [`Stack: ${sanitizeDiagnosticText(typeof input.stack === "string" ? input.stack : sanitizeDiagnosticValue(input.stack))}`] : []),
    ...(input.details !== undefined ? [`详情: ${sanitizeDiagnosticValue(input.details)}`] : [])
  ];
  return truncate(lines.join("\n"), MAX_TEXT);
}
