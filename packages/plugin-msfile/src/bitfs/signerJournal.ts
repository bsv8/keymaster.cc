// 买方 SDK 签名调用的持久边界。
// 中文说明：每个签名先保存摘要，再调用 Vault；返回签名后立即保存。
// 若进程在摘要已保存、签名结果未保存时退出，恢复时拒绝再次签名。

import type { Signer, SigningRequest } from "go-bitfs";
import type { BitfsSessionJournal } from "./sessionJournal.js";

/** 当前买方签名对应的协议步骤。 */
export type BitfsBuyerSigningFamily = "kind2" | "kind5" | "kind7-payment" | "kind12-close";

/** 构造一个把签名意图和签名结果写入会话日志的受限签名器。 */
export function createJournaledBitfsBuyerSigner(input: {
  /** 保存精确签名证据的买方会话日志。 */
  sessions: BitfsSessionJournal;
  /** 当前买方协议会话编号。 */
  sessionId: string;
  /** 当前 Vault 提供的底层受限签名器。 */
  signer: Signer;
  /** 签名用途：开池、内容请求、付款更新或关池。 */
  family: BitfsBuyerSigningFamily;
  /** Kind 7 付款更新绑定的内容授权编号。 */
  authorizationIdHex?: string;
  /** 读取 Worker 当前身份与生命周期是否仍有效。 */
  assertCurrentContext(): void;
  /** 读取当前 UTC 毫秒时间。 */
  nowMs(): number;
  onError?(error: unknown): void | Promise<void>;
}): Signer {
  const expectedPurpose = input.family === "kind5" ? "wire_message" : "transaction";
  const expectedWireKind = input.family === "kind5" ? 5 : 0;
  if (input.family === "kind7-payment" && !/^[0-9a-f]{64}$/u.test(input.authorizationIdHex ?? "")) {
    throw new TypeError("Kind 7 买方签名需要有效的 PaymentAuthorizationID");
  }

  return {
    publicKey: () => input.signer.publicKey().slice(),
    async sign(request: Readonly<SigningRequest>, signal?: AbortSignal): Promise<Uint8Array> {
      try {
        input.assertCurrentContext();
        if (signal?.aborted) throw new DOMException("BitFS 买方签名已取消", "AbortError");
        if (request.purpose !== expectedPurpose || request.wireKind !== expectedWireKind || request.digest.byteLength !== 32) {
          throw new TypeError("BitFS 买方签名用途或摘要格式不符合当前步骤");
        }

        const suffix = input.family === "kind7-payment" ? input.authorizationIdHex! : toHex(request.digest);
        const digestName = `${input.family}-sign-digest-${suffix}` as const;
        const signatureName = `${input.family}-signature-${suffix}` as const;
        const savedDigest = await input.sessions.getEvidence(input.sessionId, digestName);
        const savedSignature = await input.sessions.getEvidence(input.sessionId, signatureName);
        if (savedDigest) {
          if (!equal(savedDigest, request.digest)) throw new Error("BitFS 买方恢复签名摘要与当前步骤不一致");
          await persist(input, digestName, savedDigest);
          if (!savedSignature) throw new Error("BitFS 买方签名结果未知；恢复期间禁止再次签名");
          await persist(input, signatureName, savedSignature);
          return savedSignature.slice();
        }
        if (savedSignature) throw new Error("BitFS 买方签名结果缺少对应摘要，已拒绝继续");

        await persist(input, digestName, request.digest);
        input.assertCurrentContext();
        const signature = await input.signer.sign(request, signal);
        input.assertCurrentContext();
        await persist(input, signatureName, signature);
        return signature.slice();
      } catch (error) {
        try { await input.onError?.(error); } catch {}
        throw error;
      }
    },
  };
}

async function persist(
  input: Parameters<typeof createJournaledBitfsBuyerSigner>[0],
  name: `kind2-sign-digest-${string}` | `kind2-signature-${string}` | `kind5-sign-digest-${string}` | `kind5-signature-${string}` | `kind7-payment-sign-digest-${string}` | `kind7-payment-signature-${string}` | `kind12-close-sign-digest-${string}` | `kind12-close-signature-${string}`,
  bytes: Uint8Array,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    input.assertCurrentContext();
    const record = await input.sessions.get(input.sessionId);
    if (!record || record.role !== "buyer") throw new Error("BitFS 买方签名会话不存在");
    const prior = await input.sessions.getEvidence(input.sessionId, name);
    if (prior && !equal(prior, bytes)) throw new Error("BitFS 买方签名证据与已保存字节冲突");
    if (!prior || !record.evidence.includes(name)) {
      try {
        await input.sessions.putEvidence(input.sessionId, record.revision, name, bytes, input.nowMs());
      } catch (error) {
        if (!isSessionRevisionConflict(error) || attempt === 4) throw error;
        continue;
      }
    }
    return;
  }
}

function isSessionRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /BitFS 会话修订冲突|BitFS 会话状态提交失败|storage_conflict|etag changed|Storage object changed|precondition/iu.test(message);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
