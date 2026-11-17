export type StorageJson = null | boolean | number | string | StorageJson[] | { [key: string]: StorageJson };
function canonicalStorageJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Storage value is not JSON serializable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value instanceof Uint8Array) {
    throw new TypeError("Storage value is not JSON serializable");
  }
  if (seen.has(value)) throw new TypeError("Storage value is cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("Storage array is sparse");
        items.push(canonicalStorageJson(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Storage value is not a JSON object");
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStorageJson((value as Record<string, unknown>)[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** JSON 键序无关、Uint8Array 按字节比较的 Storage 语义身份。 */
export function storageSemanticFingerprint(value: unknown): string {
  if (value instanceof Uint8Array) {
    return `binary:${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `json:${canonicalStorageJson(value, new Set())}`;
}

/** 与语义身份相同的 canonical JSON 文本，供 unique-value-id 编码。 */
export function canonicalizeStorageJson(value: unknown): string {
  return canonicalStorageJson(value, new Set());
}
