// SatSubscription 输入校验。所有校验都在进入 transport/K-V 前完成，避免
// 把“看起来像配置”的字符串带入连接或付费路径。

import {
  MAX_AMOUNT_SCALE,
  validateChannel,
  validateJson
} from "sat-subscription-protocol/protocol";
import type {
  SatOwnerSupplierSettingsV1,
  SatSupplierConfigV1
} from "@keymaster/contracts";

/** 压缩 secp256k1 公钥 hex。 */
export function isCompressedPublicKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^(02|03)[0-9a-f]{64}$/.test(value);
}

/** 严格校验压缩公钥，不接受大写、0x 前缀或非压缩公钥。 */
export function assertCompressedPublicKeyHex(value: unknown, field: string): asserts value is string {
  if (!isCompressedPublicKeyHex(value)) throw new Error(`${field} must be lowercase compressed public key hex`);
}

/** 本地 supplierId 采用可迁移的 ASCII 标识。 */
export function assertSupplierId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("supplierId must be a lowercase ASCII identifier");
  }
}

/** 不改变输入的精确 channel 校验。 */
export function assertExactChannel(value: unknown, allowWildcard = false): asserts value is string {
  if (typeof value !== "string") throw new Error("channel must be a string");
  validateChannel(value, allowWildcard);
}

/** libp2p multiaddr 的最小安全校验；真正解析在 Window executor 完成。 */
export function assertMultiaddrs(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("multiaddrs must contain 1 to 32 addresses");
  }
  for (const address of value) {
    if (typeof address !== "string" || address.length === 0 || address.length > 512 || /[\u0000-\u001f\u007f]/.test(address)) {
      throw new Error("multiaddr contains an invalid address");
    }
  }
}

/** 校验供应商配置并返回防御性复制。 */
export function normalizeSupplierConfig(input: SatSupplierConfigV1): SatSupplierConfigV1 {
  if (!input || typeof input !== "object") throw new Error("invalid supplier config");
  assertSupplierId(input.supplierId);
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
    throw new Error("supplier name must contain 1 to 128 characters");
  }
  assertCompressedPublicKeyHex(input.supplierPublicKeyHex, "supplierPublicKeyHex");
  assertMultiaddrs(input.multiaddrs);
  if (typeof input.enabled !== "boolean") throw new Error("supplier enabled must be boolean");
  return { ...input, multiaddrs: [...input.multiaddrs] };
}

/** 校验 owner 供应商选择，不允许通过输入替换 owner 身份。 */
export function normalizeOwnerSettings(input: SatOwnerSupplierSettingsV1): SatOwnerSupplierSettingsV1 {
  if (!input || typeof input !== "object") throw new Error("invalid owner supplier settings");
  assertCompressedPublicKeyHex(input.ownerPublicKeyHex, "ownerPublicKeyHex");
  if (input.defaultPublishSupplierId !== null) assertSupplierId(input.defaultPublishSupplierId);
  if (!Array.isArray(input.receiveSupplierIds) || input.receiveSupplierIds.length > 64) {
    throw new Error("receiveSupplierIds exceeds the limit");
  }
  const receive = [...input.receiveSupplierIds];
  for (const supplierId of receive) assertSupplierId(supplierId);
  if (new Set(receive).size !== receive.length) throw new Error("receiveSupplierIds contains duplicates");
  return { ...input, receiveSupplierIds: receive };
}

/** SSP charged_amount 的规范十进制字符串；不转 number。 */
export function assertCanonicalAmount(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) {
    throw new Error("chargedAmount is not a canonical decimal string");
  }
  const fraction = value.includes(".") ? value.slice(value.indexOf(".") + 1) : "";
  if (fraction.length > MAX_AMOUNT_SCALE || (fraction.length > 0 && fraction.endsWith("0"))) {
    throw new Error("chargedAmount has a non-canonical scale");
  }
}

/** SPI 整数金额解析；禁止空串、前导零、负数和 number。 */
export function parseUnsignedBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${field} must be a canonical unsigned integer string`);
  return BigInt(value);
}

/** SPI 金额必须为正整数。 */
export function parsePositiveBigInt(value: unknown, field: string): bigint {
  const amount = parseUnsignedBigInt(value, field);
  if (amount <= 0n) throw new Error(`${field} must be positive`);
  return amount;
}

/** 复制并校验 JSON，保留原始字节。 */
export function copyValidatedJson(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("contentJson must be Uint8Array");
  validateJson(value);
  return value.slice();
}

/** 小写 hex 编码；仅用于 request_id / 公钥等诊断字段。 */
export function bytesToHex(value: Uint8Array): string {
  let out = "";
  for (const byte of value) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** 精确比较字节。 */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}
