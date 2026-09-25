// go-bitfs TypeScript 角色工作流的 Keymaster 适配层。
// SDK 只负责协议计算与验证；存储、时钟、网络、广播均由上层显式注入。

import type { ActiveKeyCrypto } from "@keymaster/contracts";
import {
  MultisigPoolEngine,
  WireError,
  type Signer,
  type SigningRequest,
  type PureFunctionFacts,
} from "go-bitfs";

/** 由 Coordinator 提供的显式 UTC 秒事实；SDK 不读取系统时钟。 */
export function bitfsWorkflowFacts(nowMs: number, blockHeight?: number): PureFunctionFacts {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("BitFS 当前时间必须是非负毫秒整数");
  if (blockHeight !== undefined && (!Number.isSafeInteger(blockHeight) || blockHeight < 0)) {
    throw new TypeError("BitFS 当前区块高度必须是非负整数");
  }
  return {
    nowUnixSeconds: BigInt(Math.floor(nowMs / 1_000)),
    ...(blockHeight === undefined ? {} : { blockHeight }),
  };
}

/** 把当前 Vault 的受限摘要签名能力收敛为 go-bitfs Signer。 */
export function createBitfsVaultSigner(cryptoPort: ActiveKeyCrypto): Signer {
  const identity = cryptoPort.getIdentity();
  const publicKey = hexToBytes(identity.publicKeyHex);
  if (publicKey.byteLength !== 33) throw new TypeError("BitFS Signer 需要 33 字节压缩公钥");
  return {
    publicKey: () => publicKey.slice(),
    async sign(request: Readonly<SigningRequest>, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted) throw new DOMException("BitFS 签名已取消", "AbortError");
      if (request.digest.byteLength !== 32 || (request.purpose !== "wire_message" && request.purpose !== "transaction")) {
        throw new TypeError("BitFS SDK 提交了不合法的受限签名请求");
      }
      const current = cryptoPort.getIdentity();
      if (current.publicKeyHex.toLowerCase() !== identity.publicKeyHex.toLowerCase()) {
        throw new WireError("unauthorized", request.wireKind, "signer", "签名期间 active Key 已变化");
      }
       try {
         const result = await cryptoPort.signDigest({ publicKeyHex: identity.publicKeyHex, digest: request.digest.slice().buffer as ArrayBuffer, format: "der" });
         if (result.format !== "der") throw new TypeError("Vault 返回了错误的签名格式");
         return new Uint8Array(result.signature).slice();
       } catch (error) {
         console.warn("[msfile] BitFS Vault digest signing failed", error instanceof Error ? error.message : String(error));
         throw error;
       }
    },
  };
}

/** 从三方已验证公钥推导规范池脚本；只返回副本，不构造协议状态或持久化 SDK 对象。 */
export function deriveBitfsPoolLockingScript(input: {
  /** 当前买方的压缩公钥。 */
  buyerPublicKeyHex: string;
  /** 报价绑定的卖方压缩公钥。 */
  sellerPublicKeyHex: string;
  /** 报价允许且本次选中的仲裁方压缩公钥。 */
  arbiterPublicKeyHex: string;
}): Uint8Array {
  const engine = new MultisigPoolEngine({
    buyerPublicKey: hexToBytes(input.buyerPublicKeyHex),
    sellerPublicKey: hexToBytes(input.sellerPublicKeyHex),
    arbiterPublicKey: hexToBytes(input.arbiterPublicKeyHex),
  });
  return engine.lockingScript().slice();
}

/** 把 SDK 稳定错误码映射成 MSFile 稳定错误码。 */
export function mapBitfsErrorCode(error: unknown): import("@keymaster/contracts").MsFileErrorCode {
  if (!(error instanceof WireError)) return "msfile_supplier_error";
  switch (error.code) {
    case "canceled": return "msfile_media_cancelled";
    case "expired":
    case "not_matured":
    case "state_conflict":
    case "insufficient_balance": return "msfile_supplier_error";
    case "signer_unavailable":
    case "unauthorized": return "msfile_unavailable";
    case "malformed_wire":
    case "non_canonical":
    case "unsupported_version":
    case "unsupported_kind":
    case "invalid_signature":
    case "invalid_evidence": return "msfile_protocol_error";
  }
}

function hexToBytes(value: string): Uint8Array {
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(value)) throw new TypeError("Vault 公钥不是压缩 secp256k1 公钥");
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}
