// packages/plugin-protocol/src/protocolService.ts
// 协议 service：transport + 校验 + source/origin 绑定 + 解锁/确认调度 +
// 调用 vault / keyspace + 构造 envelope + 签名/加解密。
//
// 设计缘由（施工单 001）：
//   - 一次只处理一个 request；状态机由 service 自己维护，UI 不参与。
//   - UI 只通过 subscribe 拿到 snapshot，通过 confirmByUser / rejectByUser
//     推动状态。
//   - popup 刷新 / 关闭 / opener 丢失 都视为会话结束，不在本地存任何
//     持久化。
//   - 不依赖 React；可单测。
//   - 错误分两类：
//       * 校验类（invalid_request / invalid_origin / wallet_locked 等）→
//         直接组 result 回 opener；
//       * 业务类（user_rejected / decrypt_failed / internal_error）→
//         同上。
//   - 用户在确认后、service 真正回传前发现 opener 不存在：直接结束
//     本地流程，不重试，不缓存。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  PROTOCOL_VERSION,
  type CipherDecryptParams,
  type CipherDecryptResult,
  type CipherEncryptParams,
  type CipherEncryptResult,
  type IdentityGetParams,
  type IdentityGetResult,
  type IntentSignParams,
  type IntentSignResult,
  type KeyspaceService,
  type MethodParams,
  type MethodResult,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolMethod,
  type ProtocolReadyMessage,
  type ProtocolResultMessage,
  type ProtocolService,
  type ProtocolSessionSnapshot,
  type VaultService
} from "@keymaster/contracts";
import { ProtocolValidationError, parseRequestMessage } from "./protocolValidation.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveSiteKey,
  sha256Bytes,
  signCompactSecp256k1
} from "./protocolCrypto.js";
import { cborDecode, cborEncode, type CborValue } from "./protocolCbor.js";
import { buildClaimProjectionFromParams } from "./protocolClaims.js";

/** ProtocolService 构造依赖。 */
export interface ProtocolServiceDeps {
  vault: VaultService;
  keyspace: KeyspaceService;
  /** 用于调试 / 日志的 logger（任意形状）。 */
  logger?: { info?: (input: unknown) => void; warn?: (input: unknown) => void; error?: (input: unknown) => void };
  /** 自定义 source window（默认取 `window.opener`）。 */
  resolveOpener?: () => Window | null;
  /** 自定义 ready 发送目标（默认 `target.postMessage(msg, "*")`）。 */
  postReady?: (target: Window, msg: ProtocolReadyMessage) => void;
  /** 自定义 result 发送（默认 `target.postMessage(msg, origin)`）。 */
  postResult?: (target: Window, origin: string, msg: ProtocolResultMessage) => void;
  /** 用户确认页 / 解锁页推动 session 状态使用。 */
  notifyUnlockChanged?: () => void;
}

interface RequestBinding {
  id: string;
  method: ProtocolMethod;
  params: MethodParams<ProtocolMethod>;
  source: Window;
  origin: string;
}

const READY_MESSAGE: ProtocolReadyMessage = { v: PROTOCOL_VERSION, type: "ready" };

export class ProtocolServiceImpl implements ProtocolService {
  private phase: ProtocolSessionSnapshot["phase"] = "waiting";
  private binding: RequestBinding | null = null;
  private listeners = new Set<(snap: ProtocolSessionSnapshot) => void>();
  private pendingRequestSnapshot:
    | { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> }
    | null = null;

  constructor(private readonly deps: ProtocolServiceDeps) {}

