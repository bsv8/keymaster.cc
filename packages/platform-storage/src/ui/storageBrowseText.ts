// 预览用的纯文本处理：严格解码、字节展示与安全的 Markdown 渲染。
//
// 单独成文件有两个原因：一是这些是安全边界，应该能被直接测；二是页面组件
// 不应该塞进这些与渲染无关的字符串处理。

/** 严格 UTF-8 解码；非法字节不静默替换成 U+FFFD。 */
export function decodeUtf8Strict(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/**
 * 解码用于展示的文本。
 *
 * 截断时最后几个字节可能落在多字节字符中间，这不是文件损坏，因此先按完整
 * 字符边界回退再解码；解码仍失败才报告编码不支持。
 */
export function decodePreviewText(bytes: Uint8Array, truncated: boolean): { ok: true; text: string } | { ok: false } {
  const full = decodeUtf8Strict(bytes);
  if (full.ok) return full;
  if (!truncated) return { ok: false };
  // 逐字节丢弃尾部，直到序列重新合法；上限是 4 字节（UTF-8 最长字符）。
  for (let drop = 1; drop <= 4 && drop < bytes.length; drop += 1) {
    const candidate = decodeUtf8Strict(bytes.subarray(0, bytes.length - drop));
    if (candidate.ok) return candidate;
  }
  return { ok: false };
}

const BINARY_UNIT = 1024;

/** 字节数的可读化。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < BINARY_UNIT) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size;
  let index = -1;
  do {
    value /= BINARY_UNIT;
    index += 1;
  } while (value >= BINARY_UNIT && index < units.length - 1);
  const rounded = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[index]}`;
}

/** 短名：长哈希与公钥在树里缩写，完整值仍在属性面板。 */
export function abbreviateName(name: string): string {
  if (name.length <= 18) return name;
  // 保留扩展名：`.json` 之类的后缀是判断用途的最强线索，缩写掉反而更难认。
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const stem = suffix ? name.slice(0, dot) : name;
  if (stem.length <= 18) return name;
  return `${stem.slice(0, 10)}…${stem.slice(-4)}${suffix}`;
}

/** ISO 时间戳的可读化；无法解析时保留原文而不是显示 Invalid Date。 */
export function formatTimestamp(value: string, locale: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(at);
  } catch {
    return value;
  }
}
