import { OnlinePaymentWait } from "./onlinePaymentWait.js";
// 仲裁应用编排：SDK 验证协议，应用保存进度、调度在线超时并执行显式操作。
// 构造函数和 list() 没有任务恢复副作用；重登不提交、不取回、不广播。
import {
  prepareSellerArbitration, completeSellerArbitratedPayment, inspectArbitrationCandidate,
  arbitrationContentPayloadBytes, verifySellerFunding, completeBuyerOpening,
  requestBuyerArbitratedContent, verifyBuyerArbitratedContent, parsePaymentState,
  verifyAcceptedPayment, type Signer, type BuyerPoolEvidence, type SellerPoolEvidence,
} from "go-bitfs";
import type { BorrowedModuleFileStore, MsFileArbitrationService, MsFileArbitrationTask } from "@keymaster/contracts";
import type { BitfsSessionJournal, BitfsSessionRecord, BitfsEvidenceName } from "./sessionJournal.js";
import type { BitfsArbitrationTransport, BitfsArbitrationEndpoint } from "./arbitrationClient.js";
import type { BitfsTransactionBroadcaster } from "./broadcast.js";
import { readBitfsBuyerLocalPaymentState } from "./buyerPoolState.js";
import { bitfsWorkflowFacts } from "./sdk.js";
import { sha256 } from "../sha256.js";
import { commitPurchasedMsFileContent, inspectPurchasedMsFileSeed } from "../storage/msfileSeedStore.js";

