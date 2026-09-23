// Keymaster 自有的 BitFS 卖方状态机。
// SDK 只负责每一步的协议验证/签名；本文件负责进度、证据、I/O 与恢复。

import {
  completeSellerPayment,
  prepareSellerDelivery,
  prepareSellerPresign,
  verifySellerFunding,
  type SellerDeliveryEvidence,
  type SellerOpeningEvidence,
  type SellerPoolEvidence,
  type Signer,
  type SigningRequest,
  transactionID,
} from "go-bitfs";
import { BitfsTransactionBroadcaster } from "./broadcast.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";
import type { BitfsSellerProtocolPort, BitfsSellerProtocolResult } from "./sellerSession.js";
import { bitfsWorkflowFacts } from "./sdk.js";

/** Kind 5 验证后的应用可读视图。证据验证必须来自 go-bitfs，不得自行解释 CBOR。 */
export interface BitfsSellerContentResolution {
  /** PaymentAuthorizationID，32 字节小写 hex。 */
  authorizationIdHex: string;
  /** 按 Kind 5 授权 Hash 顺序读取并验证的 payload。 */
  payloads: Uint8Array[];
  /** 批次包含 Block 时提供的已验证 Seed 原文。 */
  seed?: Uint8Array;
}

/** 从 exact Kind 5 到本地内容的受限端口。 */
export interface BitfsSellerContentResolver {
  /** 只有 SDK 能公开验证后 Hash 时才能为 true。 */
  readonly ready: boolean;
  resolve(input: {
    /** exact Kind 1。 */
    quoteRaw: Uint8Array;
    /** 当前池证据。 */
    pool: SellerPoolEvidence;
    /** exact Kind 5。 */
    requestRaw: Uint8Array;
    /** 本会话绑定的 Seed Hash。 */
    seedHashHex: string;
  }): Promise<BitfsSellerContentResolution>;
}

export interface BitfsSellerProtocolDeps {
  /** 当前 Key 的受限签名器。 */
  signer: Signer;
  /** Keymaster 应用会话 journal。 */
  sessions: BitfsSessionJournal;
  /** 本地内容解析/读取端口。 */
  content: BitfsSellerContentResolver;
  /** 先入 outbox 再广播的交易器。 */
  broadcaster: BitfsTransactionBroadcaster;
  /** 当前 owner 压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 当前 Worker generation。 */
  generation(): number;
  /** 可信时钟。 */
  nowMs(): number;
  /** 明确区块高度；不可用本地估算。 */
  blockHeight(): Promise<number>;
}

