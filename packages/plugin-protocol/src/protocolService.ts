// packages/plugin-protocol/src/protocolService.ts
// 协议 service：transport + 校验 + source/origin 绑定 + 解锁/确认调度 +
// 调用 vault / keyspace + 构造 envelope + 签名/加解密 + 命令流历史。
//
// 设计缘由（施工单 002 硬切换：popup 复用与命令流）：
//   - **service 生命周期 = popup 生命周期**：popup 在，service 在；
//     单条 request 完成后 service 不结束，不发 `closing`。
//   - **request 生命周期 = 单条命令卡**：一条 request 收到后落到
//     `ProtocolCommandRecord`；状态推进时同步更新该记录。
//   - **closing 只在 `pageUnloading` 路径发出**：用户手工关窗 /
//     页面卸载 / demo 主动要求关闭。
//   - **一次只处理一条 request**：第二个 request 进入时被当前 binding
//     占用则忽略（非当前 binding source/origin 的请求也忽略）。
//   - **历史按 exact origin 归档**：首条合法 request 进来时按
//     `event.origin` 拉 DB；同会话切换 origin 时重新载入。
//   - **DB 主键与 transport requestId 解耦**：`ProtocolCommandRecord.id`
//     是 service 内部生成的稳定 UUID，与 `requestId`（transport 关联用）
//     分离。调用方即便重复 `requestId`，命令卡也不会互相覆盖。
//   - **历史加载用 merge 而不是 replace**：DB 读结果只覆盖非 in-flight 的
//     内存命令卡；当前进行中的命令卡永远保留在 feed 顶部。
//   - **DB 不可用不阻塞协议主流程**：DB 异常时 `historyAvailable=false`，
//     当前 request 仍正常完成，UI 顶部显示"历史不可用"。
//   - 不依赖 React；可单测。
//   - 错误分两类：校验类（invalid_request / invalid_origin 等）直接
//     走 result 回 opener；业务类同样。失败状态仍写命令卡。

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
  type ProtocolClosingMessage,
  type ProtocolCommandDb,
  type ProtocolCommandFeedState,
  type ProtocolCommandRecord,
  type ProtocolError,
  type ProtocolErrorCode,
  type ProtocolMethod,
  type ProtocolReadyMessage,
  type ProtocolResultMessage,
  type ProtocolService,
  type ProtocolSessionPhase,
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
  /**
   * 可选命令流 DB。manifest 在 setup 阶段打开并通过这个钩子注入；
   * 测试里可以传一个内存 fake。`undefined` 时按"历史不可用"降级。
   */
  commandDb?: ProtocolCommandDb;
  /** 用于调试 / 日志的 logger（任意形状）。 */
  logger?: { info?: (input: unknown) => void; warn?: (input: unknown) => void; error?: (input: unknown) => void };
  /** 自定义 source window（默认取 `window.opener`）。 */
  resolveOpener?: () => Window | null;
  /** 自定义 ready 发送目标（默认 `target.postMessage(msg, "*")`）。 */
  postReady?: (target: Window, msg: ProtocolReadyMessage) => void;
  /** 自定义 result 发送（默认 `target.postMessage(msg, origin)`）。 */
  postResult?: (target: Window, origin: string, msg: ProtocolResultMessage) => void;
  /**
   * 自定义 closing 发送（默认 `target.postMessage(msg, "*")`）。依赖中暴露
   * 这条通道是为了让 ProtocolPopupPage 在页面卸载路径上复用同一幂等门禁。
   */
  postClosing?: (target: Window, msg: ProtocolClosingMessage) => void;
  /** 用户确认页 / 解锁页推动 session 状态使用。 */
  notifyUnlockChanged?: () => void;
  /**
   * 自定义 ID 生成器。默认用 `crypto.randomUUID()`；测试可注入稳定 id。
   * 这一层**只**用作命令流 DB 主键（`ProtocolCommandRecord.id`），不参与
   * transport `requestId`。
   */
  generateId?: () => string;
}

interface RequestBinding {
  id: string;
  method: ProtocolMethod;
  params: MethodParams<ProtocolMethod>;
  source: Window;
  origin: string;
  /** 当前命令卡 id（service 内部生成，与 transport requestId 解耦）。 */
  recordId: string;
}

const READY_MESSAGE: ProtocolReadyMessage = { v: PROTOCOL_VERSION, type: "ready" };
const CLOSING_MESSAGE: ProtocolClosingMessage = { v: PROTOCOL_VERSION, type: "closing" };