export interface BitfsArbitrationWorkflowDeps {
  owner: string;
  sessions: BitfsSessionJournal;
  store: BorrowedModuleFileStore;
  content: BorrowedModuleFileStore;
  signer: Signer;
  transport: BitfsArbitrationTransport;
  broadcaster: BitfsTransactionBroadcaster;
  services(): Promise<readonly MsFileArbitrationService[]>;
  /** 仅在手动取回/检查期间，验证链上仲裁交易并关闭买方专款账本。 */
  settleBuyer?(record: BitfsSessionRecord, pool: BuyerPoolEvidence): Promise<boolean>;
  assertActive(): void;
  signal: AbortSignal;
  now(): number;
}
interface StoredStatus { state: string; message: string; requestName?: BitfsEvidenceName; txid?: string }
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export class BitfsArbitrationWorkflow {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly wait = new OnlinePaymentWait();
  constructor(private readonly deps: BitfsArbitrationWorkflowDeps) {
    deps.signal.addEventListener("abort", () => this.dispose(), { once: true });
  }
  dispose(): void { this.wait.clear(); }
  /** 付款、关池、自动超时和手动仲裁共享同一会话串行门，避免迟到付款覆盖仲裁证据。 */
  async exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => { this.deps.assertActive(); return run(); });
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  cancelWait(id: string): void { this.wait.cancel(id); }
  /** 仅由当前实例真正发送 Kind 6 后调用；不扫描历史记录来补定时器。 */
  async delivered(id: string, timeoutSeconds: number): Promise<void> {
    await this.exclusive(id, async () => {
      const record = await this.record(id);
      if (record.role !== "seller" || record.phase !== "delivery-prepared" || !record.pendingAuthorizationId) return;
      const authorizationId = record.pendingAuthorizationId;
      this.wait.arm(id, timeoutSeconds, () => this.submit(id, authorizationId), authorizationId);
    });
  }
  async list(): Promise<MsFileArbitrationTask[]> {
    this.deps.assertActive();
    const result: MsFileArbitrationTask[] = [];
    for (const record of await this.deps.sessions.list()) {
      if (record.ownerPublicKeyHex !== this.deps.owner) continue;
      const saved = await this.status(record.sessionId);
      if (!saved && (record.phase === "paid" || record.phase === "closed" || !record.pendingAuthorizationId || !record.evidence.some(name => name.startsWith("kind5-content-request-")))) continue;
      result.push({ sessionId: record.sessionId, seedHashHex: record.seedHashHex, role: record.role,
        state: saved?.state ?? record.phase,
        message: saved?.message ?? (record.role === "seller" ? "交付后尚未收到付款，可申请仲裁" : "购买尚未完成，可尝试从仲裁取回已授权内容"),
        txid: saved?.txid ?? null,
        action: saved?.state === "settled" || saved?.state.startsWith("retrieved") ? "check" : record.role === "seller" ? "submit" : "retrieve" });
    }
    this.deps.assertActive();
    return result;
  }
  async submit(id: string, expectedAuthorizationId?: string, checkOnly = false): Promise<void> {
    return this.exclusive(id, async () => {
      let record = await this.record(id);
      if (record.role === "buyer" && checkOnly) {
        if (record.phase === "completed" || record.phase === "cancelled") return;
        const settled = await this.deps.settleBuyer?.(record, await this.buyerPool(record));
        this.deps.assertActive();
        const saved = await this.status(id);
        if (settled) {
          const latest = await this.record(id);
          await this.deps.sessions.update(id, latest.revision, { phase: saved?.state.startsWith("retrieved-partial") ? "cancelled" : "completed", pendingAuthorizationId: undefined, pendingTxid: undefined }, this.deps.now());
        }
        const partial = saved?.state.startsWith("retrieved-partial");
        await this.setStatus(id, { ...saved, state: partial ? settled ? "retrieved-partial-settled" : "retrieved-partial-pending" : settled ? "retrieved-settled" : "retrieved-pending-settlement", message: settled ? partial ? "本批内容已取回，费用池已结算；文件其它内容可另行购买" : "文件已取回，费用池结算已核验，余款已解除专款保护" : "已取回内容仍保留；费用池结算尚未查明，可稍后手动检查" });
        return;
      }
      if (record.role !== "seller") throw new Error("仅卖方可以申请仲裁");
      this.cancelWait(id);
      if (expectedAuthorizationId && record.pendingAuthorizationId !== expectedAuthorizationId) return;
      try {
        if (checkOnly) {
          const saved = await this.status(id);
          if (!saved?.txid) throw new Error("没有可查询的结算交易");
          const outcome = await this.deps.broadcaster.reconcile(saved.txid, this.deps.signal);
          this.deps.assertActive();
          if (outcome.status === "confirmed") {
            const current = await this.record(id);
            await this.deps.sessions.update(id, current.revision, { phase: "closed", pendingTxid: saved.txid }, this.deps.now());
          }
          await this.setStatus(id, { ...saved, state: outcome.status === "confirmed" ? "settled" : "broadcast-unknown", message: outcome.status === "confirmed" ? "仲裁结算已被节点接受（不代表区块确认）" : "结算仍未确定，可手动重试同一交易" });
          return;
        }
        let request = await this.deps.sessions.getEvidence(id, "kind8-arbitration-request");
        if (!request) {
          if (record.phase !== "delivery-prepared" || !record.pendingAuthorizationId) throw new Error("当前会话没有等待付款的有效交付");
          const pool = await this.sellerPool(record);
          const endpoint = await this.endpoint(id, hex(pool.opening.arbiterPublicKey));
          const info = await this.deps.transport.info?.({ endpoint, signal: this.deps.signal });
          this.deps.assertActive();
          if (!info) throw new Error("仲裁服务未提供可核验费率");
          const prepared = await prepareSellerArbitration(bitfsWorkflowFacts(this.deps.now()), { pool,
            requestRaw: await this.evidence(id, `kind5-content-request-${record.pendingAuthorizationId}`),
            deliveryRaw: await this.evidence(id, `kind6-content-delivery-${record.pendingAuthorizationId}`),
          }, this.deps.signer);
          this.deps.assertActive();
          request = prepared.outbound.bytes();
          const fee = BigInt(info.baseSat) + BigInt(info.perKiBSat) * BigInt(Math.ceil(arbitrationContentPayloadBytes(request) / 1024));
          // 验证池容量和费用候选，未通过时不向服务提交托管请求。
          inspectArbitrationCandidate(request, fee);
          await this.save(id, "arbitration-fee", bytes(fee.toString()));
          await this.save(id, "kind8-arbitration-request", request);
          record = await this.record(id);
          await this.deps.sessions.update(id, record.revision, { phase: "arbitration-prepared" }, this.deps.now());
        }
        const endpoint = await this.savedEndpoint(id);
        const fee = BigInt(JSON.parse(new TextDecoder().decode(await this.evidence(id, "arbitration-fee"))));
        const candidate = inspectArbitrationCandidate(request, fee);
        let response = await this.deps.sessions.getEvidence(id, "kind9-arbitration-response");
        if (!response) {
          await this.setStatus(id, { state: "submitting", message: "正在提交仲裁；若中断，请手动重试" });
          response = await this.deps.transport.exchange({ endpoint, request, signal: this.deps.signal });
          this.deps.assertActive();
        }
        let transaction = await this.deps.sessions.getEvidence(id, "arbitrated-payment-transaction");
        if (!transaction) {
          // SDK 重验回执及仲裁交易签名。签卖方之前严格绑定本地冻结费用候选。
          transaction = await completeSellerArbitratedPayment(bitfsWorkflowFacts(this.deps.now()), { requestRaw: request, responseRaw: response }, {
            publicKey: () => this.deps.signer.publicKey(),
            sign: async (signing, signal) => {
              this.deps.assertActive();
              if (signing.purpose !== "transaction" || !signing.transactionRaw || !equal(signing.transactionRaw, candidate.candidateRaw)) throw new Error("仲裁金额与已接受费用不符");
              await this.save(id, "kind9-arbitration-response", response!);
              const digest = await this.deps.sessions.getEvidence(id, "arbitration-sign-digest");
              const signature = await this.deps.sessions.getEvidence(id, "arbitration-signature");
              if (digest && !equal(digest, signing.digest)) throw new Error("仲裁签名摘要已固定，禁止替换");
              if (signature) { if (!digest) throw new Error("仲裁签名缺少摘要"); return signature; }
              if (digest) throw new Error("仲裁签名结果未知，禁止重复签名；请核查钱包付款记录");
              await this.save(id, "arbitration-sign-digest", signing.digest);
              const result = await this.deps.signer.sign(signing, signal);
              this.deps.assertActive();
              await this.save(id, "arbitration-signature", result);
              return result;
            },
          });
          this.deps.assertActive();
          await this.save(id, "kind9-arbitration-response", response);
          await this.save(id, "arbitrated-payment-transaction", transaction);
        }
        let outcome = await this.deps.broadcaster.resume(transaction, this.deps.signal);
        if (outcome.status === "result-unknown" && outcome.retryable) outcome = await this.deps.broadcaster.retry(outcome.txid, this.deps.signal);
        this.deps.assertActive();
        const latest = await this.record(id);
        await this.deps.sessions.update(id, latest.revision, { phase: outcome.status === "confirmed" ? "closed" : "arbitration-payment-unknown", pendingTxid: outcome.txid }, this.deps.now());
        await this.setStatus(id, { state: outcome.status === "confirmed" ? "settled" : outcome.status === "failed" ? "broadcast-failed" : "broadcast-unknown", txid: outcome.txid,
          message: outcome.status === "confirmed" ? "仲裁结算已被节点接受（不代表区块确认）" : outcome.status === "failed" ? `仲裁交易尚未结算：${outcome.reason}。可手动重试同一交易` : "已获得仲裁签名，广播结果未确定；可手动检查并重试" });
      } catch (error) { await this.failed(id, error); throw error; }
    });
  }
  async retrieve(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      const record = await this.record(id);
      if (record.role !== "buyer" || !record.pendingAuthorizationId) throw new Error("当前购买没有可取回的授权");
      try {
        const pool = await this.buyerPool(record);
        const endpoint = await this.endpoint(id, hex(pool.opening.arbiterPublicKey));
        const authorization = { rawKind1: await this.evidence(id, "kind1-quote"), rawKind5: await this.evidence(id, `kind5-content-request-${record.pendingAuthorizationId}`) };
        const saved = await this.status(id);
        let requestName = saved?.requestName;
        let request = requestName ? await this.deps.sessions.getEvidence(id, requestName) : undefined;
        // 网络失败重放 exact 请求；已收到签名 unavailable 后下一次手动操作创建新 nonce。
        if (!request || saved?.state === "unavailable") {
          request = (await requestBuyerArbitratedContent({ pool, authorization }, this.deps.signer)).bytes();
          requestName = `kind10-retrieval-request-${hex(await sha256(request))}`;
          await this.save(id, requestName, request);
        }
        await this.setStatus(id, { state: "retrieving", requestName, message: "正在从仲裁取回；若中断，请手动重试" });
        const responseName = requestName!.replace("kind10-retrieval-request-", "kind11-retrieval-response-") as BitfsEvidenceName;
        const response = await this.deps.sessions.getEvidence(id, responseName) ?? await this.deps.transport.exchange({ endpoint, request, signal: this.deps.signal });
        this.deps.assertActive();
        const staging = record.evidence.includes("download-plan") ? `bitfs-staging/by-seed/${record.seedHashHex}` : `bitfs-staging/${id}`;
        const seed = (await this.deps.content.get(`${staging}/seed.bin`))?.bytes;
        const verified = await verifyBuyerArbitratedContent({ pool, authorization, retrievalRequestRaw: request, retrievalResponseRaw: response, ...(seed ? { seed } : {}) });
        this.deps.assertActive();
        await this.save(id, responseName, response);
        if (!verified.available) {
          const messages = ["仲裁尚未收到托管，请等待卖方提交后手动重试", "仲裁尚未签署完成，请稍后手动重试", "托管内容已清理，无法取回"];
          await this.setStatus(id, { state: "unavailable", requestName, message: messages[verified.unavailableReason] ?? "内容暂不可取回" }); return;
        }
        for (const payload of verified.payloads) {
          this.deps.assertActive();
          const hash = hex(await sha256(payload));
          await this.deps.content.put(hash === record.seedHashHex ? `${staging}/seed.bin` : `${staging}/blocks/${hash}.bin`, payload);
        }
        const retrieved = await this.record(id);
        await this.deps.sessions.update(id, retrieved.revision, { phase: "arbitration-retrieval" }, this.deps.now());
        const complete = await this.commitIfComplete(record, staging);
        let settled = false;
        {
          try { settled = await this.deps.settleBuyer?.(record, pool) ?? false; } catch (error) { console.warn("[msfile] buyer arbitration ledger check deferred", error instanceof Error ? error.message : String(error)); }
          this.deps.assertActive();
          if (settled) {
            const latest = await this.record(id);
            await this.deps.sessions.update(id, latest.revision, { phase: complete ? "completed" : "cancelled", pendingAuthorizationId: undefined, pendingTxid: undefined }, this.deps.now());
          }
        }
        await this.setStatus(id, { state: complete ? settled ? "retrieved-settled" : "retrieved-pending-settlement" : "retrieved-partial", requestName, message: complete ? settled ? "文件已验证并取回入库，没有再次支付内容费用" : "文件已验证并取回入库，没有再次支付内容费用；费用池结算待手动检查" : "本批授权内容已取回并验证；文件尚有其它内容未下载" });
      } catch (error) { await this.failed(id, error); throw error; }
    });
  }
  private async commitIfComplete(record: BitfsSessionRecord, staging: string): Promise<boolean> {
    const seed = await this.deps.content.get(`${staging}/seed.bin`);
    const raw = await this.deps.sessions.getEvidence(record.sessionId, "purchase-manifest");
    if (!seed || !raw) return false;
    const manifest = JSON.parse(new TextDecoder().decode(raw));
    const info = await inspectPurchasedMsFileSeed({ seedHashHex: record.seedHashHex, seedBytes: seed.bytes, fileSizeBytes: manifest.fileSizeBytes });
    const blocks: Uint8Array[] = [];
    for (const hash of info.blockHashesHex) { const block = await this.deps.content.get(`${staging}/blocks/${hash}.bin`); if (!block) return false; blocks.push(block.bytes); }
    this.deps.assertActive();
    await commitPurchasedMsFileContent({ store: this.deps.content, seedHashHex: record.seedHashHex, seedBytes: seed.bytes, blocks, fileSizeBytes: manifest.fileSizeBytes, fileName: manifest.recommendedFilename, mediaType: "application/octet-stream", signal: this.deps.signal });
    return true;
  }
  private async sellerPool(record: BitfsSessionRecord): Promise<SellerPoolEvidence> {
    const initial = await verifySellerFunding(await this.evidence(record.sessionId, "kind4-funding-delivery"), { rawKind2: await this.evidence(record.sessionId, "kind2-opening-request"), rawKind3: await this.evidence(record.sessionId, "kind3-opening-response") });
    let pool = initial.pool; let sequence = 0;
    for (const name of record.evidence.filter(name => name.startsWith("latest-payment-transaction-"))) {
      const transaction = await this.evidence(record.sessionId, name); const payment = await parsePaymentState(transaction, pool.opening); await verifyAcceptedPayment(payment, pool.opening);
      if (payment.paymentSequence > sequence) { pool = { ...pool, latestPaymentRawTx: transaction }; sequence = payment.paymentSequence; }
    }
    return pool;
  }
  private async buyerPool(record: BitfsSessionRecord): Promise<BuyerPoolEvidence> {
    const completed = await completeBuyerOpening({ rawKind2: await this.evidence(record.sessionId, "kind2-opening-request"), rawKind3: new Uint8Array(), fundingTransactionRaw: await this.evidence(record.sessionId, "funding-transaction") }, await this.evidence(record.sessionId, "kind3-opening-response"));
    return (await readBitfsBuyerLocalPaymentState({ sessions: this.deps.sessions, session: record, completedOpening: completed.pool, excludeAuthorizationId: record.pendingAuthorizationId, includeLegacyPaymentEvidence: true })).pool;
  }
  private async endpoint(id: string, key: string): Promise<BitfsArbitrationEndpoint> {
    const saved = await this.deps.sessions.getEvidence(id, "arbitration-endpoint");
    if (saved) { const endpoint = JSON.parse(new TextDecoder().decode(saved)); if (endpoint.publicKeyHex !== key) throw new Error("原会话仲裁身份不一致"); return endpoint; }
    const service = (await this.deps.services()).find(service => service.publicKeyHex === key);
    if (!service) throw new Error("该费用池的仲裁方没有可信连接配置");
    const endpoint = { publicKeyHex: service.publicKeyHex, address: service.address };
    await this.save(id, "arbitration-endpoint", bytes(endpoint)); return endpoint;
  }
  private async savedEndpoint(id: string): Promise<BitfsArbitrationEndpoint> { return JSON.parse(new TextDecoder().decode(await this.evidence(id, "arbitration-endpoint"))); }
  private async record(id: string): Promise<BitfsSessionRecord> { this.deps.assertActive(); const record = await this.deps.sessions.get(id); if (!record || record.ownerPublicKeyHex !== this.deps.owner) throw new Error("当前钱包没有该买卖记录"); return record; }
  private async evidence(id: string, name: BitfsEvidenceName): Promise<Uint8Array> { const value = await this.deps.sessions.getEvidence(id, name); if (!value) throw new Error(`缺少仲裁证据：${name}`); return value; }
  private async save(id: string, name: BitfsEvidenceName, value: Uint8Array): Promise<void> { this.deps.assertActive(); const record = await this.record(id); await this.deps.sessions.putEvidence(id, record.revision, name, value, this.deps.now()); }
  private statusPath(id: string): string { if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(id)) throw new Error("会话编号不合法"); return `arbitration/${id}.json`; }
  private async status(id: string): Promise<StoredStatus | undefined> { const file = await this.deps.store.get(this.statusPath(id)); return file ? JSON.parse(new TextDecoder().decode(file.bytes)) : undefined; }
  private async setStatus(id: string, value: StoredStatus): Promise<void> { this.deps.assertActive(); await this.deps.store.put(this.statusPath(id), bytes(value)); }
  private async failed(id: string, error: unknown): Promise<void> { if (this.deps.signal.aborted) return; const saved = await this.status(id); await this.setStatus(id, { ...saved, state: "failed", message: error instanceof Error ? error.message : String(error) }); }
}
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
