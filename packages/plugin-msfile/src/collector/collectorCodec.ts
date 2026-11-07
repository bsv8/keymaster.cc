// 采集提交编解码：规范 JSON、gzip、摘要。宿主提供压缩与哈希能力，
// 本模块只做字节拼接，不读时钟网络磁盘，不保管私钥。

/** 摘要域前缀，防止 BitFS wire 签名跨协议重放。 */
export const COLLECTOR_SIGNATURE_DOMAIN = "BitFSCollector/submission-v1\n";

/** 当前唯一的提交版本号。 */
export const COLLECTOR_SUBMISSION_VERSION = 1;

/** 当前唯一的签名版本号。 */
export const COLLECTOR_SIG_VERSION = 1;

/** 提交端点默认路径。 */
export const COLLECTOR_SUBMISSIONS_PATH = "/v1/submissions";

/**
 * 归一化提交地址：已含提交路径（含自定义前缀）则原样使用，
 * 否则补上默认路径。兼容只填基地址的旧配置。
 */
export function collectorSubmissionUrl(endpoint: string): string {
  let trimmed = endpoint.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (trimmed.endsWith(COLLECTOR_SUBMISSIONS_PATH)) return trimmed;
  return trimmed + COLLECTOR_SUBMISSIONS_PATH;
}

/** 请求头名。 */
export const COLLECTOR_HEADERS = {
  pubkey: "X-BitFSCollector-Pubkey",
  signature: "X-BitFSCollector-Signature",
  sigVersion: "X-BitFSCollector-SigVersion",
} as const;

/** 单条提交记录。 */
export interface CollectorRecord {
  /** 内容哈希，64 位小写 hex，也是队列键。 */
  seedHashHex: string;
  /** 文件名。 */
  fileName: string;
  /** 介绍，旧记录缺省空字符串。 */
  description: string;
  /** 长度，十进制规范字符串。 */
  fileSizeBytes: string;
  /** 小写 type/subtype。 */
  mediaType: string;
}

/**
 * 编码跨语言逐字节一致的规范 JSON：键顺序固定、无空白、
 * 文件按 seedHashHex 升序。
 */
export function collectorCanonicalJson(records: CollectorRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.seedHashHex < b.seedHashHex ? -1 : a.seedHashHex > b.seedHashHex ? 1 : 0));
  let out = '{"version":1,"files":[';
  sorted.forEach((record, index) => {
    if (index > 0) out += ",";
    out += `{"seedHashHex":${JSON.stringify(record.seedHashHex)},"fileName":${JSON.stringify(record.fileName)},"description":${JSON.stringify(record.description)},"fileSizeBytes":${JSON.stringify(record.fileSizeBytes)},"mediaType":${JSON.stringify(record.mediaType)}}`;
  });
  return `${out}]}`;
}

/** 十六进制小写编码。 */
export function collectorHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Base64 编码（浏览器 atob/btoa 与 Node Buffer 双兼容）。 */
export function collectorBase64Encode(bytes: Uint8Array): string {
  const buffer = globalThis.Buffer;
  if (typeof buffer !== "undefined") return buffer.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Base64 解码。 */
export function collectorBase64Decode(base64: string): Uint8Array {
  const buffer = globalThis.Buffer;
  if (typeof buffer !== "undefined") return new Uint8Array(buffer.from(base64, "base64"));
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** 摘要输入 = 域前缀 + gzip 原始字节；摘要 = SHA-256(输入)。 */
export function collectorDigestInput(gzip: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(COLLECTOR_SIGNATURE_DOMAIN);
  const input = new Uint8Array(prefix.byteLength + gzip.byteLength);
  input.set(prefix, 0);
  input.set(gzip, prefix.byteLength);
  return input;
}

/** 平台能力：gzip 压缩实际发送字节（字节不必跨实现相同）。 */
export type CollectorGzip = (canonical: Uint8Array) => Promise<Uint8Array>;

/** 平台能力：SHA-256。 */
export type CollectorSha256 = (input: Uint8Array) => Promise<Uint8Array>;

/** 默认 gzip 能力（CompressionStream，Worker/页面可用）。 */
export async function defaultCollectorGzip(canonical: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(canonical as BufferSource);
  await writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 默认 SHA-256 能力（SubtleCrypto）。 */
export async function defaultCollectorSha256(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input as BufferSource));
}