export class ProtocolServiceImpl implements ProtocolService {
  private phase: ProtocolSessionPhase = "waiting";
  private binding: RequestBinding | null = null;
  private listeners = new Set<(snap: ProtocolSessionSnapshot) => void>();
  private feedListeners = new Set<(state: ProtocolCommandFeedState) => void>();
  private pendingRequestSnapshot:
    | { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> }
    | null = null;
  /**
   * 本会话是否已经向 opener 发过 `closing`。`closing` 与 `popup.closed` 是
   * 并联收敛的断开信号，因此本标志只用来防止重复发出 `closing` 本身。
   */
  private closingSent = false;

  /** 当前 origin（exact event.origin，**不**归一化）。 */
  private currentOriginValue: string | null = null;
  /** 当前 origin 下的命令流（最新在前；按 updatedAt desc）。 */
  private feedCommands: ProtocolCommandRecord[] = [];
  /** 命令流 DB 是否可用。false 时 UI 顶部显示"历史不可用"。 */
  private historyAvailableFlag: boolean;
  /** DB 加载 promise：避免重复打开 + 重复载入。 */
  private historyLoadInFlight: Promise<void> | null = null;
  /** 当前绑定的命令卡 id；用于状态推进时定位。 */
  private currentRecordId: string | null = null;

  constructor(private readonly deps: ProtocolServiceDeps) {
    this.historyAvailableFlag = Boolean(deps.commandDb);
  }

  /**
   * 内部稳定 id 生成器。**不**允许与 transport `requestId` 共用——同一
   * requestId 重复发来时，必须落两条不同命令卡，而不是互相覆盖。
   */
  private nextRecordId(): string {
    if (this.deps.generateId) {
      return this.deps.generateId();
    }
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // 兜底：测试环境或非常规运行时。用时间戳 + 随机数即可。
    return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 启动会话。挂在 window.message 监听**之后**再调用，确保 ready 不丢。 */
  startSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.closingSent = false;
    // 注意：startSession **不**清空 currentOrigin / feedCommands / history。
    // 设计缘由：popup 刷新场景下我们仍要按"上次服务的 origin"载入历史；
    // 但施工单 002 收口显式不恢复未完成 request，未完成 request 由 binding
    // 状态自然丢失。
    this.emit();
    this.postReadyIfPossible();
  }

