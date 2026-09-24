// BitFS 买方 DataChannel 会话：开池、按序取块、验货付款和最终入库。
//
// Worker 提供签名、链上查询、内容存储与 DataChannel 发送能力；本文件只用
// go-bitfs 纯步骤验证/签名，且每个对外 Artifact 都先写入会话证据再发送。

import {
  acceptBuyerQuote,
  completeBuyerOpening,
  inspectSellerDeliveryRequest,
  parse,
  parsePaymentState,
  prepareBuyerCloseArtifact,
  prepareBuyerContentRequest,
  verifyAcceptedPayment,
  verifyBuyerCompletedCloseArtifact,
  verifyBuyerDelivery,
  transactionID,
  type BuyerPoolEvidence,
  type SellerPoolEvidence,
  type Signer,
  type WireKind,
} from "go-bitfs";
import type { MsFileBitfsPurchasePhase, OwnerFileStore } from "@keymaster/contracts";
import type { BitfsBuyerTask } from "./buyerTask.js";
import type { BitfsBuyerDownloadPlan } from "./buyerDownloadPlan.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";
import { createJournaledBitfsBuyerSigner } from "./signerJournal.js";
import { bitfsWorkflowFacts } from "./sdk.js";
import { commitPurchasedMsFileContent, inspectPurchasedMsFileSeed } from "../storage/msfileSeedStore.js";

const MAX_CHAIN_WAIT_MS = 120_000;
const CHAIN_POLL_INTERVAL_MS = 2_000;
const POOL_FEE_RESERVE_MULTIPLIER = 2n;
const PURCHASE_MANIFEST_FORMAT = "keymaster.bitfs-purchase-manifest";

/** 报价验签后固定的文件入库信息；重启后不需要重新接受可能已过期的报价。 */
interface BitfsBuyerPurchaseManifest {
  /** 入库清单格式标识。 */
  format: typeof PURCHASE_MANIFEST_FORMAT;
  /** 入库清单版本号。 */
  version: 1;
  /** 与买方会话绑定的 Seed Hash。 */
  seedHashHex: string;
  /** 报价签名绑定的原文件字节数。 */
  fileSizeBytes: string;
  /** 报价给出的推荐文件名。 */
  recommendedFilename: string;
}

/**
 * Worker 重启后续做已进入 content-committing 的本地提交。
 * 该阶段只会在付款交易已按 Kind 5 授权观察后写入；这里不签名、不广播，
 * 只从已验收暂存区重新执行幂等的 Block → Seed → meta 入库。
 */
export async function recoverBitfsBuyerContentCommit(input: {
  /** 买卖会话与证据日志。 */
  sessions: BitfsSessionJournal;
  /** 当前 Owner 的 MSFile 根存储。 */
  contentStore: OwnerFileStore;
  /** 需要恢复的买方会话编号。 */
  sessionId: string;
  /** 显式 UTC 毫秒。 */
  nowMs: number;
  /** 文件提交后刷新卖方派生索引。 */
  onContentCommitted?(seedHashHex: string): Promise<void> | void;
}): Promise<boolean> {
  const record = await input.sessions.get(input.sessionId);
  if (!record || record.role !== "buyer" || record.phase !== "content-committing") return false;
  const manifestRaw = await input.sessions.getEvidence(record.sessionId, "purchase-manifest");
  // 兼容入库清单加入前创建的会话：保留日志供诊断，不猜测文件名或长度。
  if (!manifestRaw) return false;
  const manifest = parsePurchaseManifest(manifestRaw, record.seedHashHex);
  const evidence = record.evidence;
  const paymentIds = evidence
    .filter((name) => name.startsWith("kind7-payment-update-"))
    .map((name) => name.slice("kind7-payment-update-".length));
  if (!paymentIds.some((id) => evidence.includes(`latest-payment-transaction-${id}` as const))) {
    throw new Error("BitFS 入库恢复缺少与已验收付款对应的交易证据");
  }

  const shared = evidence.includes("download-plan");
  const seedObject = await input.contentStore.get(shared
    ? sharedStagingPath(record.seedHashHex, "seed.bin")
    : `bitfs-staging/${record.sessionId}/seed.bin`);
  if (!seedObject) throw new Error("BitFS 入库恢复缺少已验收 Seed 暂存");
  const inspected = await inspectPurchasedMsFileSeed({
    seedHashHex: record.seedHashHex,
    seedBytes: seedObject.bytes,
    fileSizeBytes: manifest.fileSizeBytes,
  });
  const blocks: Uint8Array[] = [];
  for (const hash of inspected.blockHashesHex) {
    const block = await input.contentStore.get(shared
      ? sharedStagingPath(record.seedHashHex, `blocks/${hash}.bin`)
      : `bitfs-staging/${record.sessionId}/blocks/${hash}.bin`);
    if (!block) throw new Error(`BitFS 入库恢复缺少已验收 Block：${hash}`);
    blocks.push(block.bytes);
  }
  await commitPurchasedMsFileContent({
    store: input.contentStore,
    seedHashHex: record.seedHashHex,
    seedBytes: seedObject.bytes,
    blocks,
    fileSizeBytes: manifest.fileSizeBytes,
    fileName: manifest.recommendedFilename,
    mediaType: "application/octet-stream",
    now: () => input.nowMs,
  });
  try { await input.onContentCommitted?.(record.seedHashHex); } catch { /* 已保存文件可用；索引刷新不影响资金恢复。 */ }
  const latest = await input.sessions.get(record.sessionId);
  if (latest?.phase === "content-committing") {
    await input.sessions.update(record.sessionId, latest.revision, {
      phase: latest.evidence.includes("kind12-close-request") ? "close-requested" : "close-required",
      pendingTxid: undefined,
      pendingAuthorizationId: undefined,
    }, input.nowMs);
  }
  return true;
}

/** 买方当前购买阶段，供 Worker 显示中文进度。 */
export type BitfsBuyerPurchasePhase = MsFileBitfsPurchasePhase;

/** 买方购买进度摘要，不含协议原文、签名或交易原文。 */
export interface BitfsBuyerPurchaseProgress {
  /** 买方引用的报价会话编号。 */
  sessionId: string;
  /** 当前购买阶段。 */
  phase: BitfsBuyerPurchasePhase;
  /** 首次开池时锁入的最高预算，单位聪。 */
  openingAmountSatoshis: string;
  /** 已验收并暂存的不同文件块数量。 */
  verifiedBlockCount: number;
  /** 报价绑定的文件块总数。 */
  totalBlockCount: number | null;
  /** 当前阶段说明；失败时为中文错误信息。 */
  message: string | null;
}

/** 买方 WebRTC 数据通道；会话编号是 Worker 内部 transport ID。 */
export interface BitfsBuyerStream {
  /** 发送一条已持久化的 exact Artifact。 */
  send(frame: Uint8Array): Promise<void>;
}

/** 买方协议会话的 Worker 依赖。 */
export interface BitfsBuyerProtocolDeps {
  /** 共用的买方需求、报价与开池任务。 */
  task: BitfsBuyerTask;
  /** 保存买方会话与 exact Artifact 的本地 journal。 */
  sessions: BitfsSessionJournal;
  /** 当前 Vault 的受限买方签名器。 */
  signer: Signer;
  /** 当前 Owner 的 MSFile 根存储；暂存路径不写入可用文件索引。 */
  contentStore: OwnerFileStore;
  /** 同 Seed 多卖家共用的唯一 Block 归属和逐池付款预算。 */
  downloadPlan: BitfsBuyerDownloadPlan;
  /** 已保存到同 Seed 下载计划的卖家优先策略。 */
  selectionPriority: "price" | "recent-speed";
  /** 下载计划更新后唤醒其他可接收内容的卖家池。 */
  onDownloadPlanChanged?(): void;
  /** 获取当前明确的链高度；无高度时拒绝使用高度锁事实。 */
  blockHeight(): Promise<number>;
  /** 从 FundingTx 池输出查询并返回当前完整付款交易原文。 */
  readPoolSpendChain(fundingTxid: string, afterTxid?: string): Promise<Array<{ txid: string; rawTransaction: Uint8Array; status: "confirmed" | "unconfirmed" }>>;
  /** 当前 Worker 的可信 UTC 毫秒。 */
  nowMs(): number;
  /** 从调用者绑定的配置读取池内手续费率，单位聪/千字节。 */
  minerFeeRateSatoshisPerKilobyte: bigint;
  /** 每次异步边界前核对 owner、generation 和 Vault。 */
  assertCurrentContext(): void;
  /** 文件完成入库后通知 Worker 刷新卖方 Seed 索引。 */
  onContentCommitted?(seedHashHex: string): Promise<void> | void;
  /** 买方验证内容并在链上确认付款后，保存可用于卖家排序的速度样本。 */
  onVerifiedDelivery?(input: {
    /** 买方会话编号。 */
    sessionId: string;
    /** 对应已验签 Kind 5 的付款授权编号。 */
    authorizationIdHex: string;
    /** 本次已验证文件 Block 的有效字节数，不含 Seed。 */
    effectiveBlockBytes: number;
    /** 从发送 Kind 5 到验收 Kind 6 的毫秒数。 */
    elapsedMs: number;
  }): Promise<void> | void;
  /** 状态变化通知；只返回不含精确证据的摘要。 */
  onProgress(progress: BitfsBuyerPurchaseProgress): void;
}

/** 单报价买方协议端口；相同会话串行处理并可按 exact bytes 重放。 */
export class BitfsBuyerProtocol {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly purchaseConfigs = new Map<string, { openingAmountSatoshis: string }>();
  /** 当前 Worker 进程内各买方会话的 Kind 5 发送时刻；重启后不伪造速度样本。 */
  private readonly contentRequestStartedAtMs = new Map<string, number>();

  constructor(private readonly deps: BitfsBuyerProtocolDeps) {}

  /** 由用户明确点击购买后准备并发送 Kind 2；尚未广播资金池交易。 */
  async startPurchase(input: {
    sessionId: string;
    stream: BitfsBuyerStream;
    /** 本卖家池的固定开池金额，由 Worker 按唯一 Block 分配预算。 */
    openingAmountSatoshis?: string;
    /** 开池金额中可用于 Seed/Block 付款的预算，不含矿工费。 */
    contentBudgetSatoshis?: string;
    /** 本池专用于 Seed 的预算；每个可接替费用池按自己的 Seed 报价预留。 */
    seedBudgetSatoshis?: string;
    /** 本池是否参加唯一 Seed 的认领；已购买 Seed 后新开的池不参加。 */
    seedBudgetReserved?: boolean;
    /** 本池专用于 Block 的预算。 */
    blockBudgetSatoshis?: string;
    /** 最近已确认速度；未知时为 null。 */
    recentBytesPerSecond?: string | null;
  }): Promise<BitfsBuyerPurchaseProgress> {
    let result: BitfsBuyerPurchaseProgress | undefined;
    await this.serial(input.sessionId, async () => { result = await this.startPurchaseNow(input); });
    return result!;
  }