  /** 启动会话。挂在 window.message 监听**之后**再调用，确保 ready 不丢。 */
  startSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.emit();
    this.postReadyIfPossible();
  }

  /** 关闭当前会话并清空内部状态。 */
  endSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.emit();
  }

  /** 同步取当前快照。 */
  snapshot(): ProtocolSessionSnapshot {
    return this.snapshotInternal();
  }

  /** 订阅会话状态变化；立即把当前快照喂给 handler。 */
  subscribe(handler: (snap: ProtocolSessionSnapshot) => void): () => void {
    this.listeners.add(handler);
    handler(this.snapshotInternal());
    return () => this.listeners.delete(handler);
  }

  /** 处理来自 `window` 的 message 事件。 */
  handleMessage(event: MessageEvent): void {
    if (!this.binding) {
      this.tryAcceptFirstRequest(event);
      return;
    }
    // 已绑定：只接受同 source + 同 origin 的消息。其它一律忽略。
    if (event.source !== this.binding.source || event.origin !== this.binding.origin) {
      return;
    }
    // 当前 V1 不支持同会话多 request；忽略后续。
  }

  /** 用户在确认页点击"确认"。开始执行方法。 */
  async confirmByUser(): Promise<void> {
    if (!this.binding) {
      // 没绑定 request；忽略。
      return;
    }
    if (this.phase !== "confirming") {
      return;
    }
    const binding = this.binding;
    this.setPhase("executing");
    try {
      const result = await this.dispatch(binding);
      await this.replyResult(binding, result);
    } catch (err) {
      const protoErr = toProtocolError(err);
      await this.replyError(binding, protoErr.code, protoErr.message);
    }
  }

  /** 用户点击"取消"。回 user_rejected 并结束会话。 */
  async rejectByUser(): Promise<void> {
    if (!this.binding) {
      this.setPhase("waiting");
      this.emit();
      return;
    }
    const binding = this.binding;
    await this.replyError(binding, "user_rejected", "User rejected");
  }

  /** 解锁状态机推进：vault unlock 完成后由 UI 调本方法继续已绑定的 request。 */
  resumeAfterUnlock(): void {
    if (!this.binding) return;
    if (this.phase !== "unlocking") return;
    this.setPhase("confirming");
  }

  /** vault locked / uninitialized 时让 UI 进入解锁页。 */
  isWaitingForUnlock(): boolean {
    return this.phase === "unlocking" && this.binding !== null;
  }

  /** 给 UI 用的便利：当前已绑定的 request（如果已经进入 confirming / unlocking）。 */
  currentRequest(): { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> } | null {
    if (!this.binding) return null;
    return {
      id: this.binding.id,
      method: this.binding.method,
      params: this.binding.params
    };
  }

  /* ============== 内部 ============== */

  private snapshotInternal(): ProtocolSessionSnapshot {
    return {
      phase: this.phase,
      boundSource: this.binding?.source ?? null,
      boundOrigin: this.binding?.origin ?? null,
      method: this.binding?.method ?? null,
      requestId: this.binding?.id ?? null
    };
  }

  private setPhase(phase: ProtocolSessionSnapshot["phase"]): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshotInternal();
    for (const l of this.listeners) l(snap);
  }

  private postReadyIfPossible(): void {
    const opener = this.getOpener();
    if (!opener) {
      // 情况 A：opener 缺失。直接进 error 态。
      this.setPhase("error");
      return;
    }
    if (this.deps.postReady) {
      this.deps.postReady(opener, READY_MESSAGE);
      return;
    }
    // 真实 postMessage：用 "*" 即可——opener 已经在调用方站点上。
    // 第一条 request 进入时会再校验 origin。
    try {
      opener.postMessage(READY_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "ready.failed", data: { err: String(err) } });
    }
  }

  private tryAcceptFirstRequest(event: MessageEvent): void {
    const opener = this.getOpener();
    if (!opener) return;
    if (event.source !== opener) return;
    const data = event.data;
    // 必须是结构化合法的 request（v / type / id / method）。
    if (!looksLikeRequest(data)) return;
    let parsed;
    try {
      parsed = parseRequestMessage(data);
    } catch (err) {
      if (err instanceof ProtocolValidationError) {
        // 情况 B：非法 request；按规则忽略，不在 ready 之前 reject。
        return;
      }
      this.deps.logger?.error?.({ scope: "protocol.validation", event: "unexpected", data: { err: String(err) } });
      return;
    }
    this.binding = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params,
      source: event.source as Window,
      origin: event.origin
    };
    this.pendingRequestSnapshot = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params
    };
    // 决定下一步：vault unlocked → confirming；其它 → unlocking。
    const status = this.deps.vault.status();
    if (status === "unlocked") {
      this.setPhase("confirming");
    } else {
      this.setPhase("unlocking");
    }
  }

  private async dispatch(binding: RequestBinding): Promise<MethodResult> {
    switch (binding.method) {
      case "identity.get":
        return this.executeIdentityGet(binding.params as IdentityGetParams, binding.origin);
      case "intent.sign":
        return this.executeIntentSign(binding.params as IntentSignParams, binding.origin);
      case "cipher.encrypt":
        return this.executeCipherEncrypt(binding.params as CipherEncryptParams, binding.origin);
      case "cipher.decrypt":
        return this.executeCipherDecrypt(binding.params as CipherDecryptParams, binding.origin);
    }
  }

  private async executeIdentityGet(
    params: IdentityGetParams,
    eventOrigin: string
  ): Promise<IdentityGetResult> {
    if (params.aud !== eventOrigin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    const active = this.requireActiveKey();
    const { publicKeyHex, label, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);

    const { resolvedClaims, projection } = buildClaimProjectionFromParams(params, {
      activeKeyLabel: label
    });

    // envelope 真值 = [v, id, aud, iat, exp, text, subjectPublicKey, claims]
    // projection 已经是 [name, val] 二元组列表；CBOR 编码时直接转 CborValue。
    const envelopeInput: CborValue[] = [
      PROTOCOL_VERSION,
      this.binding!.id,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      publicKeyBytes,
      projection.map(([name, val]) => [name, valToCbor(val)])
    ];
    const envelopeCbor = cborEncode(envelopeInput);
    const signature = await this.signWithActive(keyId, envelopeCbor);

    return {
      identityEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature),
      subject: { publicKey: toBinaryField(publicKeyBytes) },
      resolvedClaims
    };
  }

  private async executeIntentSign(
    params: IntentSignParams,
    eventOrigin: string
  ): Promise<IntentSignResult> {
    if (params.aud !== eventOrigin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);
    const contentSha256 = sha256Bytes(new Uint8Array(params.content.bytes));
    // envelope 真值 = [v, id, aud, iat, exp, text, contentType, contentSha256, subjectPublicKey]
    const envelopeCbor = cborEncode([
      PROTOCOL_VERSION,
      this.binding!.id,
      params.aud,
      params.iat,
      params.exp,
      params.text,
      params.contentType,
      contentSha256,
      publicKeyBytes
    ]);
    const signature = await this.signWithActive(keyId, envelopeCbor);
    return {
      signedEnvelope: toBinaryField(envelopeCbor, "application/cbor"),
      signature: toBinaryField(signature)
    };
  }

  private async executeCipherEncrypt(
    params: CipherEncryptParams,
    eventOrigin: string
  ): Promise<CipherEncryptResult> {
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const siteKey = await this.deriveSiteKeyWithActive(keyId, eventOrigin);
    // inner plaintext = [v, contentType, contentBytes]
    const inner = cborEncode([
      PROTOCOL_VERSION,
      params.contentType,
      new Uint8Array(params.content.bytes)
    ]);
    const { nonce, cipherbytes } = aesGcmEncrypt(siteKey, inner);
    return {
      nonce: toBinaryField(nonce),
      cipherbytes: toBinaryField(cipherbytes)
    };
  }

  private async executeCipherDecrypt(
    params: CipherDecryptParams,
    eventOrigin: string
  ): Promise<CipherDecryptResult> {
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    let siteKey: Uint8Array;
    try {
      siteKey = await this.deriveSiteKeyWithActive(keyId, eventOrigin);
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    let plain: Uint8Array;
    try {
      plain = aesGcmDecrypt(
        siteKey,
        new Uint8Array(params.nonce.bytes),
        new Uint8Array(params.cipherbytes.bytes)
      );
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    let decoded: CborValue;
    try {
      decoded = cborDecode(plain);
    } catch {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    if (!Array.isArray(decoded) || decoded.length !== 3) {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    const [v, contentType, contentBytes] = decoded;
    if (v !== PROTOCOL_VERSION || typeof contentType !== "string" || !(contentBytes instanceof Uint8Array)) {
      throw protocolError("decrypt_failed", "Decrypt failed");
    }
    return {
      contentType,
      content: toBinaryField(contentBytes)
    };
  }

  private requireActiveKey() {
    const active = this.deps.keyspace.active();
    if (!active.activePublicKeyHex) {
      throw protocolError("active_key_unavailable", "No active key available");
    }
    const id = this.deps.keyspace.requireActiveKey();
    if (!id.publicKeyHex) {
      throw protocolError("active_key_unavailable", "No active key available");
    }
    return {
      publicKeyHex: id.publicKeyHex,
      label: id.label,
      keyId: id.keyId
    };
  }

  /** sign helper：从 vault.withPrivateKey 借私钥。 */
  private async signWithActive(keyId: string, bytes: Uint8Array): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return signCompactSecp256k1(material.hex, bytes);
    });
  }

  /** cipher siteKey 派生：借私钥后 HMAC。 */
  private async deriveSiteKeyWithActive(keyId: string, exactOrigin: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      return deriveSiteKey(material.hex, exactOrigin);
    });
  }

  /** publicKey 字节：用 vault.withPrivateKey 派生 33-byte compressed pubkey。 */
  private async fetchPublicKeyBytes(publicKeyHex: string, keyId: string): Promise<Uint8Array> {
    return this.deps.vault.withPrivateKey(keyId, async (material) => {
      const pub = secp256k1.getPublicKey(hexToBytes(material.hex), true);
      return pub;
    });
  }

  /* ============== 发送 ============== */

  private async replyResult(binding: RequestBinding, result: MethodResult): Promise<void> {
    if (!this.canPostToOpener(binding)) {
      // 情况 H：opener 已关，结束本地流程。
      this.setPhase("closing");
      this.endSession();
      return;
    }
    const message: ProtocolResultMessage = {
      v: PROTOCOL_VERSION,
      type: "result",
      id: binding.id,
      ok: true,
      result
    };
    this.postMessage(binding, message);
    this.setPhase("closing");
    this.endSession();
  }

  private async replyError(
    binding: RequestBinding,
    code: ProtocolErrorCode,
    errorMessage: string
  ): Promise<void> {
    if (this.canPostToOpener(binding)) {
      const message: ProtocolResultMessage = {
        v: PROTOCOL_VERSION,
        type: "result",
        id: binding.id,
        ok: false,
        error: { code, message: errorMessage }
      };
      this.postMessage(binding, message);
    }
    // 状态机切到 error 让 UI 展示错误；会话进入 closing 后续由 UI 决定关 popup。
    this.phase = "error";
    this.emit();
  }

  private canPostToOpener(binding: RequestBinding): boolean {
    try {
      const s = binding.source as Window & { closed?: boolean };
      if (s.closed === true) return false;
    } catch {
      return false;
    }
    return true;
  }

  private postMessage(binding: RequestBinding, message: ProtocolResultMessage): void {
    if (this.deps.postResult) {
      this.deps.postResult(binding.source, binding.origin, message);
      return;
    }
    try {
      binding.source.postMessage(message, binding.origin);
    } catch (err) {
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "postMessage.failed", data: { err: String(err) } });
    }
  }

  private getOpener(): Window | null {
    if (this.deps.resolveOpener) {
      return this.deps.resolveOpener();
    }
    if (typeof window === "undefined") return null;
    return window.opener;
  }
}