/** 生产卖方端口；每条输出字节均在返回前已持久化。 */
export class BitfsSellerProtocol implements BitfsSellerProtocolPort {
  readonly ready: boolean;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: BitfsSellerProtocolDeps) {
    this.ready = deps.content.ready;
  }

  async openSession(input: { sessionId: string; quoteBytes: Uint8Array; seedHashHex: string; counterpartyPublicKeyHex: string }): Promise<void> {
    if (!this.ready) throw new Error("BitFS 卖方内容解析端口未就绪");
    await this.serial(input.sessionId, async () => {
      let record = await this.deps.sessions.get(input.sessionId);
      if (!record) {
        record = await this.deps.sessions.create({
          sessionId: input.sessionId,
          role: "seller",
          ownerPublicKeyHex: this.deps.ownerPublicKeyHex,
          counterpartyPublicKeyHex: input.counterpartyPublicKeyHex,
          seedHashHex: input.seedHashHex,
          generation: this.deps.generation(),
          phase: "quoted",
        }, this.deps.nowMs());
      }
      this.assertCurrent(record);
      if (!record.evidence.includes("kind1-quote")) {
        await this.deps.sessions.putEvidence(input.sessionId, record.revision, "kind1-quote", input.quoteBytes, this.deps.nowMs());
      }
    });
  }

  async onFrame(input: { sessionId: string; kind: import("go-bitfs").WireKind; bytes: Uint8Array }): Promise<BitfsSellerProtocolResult> {
    let result: BitfsSellerProtocolResult = { type: "none" };
    await this.serial(input.sessionId, async () => { result = await this.handle(input); });
    return result;
  }

  private async handle(input: { sessionId: string; kind: import("go-bitfs").WireKind; bytes: Uint8Array }): Promise<BitfsSellerProtocolResult> {
    let record = await this.requiredRecord(input.sessionId);
    this.assertCurrent(record);
    if (input.kind === 2) {
      if (record.phase !== "quoted" && record.phase !== "opening-presigned") return { type: "close", reason: "state_conflict" };
      if (record.evidence.includes("kind3-opening-response")) {
        const replay = await this.requiredEvidence(record.sessionId, "kind3-opening-response");
        return { type: "send", frames: [replay] };
      }
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, "kind2-opening-request", input.bytes, this.deps.nowMs());
      const prepared = await prepareSellerPresign(input.bytes, this.deps.signer);
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, "kind3-opening-response", prepared.outbound.bytes(), this.deps.nowMs());
      await this.deps.sessions.update(record.sessionId, record.revision, { phase: "opening-presigned" }, this.deps.nowMs());
      return { type: "send", frames: [prepared.outbound.bytes()] };
    }
    if (input.kind === 4) {
      if (record.phase !== "opening-presigned" && record.phase !== "funded") return { type: "close", reason: "state_conflict" };
      if (record.phase === "funded") return { type: "none" };
      const opening = await this.openingEvidence(record.sessionId);
      const funded = await verifySellerFunding(input.bytes, opening);
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, "kind4-funding-delivery", input.bytes, this.deps.nowMs());
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, "funding-transaction", funded.fundingTransactionRaw, this.deps.nowMs());
      await this.deps.sessions.update(record.sessionId, record.revision, { phase: "funded" }, this.deps.nowMs());
      return { type: "none" };
    }
    if (input.kind === 5) {
      if (record.phase !== "funded" && record.phase !== "paid") return { type: "close", reason: "state_conflict" };
      const quoteRaw = await this.requiredEvidence(record.sessionId, "kind1-quote");
      const pool = await this.poolEvidence(record);
      const content = await this.deps.content.resolve({ quoteRaw, pool, requestRaw: input.bytes, seedHashHex: record.seedHashHex });
      assertHash(content.authorizationIdHex);
      const requestName = `kind5-content-request-${content.authorizationIdHex}` as const;
      const deliveryName = `kind6-content-delivery-${content.authorizationIdHex}` as const;
      if (record.evidence.includes(deliveryName)) return { type: "send", frames: [await this.requiredEvidence(record.sessionId, deliveryName)] };
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, requestName, input.bytes, this.deps.nowMs());
      const prepared = await prepareSellerDelivery(await this.facts(), {
        quoteRaw,
        pool,
        requestRaw: input.bytes,
        contentPayloads: content.payloads,
        ...(content.seed === undefined ? {} : { seed: content.seed }),
      }, this.deps.signer);
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, deliveryName, prepared.outbound.bytes(), this.deps.nowMs());
      await this.deps.sessions.update(record.sessionId, record.revision, { phase: "delivery-prepared" }, this.deps.nowMs());
      return { type: "send", frames: [prepared.outbound.bytes()] };
    }
    if (input.kind === 7) {
      if (record.phase !== "delivery-prepared" && record.phase !== "payment-signing" && record.phase !== "payment-unknown") return { type: "close", reason: "state_conflict" };
      // Kind 7 的授权 ID 必须由前一次 Kind 5 解析结果确定；会话串行化保证只有一个待收款批次。
      const requestName = [...record.evidence].reverse().find((name) => name.startsWith("kind5-content-request-"));
      if (!requestName) return { type: "close", reason: "state_conflict" };
      const authorizationIdHex = requestName.slice("kind5-content-request-".length);
      const deliveryName = `kind6-content-delivery-${authorizationIdHex}` as const;
      const paymentName = `kind7-payment-update-${authorizationIdHex}` as const;
      const transactionName = `latest-payment-transaction-${authorizationIdHex}` as const;
      const requestRaw = await this.requiredEvidence(record.sessionId, requestName);
      const deliveryRaw = await this.requiredEvidence(record.sessionId, deliveryName);
      const quoteRaw = await this.requiredEvidence(record.sessionId, "kind1-quote");
      const delivery: SellerDeliveryEvidence = { rawKind1: quoteRaw, rawKind5: requestRaw, rawKind6: deliveryRaw };
      const priorPayment = record.evidence.includes(paymentName)
        ? await this.requiredEvidence(record.sessionId, paymentName)
        : undefined;
      if (priorPayment && !equalBytes(priorPayment, input.bytes)) return { type: "close", reason: "state_conflict" };
      if (record.evidence.includes(transactionName)) {
        const rawTransaction = await this.requiredEvidence(record.sessionId, transactionName);
        const txid = toHex(transactionID(rawTransaction));
        if (record.phase !== "payment-unknown" || record.pendingTxid !== txid) {
          record = await this.deps.sessions.update(record.sessionId, record.revision, { phase: "payment-unknown", pendingTxid: txid }, this.deps.nowMs());
        }
        const outcome = await this.deps.broadcaster.resume(rawTransaction);
        if (outcome.status === "confirmed") {
          await this.deps.sessions.update(record.sessionId, record.revision, { phase: "paid", pendingTxid: undefined }, this.deps.nowMs());
        }
        return { type: "none" };
      }

      // Kind 7 与 payment-signing 状态在调用协议签名步骤前先持久化。
      // Signer 还会把签名摘要和返回签名分开落盘，以便重启后复用同一签名。
      const prepared = await persistSellerKind7BeforeSigning({
        sessions: this.deps.sessions,
        record,
        authorizationIdHex,
        kind7Bytes: input.bytes,
        signer: this.deps.signer,
        nowMs: this.deps.nowMs(),
      });
      record = prepared.record;
      const completed = await completeSellerPayment(await this.facts(), {
        pool: await this.poolEvidence(record), delivery, requestRaw, updateRaw: input.bytes,
      }, prepared.signer);
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, transactionName, completed.rawTransaction, this.deps.nowMs());
      const txid = toHex(transactionID(completed.rawTransaction));
      record = await this.deps.sessions.update(record.sessionId, record.revision, {
        phase: "payment-unknown",
        pendingTxid: txid,
      }, this.deps.nowMs());
      // 会话必须先持有 exact 交易和 pendingTxid；即使广播期间崩溃，启动恢复也能关联并对账。
      const outcome = await this.deps.broadcaster.submit(completed.rawTransaction);
      if (outcome.status === "confirmed") {
        await this.deps.sessions.update(record.sessionId, record.revision, { phase: "paid", pendingTxid: undefined }, this.deps.nowMs());
      }
      return { type: "none" };
    }
    return { type: "close", reason: "unexpected_kind" };
  }

  private async poolEvidence(record: BitfsSessionRecord): Promise<SellerPoolEvidence> {
    const funded = await verifySellerFunding(await this.requiredEvidence(record.sessionId, "kind4-funding-delivery"), await this.openingEvidence(record.sessionId));
    const latestName = [...record.evidence].reverse().find((name) => name.startsWith("latest-payment-transaction-"));
    return latestName === undefined ? funded.pool : { ...funded.pool, latestPaymentRawTx: await this.requiredEvidence(record.sessionId, latestName) };
  }

  private async openingEvidence(sessionId: string): Promise<SellerOpeningEvidence> {
    return {
      rawKind2: await this.requiredEvidence(sessionId, "kind2-opening-request"),
      rawKind3: await this.requiredEvidence(sessionId, "kind3-opening-response"),
    };
  }

  private async facts() { return bitfsWorkflowFacts(this.deps.nowMs(), await this.deps.blockHeight()); }
  private async requiredRecord(sessionId: string): Promise<BitfsSessionRecord> { const value = await this.deps.sessions.get(sessionId); if (!value) throw new Error("BitFS 卖方会话不存在"); return value; }
  private async requiredEvidence(sessionId: string, name: import("./sessionJournal.js").BitfsEvidenceName): Promise<Uint8Array> { const value = await this.deps.sessions.getEvidence(sessionId, name); if (!value) throw new Error(`BitFS 卖方证据缺失: ${name}`); return value; }
  private assertCurrent(record: BitfsSessionRecord): void { if (record.generation !== this.deps.generation() || record.ownerPublicKeyHex !== this.deps.ownerPublicKeyHex) throw new Error("BitFS 卖方会话 generation 已失效"); }
  private async serial(sessionId: string, action: () => Promise<void>): Promise<void> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(action);
    this.locks.set(sessionId, next);
    try { await next; } finally { if (this.locks.get(sessionId) === next) this.locks.delete(sessionId); }
  }
}