  /**
   * 关闭当前会话并清空内部状态。**不**主动发 `closing`——`closing` 由
   * `pageUnloading` 路径发出，避免 `endSession` 误把单条 request 收尾
   * 当成"会话结束"。
   */
  endSession(): void {
    this.phase = "waiting";
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
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

  /** 当前 origin（exact event.origin）。未收到第一条 request 时为 null。 */
  currentOrigin(): string | null {
    return this.currentOriginValue;
  }

  /** 同步取当前命令流 feed 状态。 */
  feedSnapshot(): ProtocolCommandFeedState {
    return {
      currentOrigin: this.currentOriginValue,
      commands: this.feedCommands.slice(),
      historyAvailable: this.historyAvailableFlag
    };
  }

  /** 订阅命令流变化。立即把当前 feed 状态喂给 handler。 */
  subscribeFeed(handler: (state: ProtocolCommandFeedState) => void): () => void {
    this.feedListeners.add(handler);
    handler(this.feedSnapshot());
    return () => this.feedListeners.delete(handler);
  }

  /** 处理来自 `window` 的 message 事件。 */
  handleMessage(event: MessageEvent): void {
    if (!this.binding) {
      this.tryAcceptFirstRequest(event);
      return;
    }
    // 已绑定：只接受同 source + 同 origin 的消息；其它一律忽略。
    if (event.source !== this.binding.source || event.origin !== this.binding.origin) {
      return;
    }
    // 当前 V1 不支持同会话并发多 request；忽略后续。
  }

  /** 用户在确认页点击"确认"。开始执行方法。 */
  async confirmByUser(): Promise<void> {
    if (!this.binding) {
      return;
    }
    if (this.phase !== "confirming") {
      return;
    }
    const binding = this.binding;
    this.setPhase("executing");
    this.updateRecordPhase(binding.recordId, "executing");
    let result: MethodResult | null = null;
    let errCode: ProtocolErrorCode | null = null;
    let errMessage: string | null = null;
    try {
      result = await this.dispatch(binding);
    } catch (err) {
      const protoErr = toProtocolError(err);
      errCode = protoErr.code;
      errMessage = protoErr.message;
    }
    // 写命令卡终态：成功 / 失败 都落 DB。
    if (result) {
      this.updateRecordFinal(binding.recordId, "approved", "approved");
      await this.replyResult(binding, result);
    } else if (errCode && errMessage) {
      this.updateRecordFinal(binding.recordId, "failed", "failed", errCode, errMessage);
      await this.replyError(binding, errCode, errMessage);
    }
    // 单条 request 收尾：清 binding、phase 回到 waiting。
    // 不发 closing（closing 由 pageUnloading 路径发），不调 endSession。
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
  }

  /** 用户点击"取消"。回 user_rejected，把命令卡标 rejected，phase 回到 waiting。 */
  async rejectByUser(): Promise<void> {
    if (!this.binding) {
      this.setPhase("waiting");
      this.emit();
      return;
    }
    const binding = this.binding;
    this.updateRecordFinal(binding.recordId, "rejected", "rejected");
    await this.replyError(binding, "user_rejected", "User rejected");
    this.binding = null;
    this.pendingRequestSnapshot = null;
    this.currentRecordId = null;
    this.setPhase("waiting");
  }

  /** 解锁状态机推进：vault unlock 完成后由 UI 调本方法继续已绑定的 request。 */
  resumeAfterUnlock(): void {
    if (!this.binding) return;
    if (this.phase !== "unlocking") return;
    this.setPhase("confirming");
    this.updateRecordPhase(this.binding.recordId, "waiting_confirm");
  }

  /**
   * 页面层 best-effort 触发：用户手工关闭窗口 / 刷新 / 卸载时由
   * ProtocolPopupPage 调用。本方法**只**负责"如果还没发过 closing
   * 就尝试发一次"，发送失败不重试、不阻塞。idempotent。
   */
  pageUnloading(): void {
    this.sendClosingBestEffort();
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

  private setPhase(phase: ProtocolSessionPhase): void {
    this.phase = phase;
    this.emit();
  }

  private emit(): void {
    const snap = this.snapshotInternal();
    for (const l of this.listeners) l(snap);
  }

  private emitFeed(): void {
    const state = this.feedSnapshot();
    for (const l of this.feedListeners) l(state);
  }

  private postReadyIfPossible(): void {
    const opener = this.getOpener();
    if (!opener) {
      this.setPhase("error");
      return;
    }
    if (this.deps.postReady) {
      this.deps.postReady(opener, READY_MESSAGE);
      return;
    }
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
    if (!looksLikeRequest(data)) return;
    let parsed;
    try {
      parsed = parseRequestMessage(data);
    } catch (err) {
      if (err instanceof ProtocolValidationError) {
        // 非法 request：按规则忽略。
        return;
      }
      this.deps.logger?.error?.({ scope: "protocol.validation", event: "unexpected", data: { err: String(err) } });
      return;
    }
    // origin 切换：如果与上次服务的 origin 不同，重新载入该 origin 的历史。
    // 注意：载入完成前先把当前命令卡 upsert 到 feed；loadHistoryForOrigin
    // 用 merge 模式不会覆盖当前卡。
    if (this.currentOriginValue !== event.origin) {
      this.currentOriginValue = event.origin;
      // 触发历史载入（fire & forget；UI 走 historyAvailable 兜底）。
      void this.loadHistoryForOrigin(event.origin);
    }
    // 创命令卡：内部稳定 id 与 transport requestId 解耦，避免调用方
    // 重复 requestId 时旧命令卡被覆盖。
    const recordId = this.nextRecordId();
    const now = Date.now();
    const activePub = this.deps.keyspace.active().activePublicKeyHex ?? "";
    const newRecord: ProtocolCommandRecord = {
      id: recordId,
      origin: event.origin,
      requestId: parsed.id,
      method: parsed.method,
      phase: "waiting_unlock",
      decision: "pending",
      status: "pending",
      textSummary: this.summarizeText(parsed.params),
      claimsSummary: this.summarizeClaims(parsed.params),
      contentType: this.summarizeContentType(parsed.params),
      payloadSize: this.summarizePayloadSize(parsed.params),
      activePublicKeyHex: activePub,
      createdAt: now,
      updatedAt: now,
      finishedAt: 0,
      errorCode: "",
      errorMessage: ""
    };
    this.upsertFeedCommand(newRecord);
    this.persistRecord(newRecord);

    this.binding = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params,
      source: event.source as Window,
      origin: event.origin,
      recordId
    };
    this.pendingRequestSnapshot = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params
    };
    this.currentRecordId = recordId;
    const status = this.deps.vault.status();
    if (status === "unlocked") {
      this.setPhase("confirming");
      this.updateRecordPhase(recordId, "waiting_confirm");
    } else {
      this.setPhase("unlocking");
    }
  }

