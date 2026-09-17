// KeyHold SDK 包装（keyhold@2.1.0）。
//
// 桶内单 Key 文件的解析、序列化、加密与解锁全部走官方 SDK；平台层只负责
// 文件读写、文件名一致性与错误分类，不复制密码学实现。

import { exportPrivateKey, parseDocument, recommendedParameters, serializeDocument, unlockDocument } from "keyhold";
import type { KeyHoldDocumentV1 } from "@keymaster/contracts";

/** 严格解析单 Key 文件；BOM 与非规范 JSON 都会被拒绝。 */
export function parseKeyHoldDocument(input: string | Uint8Array): KeyHoldDocumentV1 {
  const raw = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (raw.startsWith("\ufeff")) throw new TypeError("KeyHold BOM is not allowed");
  return parseDocument(raw);
}

/** 序列化为 KeyHold 规范 JSON；用于新建与改密后的整文件替换。 */
export function serializeKeyHoldDocument(document: KeyHoldDocumentV1): string {
  return serializeDocument(document);
}

/** 使用该 Key 自己的密码解锁；失败统一抛错，调用方按认证失败处理。 */
export async function decryptKeyHoldDocument(
  document: KeyHoldDocumentV1,
  password: string,
): Promise<{ label: string; publicKeyHex: string; privateKey: Uint8Array }> {
  const result = await unlockDocument(document, password);
  if (result.publicKeyHex !== document.publicKeyHex) {
    result.privateKey.fill(0);
    throw new TypeError("KeyHold public key does not match the decrypted private key");
  }
  return { label: document.label, publicKeyHex: result.publicKeyHex, privateKey: result.privateKey };
}

/** 用显式参数创建一份新的 KeyHold 文档；调用方必须清零 privateKey。 */
export async function createKeyHoldDocument(
  input: { label: string; privateKey: Uint8Array },
  password: string,
  options?: { iterations?: number },
): Promise<KeyHoldDocumentV1> {
  const recommended = recommendedParameters();
  const parameters = options?.iterations === undefined
    ? recommended
    : { ...recommended, keyDerivation: { ...recommended.keyDerivation, iterations: options.iterations } };
  const encoded = await exportPrivateKey({
    privateKey: input.privateKey,
    password,
    label: input.label,
    parameters,
  });
  return parseDocument(encoded);
}