/** SDK 尚未提供 Kind 5 已验证 Hash 视图时的 fail-closed 端口。 */
export function createUnavailableBitfsSellerContentResolver(): BitfsSellerContentResolver {
  return { ready: false, async resolve() { throw new Error("go-bitfs 尚未公开 Kind 5 已验证内容 Hash 视图"); } };
}

/** 在卖方签名前持久化 Kind 7；结果不明时恢复路径拒绝再次调用签名器。 */
export async function persistSellerKind7BeforeSigning(input: {
  /** 存储卖方会话与 exact 证据的 journal。 */
  sessions: BitfsSessionJournal;
  /** 当前 CAS 会话记录。 */
  record: BitfsSessionRecord;
  /** 对应 Kind 5 授权的稳定编号。 */
  authorizationIdHex: string;
  /** 买方发来的 exact Kind 7。 */
  kind7Bytes: Uint8Array;
  /** 卖方受限签名端口。 */
  signer: Signer;
  /** 显式当前时间。 */
  nowMs: number;
}): Promise<{ record: BitfsSessionRecord; signer: Signer }> {
  assertHash(input.authorizationIdHex);
  if (input.record.role !== "seller" || (input.record.phase !== "delivery-prepared" && input.record.phase !== "payment-signing")) {
    throw new Error("BitFS 会话不在收款准备阶段");
  }
  const suffix = input.authorizationIdHex;
  const requestName = `kind7-payment-update-${suffix}` as const;
  const digestName = `kind7-payment-sign-digest-${suffix}` as const;
  const signatureName = `kind7-payment-signature-${suffix}` as const;
  let record = input.record;
  const existingUpdate = await input.sessions.getEvidence(record.sessionId, requestName);
  if (existingUpdate && !equalBytes(existingUpdate, input.kind7Bytes)) throw new Error("BitFS 会话的 Kind 7 exact bytes 不一致");
  if (!record.evidence.includes(requestName)) {
    record = await input.sessions.putEvidence(record.sessionId, record.revision, requestName, input.kind7Bytes, input.nowMs);
  }
  if (record.phase === "delivery-prepared") {
    record = await input.sessions.update(record.sessionId, record.revision, { phase: "payment-signing" }, input.nowMs);
  }

  const persistEvidence = async (name: typeof digestName | typeof signatureName, bytes: Uint8Array): Promise<void> => {
    if (record.evidence.includes(name)) {
      const saved = await input.sessions.getEvidence(record.sessionId, name);
      if (!saved || !equalBytes(saved, bytes)) throw new Error("BitFS 签名恢复证据不一致");
      return;
    }
    // 对部分写入后崩溃的情况，putEvidence 会回读检查相同字节并补足索引。
    record = await input.sessions.putEvidence(record.sessionId, record.revision, name, bytes, input.nowMs);
  };
  const signer: Signer = {
    publicKey: () => input.signer.publicKey().slice(),
    async sign(request: Readonly<SigningRequest>, signal?: AbortSignal): Promise<Uint8Array> {
      if (request.purpose !== "transaction" || request.wireKind !== 0 || request.digest.byteLength !== 32) {
        throw new TypeError("BitFS 收款只允许一笔明确交易签名");
      }
      const savedDigest = await input.sessions.getEvidence(record.sessionId, digestName);
      const savedSignature = await input.sessions.getEvidence(record.sessionId, signatureName);
      if (savedDigest) {
        if (!equalBytes(savedDigest, request.digest)) throw new Error("BitFS 恢复交易签名摘要不一致");
        await persistEvidence(digestName, savedDigest);
        if (savedSignature) {
          await persistEvidence(signatureName, savedSignature);
          return savedSignature.slice();
        }
        // intent 已持久化但结果缺失时，无法判断崩溃发生在签名器调用前还是返回后。
        // 为遵守恢复期间绝不重签的约束，保持 fail-closed，等待显式人工处理。
        throw new Error("BitFS 收款签名结果不确定；恢复路径禁止再次调用签名器");
      }
      if (savedSignature) throw new Error("BitFS 签名持久化缺少对应摘要");
      // 首次签名前先保存签名意图。后续即使结果不明，也不会再次调用签名器。
      await persistEvidence(digestName, request.digest);
      const signatureBytes = await input.signer.sign(request, signal);
      await persistEvidence(signatureName, signatureBytes);
      return signatureBytes.slice();
    },
  };
  return { record, signer };
}

function assertHash(value: string): void { if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("PaymentAuthorizationID 不合法"); }
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