  private async dispatch(binding: RequestBinding): Promise<MethodResult> {
    console.info("[protocol] dispatch", {
      requestId: binding.id,
      method: binding.method,
      origin: binding.origin,
      paramsKeys: Object.keys(binding.params as object)
    });
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
    console.info("[protocol] identity.get begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      aud: params.aud,
      claimCount: params.claims?.length ?? 0
    });
    if (params.aud !== eventOrigin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    const active = this.requireActiveKey();
    const { publicKeyHex, label, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);

    const { resolvedClaims, projection } = buildClaimProjectionFromParams(params, {
      activeKeyLabel: label
    });

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
    console.info("[protocol] intent.sign begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      aud: params.aud,
      contentType: params.contentType,
      contentBytes: params.content.bytes.byteLength
    });
    if (params.aud !== eventOrigin) {
      throw protocolError("invalid_origin", "aud does not match event origin");
    }
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const publicKeyBytes = await this.fetchPublicKeyBytes(publicKeyHex, keyId);
    const contentSha256 = sha256Bytes(new Uint8Array(params.content.bytes));
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
    console.info("[protocol] cipher.encrypt begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      contentType: params.contentType,
      contentBytes: params.content.bytes.byteLength
    });
    const active = this.requireActiveKey();
    const { publicKeyHex, keyId } = active;
    const siteKey = await this.deriveSiteKeyWithActive(keyId, eventOrigin);
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
    console.info("[protocol] cipher.decrypt begin", {
      requestId: this.binding?.id,
      origin: eventOrigin,
      nonceBytes: params.nonce.bytes.byteLength,
      cipherbytesBytes: params.cipherbytes.bytes.byteLength
    });
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
    // 注意：单条 request 收尾**不**发 `closing`。closing 由
    // pageUnloading 路径在 popup 真正销毁时发。
  }

  private async replyError(
    binding: RequestBinding,
    code: ProtocolErrorCode,
    errorMessage: string
  ): Promise<void> {
    console.error("[protocol] replyError", {
      requestId: binding.id,
      method: binding.method,
      origin: binding.origin,
      code,
      errorMessage
    });
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

  /**
   * best-effort 发送 `closing`。idempotent：最多发一次。失败不重试、
   * 不抛、不阻塞，由 client 端 `popup.closed === true` 兜底。
   *
   * 优先级：绑定的 request source > window.opener。前者覆盖 service 启动后
   * opener 已被回收的情况；后者覆盖 popup 页面在 waiting 阶段就触发卸载
   * （还没绑定 request）的边缘情况。
   */
  private sendClosingBestEffort(): void {
    if (this.closingSent) return;
    const target = this.binding?.source ?? this.getOpener();
    if (!target) {
      this.closingSent = true;
      return;
    }
    if (!this.canPostToTarget(target)) {
      this.closingSent = true;
      return;
    }
    this.closingSent = true;
    if (this.deps.postClosing) {
      try {
        this.deps.postClosing(target, CLOSING_MESSAGE);
      } catch (err) {
        this.deps.logger?.error?.({ scope: "protocol.transport", event: "closing.failed", data: { err: String(err) } });
      }
      return;
    }
    try {
      target.postMessage(CLOSING_MESSAGE, "*");
    } catch (err) {
      this.deps.logger?.error?.({ scope: "protocol.transport", event: "closing.failed", data: { err: String(err) } });
    }
  }

  private canPostToTarget(target: Window): boolean {
    try {
      const s = target as Window & { closed?: boolean };
      if (s.closed === true) return false;
    } catch {
      return false;
    }
    return true;
  }

  private getOpener(): Window | null {
    if (this.deps.resolveOpener) {
      return this.deps.resolveOpener();
    }
    if (typeof window === "undefined") return null;
    return window.opener;
  }

  /* ============== 命令流（feed）+ DB ============== */

  /**
   * 推一条命令到当前 feed。`commands` 数组按 `updatedAt desc` 排序；
   * 同 `id` 已存在时覆盖并前移。
   */
  private upsertFeedCommand(record: ProtocolCommandRecord): void {
    const idx = this.feedCommands.findIndex((c) => c.id === record.id);
    if (idx >= 0) {
      this.feedCommands[idx] = record;
    } else {
      this.feedCommands.unshift(record);
    }
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
  }

  private updateRecordPhase(id: string, phase: ProtocolCommandRecord["phase"]): void {
    const rec = this.feedCommands.find((c) => c.id === id);
    if (!rec) return;
    rec.phase = phase;
    rec.status = phase;
    rec.updatedAt = Date.now();
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
    this.persistRecord(rec);
  }

  private updateRecordFinal(
    id: string,
    phase: ProtocolCommandRecord["phase"],
    decision: ProtocolCommandRecord["decision"],
    errorCode: string = "",
    errorMessage: string = ""
  ): void {
    const rec = this.feedCommands.find((c) => c.id === id);
    if (!rec) return;
    rec.phase = phase;
    rec.decision = decision;
    rec.status = phase;
    rec.errorCode = errorCode;
    rec.errorMessage = errorMessage;
    rec.finishedAt = Date.now();
    rec.updatedAt = rec.finishedAt;
    this.feedCommands.sort((a, b) => b.updatedAt - a.updatedAt);
    this.emitFeed();
    this.persistRecord(rec);
  }

  private persistRecord(record: ProtocolCommandRecord): void {
    const db = this.deps.commandDb;
    if (!db) return;
    void db.putCommand(record).catch((err) => {
      console.error("[protocol.commandDb] persistRecord failed", {
        id: record.id,
        origin: record.origin,
        error: err instanceof Error ? err.message : String(err)
      });
      // 写失败 → 历史不可用；UI 顶部显示"历史不可用"提示。
      // 仍然在内存里保留命令卡，主协议流程不中断。
      // 注意：写成功**不**主动把 historyAvailable 翻回 true —— 历史可用
      // 是由"DB 能读 + DB 能写"共同决定的，单次写成功不足以证明 DB
      // 已经恢复。翻回 true 只能由 loadHistoryForOrigin 成功完成时做。
      if (this.historyAvailableFlag) {
        this.historyAvailableFlag = false;
        this.emitFeed();
      }
    });
  }

  private async loadHistoryForOrigin(origin: string): Promise<void> {
    if (this.historyLoadInFlight) {
      return this.historyLoadInFlight;
    }
    const db = this.deps.commandDb;
    if (!db) {
      this.historyAvailableFlag = false;
      // 即使没 DB，也保留当前 in-flight 命令卡（如果有）。
      this.feedCommands = this.feedCommands.filter(
        (c) => c.origin === origin && c.id === this.currentRecordId
      );
      this.emitFeed();
      return;
    }
    const task = (async () => {
      try {
        const list = await db.listCommandsByOrigin(origin);
        // merge：DB 列表是基线，但**当前 in-flight 命令卡**必须保留。
        // 因为 in-flight 卡的最新状态只在内存里，DB 里可能还没有它的
        // 中间态记录（持久化是 fire & forget）。
        const inflight = this.currentRecordId
          ? this.feedCommands.find((c) => c.id === this.currentRecordId)
          : undefined;
        const merged: ProtocolCommandRecord[] = list.slice();
        if (inflight && !merged.some((c) => c.id === inflight.id)) {
          merged.unshift(inflight);
        }
        merged.sort((a, b) => b.updatedAt - a.updatedAt);
        this.feedCommands = merged;
        this.historyAvailableFlag = true;
        this.emitFeed();
      } catch (err) {
        console.error("[protocol.commandDb] loadHistoryForOrigin failed", {
          origin,
          error: err instanceof Error ? err.message : String(err)
        });
        this.historyAvailableFlag = false;
        // 读失败时也保留当前 in-flight 命令卡。
        this.feedCommands = this.feedCommands.filter(
          (c) => c.id === this.currentRecordId
        );
        this.emitFeed();
      } finally {
        this.historyLoadInFlight = null;
      }
    })();
    this.historyLoadInFlight = task;
    return task;
  }

  /* ============== 摘要工具 ============== */

  private summarizeText(params: MethodParams<ProtocolMethod>): string {
    const p = params as { text?: unknown };
    return typeof p.text === "string" ? p.text : "";
  }

  private summarizeClaims(params: MethodParams<ProtocolMethod>): string[] {
    const p = params as { claims?: unknown };
    if (Array.isArray(p.claims)) {
      return p.claims.filter((c): c is string => typeof c === "string");
    }
    return [];
  }

  private summarizeContentType(params: MethodParams<ProtocolMethod>): string {
    const p = params as { contentType?: unknown };
    return typeof p.contentType === "string" ? p.contentType : "";
  }

  private summarizePayloadSize(params: MethodParams<ProtocolMethod>): number {
    const p = params as { content?: { bytes?: { byteLength?: number } }; cipherbytes?: { bytes?: { byteLength?: number } } };
    if (p.content?.bytes && typeof p.content.bytes.byteLength === "number") {
      return p.content.bytes.byteLength;
    }
    if (p.cipherbytes?.bytes && typeof p.cipherbytes.bytes.byteLength === "number") {
      return p.cipherbytes.bytes.byteLength;
    }
    return 0;
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