function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolValidationError) {
    return { code: err.code, message: err.message };
  }
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return { code: e.code as ProtocolErrorCode, message: e.message };
    }
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : "Internal error" };
}

function protocolError(code: ProtocolErrorCode, message: string): ProtocolError {
  return { code, message };
}

function looksLikeRequest(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === PROTOCOL_VERSION &&
    o.type === "request" &&
    typeof o.id === "string" &&
    typeof o.method === "string"
  );
}

function toBinaryField(bytes: Uint8Array, mime?: string) {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return mime
    ? { $type: "binary" as const, bytes: ab, mime }
    : { $type: "binary" as const, bytes: ab };
}

/** 把 claim 投影值安全转成 CborValue。 */
function valToCbor(v: unknown): CborValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(valToCbor);
  // 已经构造好的 ["binary", mime, sha256bytes] 投影：原样透传。
  if (Array.isArray(v) && v.length === 3 && v[0] === "binary" && typeof v[1] === "string" && v[2] instanceof Uint8Array) {
    return ["binary", v[1] as string, v[2] as Uint8Array];
  }
  if (typeof v === "object" && v && "$type" in v) {
    const f = v as { $type?: unknown; bytes?: unknown; mime?: unknown };
    if (f.$type === "binary" && f.bytes instanceof ArrayBuffer) {
      return new Uint8Array(f.bytes);
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("Invalid hex characters");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function createProtocolService(deps: ProtocolServiceDeps): ProtocolServiceImpl {
  return new ProtocolServiceImpl(deps);
}