  /** 付款签名生成前允许取消；先记取消意图，再通过既有 Kind 12/13 回收费用池。 */
  async cancelPurchase(input: { sessionId: string; stream: BitfsBuyerStream }): Promise<BitfsBuyerPurchaseProgress> {
    let result: BitfsBuyerPurchaseProgress | undefined;
    await this.serial(input.sessionId, async () => { result = await this.cancelPurchaseNow(input); });
    return result!;
  }

  /** 在新 DataChannel 上按 journal 重放当前唯一未完成的 exact Artifact。 */
  async resumePurchase(input: { sessionId: string; stream: BitfsBuyerStream }): Promise<BitfsBuyerPurchaseProgress> {
    let result: BitfsBuyerPurchaseProgress | undefined;
    await this.serial(input.sessionId, async () => { result = await this.resumePurchaseNow(input); });
    return result!;
  }

  /** 响应其他卖家完成付款后，尝试分配此池的下一份内容。 */
  async continueSharedDownload(input: { sessionId: string; stream: BitfsBuyerStream }): Promise<void> {
    await this.serial(input.sessionId, async () => {
      const record = await this.requiredSession(input.sessionId);
      if (record.phase !== "funded" || !record.evidence.includes("download-plan")) return;
      const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), await this.requiredEvidence(input.sessionId, "kind1-quote"));
      await this.continueSharedFundedPool(input.sessionId, quote, input.stream);
    });
  }

  private async resumePurchaseNow(input: { sessionId: string; stream: BitfsBuyerStream }): Promise<BitfsBuyerPurchaseProgress> {
    this.deps.assertCurrentContext();
    let record = await this.requiredSession(input.sessionId);
    const quoteRaw = await this.requiredEvidence(input.sessionId, "kind1-quote");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    const openingConfiguration = await this.deps.sessions.getEvidence(input.sessionId, "opening-configuration");
    if (openingConfiguration) {
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(openingConfiguration)) as { openingAmountSatoshis?: unknown };
        if (typeof parsed.openingAmountSatoshis === "string" && /^(0|[1-9][0-9]*)$/u.test(parsed.openingAmountSatoshis)) {
          this.purchaseConfigs.set(input.sessionId, { openingAmountSatoshis: parsed.openingAmountSatoshis });
        } else throw new Error("BitFS 重连缺少有效的固定开池金额证据");
      } catch {
        throw new Error("BitFS 重连缺少有效的固定开池金额证据");
      }
    }
    const openingAmount = this.readOpeningAmount(input.sessionId);
    if (record.evidence.includes("download-plan")) {
      await this.registerSharedPlanPool(input.sessionId, quote, openingAmount);
    }
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);

    if (["opening-presign", "funding-prepared", "funding-unknown"].includes(record.phase)) {
      const kind2 = await this.deps.sessions.getEvidence(input.sessionId, "kind2-opening-request");
      if (!kind2) throw new Error("BitFS 重连缺少已保存的 Kind 2 开池请求");
      this.deps.assertCurrentContext();
      await input.stream.send(kind2);
      this.progress(input.sessionId, "opening", openingAmount, await this.countStagedBlocks(input.sessionId), totalBlocks,
        "已在新连接重发原 Kind 2，等待卖方返回同一份开池预签");
      return this.progressForSession(input.sessionId);
    }

    if (["request-prepared", "delivery-verified", "payment-unknown"].includes(record.phase)) {
      const authorizationId = record.pendingAuthorizationId;
      if (!authorizationId) throw new Error("BitFS 重连缺少待处理的内容授权编号");
      const requestRaw = await this.deps.sessions.getEvidence(input.sessionId, `kind5-content-request-${authorizationId}`);
      if (!requestRaw) throw new Error("BitFS 重连缺少已保存的 Kind 5 内容请求");
      const deliveryRaw = await this.deps.sessions.getEvidence(input.sessionId, `kind6-content-delivery-${authorizationId}`);
      const paymentRaw = await this.deps.sessions.getEvidence(input.sessionId, `kind7-payment-update-${authorizationId}`);
      if (!deliveryRaw || !paymentRaw) {
        this.deps.assertCurrentContext();
        await input.stream.send(requestRaw);
        this.progress(input.sessionId, "requesting-blocks", openingAmount, await this.countStagedBlocks(input.sessionId), totalBlocks,
          "已在新连接重发原 Kind 5，等待卖方重发对应内容交付");
        return this.progressForSession(input.sessionId);
      }

      const pool = await this.readCurrentPool(input.sessionId);
      const summary = await this.inspectKind5({ sessionId: input.sessionId, quoteRaw, pool, rawKind5: requestRaw });
      if (summary.authorizationIdHex !== authorizationId) throw new Error("恢复中的 Kind 5 授权编号与会话不一致");
      this.deps.assertCurrentContext();
      // 重连后先重放完全相同的付款凭证，卖方据此恢复链上付款对账。
      await input.stream.send(paymentRaw);
      const latestPaymentName = `latest-payment-transaction-${authorizationId}` as const;
      let nextPayment: { txid: string; rawTransaction: Uint8Array } | undefined;
      const savedLatest = await this.deps.sessions.getEvidence(input.sessionId, latestPaymentName);
      const currentRaw = savedLatest ?? pool.latestPaymentRawTx;
      if (currentRaw) {
        const state = await parsePaymentState(currentRaw, pool.opening);
        await verifyAcceptedPayment(state, pool.opening);
        if (state.paymentSequence === summary.paymentSequence
          && state.sellerAmountSatoshis.toString(10) === summary.sellerAmountAfterSatoshis) {
          nextPayment = { txid: bytesToHex(transactionID(currentRaw)), rawTransaction: currentRaw };
        }
      }
      nextPayment ??= await this.waitForNextPayment(input.sessionId, pool, {
        paymentSequence: summary.paymentSequence,
        sellerAmountAfterSatoshis: summary.sellerAmountAfterSatoshis,
      });
      if (!nextPayment) return this.progressForSession(input.sessionId);
      record = await this.requiredSession(input.sessionId);
      if (record.evidence.includes(latestPaymentName)) {
        const existing = await this.requiredEvidence(input.sessionId, latestPaymentName);
        if (!equal(existing, nextPayment.rawTransaction)) throw new Error("重连观察到的付款交易与既有证据冲突");
      } else {
        record = await this.deps.sessions.putEvidence(input.sessionId, record.revision, latestPaymentName, nextPayment.rawTransaction, this.deps.nowMs());
      }
      if (record.evidence.includes("download-plan")) {
        await this.completeSharedPayment({ sessionId: input.sessionId, quote, summary, pool });
        this.deps.onDownloadPlanChanged?.();
      }
      this.deps.assertCurrentContext();
      await input.stream.send(paymentRaw);
      record = await this.requiredSession(input.sessionId);
      record = await this.deps.sessions.update(input.sessionId, record.revision, {
        phase: "funded",
        pendingTxid: undefined,
        pendingAuthorizationId: undefined,
      }, this.deps.nowMs());
      this.contentRequestStartedAtMs.delete(input.sessionId);
    }

    record = await this.requiredSession(input.sessionId);
    if (record.phase === "content-committing") {
      await recoverBitfsBuyerContentCommit({
        sessions: this.deps.sessions,
        contentStore: this.deps.contentStore,
        sessionId: input.sessionId,
        nowMs: this.deps.nowMs(),
        onContentCommitted: this.deps.onContentCommitted,
      });
      record = await this.requiredSession(input.sessionId);
    }
    if (["close-required", "close-requested", "close-unknown", "cancel-closing-pool", "cancel-close-unknown"].includes(record.phase)) {
      await this.prepareAndSendClose(input.sessionId, await this.countStagedBlocks(input.sessionId), totalBlocks, input.stream);
      return this.progressForSession(input.sessionId);
    }
    if (record.phase === "funded") {
      await this.continueFundedPool(input.sessionId, quote, input.stream);
      return this.progressForSession(input.sessionId);
    }
    return this.progressForSession(input.sessionId);
  }

  private async cancelPurchaseNow(input: { sessionId: string; stream: BitfsBuyerStream }): Promise<BitfsBuyerPurchaseProgress> {
    this.deps.assertCurrentContext();
    let record = await this.requiredSession(input.sessionId);
    const cancellationAlreadyStarted = record.phase === "cancel-closing-pool" || record.phase === "cancel-close-unknown";
    if (record.phase === "cancelled") return this.progressForSession(input.sessionId);
    if (record.phase === "quote-selected") {
      const openingMayHaveReservedFunding = record.evidence.includes("opening-configuration")
        || record.evidence.includes("funding-transaction");
      if (openingMayHaveReservedFunding) {
        record = await this.deps.sessions.update(input.sessionId, record.revision, { phase: "cancel-opening" }, this.deps.nowMs());
        await this.deps.task.cancelUnfundedOpening(input.sessionId);
      } else {
        record = await this.deps.sessions.update(input.sessionId, record.revision, { phase: "cancelled" }, this.deps.nowMs());
      }
      if (record.evidence.includes("download-plan")) {
        await this.deps.downloadPlan.closePool(input.sessionId);
        this.deps.onDownloadPlanChanged?.();
      }
      this.progress(input.sessionId, "cancelled", "0", 0, 0, "购买已取消；未派发的开池资金预留已安全释放。");
      return this.progressForSession(input.sessionId);
    }
    if (record.phase === "opening-presign" || record.phase === "funding-prepared" || record.phase === "cancel-opening") {
      if (record.evidence.includes("kind3-opening-response") || record.evidence.includes("kind4-funding-delivery")) {
        throw new Error("卖方已完成开池预签；等待资金交易状态明确后才能关池取消");
      }
      if (record.phase !== "cancel-opening") {
        record = await this.deps.sessions.update(input.sessionId, record.revision, { phase: "cancel-opening" }, this.deps.nowMs());
      }
      this.progress(input.sessionId, "cancelling-opening", this.readOpeningAmount(input.sessionId), 0, 0, "正在释放尚未派发的开池资金预留。");
      await this.deps.task.cancelUnfundedOpening(input.sessionId);
      if (record.evidence.includes("download-plan")) {
        await this.deps.downloadPlan.closePool(input.sessionId);
        this.deps.onDownloadPlanChanged?.();
      }
      this.progress(input.sessionId, "cancelled", this.readOpeningAmount(input.sessionId), 0, 0, "购买已取消；开池资金未广播，资金预留已释放。");
      return this.progressForSession(input.sessionId);
    }
    if (!cancellationAlreadyStarted) {
      if (record.phase !== "funded" && record.phase !== "request-prepared") {
        throw new Error("当前阶段已有付款或正在关池；为避免冲突，不能取消购买");
      }
      if (record.phase === "request-prepared" && !record.pendingAuthorizationId) {
        throw new Error("当前内容请求缺少付款授权编号；为避免误关池，不能取消购买");
      }
      if (record.pendingAuthorizationId) {
        const authorizationId = record.pendingAuthorizationId;
        const paymentEvidence = [
          `kind7-payment-update-${authorizationId}`,
          `kind7-payment-sign-digest-${authorizationId}`,
          `kind7-payment-signature-${authorizationId}`,
        ];
        if (paymentEvidence.some((name) => record.evidence.includes(name as import("./sessionJournal.js").BitfsEvidenceName))) {
          throw new Error("当前内容请求已有付款签名；不能通过取消关池替代正常付款结算");
        }
      }
      for (const required of ["kind2-opening-request", "kind3-opening-response", "funding-transaction"] as const) {
        if (!record.evidence.includes(required) || !(await this.deps.sessions.getEvidence(input.sessionId, required))) {
          throw new Error("费用池证据不完整；暂不能安全取消购买");
        }
      }
      record = await this.deps.sessions.update(input.sessionId, record.revision, {
        phase: "cancel-closing-pool",
        pendingTxid: undefined,
        pendingAuthorizationId: undefined,
      }, this.deps.nowMs());
    }
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), await this.requiredEvidence(input.sessionId, "kind1-quote"));
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    const verifiedBlocks = await this.countStagedBlocks(input.sessionId);
    try {
      await this.prepareAndSendClose(input.sessionId, verifiedBlocks, totalBlocks, input.stream);
    } catch (error) {
      const latest = await this.requiredSession(input.sessionId);
      if (latest.evidence.includes("kind12-close-request")
        && (latest.phase === "cancel-closing-pool" || latest.phase === "cancel-close-unknown")) {
        if (latest.phase === "cancel-closing-pool") {
          await this.deps.sessions.update(input.sessionId, latest.revision, { phase: "cancel-close-unknown" }, this.deps.nowMs());
        }
        this.progress(input.sessionId, "cancel-unknown", this.readOpeningAmount(input.sessionId), verifiedBlocks, totalBlocks,
          "取消关池请求的发送结果暂时未知；费用池继续受保护，可在卖方连接恢复后重发同一请求");
        return this.progressForSession(input.sessionId);
      }
      throw error;
    }
    return this.progressForSession(input.sessionId);
  }

  private async startPurchaseNow(input: {
    sessionId: string;
    stream: BitfsBuyerStream;
    openingAmountSatoshis?: string;
    contentBudgetSatoshis?: string;
    seedBudgetSatoshis?: string;
    seedBudgetReserved?: boolean;
    blockBudgetSatoshis?: string;
    recentBytesPerSecond?: string | null;
  }): Promise<BitfsBuyerPurchaseProgress> {
    this.deps.assertCurrentContext();
    let record = await this.requiredSession(input.sessionId);
    if (record.phase !== "quote-selected" && record.phase !== "opening-presign" && record.phase !== "funding-prepared") {
      if (record.evidence.includes("kind2-opening-request")
        && ["funding-unknown", "funded", "request-prepared", "delivery-verified", "payment-unknown", "content-committing", "completed"].includes(record.phase)) {
        return this.progressForSession(input.sessionId);
      }
      throw new Error("该 BitFS 报价已进入购买流程或无法恢复");
    }
    const quoteRaw = await this.requiredEvidence(record.sessionId, "kind1-quote");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    if (quote.terms.fileSizeBytes === 0n) throw new Error("当前入库校验不支持购买空文件；资金尚未广播");
    await this.persistPurchaseManifest(record, {
      seedHashHex: bytesToHex(quote.terms.seedHash),
      fileSizeBytes: quote.terms.fileSizeBytes.toString(10),
      recommendedFilename: quote.terms.recommendedFilename,
    });
    const blockCount = (quote.terms.fileSizeBytes + 262_143n) / 262_144n;
    // 预算按 Seed 价 + 每块完整价的上界计算，另预留两笔池内交易手续费。
    // 真正付款仍由 SDK 根据 exact Seed 和 Block 长度逐批计算。
    const defaultOpeningAmount = quote.terms.seedPriceSatoshis
      + quote.terms.fullBlockPriceSatoshis * blockCount
      + this.deps.minerFeeRateSatoshisPerKilobyte * POOL_FEE_RESERVE_MULTIPLIER;
    const openingAmount = input.openingAmountSatoshis === undefined
      ? defaultOpeningAmount
      : parseSatoshiAmount(input.openingAmountSatoshis);
    const feeReserve = this.deps.minerFeeRateSatoshisPerKilobyte * POOL_FEE_RESERVE_MULTIPLIER;
    const contentBudget = input.contentBudgetSatoshis === undefined
      ? openingAmount - feeReserve
      : parseSatoshiAmount(input.contentBudgetSatoshis);
    const seedBudget = parseSatoshiAmount(input.seedBudgetSatoshis ?? quote.terms.seedPriceSatoshis.toString(10));
    const seedBudgetReserved = input.seedBudgetReserved ?? true;
    const blockBudget = parseSatoshiAmount(input.blockBudgetSatoshis ?? (contentBudget - seedBudget).toString(10));
    if (contentBudget < quote.terms.fullBlockPriceSatoshis || openingAmount !== contentBudget + feeReserve) {
      throw new Error("本卖家池的固定预算不足或与手续费预留不匹配；未派发资金");
    }
    if (seedBudget + blockBudget !== contentBudget
      || (seedBudgetReserved && seedBudget < quote.terms.seedPriceSatoshis)
      || (!seedBudgetReserved && seedBudget !== 0n)
      || blockBudget < quote.terms.fullBlockPriceSatoshis) {
      throw new Error("本卖家池的 Seed/Block 专用预算无效；未派发资金");
    }
    if (openingAmount <= 0n || openingAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("BitFS 最高开池预算超出当前钱包安全金额范围");
    }
    const openingAmountSatoshis = openingAmount.toString(10);
    this.purchaseConfigs.set(record.sessionId, { openingAmountSatoshis });
    const downloadPlanEvidence = new TextEncoder().encode(JSON.stringify({
      contentBudgetSatoshis: contentBudget.toString(10),
      seedBudgetSatoshis: seedBudget.toString(10),
      seedBudgetReserved,
      blockBudgetSatoshis: blockBudget.toString(10),
      priority: this.deps.selectionPriority,
      recentBytesPerSecond: input.recentBytesPerSecond ?? null,
    }));
    const priorDownloadPlan = await this.deps.sessions.getEvidence(record.sessionId, "download-plan");
    if (priorDownloadPlan && !equal(priorDownloadPlan, downloadPlanEvidence)) {
      throw new Error("同一买家会话的费用池预算或卖家优先级已固定；拒绝替换");
    }
    if (!priorDownloadPlan) {
      record = await this.deps.sessions.putEvidence(record.sessionId, record.revision, "download-plan", downloadPlanEvidence, this.deps.nowMs());
    }
    await this.registerSharedPlanPool(record.sessionId, quote, openingAmountSatoshis);
    const totalBlockCount = Number(blockCount);
    this.progress(record.sessionId, "opening", openingAmountSatoshis, 0, totalBlockCount, "正在准备开池交易；资金尚未广播");
    try {
      const arbiterPublicKeyHex = quote.terms.supportedArbiterPublicKeys[0]
        ? bytesToHex(quote.terms.supportedArbiterPublicKeys[0])
        : "";
      if (!arbiterPublicKeyHex) throw new Error("签名报价没有支持的仲裁方，不能安全开池");
      const nowUnixSeconds = Math.floor(this.deps.nowMs() / 1_000);
      const rawKind2 = await this.deps.task.prepareOpening({
        sessionId: record.sessionId,
        openingAmountSatoshis,
        expiryLockTime: nowUnixSeconds + 30 * 24 * 60 * 60,
        minerFeeRateSatoshisPerKilobyte: this.deps.minerFeeRateSatoshisPerKilobyte,
        arbiterPublicKeyHex,
      });
      this.deps.assertCurrentContext();
      await input.stream.send(rawKind2);
      this.progress(record.sessionId, "opening", openingAmountSatoshis, 0, totalBlockCount, "已发送开池预签请求，等待卖方 Kind 3");
      return this.snapshot(record.sessionId, "opening", openingAmountSatoshis, 0, totalBlockCount, "等待卖方预签");
    } catch (error) {
      await this.markFailed(record.sessionId, openingAmountSatoshis, totalBlockCount, error);
      throw error;
    }
  }

  /** 处理 DataChannel 的 Kind 3 与 Kind 6；重复帧重放首次持久化的 Artifact。 */
  async onFrame(input: { sessionId: string; rawArtifact: Uint8Array; stream: BitfsBuyerStream }): Promise<void> {
    await this.serial(input.sessionId, async () => {
      this.deps.assertCurrentContext();
      const artifact = parse(input.rawArtifact.slice());
      if (artifact.kind === 1) {
        const savedQuote = await this.requiredEvidence(input.sessionId, "kind1-quote");
        if (!equal(savedQuote, artifact.bytes())) throw new Error("同一 BitFS 会话收到不同报价，已拒绝替换报价");
        return;
      }
      if (artifact.kind === 3) {
        const record = await this.requiredSession(input.sessionId);
        if (record.phase === "cancel-opening" || record.phase === "cancelled") return;
        await this.handleOpeningResponse(input.sessionId, artifact.kind, artifact.bytes(), input.stream);
        return;
      }
      if (artifact.kind === 6) {
        const record = await this.requiredSession(input.sessionId);
        if (["cancel-closing-pool", "cancel-close-unknown", "cancelled"].includes(record.phase)) {
          // 取消意图已经先落盘。此后到达的迟到交付不再触发新的付款签名。
          return;
        }
        await this.handleContentDelivery(input.sessionId, artifact.kind, artifact.bytes(), input.stream);
        return;
      }
      if (artifact.kind === 13) {
        await this.handleCloseResponse(input.sessionId, artifact.bytes(), input.stream);
        return;
      }
      throw new Error(`买方当前不接受 Kind ${artifact.kind}`);
    });
  }

  /** 返回最近一个仍未完成的买方会话进度。 */
  async progressForSession(sessionId: string): Promise<BitfsBuyerPurchaseProgress> {
    const record = await this.requiredSession(sessionId);
    const quoteRaw = await this.requiredEvidence(record.sessionId, "kind1-quote");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    const blockCount = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    const opening = this.readOpeningAmount(record.sessionId);
    const verifiedBlockCount = await this.countStagedBlocks(record.sessionId);
    return this.snapshot(record.sessionId, phaseFor(record), opening, verifiedBlockCount, blockCount, null);
  }

  private async persistPurchaseManifest(record: BitfsSessionRecord, manifest: Omit<BitfsBuyerPurchaseManifest, "format" | "version">): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ format: PURCHASE_MANIFEST_FORMAT, version: 1, ...manifest })}\n`);
    const existing = await this.deps.sessions.getEvidence(record.sessionId, "purchase-manifest");
    if (existing) {
      if (!equal(existing, bytes)) throw new Error("已固定 BitFS 入库清单与当前报价不一致");
      return;
    }
    const latest = await this.requiredSession(record.sessionId);
    await this.deps.sessions.putEvidence(record.sessionId, latest.revision, "purchase-manifest", bytes, this.deps.nowMs());
  }

  private async handleOpeningResponse(sessionId: string, _kind: WireKind, rawKind3: Uint8Array, stream: BitfsBuyerStream): Promise<void> {
    let record = await this.requiredSession(sessionId);
    if (["cancel-opening", "cancelled", "completed", "refunded", "refund-ready", "refund-unknown", "failed", "content-committing"].includes(record.phase)) return;
    const quoteRaw = await this.requiredEvidence(sessionId, "kind1-quote");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    const amount = this.readOpeningAmount(sessionId);
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    if (["close-required", "close-requested", "close-unknown", "cancel-closing-pool", "cancel-close-unknown"].includes(record.phase)) {
      const savedKind12 = await this.deps.sessions.getEvidence(sessionId, "kind12-close-request");
      if (savedKind12) await stream.send(savedKind12);
      else await this.prepareAndSendClose(sessionId, await this.countStagedBlocks(sessionId), totalBlocks, stream);
      return;
    }
    const savedKind4 = await this.deps.sessions.getEvidence(sessionId, "kind4-funding-delivery");
    if (savedKind4) {
      await stream.send(savedKind4);
      record = await this.requiredSession(sessionId);
      if (record.pendingAuthorizationId) {
        const savedKind5 = await this.deps.sessions.getEvidence(sessionId, `kind5-content-request-${record.pendingAuthorizationId}`);
        if (!savedKind5) throw new Error("BitFS 已登记的内容授权缺少对应 Kind 5 证据");
        await stream.send(savedKind5);
        return;
      }
      if (record.phase !== "funded") {
        record = await this.deps.sessions.update(sessionId, record.revision, {
          phase: "funded",
          pendingTxid: undefined,
          pendingAuthorizationId: undefined,
        }, this.deps.nowMs());
      }
      await this.continueFundedPool(sessionId, quote, stream);
      return;
    }
    await this.deps.task.acceptOpeningResponse({ sessionId, rawKind3 });
    this.progress(sessionId, "funding", amount, 0, totalBlocks, "卖方已预签，正在提交并核对开池资金交易");
    const deadline = this.deps.nowMs() + MAX_CHAIN_WAIT_MS;
    let kind4: Uint8Array | undefined;
    while (this.deps.nowMs() < deadline) {
      this.deps.assertCurrentContext();
      const result = await this.deps.task.submitOrReconcileFunding(sessionId);
      if (result.outcome.status === "failed") throw new Error("BitFS 开池资金交易未广播；可用余额未解锁前请先检查专款状态");
      if (result.kind4) {
        kind4 = result.kind4;
        break;
      }
      record = (await this.deps.sessions.get(sessionId)) ?? record;
      this.progress(sessionId, "funding-unknown", amount, 0, totalBlocks, "资金交易结果仍在核对；不会创建第二笔交易");
      await delay(CHAIN_POLL_INTERVAL_MS);
    }
    if (!kind4) {
      this.progress(sessionId, "funding-unknown", amount, 0, totalBlocks, "资金交易结果暂时未知；保留原交易等待恢复");
      return;
    }
    this.deps.assertCurrentContext();
    await stream.send(kind4);
    record = await this.requiredSession(sessionId);
    if (record.evidence.includes("download-plan")) {
      await this.continueFundedPool(sessionId, quote, stream);
      return;
    }
    this.progress(sessionId, "requesting-seed", amount, 0, totalBlocks, "已发送资金证明，正在请求 Seed");
    await this.prepareAndSendRequest({ sessionId, contentHashes: [quote.terms.seedHash.slice()], stream });
  }

  /** 已有会话沿用原有逐池下载逻辑；新会话改走 Seed 级共享计划。 */
  private async continueFundedPool(sessionId: string, quote: ReturnType<typeof acceptBuyerQuote>, stream: BitfsBuyerStream): Promise<void> {
    const record = await this.requiredSession(sessionId);
    if (record.evidence.includes("download-plan")) {
      await this.continueSharedFundedPool(sessionId, quote, stream);
      return;
    }
    await this.continueLegacyFundedPool(sessionId, quote, stream);
  }

  /** 新下载计划按预算为多个池分配不同 Block，并共用一份已付款 Seed。 */
  private async continueSharedFundedPool(sessionId: string, quote: ReturnType<typeof acceptBuyerQuote>, stream: BitfsBuyerStream): Promise<void> {
    const beforeActivation = await this.deps.downloadPlan.snapshot();
    if (beforeActivation.stopRequested) {
      await this.closeStoppedSharedPool(sessionId, quote, stream);
      return;
    }
    await this.deps.downloadPlan.activatePool(sessionId);
    this.deps.onDownloadPlanChanged?.();
    if ((await this.deps.downloadPlan.snapshot()).stopRequested) {
      await this.closeStoppedSharedPool(sessionId, quote, stream);
      return;
    }
    const seedHashHex = bytesToHex(quote.terms.seedHash);
    const seedBytes = await this.readStagedBytes(sessionId, "seed.bin");
    if (!seedBytes) {
      const claim = await this.deps.downloadPlan.claimSeed(sessionId, this.deps.selectionPriority);
      if (claim === "assigned") {
        if ((await this.deps.downloadPlan.snapshot()).stopRequested) {
          await this.closeStoppedSharedPool(sessionId, quote, stream);
        } else {
          await this.prepareAndSendRequest({ sessionId, contentHashes: [quote.terms.seedHash.slice()], stream });
          this.deps.onDownloadPlanChanged?.();
        }
      } else if (claim === "stopped") {
        await this.closeStoppedSharedPool(sessionId, quote, stream);
      } else {
        this.progress(sessionId, "requesting-seed", this.readOpeningAmount(sessionId), 0,
          Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n), "等待已获分配的卖家池交付 Seed");
      }
      return;
    }
    const plan = await this.deps.downloadPlan.snapshot();
    if (plan.stopRequested) {
      await this.closeStoppedSharedPool(sessionId, quote, stream);
      return;
    }
    if (!plan.seedCompleted) {
      this.progress(sessionId, "requesting-seed", this.readOpeningAmount(sessionId), 0,
        Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n), "已收到 Seed，正在等待对应付款交易确认");
      return;
    }
    if (plan.blockHashesHex === null) {
      const hashes = await this.getAllBlockHashes(sessionId, quote.terms.fileSizeBytes.toString(10), seedHashHex);
      await this.deps.downloadPlan.setBlockHashes(hashes);
    }
    const latest = await this.deps.downloadPlan.snapshot();
    if (latest.stopRequested) {
      await this.closeStoppedSharedPool(sessionId, quote, stream);
      return;
    }
    const allBlockHashes = latest.blockHashesHex ?? [];
    if (latest.totalBlockCount !== null && latest.completedBlockCount === latest.totalBlockCount) {
      await this.commitAndCloseSharedFile(sessionId, quote, allBlockHashes, latest.completedBlockCount, stream);
      return;
    }
    const nextHash = await this.deps.downloadPlan.claimNextBlock(sessionId, this.deps.selectionPriority);
    if ((await this.deps.downloadPlan.snapshot()).stopRequested) {
      await this.closeStoppedSharedPool(sessionId, quote, stream);
      return;
    }
    if (!nextHash) {
      const ownPool = latest.pools.find((pool) => pool.sessionId === sessionId);
      const blockBudgetLeft = ownPool
        ? BigInt(ownPool.blockBudgetSatoshis) - BigInt(ownPool.blockCommittedSatoshis)
        : 0n;
      if (ownPool && !ownPool.closed && !ownPool.inFlightBlockHashHex
        && blockBudgetLeft < BigInt(ownPool.fullBlockPriceSatoshis)
        && latest.completedBlockCount < (latest.totalBlockCount ?? 0)) {
        let record = await this.requiredSession(sessionId);
        if (record.phase === "funded") {
          record = await this.deps.sessions.update(sessionId, record.revision, { phase: "close-required" }, this.deps.nowMs());
        }
        try {
          await this.prepareAndSendClose(sessionId, latest.completedBlockCount, latest.totalBlockCount ?? 0, stream);
        } catch (error) {
          const message = error instanceof Error ? error.message : "关池请求准备失败";
          this.progress(sessionId, "closing-pool", this.readOpeningAmount(sessionId), latest.completedBlockCount,
            latest.totalBlockCount, `本池预算已用完；关池回收尚未完成：${message.slice(0, 160)}`);
        }
        return;
      }
      this.progress(sessionId, "requesting-blocks", this.readOpeningAmount(sessionId), latest.completedBlockCount,
        latest.totalBlockCount, "等待其他费用池完成已认领 Block，或等待本池预算可用");
      return;
    }
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    this.progress(sessionId, "requesting-blocks", this.readOpeningAmount(sessionId), latest.completedBlockCount, totalBlocks,
      `正在请求文件块 ${latest.completedBlockCount + 1}/${allBlockHashes.length}`);
    await this.prepareAndSendRequest({ sessionId, contentHashes: [hexToBytes(nextHash)], seed: seedBytes, stream });
    this.deps.onDownloadPlanChanged?.();
  }

  /** 文件已请求取消时，不再领取内容；逐池发送既有 Kind 12 并等待回收确认。 */
  private async closeStoppedSharedPool(
    sessionId: string,
    quote: ReturnType<typeof acceptBuyerQuote>,
    stream: BitfsBuyerStream,
  ): Promise<void> {
    let record = await this.requiredSession(sessionId);
    if (record.phase === "funded") {
      for (const required of ["kind2-opening-request", "kind3-opening-response", "funding-transaction"] as const) {
        if (!record.evidence.includes(required) || !(await this.deps.sessions.getEvidence(sessionId, required))) {
          throw new Error("取消共享下载时费用池证据不完整；资金仍保持保护状态");
        }
      }
      record = await this.deps.sessions.update(sessionId, record.revision, {
        phase: "cancel-closing-pool",
        pendingTxid: undefined,
        pendingAuthorizationId: undefined,
      }, this.deps.nowMs());
    }
    if (record.phase !== "cancel-closing-pool" && record.phase !== "cancel-close-unknown") return;
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    const verifiedBlocks = await this.countStagedBlocks(sessionId);
    try {
      await this.prepareAndSendClose(sessionId, verifiedBlocks, totalBlocks, stream);
    } catch (error) {
      const latest = await this.requiredSession(sessionId);
      if (latest.evidence.includes("kind12-close-request")) {
        if (latest.phase === "cancel-closing-pool") {
          await this.deps.sessions.update(sessionId, latest.revision, { phase: "cancel-close-unknown" }, this.deps.nowMs());
        }
        const message = error instanceof Error ? error.message : "关池请求准备失败";
        this.progress(sessionId, "cancel-unknown", this.readOpeningAmount(sessionId), verifiedBlocks, totalBlocks,
          `整文件取消已暂停新内容；费用池回收尚未确认：${message.slice(0, 160)}`);
        return;
      }
      throw error;
    }
  }

  private async commitAndCloseSharedFile(
    sessionId: string,
    quote: ReturnType<typeof acceptBuyerQuote>,
    uniqueBlockHashes: readonly string[],
    completedBlockCount: number,
    stream: BitfsBuyerStream,
  ): Promise<void> {
    const seedHashHex = bytesToHex(quote.terms.seedHash);
    const orderedBlockHashes = await this.getAllBlockHashes(sessionId, quote.terms.fileSizeBytes.toString(10), seedHashHex);
    let record = await this.requiredSession(sessionId);
    if (record.phase === "funded") {
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: "content-committing" }, this.deps.nowMs());
    }
    this.progress(sessionId, "content-committing", this.readOpeningAmount(sessionId), completedBlockCount, uniqueBlockHashes.length,
      "所有唯一 Block 均已付款，正在写入本地文件");
    await this.commitStagedFile(sessionId, quote.terms.fileSizeBytes.toString(10), quote.terms.recommendedFilename, seedHashHex, orderedBlockHashes);
    record = await this.requiredSession(sessionId);
    if (record.phase === "content-committing") {
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: "close-required", pendingTxid: undefined }, this.deps.nowMs());
    }
    try { await this.deps.onContentCommitted?.(seedHashHex); } catch { /* 文件已保存；索引刷新不阻止关池。 */ }
    const totalBlockCount = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    await this.prepareAndSendClose(sessionId, completedBlockCount, totalBlockCount, stream);
    this.deps.onDownloadPlanChanged?.();
  }

  private async continueLegacyFundedPool(sessionId: string, quote: ReturnType<typeof acceptBuyerQuote>, stream: BitfsBuyerStream): Promise<void> {
    const seedHashHex = bytesToHex(quote.terms.seedHash);
    const seedBytes = await this.readStagedBytes(sessionId, "seed.bin");
    if (!seedBytes) {
      await this.prepareAndSendRequest({ sessionId, contentHashes: [quote.terms.seedHash.slice()], stream });
      return;
    }
    const blockHashes = await this.getAllBlockHashes(sessionId, quote.terms.fileSizeBytes.toString(10), seedHashHex);
    let nextHash: string | undefined;
    for (const hash of blockHashes) {
      if (!(await this.readStagedBytes(sessionId, `blocks/${hash}.bin`))) {
        nextHash = hash;
        break;
      }
    }
    if (!nextHash) {
      let record = await this.requiredSession(sessionId);
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: "content-committing" }, this.deps.nowMs());
      this.deps.assertCurrentContext();
      await this.commitStagedFile(sessionId, quote.terms.fileSizeBytes.toString(10), quote.terms.recommendedFilename, seedHashHex, blockHashes);
      record = await this.requiredSession(sessionId);
      await this.deps.sessions.update(sessionId, record.revision, { phase: "close-required" }, this.deps.nowMs());
      try { await this.deps.onContentCommitted?.(seedHashHex); } catch { /* 文件已提交；索引刷新不阻止关池。 */ }
      const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
      await this.prepareAndSendClose(sessionId, blockHashes.length, totalBlocks, stream);
      return;
    }
    const totalBlocks = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    const completedBlocks = await this.countStagedBlocks(sessionId);
    this.progress(sessionId, "requesting-blocks", this.readOpeningAmount(sessionId), completedBlocks, totalBlocks,
      `正在请求文件块 ${completedBlocks + 1}/${blockHashes.length}`);
    await this.prepareAndSendRequest({ sessionId, contentHashes: [hexToBytes(nextHash)], seed: seedBytes, stream });
  }

  private async handleContentDelivery(sessionId: string, _kind: WireKind, rawKind6: Uint8Array, stream: BitfsBuyerStream): Promise<void> {
    const contentReceivedAtMs = monotonicNowMs();
    let record = await this.requiredSession(sessionId);
    const priorDeliveries = record.evidence.filter((name): name is `kind6-content-delivery-${string}` => name.startsWith("kind6-content-delivery-"));
    for (const priorName of priorDeliveries) {
      const priorRaw = await this.deps.sessions.getEvidence(sessionId, priorName);
      if (!priorRaw || !equal(priorRaw, rawKind6)) continue;
      const priorAuthorizationId = priorName.slice("kind6-content-delivery-".length);
      const priorPayment = await this.deps.sessions.getEvidence(sessionId, `kind7-payment-update-${priorAuthorizationId}`);
      if (priorPayment) {
        await stream.send(priorPayment);
        return;
      }
      if (priorAuthorizationId !== record.pendingAuthorizationId) {
        throw new Error("历史 Kind 6 缺少已保存 Kind 7，不能覆盖当前付款授权");
      }
      // Kind 6 只会在 SDK 完成验货和签名后落盘。若进程恰好在保存 Kind 7
      // 前退出，下面重放 SDK 步骤时 signer journal 会返回同一份已保存签名。
    }
    const authorizationId = record.pendingAuthorizationId;
    if (!authorizationId) throw new Error("收到 Kind 6，但当前会话没有待验收的 Kind 5");
    const requestName = `kind5-content-request-${authorizationId}` as const;
    const deliveryName = `kind6-content-delivery-${authorizationId}` as const;
    const paymentName = `kind7-payment-update-${authorizationId}` as const;
    const savedPayment = await this.deps.sessions.getEvidence(sessionId, paymentName);
    const savedDelivery = await this.deps.sessions.getEvidence(sessionId, deliveryName);
    if (savedPayment) {
      if (!savedDelivery || !equal(savedDelivery, rawKind6)) throw new Error("同一内容授权收到不同 Kind 6，已拒绝替换已验货证据");
      await stream.send(savedPayment);
      return;
    }
    const rawKind5 = await this.requiredEvidence(sessionId, requestName);
    const quoteRaw = await this.requiredEvidence(sessionId, "kind1-quote");
    const pool = await this.readCurrentPool(sessionId);
    const kind5Summary = await this.inspectKind5({ sessionId, quoteRaw, pool, rawKind5 });
    if (kind5Summary.authorizationIdHex !== authorizationId) throw new Error("Kind 5 授权编号与会话待处理编号不一致");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    const seedHashHex = bytesToHex(quote.terms.seedHash);
    const seedStaged = await this.readStagedSeed(sessionId);
    const result = await verifyBuyerDelivery(await this.facts(), {
      authorization: { rawKind1: quoteRaw, rawKind5 },
      pool,
      deliveryRaw: rawKind6,
      ...(kind5Summary.contentHashes.some((hash) => bytesToHex(hash) !== seedHashHex)
        ? { seed: seedStaged }
        : {}),
    }, createJournaledBitfsBuyerSigner({
      sessions: this.deps.sessions,
      sessionId,
      signer: this.deps.signer,
      family: "kind7-payment",
      authorizationIdHex: authorizationId,
      assertCurrentContext: this.deps.assertCurrentContext,
      nowMs: this.deps.nowMs,
    }));
    this.deps.assertCurrentContext();
    const expectedPayloads = kind5Summary.contentHashes;
    if (result.payloads.length !== expectedPayloads.length) throw new Error("Kind 6 payload 数量与 Kind 5 不一致");
    const effectiveBlockBytes = expectedPayloads.reduce((sum, hash, index) =>
      bytesToHex(hash) === seedHashHex ? sum : sum + (result.payloads[index]?.byteLength ?? 0), 0);
    const requestStartedAtMs = this.contentRequestStartedAtMs.get(sessionId);
    const deliveryElapsedMs = requestStartedAtMs === undefined
      ? undefined
      : Math.max(1, Math.round(contentReceivedAtMs - requestStartedAtMs));
    for (let index = 0; index < result.payloads.length; index += 1) {
      const hashHex = bytesToHex(expectedPayloads[index]!);
      if (hashHex === seedHashHex) await this.stageBytes(sessionId, "seed.bin", result.payloads[index]!);
      else await this.stageBytes(sessionId, `blocks/${hashHex}.bin`, result.payloads[index]!);
    }
    record = (await this.deps.sessions.get(sessionId)) ?? record;
    const deliveryCommit = await this.deps.sessions.putEvidence(sessionId, record.revision, deliveryName, rawKind6, this.deps.nowMs());
    record = await this.deps.sessions.putEvidence(sessionId, deliveryCommit.revision, paymentName, result.outbound.bytes(), this.deps.nowMs());

    const allBlockHashes = await this.getAllBlockHashes(sessionId, quote.terms.fileSizeBytes.toString(10), seedHashHex);
    const blockHashes = [...new Set(allBlockHashes)];
    let completedBlockCount = await this.countStagedBlocks(sessionId);
    let fileReady = true;
    for (const hash of blockHashes) {
      if (!(await this.readStagedBytes(sessionId, `blocks/${hash}.bin`))) { fileReady = false; break; }
    }
    this.deps.assertCurrentContext();
    await stream.send(result.outbound.bytes());
    this.progress(sessionId, "payment-unknown", this.readOpeningAmount(sessionId), completedBlockCount, allBlockHashes.length, "已发送付款凭证，正在核对卖方累计付款");
    const nextPayment = await this.waitForNextPayment(sessionId, pool, {
      paymentSequence: kind5Summary.paymentSequence,
      sellerAmountAfterSatoshis: kind5Summary.sellerAmountAfterSatoshis,
    });
    if (!nextPayment) return;
    record = (await this.deps.sessions.get(sessionId)) ?? record;
    const savedKind7 = await this.requiredEvidence(sessionId, paymentName);
    const latestPaymentName = `latest-payment-transaction-${authorizationId}` as const;
    if (record.evidence.includes(latestPaymentName)) {
      const savedLatestPayment = await this.requiredEvidence(sessionId, latestPaymentName);
      if (!equal(savedLatestPayment, nextPayment.rawTransaction)) throw new Error("同一 Kind 5 授权对应了不同付款交易，已停止自动购买");
    } else {
      record = await this.deps.sessions.putEvidence(sessionId, record.revision, latestPaymentName, nextPayment.rawTransaction, this.deps.nowMs());
    }
    if (record.evidence.includes("download-plan")) {
      await this.completeSharedPayment({ sessionId, quote, summary: kind5Summary, pool });
      const downloadPlan = await this.deps.downloadPlan.snapshot();
      completedBlockCount = downloadPlan.completedBlockCount;
      fileReady = downloadPlan.totalBlockCount !== null && downloadPlan.completedBlockCount === downloadPlan.totalBlockCount;
    }
    this.contentRequestStartedAtMs.delete(sessionId);
    if (effectiveBlockBytes > 0 && deliveryElapsedMs !== undefined
      && Number.isSafeInteger(effectiveBlockBytes) && Number.isSafeInteger(deliveryElapsedMs)) {
      try {
        await this.deps.onVerifiedDelivery?.({
          sessionId,
          authorizationIdHex: authorizationId,
          effectiveBlockBytes,
          elapsedMs: deliveryElapsedMs,
        });
      } catch {
        // 速度只影响后续卖家排序；样本写入失败不回滚已经确认的付款。
      }
    }
    // 卖方在 Kind 7 首次处理后处于 payment-unknown；重放同一凭证让其按 txid
    // 对账并推进阶段。DataChannel 有序，因此随后发出的下一个 Kind 5 不会抢跑。
    await stream.send(savedKind7);
    record = (await this.deps.sessions.get(sessionId)) ?? record;
    if (fileReady) {
      record = await this.deps.sessions.update(sessionId, record.revision, {
        phase: "content-committing",
        pendingTxid: undefined,
        pendingAuthorizationId: undefined,
      }, this.deps.nowMs());
      this.progress(sessionId, "content-committing", this.readOpeningAmount(sessionId), completedBlockCount, allBlockHashes.length, "所有块已验货且付款已在链上观察，正在提交本地文件");
      await this.commitStagedFile(sessionId, quote.terms.fileSizeBytes.toString(10), quote.terms.recommendedFilename, seedHashHex, allBlockHashes);
      record = (await this.deps.sessions.get(sessionId)) ?? record;
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: "close-required", pendingTxid: undefined }, this.deps.nowMs());
      try { await this.deps.onContentCommitted?.(seedHashHex); } catch { /* 文件已提交；索引刷新失败不应阻止关池。 */ }
      try {
        await this.prepareAndSendClose(sessionId, completedBlockCount, allBlockHashes.length, stream);
        if (record.evidence.includes("download-plan")) this.deps.onDownloadPlanChanged?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : "关池请求准备失败";
        this.progress(sessionId, "closing-pool", this.readOpeningAmount(sessionId), completedBlockCount, allBlockHashes.length, `文件已保存；关池尚未完成，费用池仍受保护：${message.slice(0, 160)}`);
      }
      return;
    }
    await this.deps.sessions.update(sessionId, record.revision, {
      phase: "funded",
      pendingTxid: undefined,
      pendingAuthorizationId: undefined,
    }, this.deps.nowMs());
    if (record.evidence.includes("download-plan")) {
      await this.continueSharedFundedPool(sessionId, quote, stream);
      return;
    }
    const delivered = new Set<string>();
    for (const hash of blockHashes) {
      if (await this.readStagedBytes(sessionId, `blocks/${hash}.bin`)) delivered.add(hash);
    }
    const nextHash = blockHashes.find((hash) => !delivered.has(hash));
    if (!nextHash) throw new Error("BitFS 块进度与暂存内容不一致");
    this.progress(sessionId, "requesting-blocks", this.readOpeningAmount(sessionId), delivered.size, allBlockHashes.length, `正在请求文件块 ${delivered.size + 1}/${blockHashes.length}`);
    await this.prepareAndSendRequest({ sessionId, contentHashes: [hexToBytes(nextHash)], seed: seedStaged, stream });
  }

  private async prepareAndSendClose(sessionId: string, verifiedBlockCount: number, totalBlockCount: number, stream: BitfsBuyerStream): Promise<void> {
    let record = await this.requiredSession(sessionId);
    let rawKind12 = await this.deps.sessions.getEvidence(sessionId, "kind12-close-request");
    if (!rawKind12) {
      const pool = await this.readCurrentPool(sessionId);
      const latestPayment = pool.latestPaymentRawTx
        ? await parsePaymentState(pool.latestPaymentRawTx, pool.opening)
        : undefined;
      rawKind12 = (await prepareBuyerCloseArtifact(await this.facts(), {
        pool,
        targetSellerAmountSatoshis: latestPayment?.sellerAmountSatoshis ?? 0n,
      }, createJournaledBitfsBuyerSigner({
        sessions: this.deps.sessions,
        sessionId,
        signer: this.deps.signer,
        family: "kind12-close",
        assertCurrentContext: this.deps.assertCurrentContext,
        nowMs: this.deps.nowMs,
      }))).bytes();
      this.deps.assertCurrentContext();
      record = (await this.deps.sessions.get(sessionId)) ?? record;
      record = await this.deps.sessions.putEvidence(sessionId, record.revision, "kind12-close-request", rawKind12, this.deps.nowMs());
    } else if (!record.evidence.includes("kind12-close-request")) {
      record = await this.deps.sessions.putEvidence(sessionId, record.revision, "kind12-close-request", rawKind12, this.deps.nowMs());
    }
    if (record.phase === "cancel-closing-pool") {
      // 持久化发送未知状态后才碰 DataChannel；Worker 中断时可识别需重发同一 Kind 12。
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: "cancel-close-unknown" }, this.deps.nowMs());
    }
    const cancelling = record.phase === "cancel-closing-pool" || record.phase === "cancel-close-unknown";
    if (!cancelling && record.phase !== "close-requested" && record.phase !== "close-unknown" && record.phase !== "completed") {
      record = await this.deps.sessions.update(sessionId, record.revision, {
        phase: "close-requested",
        pendingAuthorizationId: undefined,
      }, this.deps.nowMs());
    }
    this.deps.assertCurrentContext();
    await stream.send(rawKind12);
    this.progress(sessionId, cancelling ? "cancelling-pool" : "closing-pool", this.readOpeningAmount(sessionId), verifiedBlockCount, totalBlockCount,
      cancelling ? "已发送取消关池请求，等待卖方签署并确认余款回收" : "文件已写入本地，正在协商关闭费用池并收回余款");
  }

  private async handleCloseResponse(sessionId: string, rawKind13: Uint8Array, _stream: BitfsBuyerStream): Promise<void> {
    let record = await this.requiredSession(sessionId);
    if (!record.evidence.includes("kind12-close-request")) throw new Error("收到 Kind 13，但买方尚未发送 Kind 12 关池请求");
    const savedResponse = await this.deps.sessions.getEvidence(sessionId, "kind13-close-response");
    if (savedResponse && !equal(savedResponse, rawKind13)) throw new Error("同一 BitFS 会话收到不同 Kind 13，已拒绝替换关池交易");
    const pool = await this.readCurrentPool(sessionId);
    const closeTransaction = await verifyBuyerCompletedCloseArtifact({ pool, responseRaw: rawKind13 });
    this.deps.assertCurrentContext();
    if (!record.evidence.includes("kind13-close-response")) {
      record = await this.deps.sessions.putEvidence(sessionId, record.revision, "kind13-close-response", rawKind13, this.deps.nowMs());
    }
    const savedClose = await this.deps.sessions.getEvidence(sessionId, "close-transaction");
    if (savedClose && !equal(savedClose, closeTransaction)) throw new Error("同一 BitFS 关池响应对应不同完整交易");
    if (!record.evidence.includes("close-transaction")) {
      record = await this.deps.sessions.putEvidence(sessionId, record.revision, "close-transaction", closeTransaction, this.deps.nowMs());
    }
    const txid = bytesToHex(transactionID(closeTransaction));
    record = (await this.deps.sessions.get(sessionId)) ?? record;
    const cancelling = record.phase === "cancel-closing-pool" || record.phase === "cancel-close-unknown";
    const pendingPhase = cancelling ? "cancel-close-unknown" : "close-unknown";
    if (record.phase !== "completed" && record.phase !== "cancelled" && (record.phase !== pendingPhase || record.pendingTxid !== txid)) {
      record = await this.deps.sessions.update(sessionId, record.revision, { phase: pendingPhase, pendingTxid: txid }, this.deps.nowMs());
    }
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), await this.requiredEvidence(sessionId, "kind1-quote"));
    const blockCount = Number((quote.terms.fileSizeBytes + 262_143n) / 262_144n);
    const verifiedBlockCount = await this.countStagedBlocks(sessionId);
    const deadline = this.deps.nowMs() + MAX_CHAIN_WAIT_MS;
    while (this.deps.nowMs() < deadline) {
      this.deps.assertCurrentContext();
      const result = await this.deps.task.submitOrReconcilePoolRecovery(sessionId);
      if (result.closed) {
        const latest = await this.requiredSession(sessionId);
        if (latest.evidence.includes("download-plan")) {
          await this.deps.downloadPlan.closePool(sessionId);
          this.deps.onDownloadPlanChanged?.();
        }
        this.progress(sessionId, cancelling ? "cancelled" : "completed", this.readOpeningAmount(sessionId), verifiedBlockCount, blockCount,
          cancelling ? "购买已取消，费用池已关闭且余款已收回" : "文件已验证并写入本地，费用池已关闭且余款已收回");
        return;
      }
      if (result.outcome.status === "failed") {
        this.progress(sessionId, cancelling ? "cancel-unknown" : "close-unknown", this.readOpeningAmount(sessionId), verifiedBlockCount, blockCount,
          cancelling ? "取消关池交易尚未派发；费用池资金仍受保护" : "关池交易尚未派发；原交易和费用池资金仍受保护");
        return;
      }
      this.progress(sessionId, cancelling ? "cancel-unknown" : "close-unknown", this.readOpeningAmount(sessionId), verifiedBlockCount, blockCount,
        cancelling ? "取消关池交易结果仍在核对，费用池资金继续受保护" : "关池交易结果仍在链上核对，费用池资金继续受保护");
      await delay(CHAIN_POLL_INTERVAL_MS);
    }
    this.progress(sessionId, cancelling ? "cancel-unknown" : "close-unknown", this.readOpeningAmount(sessionId), verifiedBlockCount, blockCount,
      cancelling ? "取消关池交易暂未被节点观察；保留原交易等待恢复" : "关池交易暂未被节点观察；保留原交易等待恢复");
  }

  private async prepareAndSendRequest(input: { sessionId: string; contentHashes: Uint8Array[]; seed?: Uint8Array; stream: BitfsBuyerStream }): Promise<void> {
    this.deps.assertCurrentContext();
    const record = await this.requiredSession(input.sessionId);
    const quoteRaw = await this.requiredEvidence(input.sessionId, "kind1-quote");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(this.deps.nowMs()), quoteRaw);
    const pool = await this.readCurrentPool(input.sessionId);
    const nowSeconds = BigInt(Math.floor(this.deps.nowMs() / 1_000));
    const expiry = quote.terms.quoteExpiresAtUnixSeconds;
    const deliveryDeadline = nowSeconds + 60n < expiry ? nowSeconds + 60n : expiry;
    if (deliveryDeadline <= nowSeconds) throw new Error("卖方报价已过期，BitFS 不会继续签署付款授权");
    const prepared = await prepareBuyerContentRequest(await this.facts(), {
      quoteRaw,
      pool,
      contentHashes: input.contentHashes,
      deliveryDeadline,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
    }, createJournaledBitfsBuyerSigner({
      sessions: this.deps.sessions,
      sessionId: input.sessionId,
      signer: this.deps.signer,
      family: "kind5",
      assertCurrentContext: this.deps.assertCurrentContext,
      nowMs: this.deps.nowMs,
    }));
    const latestRecord = await this.requiredSession(input.sessionId);
    const sellerPool = await this.asSellerPool(input.sessionId, pool);
    const summary = await inspectSellerDeliveryRequest(await this.facts(), {
      quoteRaw,
      pool: sellerPool,
      requestRaw: prepared.outbound.bytes(),
    });
    const authorizationIdHex = bytesToHex(summary.paymentAuthorizationID);
    const name = `kind5-content-request-${authorizationIdHex}` as const;
    const latest = await this.deps.sessions.putEvidence(input.sessionId, latestRecord.revision, name, prepared.outbound.bytes(), this.deps.nowMs());
    const updated = await this.deps.sessions.update(input.sessionId, latest.revision, {
      phase: "request-prepared",
      pendingAuthorizationId: authorizationIdHex,
      deadlineUnixSeconds: deliveryDeadline.toString(10),
    }, this.deps.nowMs());
    this.deps.assertCurrentContext();
    this.contentRequestStartedAtMs.set(input.sessionId, monotonicNowMs());
    await input.stream.send(prepared.outbound.bytes());
    const progress = await this.progressForSession(input.sessionId);
    this.deps.onProgress({ ...progress, phase: "requesting-blocks", message: "已发送内容请求，等待卖方交付" });
    void updated;
  }

  private async readCurrentPool(sessionId: string): Promise<BuyerPoolEvidence> {
    const rawKind2 = await this.requiredEvidence(sessionId, "kind2-opening-request");
    const rawKind3 = await this.requiredEvidence(sessionId, "kind3-opening-response");
    const fundingRaw = await this.requiredEvidence(sessionId, "funding-transaction");
    const completed = await completeBuyerOpening({ rawKind2, rawKind3: new Uint8Array(), fundingTransactionRaw: fundingRaw }, rawKind3);
    const fundingTxid = bytesToHex(transactionID(fundingRaw));
    const record = await this.requiredSession(sessionId);
    let savedLatest: Uint8Array | undefined;
    let savedSequence = -1;
    for (const name of record.evidence.filter((item) => item.startsWith("latest-payment-transaction-"))) {
      const candidate = await this.deps.sessions.getEvidence(sessionId, name);
      if (!candidate) throw new Error("BitFS 买方会话缺少已登记的付款交易原文");
      const state = await parsePaymentState(candidate, completed.pool.opening);
      await verifyAcceptedPayment(state, completed.pool.opening);
      if (state.paymentSequence > savedSequence) {
        savedSequence = state.paymentSequence;
        savedLatest = candidate;
      } else if (state.paymentSequence === savedSequence && savedLatest && !equal(savedLatest, candidate)) {
        throw new Error("BitFS 买方付款日志包含相同序号的冲突交易");
      }
    }
    const latestTxid = savedLatest === undefined ? undefined : bytesToHex(transactionID(savedLatest));
    // Kind 12 freezes the buyer-selected latest payment state. After the seller
    // broadcasts the final close, that chain spend must not be mistaken for a
    // newer ordinary payment while verifying the exact Kind 13 response.
    const chain = record.evidence.includes("kind12-close-request")
      ? []
      : await this.deps.readPoolSpendChain(fundingTxid, latestTxid);
    if (chain.length > 1) throw new Error("BitFS 池链出现多笔尚未写入会话日志的付款，已停止自动购买");
    const last = chain.at(-1);
    const currentRaw = last?.rawTransaction ?? savedLatest;
    return { ...completed.pool, ...(currentRaw === undefined ? {} : { latestPaymentRawTx: currentRaw.slice() }) };
  }

  private async asSellerPool(sessionId: string, pool: BuyerPoolEvidence): Promise<SellerPoolEvidence> {
    return {
      opening: pool.opening,
      fundingTransactionRaw: await this.requiredEvidence(sessionId, "funding-transaction"),
      ...(pool.latestPaymentRawTx === undefined ? {} : { latestPaymentRawTx: pool.latestPaymentRawTx.slice() }),
    };
  }

  private async inspectKind5(input: { sessionId: string; quoteRaw: Uint8Array; pool: BuyerPoolEvidence; rawKind5: Uint8Array }): Promise<{
    authorizationIdHex: string;
    contentHashes: Uint8Array[];
    paymentSequence: number;
    sellerAmountAfterSatoshis: string;
  }> {
    const summary = await inspectSellerDeliveryRequest(await this.facts(), {
      quoteRaw: input.quoteRaw,
      pool: await this.asSellerPool(input.sessionId, input.pool),
      requestRaw: input.rawKind5,
    });
    return {
      authorizationIdHex: bytesToHex(summary.paymentAuthorizationID),
      contentHashes: summary.contentHashes.map((hash) => hash.slice()),
      paymentSequence: summary.paymentSequence,
      sellerAmountAfterSatoshis: summary.sellerAmountAfterSatoshis.toString(10),
    };
  }

  private async waitForNextPayment(
    sessionId: string,
    previousPool: BuyerPoolEvidence,
    expected: { paymentSequence: number; sellerAmountAfterSatoshis: string },
  ): Promise<{ txid: string; rawTransaction: Uint8Array } | undefined> {
    const fundingRaw = await this.requiredEvidence(sessionId, "funding-transaction");
    const fundingTxid = bytesToHex(transactionID(fundingRaw));
    const previousTxid = previousPool.latestPaymentRawTx
      ? bytesToHex(transactionID(previousPool.latestPaymentRawTx))
      : undefined;
    const deadline = this.deps.nowMs() + MAX_CHAIN_WAIT_MS;
    while (this.deps.nowMs() < deadline) {
      this.deps.assertCurrentContext();
      const chain = await this.deps.readPoolSpendChain(fundingTxid, previousTxid);
      const last = chain.at(-1);
      if (chain.length > 1) throw new Error("BitFS 池链出现多笔尚未核对的付款，已停止自动购买");
      if (last) {
        const state = await parsePaymentState(last.rawTransaction, previousPool.opening);
        await verifyAcceptedPayment(state, previousPool.opening);
        if (state.paymentSequence !== expected.paymentSequence
          || state.sellerAmountSatoshis.toString(10) !== expected.sellerAmountAfterSatoshis) {
          throw new Error("链上 BitFS 付款状态与本轮 Kind 5 授权不一致");
        }
        return { txid: last.txid, rawTransaction: last.rawTransaction.slice() };
      }
      await delay(CHAIN_POLL_INTERVAL_MS);
    }
    const record = await this.requiredSession(sessionId);
    await this.deps.sessions.update(sessionId, record.revision, { phase: "payment-unknown" }, this.deps.nowMs());
    return undefined;
  }

  private async commitStagedFile(sessionId: string, fileSizeBytes: string, fileName: string, seedHashHex: string, blockHashes: readonly string[]): Promise<void> {
    const seedBytes = await this.readStagedSeed(sessionId);
    const blocks: Uint8Array[] = [];
    for (const hash of blockHashes) {
      const bytes = await this.readStagedBytes(sessionId, `blocks/${hash}.bin`);
      if (!bytes) throw new Error(`已验收的 BitFS 文件块暂存缺失：${hash}`);
      blocks.push(bytes);
    }
    await commitPurchasedMsFileContent({
      store: this.deps.contentStore,
      seedHashHex,
      seedBytes,
      blocks,
      fileSizeBytes,
      fileName,
      mediaType: "application/octet-stream",
      now: () => this.deps.nowMs(),
    });
  }

  private async getAllBlockHashes(sessionId: string, fileSizeBytes: string, seedHashHex: string): Promise<string[]> {
    const seedBytes = await this.readStagedSeed(sessionId);
    const inspected = await inspectPurchasedMsFileSeed({ seedHashHex, seedBytes, fileSizeBytes });
    return inspected.blockHashesHex;
  }

  private async readStagedSeed(sessionId: string): Promise<Uint8Array> {
    const value = await this.readStagedBytes(sessionId, "seed.bin");
    if (!value) throw new Error("本地暂存中缺少已验签 BitFS Seed");
    return value;
  }

  private async stageBytes(sessionId: string, relativePath: string, bytes: Uint8Array): Promise<void> {
    const record = await this.requiredSession(sessionId);
    const path = record.evidence.includes("download-plan")
      ? sharedStagingPath(record.seedHashHex, relativePath)
      : `bitfs-staging/${assertSessionId(sessionId)}/${relativePath}`;
    const prior = await this.deps.contentStore.get(path);
    if (prior) {
      if (!equal(prior.bytes, bytes)) throw new Error("BitFS 已验签暂存内容与重试字节冲突");
      return;
    }
    try { await this.deps.contentStore.put(path, bytes.slice(), { ifNoneMatch: "*" }); }
    catch {
      const raced = await this.deps.contentStore.get(path);
      if (!raced || !equal(raced.bytes, bytes)) throw new Error("BitFS 已验签内容暂存失败");
    }
  }

  private async readStagedBytes(sessionId: string, relativePath: string): Promise<Uint8Array | undefined> {
    const record = await this.requiredSession(sessionId);
    const path = record.evidence.includes("download-plan")
      ? sharedStagingPath(record.seedHashHex, relativePath)
      : `bitfs-staging/${assertSessionId(sessionId)}/${relativePath}`;
    const item = await this.deps.contentStore.get(path);
    return item?.bytes.slice();
  }

  private async countStagedBlocks(sessionId: string): Promise<number> {
    const record = await this.requiredSession(sessionId);
    if (record.evidence.includes("download-plan")) {
      return (await this.deps.downloadPlan.snapshot()).completedBlockCount;
    }
    const prefix = `bitfs-staging/${assertSessionId(sessionId)}/blocks/`;
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await this.deps.contentStore.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
      count += page.files.filter((file) => /^bitfs-staging\/[0-9a-z][0-9a-z._-]{0,127}\/blocks\/[0-9a-f]{64}\.bin$/u.test(file.path)).length;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return count;
  }

  private async registerSharedPlanPool(sessionId: string, quote: ReturnType<typeof acceptBuyerQuote>, openingAmountSatoshis: string): Promise<void> {
    const raw = await this.requiredEvidence(sessionId, "download-plan");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
    catch { throw new Error("BitFS 下载计划池预算证据损坏"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 下载计划池预算证据格式错误");
    const row = value as Record<string, unknown>;
    const expectedKeys = [
      "blockBudgetSatoshis", "contentBudgetSatoshis", "priority", "recentBytesPerSecond",
      "seedBudgetReserved", "seedBudgetSatoshis",
    ].sort().join(",");
    if (Object.keys(row).sort().join(",") !== expectedKeys
      || typeof row.contentBudgetSatoshis !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(row.contentBudgetSatoshis)
      || typeof row.seedBudgetSatoshis !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(row.seedBudgetSatoshis)
      || typeof row.blockBudgetSatoshis !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(row.blockBudgetSatoshis)
      || typeof row.seedBudgetReserved !== "boolean"
      || (row.priority !== "price" && row.priority !== "recent-speed")
      || (row.recentBytesPerSecond !== null && (typeof row.recentBytesPerSecond !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(row.recentBytesPerSecond)))) {
      throw new Error("BitFS 下载计划池预算证据字段无效");
    }
    const contentBudget = BigInt(row.contentBudgetSatoshis);
    const seedBudget = BigInt(row.seedBudgetSatoshis);
    const blockBudget = BigInt(row.blockBudgetSatoshis);
    const feeReserve = this.deps.minerFeeRateSatoshisPerKilobyte * POOL_FEE_RESERVE_MULTIPLIER;
    if (seedBudget + blockBudget !== contentBudget
      || (row.seedBudgetReserved && seedBudget < quote.terms.seedPriceSatoshis)
      || (!row.seedBudgetReserved && seedBudget !== 0n)
      || blockBudget < quote.terms.fullBlockPriceSatoshis
      || BigInt(openingAmountSatoshis) !== contentBudget + feeReserve) {
      throw new Error("BitFS 下载计划预算与固定开池金额不一致");
    }
    const record = await this.requiredSession(sessionId);
    await this.deps.downloadPlan.registerPool({
      sessionId,
      sellerPublicKeyHex: record.counterpartyPublicKeyHex,
      fullBlockPriceSatoshis: quote.terms.fullBlockPriceSatoshis.toString(10),
      seedPriceSatoshis: quote.terms.seedPriceSatoshis.toString(10),
      contentBudgetSatoshis: contentBudget.toString(10),
      seedBudgetSatoshis: seedBudget.toString(10),
      seedBudgetReserved: row.seedBudgetReserved,
      blockBudgetSatoshis: blockBudget.toString(10),
      recentBytesPerSecond: row.recentBytesPerSecond as string | null,
    });
  }

  private async completeSharedPayment(input: {
    sessionId: string;
    quote: ReturnType<typeof acceptBuyerQuote>;
    summary: { contentHashes: Uint8Array[]; paymentSequence: number; sellerAmountAfterSatoshis: string };
    pool: BuyerPoolEvidence;
  }): Promise<void> {
    if (input.summary.contentHashes.length !== 1) throw new Error("BitFS 共享计划每次只能结算一个内容 Hash");
    const priorSellerAmount = await this.readPriorSellerAmount(input.sessionId, input.pool.opening, input.summary.paymentSequence);
    const paid = BigInt(input.summary.sellerAmountAfterSatoshis) - priorSellerAmount;
    if (paid <= 0n) throw new Error("BitFS 共享计划本轮已确认付款金额无效");
    const hashHex = bytesToHex(input.summary.contentHashes[0]!);
    const seedHashHex = bytesToHex(input.quote.terms.seedHash);
    if (hashHex === seedHashHex) {
      await this.deps.downloadPlan.completeSeed(input.sessionId, paid.toString(10));
      const hashes = await this.getAllBlockHashes(input.sessionId, input.quote.terms.fileSizeBytes.toString(10), seedHashHex);
      await this.deps.downloadPlan.setBlockHashes(hashes);
    } else {
      await this.deps.downloadPlan.completeBlock(input.sessionId, hashHex, paid.toString(10));
    }
  }

  private async readPriorSellerAmount(sessionId: string, opening: BuyerPoolEvidence["opening"], paymentSequence: number): Promise<bigint> {
    const record = await this.requiredSession(sessionId);
    let bestSequence = -1;
    let bestAmount = 0n;
    for (const name of record.evidence.filter((item) => item.startsWith("latest-payment-transaction-"))) {
      const raw = await this.deps.sessions.getEvidence(sessionId, name as `latest-payment-transaction-${string}`);
      if (!raw) throw new Error("BitFS 共享下载恢复缺少已登记付款交易原文");
      const state = await parsePaymentState(raw, opening);
      if (state.paymentSequence < paymentSequence && state.paymentSequence > bestSequence) {
        bestSequence = state.paymentSequence;
        bestAmount = state.sellerAmountSatoshis;
      }
    }
    return bestAmount;
  }

  private async markFailed(sessionId: string, amount: string, total: number, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "BitFS 买方流程失败";
    this.progress(sessionId, "failed", amount, 0, total, message.slice(0, 240));
    const record = await this.deps.sessions.get(sessionId);
    if (record && record.phase !== "failed") {
      await this.deps.sessions.update(sessionId, record.revision, { phase: "failed", failureCode: "buyer-purchase-failed" }, this.deps.nowMs()).catch(() => undefined);
    }
  }

  private async facts() {
    return bitfsWorkflowFacts(this.deps.nowMs(), await this.deps.blockHeight());
  }

  private async requiredSession(sessionId: string): Promise<BitfsSessionRecord> {
    const record = await this.deps.sessions.get(assertSessionId(sessionId));
    if (!record || record.role !== "buyer") throw new Error("BitFS 买方会话不存在");
    return record;
  }

  private async requiredEvidence(sessionId: string, name: Parameters<BitfsSessionJournal["getEvidence"]>[1]): Promise<Uint8Array> {
    const value = await this.deps.sessions.getEvidence(sessionId, name);
    if (!value) throw new Error(`BitFS 买方会话证据缺失：${name}`);
    return value;
  }

  private readOpeningAmount(sessionId: string): string {
    const value = this.purchaseConfigs.get(sessionId)?.openingAmountSatoshis;
    if (value) return value;
    return "0";
  }

  private progress(sessionId: string, phase: BitfsBuyerPurchasePhase, amount: string, verified: number, total: number | null, message: string | null): void {
    this.deps.onProgress({ sessionId, phase, openingAmountSatoshis: amount, verifiedBlockCount: verified, totalBlockCount: total, message });
  }

  private snapshot(sessionId: string, phase: BitfsBuyerPurchasePhase, amount: string, verified: number, total: number | null, message: string | null): BitfsBuyerPurchaseProgress {
    return { sessionId, phase, openingAmountSatoshis: amount, verifiedBlockCount: verified, totalBlockCount: total, message };
  }

  private async serial(sessionId: string, action: () => Promise<void>): Promise<void> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(action);
    this.locks.set(sessionId, next);
    try { await next; } finally { if (this.locks.get(sessionId) === next) this.locks.delete(sessionId); }
  }
}

function phaseFor(record: BitfsSessionRecord): BitfsBuyerPurchasePhase {
  if (record.phase === "completed") return "completed";
  if (record.phase === "cancelled") return "cancelled";
  if (record.phase === "cancel-opening") return "cancelling-opening";
  if (record.phase === "cancel-closing-pool") return "cancelling-pool";
  if (record.phase === "cancel-close-unknown") return "cancel-unknown";
  if (record.phase === "close-required") return "closing-pool";
  if (record.phase === "close-requested") return "closing-pool";
  if (record.phase === "close-unknown") return "close-unknown";
  if (record.phase === "funding-unknown") return "funding-unknown";
  if (record.phase === "funding-prepared" || record.phase === "opening-presign") return "funding";
  if (record.phase === "request-prepared" || record.phase === "delivery-verified") return "requesting-blocks";
  if (record.phase === "payment-unknown") return "payment-unknown";
  if (record.phase === "content-committing") return "content-committing";
  if (record.phase === "failed") return "failed";
  if (record.phase === "funded") return "requesting-seed";
  return "opening";
}

function parsePurchaseManifest(bytes: Uint8Array, expectedSeedHashHex: string): BitfsBuyerPurchaseManifest {
  if (bytes.byteLength < 2 || bytes.byteLength > 2_048) throw new Error("BitFS 入库恢复清单大小无效");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("BitFS 入库恢复清单损坏"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 入库恢复清单格式错误");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.join(",") !== "fileSizeBytes,format,recommendedFilename,seedHashHex,version"
    || row.format !== PURCHASE_MANIFEST_FORMAT || row.version !== 1
    || row.seedHashHex !== expectedSeedHashHex
    || typeof row.fileSizeBytes !== "string" || !/^[1-9][0-9]*$/u.test(row.fileSizeBytes)
    || BigInt(row.fileSizeBytes) > 0xffff_ffff_ffff_ffffn
    || typeof row.recommendedFilename !== "string") {
    throw new Error("BitFS 入库恢复清单字段无效");
  }
  const fileNameBytes = new TextEncoder().encode(row.recommendedFilename);
  if (fileNameBytes.byteLength < 1 || fileNameBytes.byteLength > 255
    || row.recommendedFilename === "." || row.recommendedFilename === ".."
    || row.recommendedFilename.includes("/") || row.recommendedFilename.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(row.recommendedFilename)) {
    throw new Error("BitFS 入库恢复文件名无效");
  }
  return {
    format: PURCHASE_MANIFEST_FORMAT,
    version: 1,
    seedHashHex: expectedSeedHashHex,
    fileSizeBytes: row.fileSizeBytes,
    recommendedFilename: row.recommendedFilename,
  };
}

function sharedStagingPath(seedHashHex: string, relativePath: string): string {
  if (!/^[0-9a-f]{64}$/u.test(seedHashHex)) throw new TypeError("BitFS 共享暂存 Seed Hash 无效");
  if (!/^(?:seed\.bin|blocks\/[0-9a-f]{64}\.bin)$/u.test(relativePath)) throw new TypeError("BitFS 共享暂存文件路径无效");
  return `bitfs-staging/by-seed/${seedHashHex}/${relativePath}`;
}

function assertSessionId(value: string): string {
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(value)) throw new TypeError("BitFS 买方 session ID 无效");
  return value;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new TypeError("BitFS 字节 hex 无效");
  return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesToHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function parseSatoshiAmount(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("BitFS 开池金额必须是十进制聪字符串");
  return BigInt(value);
}
function equal(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
function monotonicNowMs(): number {
  const performanceNow = globalThis.performance?.now();
  return typeof performanceNow === "number" && Number.isFinite(performanceNow) ? performanceNow : Date.now();
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
