// SatSubscription 设置文件／用户表单的入口解析及字节工具。
// 内部状态和服务直接使用解析结果；SSP Wire 由上游 SDK 编解码。

import type { SatSupplierConfigV1 } from "@keymaster/contracts";

export function isCompressedPublicKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^(02|03)[0-9a-f]{64}$/.test(value);
}

export function assertCompressedPublicKeyHex(value: unknown, field: string): asserts value is string {
  if (!isCompressedPublicKeyHex(value)) throw new Error(`${field} must be lowercase compressed public key hex`);
}

export function assertSupplierId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("supplierId must be a lowercase ASCII identifier");
  }
}

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

/** 只在磁盘／用户表单入口调用；选择已声明字段并分离可变数组。 */
export function normalizeSupplierConfig(input: SatSupplierConfigV1): SatSupplierConfigV1 {
  if (!input || typeof input !== "object") throw new Error("invalid supplier config");
  assertSupplierId(input.supplierId);
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
    throw new Error("supplier name must contain 1 to 128 characters");
  }
  assertCompressedPublicKeyHex(input.supplierPublicKeyHex, "supplierPublicKeyHex");
  assertMultiaddrs(input.multiaddrs);
  if (typeof input.enabled !== "boolean") throw new Error("supplier enabled must be boolean");
  return {
    supplierId: input.supplierId, name: input.name, supplierPublicKeyHex: input.supplierPublicKeyHex,
    multiaddrs: [...input.multiaddrs], enabled: input.enabled,
  };
}

export function bytesToHex(value: Uint8Array): string {
  let out = "";
  for (const byte of value) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}
