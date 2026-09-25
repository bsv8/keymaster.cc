// BitFS 买方需求、报价发现与开池任务的本地编排。
//
// 中文说明：需求发布和报价发现通过 Coordinator 注入的 ChannelProtocol
// 端口完成；本模块保存已验签 Kind 1。当前开池仍必须由明确的后续买方操作
// 触发，需求和报价阶段不会拆分或广播资金。

import type { BsvNetwork } from "@keymaster/contracts";
import {
  acceptBuyerQuote,
  completeBuyerOpening,
  parse,
  parsePaymentState,
  prepareBuyerFundingDelivery,
  prepareBuyerOpening,
  buildBuyerMaturedRefund,
  verifyBuyerCompletedCloseArtifact,
  verifyBuyerCompletedClose,
  WireError,
  type BuyerOpeningEvidence,
  type BuyerPoolEvidence,
  type Signer,
  type VerifiedQuote,
} from "go-bitfs";
import type { BitfsFundingLedger, BitfsFundingTransactionView, PreparedBitfsFunding } from "./funding.js";
import type { BitfsBroadcastOutcome, BitfsTransactionBroadcaster, BitfsTransactionJournal } from "./broadcast.js";
import { createJournaledBitfsBuyerSigner } from "./signerJournal.js";
import { bitfsWorkflowFacts, deriveBitfsPoolLockingScript } from "./sdk.js";
import { bitfsTxidHex } from "./txid.js";
import {
  assertBitfsBuyerCloseBinding,
  parseBitfsBuyerCloseBinding,
  readBitfsBuyerLocalPaymentState,
} from "./buyerPoolState.js";
import type { BitfsPoolSpendChain } from "./wocChain.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";

/** 关池交易查询确认缺失后，允许重放同一 exact bytes 前等待的间隔。 */
const POOL_RECOVERY_RETRY_INTERVAL_MS = 30_000;

/** 买方开池任务依赖；所有时钟、身份、持久化与交易解析均由 Worker 提供。 */
export interface BitfsBuyerTaskDeps {
  /** 当前 Key + Seed 的会话证据存储。 */
  sessions: BitfsSessionJournal;
  /** 当前 Key + Seed 的专款账本。 */
  ledger: BitfsFundingLedger;
  /** 保存 exact FundingTx 的 outbox。 */
  transactions: BitfsTransactionJournal;
  /** 唯一可以向节点派发 BitFS 交易的广播器。 */
  broadcaster: BitfsTransactionBroadcaster;
  /** 当前 Vault 受限签名器。 */
  signer: Signer;
  /** Worker 专用资金准备器；按本模块推导的固定池脚本与金额准备 exact FundingTx。 */
  prepareFunding(input: {
    /** 当前买卖会话编号。 */
    sessionId: string;
    /** 当前 Seed 的开池输出金额，十进制聪字符串。 */
    openingOutput: { valueSatoshis: string; scriptHex: string };
  }): Promise<PreparedBitfsFunding>;
  /** 经 Coordinator/ChannelProtocol 发布真实 Hash 需求；回调在广播前收到真实 message_id。 */
  publishHashRequest?(
    onPrepared: (messageId: string) => void,
    onDefinitelyFailed: (messageId: string) => void,
  ): Promise<{ messageId: string }>;
  /** Worker 在节点明确未派发后释放对应的 P2PKH durable input claim。 */
  releasePreparedSubmission(input: { ownerPublicKeyHex: string; network: BsvNetwork; txid: string; submissionId: string }): Promise<void>;
  /** 当前 Key 压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 当前 Key 的 P2PKH 锁定脚本；关池时只把此脚本的输出记回买方专款。 */
  ownerP2pkhScriptHex: string;
  /** 当前任务 Seed Hash。 */
  seedHashHex: string;
  /** 资金所属网络。 */
  network: BsvNetwork;
  /** 创建任务时的 Worker generation。 */
  generation: number;
  /** 从交易原文重新解析 canonical txid、输入与输出。 */
  parseTransaction(rawTransactionHex: string, expectedTxid?: string): BitfsFundingTransactionView;
  /** 每次签名、写盘或广播前核对 owner/network/generation。 */
  assertCurrentContext(): void;
  /** Worker 提供的 UTC 毫秒。 */
  nowMs(): number;
  /** 查询退款锁所需的当前链高度；时间锁仍由显式 nowMs 判定。 */
  blockHeight?(): Promise<number>;
  /** 查询开池输出当前被哪一笔累计池状态花费；未知状态必须显式返回 unknown。 */
  readPoolSpendChain?(fundingTxid: string): Promise<BitfsPoolSpendChain>;
}

/** ChannelProtocol Hash 请求允许的最长有效期；单位毫秒。 */
const HASH_REQUEST_LIFETIME_MS = 10 * 60 * 1_000;

/** 已验证报价的简要视图；金额均为十进制聪字符串。 */
export interface BitfsBuyerQuoteView {
  /** 买方会话编号。 */
  sessionId: string;
  /** 固定报价对应的 Seed Hash。 */
  seedHashHex: string;
  /** 报价签名绑定的原文件字节数。 */
  fileSizeBytes: string;
  /** 报价卖方压缩公钥。 */
  sellerPublicKeyHex: string;
  /** Seed 单价。 */
  seedPriceSatoshis: string;
  /** 完整 Block 单价。 */
  fullBlockPriceSatoshis: string;
  /** 报价有效截止 UTC Unix 秒。 */
  quoteExpiresAtUnixSeconds: string;
  /** 卖方建议文件名。 */
  recommendedFilename: string;
  /** 报价允许的仲裁方压缩公钥；买方只能选择列表内公钥。 */
  supportedArbiterPublicKeys: string[];
}

/** 开池准备的固定参数。 */
export interface BitfsBuyerOpeningInput {
  /** 要开池的已验签卖方报价会话编号。 */
  sessionId: string;
  /** 第一池在 Kind 2 中承诺的专款金额，十进制聪字符串。 */
  openingAmountSatoshis: string;
  /** 退款交易到期锁定值；解释规则由 go-bitfs 决定。 */
  expiryLockTime: number;
  /** 池内退款/付款交易矿工费率，单位聪/千字节。 */
  minerFeeRateSatoshisPerKilobyte: bigint;
  /** 从已验证报价允许列表选出的仲裁方公钥。 */
  arbiterPublicKeyHex: string;
}

/** 关池广播/恢复摘要，不暴露交易原文。 */
export interface BitfsPoolRecoveryResult {
  /** 原关池交易的广播或链上查询结果。 */
  outcome: BitfsBroadcastOutcome;
  /** 已观察关池交易并完成专款账本回收时为 true。 */
  closed: boolean;
}

/** 到期退款的恢复摘要；尚未到期或链上已有最终关闭状态时返回 undefined。 */
export interface BitfsMaturedRefundResult {
  /** 原退款交易的广播或链上查询结果。 */
  outcome: BitfsBroadcastOutcome;
  /** 已观察退款交易并完成专款账本回收时为 true。 */
  refunded: boolean;
}

/** 买方开池生命周期入口。 */
export interface BitfsBuyerTask {
  /** 发布一次绑定当前 Seed 的 ChannelProtocol Hash 请求；重复调用复用同一编号。 */
  publishDemand(): Promise<string>;
  /** 清除当前请求编号；公开请求不能撤回，但 Worker 会忽略后续 offer。 */
  cancelDemand(): Promise<void>;
  /** 固定一个引用本次需求、且由对应卖家通过 ChannelProtocol offer 送达的 exact Kind 1。 */
  acceptDiscoveredQuote(input: {
    /** 买方会话编号。 */
    sessionId: string;
    /** 必须与当前需求返回的 message_id 相同。 */
    requestMessageId: string;
    /** ChannelProtocol 已验签 offer 信封中的卖家公钥。 */
    counterpartyPublicKeyHex: string;
    /** WebRTC DataChannel 上收到的 exact Kind 1 字节。 */
    rawKind1: Uint8Array;
  }): Promise<BitfsBuyerQuoteView>;
  /** 返回本次需求已验证并持久化的报价，不包含原始交易或证据字节。 */
  listDiscoveredQuotes(): Promise<BitfsBuyerQuoteView[]>;
  /** 验证并固定 exact Kind 1 报价，不触发专款拆分或广播。 */
  acceptQuote(input: {
    /** 买方会话编号。 */
    sessionId: string;
    /** 与卖家连接身份绑定的压缩公钥。 */
    counterpartyPublicKeyHex: string;
    /** 卖方签名的 exact Kind 1 报价字节。 */
    rawKind1: Uint8Array;
  }): Promise<BitfsBuyerQuoteView>;
  /** Worker 重启后按持久化 session ID 恢复同一个买方任务。 */
  resume(sessionId: string): Promise<BitfsSessionRecord>;
  /** 只按原 txid 查询 FundingTx；观察到交易后补齐专款账本与 Kind 4，不主动广播。 */
  reconcileFunding(sessionId: string): Promise<{ outcome: BitfsBroadcastOutcome; kind4?: Uint8Array } | undefined>;
  /** 从报价和三方公钥推导池脚本，准备并保护 FundingTx，再持久化 exact Kind 2。 */
  prepareOpening(input: BitfsBuyerOpeningInput): Promise<Uint8Array>;
  /** 验证 exact Kind 3 并持久化；返回已验证的池证据。 */
  acceptOpeningResponse(input: { sessionId: string; rawKind3: Uint8Array }): Promise<BuyerPoolEvidence>;
  /** 在 Kind 3 到达前完成取消；仅释放可证明未派发的开池占用。 */
  cancelUnfundedOpening(sessionId: string): Promise<void>;
  /** 首次提交 FundingTx，或只按 txid 对账未知结果；资金观察后返回 exact Kind 4。 */
  submitOrReconcileFunding(sessionId: string): Promise<{ outcome: BitfsBroadcastOutcome; kind4?: Uint8Array }>;
  /** 从已保存的双签 Kind 13 恢复并继续同一笔关池交易；不重新签名或构造新交易。 */
  resumePoolRecovery(sessionId: string): Promise<BitfsPoolRecoveryResult | undefined>;
  /** 验证并广播已持久化的 Kind 13 完整关池交易；观察后释放池资金并更新专款账本。 */
  submitOrReconcilePoolRecovery(sessionId: string): Promise<BitfsPoolRecoveryResult>;
  /** 退款锁到期后广播 SDK 预签退款，并按原 txid 恢复；不请求额外签名。 */
  recoverMaturedRefund(sessionId: string): Promise<BitfsMaturedRefundResult | undefined>;
}

/** 创建固定 Key + Seed + 网络上下文的单报价买方任务。 */
export function createBitfsBuyerTask(deps: BitfsBuyerTaskDeps): BitfsBuyerTask {
  const owner = assertPublicKey(deps.ownerPublicKeyHex);
  const seed = assertHash(deps.seedHashHex);
  const network = assertNetwork(deps.network);
  if (!/^(?:[0-9a-f]{2})+$/u.test(deps.ownerP2pkhScriptHex)) throw new TypeError("BitFS 买方当前 Key 的 P2PKH 锁定脚本无效");
  if (!Number.isSafeInteger(deps.generation) || deps.generation < 0) throw new TypeError("BitFS 买方任务 generation 无效");
  if (bytesToHex(deps.signer.publicKey()) !== owner) throw new Error("BitFS 买方 Signer 与当前 Key 不一致");

  const readSession = async (sessionId: string): Promise<BitfsSessionRecord> => {
    deps.assertCurrentContext();
    const normalizedSessionId = assertSessionId(sessionId);
    const session = await deps.sessions.get(normalizedSessionId);
    if (!session || session.role !== "buyer" || session.ownerPublicKeyHex !== owner
      || session.seedHashHex !== seed) {
      throw new Error("BitFS 买方会话身份已变化");
    }
    return session;
  };

  let currentDemandMessageId = "";
  let currentDemandExpiresAtMs = 0;

  const readQuote = async (session: BitfsSessionRecord): Promise<{ raw: Uint8Array; quote: VerifiedQuote }> => {
    const raw = await deps.sessions.getEvidence(session.sessionId, "kind1-quote");
    if (!raw) throw new Error("BitFS 买方会话缺少已固定的 Kind 1 报价");
    const quote = acceptBuyerQuote(bitfsWorkflowFacts(deps.nowMs()), raw);
    if (bytesToHex(quote.sellerPublicKey) !== session.counterpartyPublicKeyHex) throw new Error("已固定报价的卖方身份不匹配");
    if (bytesToHex(quote.terms.seedHash) !== seed || bytesToHex(quote.terms.buyerPublicKey) !== owner) {
      throw new Error("已固定报价没有绑定当前买方 Key 与 Seed");
    }
    return { raw, quote };
  };

  const readOpeningEvidence = async (session: BitfsSessionRecord): Promise<BuyerOpeningEvidence> => {
    const rawKind2 = await deps.sessions.getEvidence(session.sessionId, "kind2-opening-request");
    const rawKind3 = await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response");
    const fundingTransactionRaw = await deps.sessions.getEvidence(session.sessionId, "funding-transaction");
    if (!rawKind2 || !fundingTransactionRaw) throw new Error("BitFS 买方开池证据不完整");
    return { rawKind2, rawKind3: rawKind3 ?? new Uint8Array(), fundingTransactionRaw };
  };

  const assertFundingTxReserved = async (session: BitfsSessionRecord, raw: Uint8Array, allowObserved = false): Promise<string> => {
    const parsed = deps.parseTransaction(toHex(raw));
    const txid = assertHash(parsed.canonicalTxid);
    const [storedRaw, record] = await Promise.all([
      deps.transactions.getTransaction(txid),
      deps.transactions.getTransactionRecord(txid),
    ]);
    const permittedOutboxStates = allowObserved ? ["prepared", "result-unknown", "confirmed", "failed"] : ["prepared"];
    if (!storedRaw || !equal(storedRaw, raw) || !record || !permittedOutboxStates.includes(record.state)) {
      throw new Error("FundingTx exact bytes 未处于允许的 BitFS outbox 状态");
    }
    const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
    const plan = account.transactions.find((item) => item.txid === txid && item.purpose === "opening");
    const pool = account.pools.find((item) => item.poolId === session.sessionId && item.fundingTxid === txid);
    const expectedInputs = parsed.inputs.slice().sort();
    const plannedOutputs = plan?.expectedOutputs ?? [];
    const actualOutputs = parsed.outputs.map((item) => ({
      txid,
      vout: item.vout,
      valueSatoshis: String(item.valueSatoshis),
      scriptHex: item.scriptHex.toLowerCase(),
    }));
    const permittedPoolStates = allowObserved ? ["funding-pending", "open", "funding-failed"] : ["funding-pending"];
    if (!plan || !plan.p2pkhSubmissionId || !pool || !permittedPoolStates.includes(pool.state)
      || plan.poolId !== session.sessionId
      || !sameStrings(plan.inputOutpoints, expectedInputs)
      || !sameOutputs(plannedOutputs, actualOutputs)) {
      throw new Error("FundingTx 与本 Seed 的专款账本计划不一致");
    }
    return txid;
  };

  const saveExactEvidence = async (session: BitfsSessionRecord, name: Parameters<BitfsSessionJournal["putEvidence"]>[2], bytes: Uint8Array): Promise<BitfsSessionRecord> => {
    deps.assertCurrentContext();
    return deps.sessions.putEvidence(session.sessionId, session.revision, name, bytes, deps.nowMs());
  };

  const acceptQuote = async (input: {
    sessionId: string;
    counterpartyPublicKeyHex: string;
    rawKind1: Uint8Array;
  }): Promise<BitfsBuyerQuoteView> => {
      const sessionId = assertSessionId(input.sessionId);
      deps.assertCurrentContext();
      if (!(input.rawKind1 instanceof Uint8Array) || input.rawKind1.byteLength === 0) throw new TypeError("Kind 1 exact 报价不能为空");
      const counterparty = assertPublicKey(input.counterpartyPublicKeyHex);
      const quote = acceptBuyerQuote(bitfsWorkflowFacts(deps.nowMs()), input.rawKind1);
      if (bytesToHex(quote.sellerPublicKey) !== counterparty) throw new Error("报价签名公钥与连接身份不一致");
      if (bytesToHex(quote.terms.seedHash) !== seed || bytesToHex(quote.terms.buyerPublicKey) !== owner) {
        throw new Error("报价没有绑定当前买方 Key 与请求 Seed");
      }
      const existing = await deps.sessions.get(sessionId);
      if (existing) {
        if (existing.role !== "buyer" || existing.ownerPublicKeyHex !== owner || existing.counterpartyPublicKeyHex !== counterparty
          || existing.seedHashHex !== seed) {
          throw new Error("同一 BitFS session ID 已绑定其它身份");
        }
        const saved = await deps.sessions.getEvidence(sessionId, "kind1-quote");
        if (saved && !equal(saved, input.rawKind1)) throw new Error("同一买方会话不能替换已固定报价");
        if (!saved) await saveExactEvidence(existing, "kind1-quote", input.rawKind1);
      } else {
        deps.assertCurrentContext();
        const created = await deps.sessions.create({
          sessionId,
          role: "buyer",
          ownerPublicKeyHex: owner,
          counterpartyPublicKeyHex: counterparty,
          seedHashHex: seed,
          generation: deps.generation,
          phase: "quote-selected",
        }, deps.nowMs());
        await saveExactEvidence(created, "kind1-quote", input.rawKind1);
      }
      const view = toQuoteView(sessionId, seed, quote);
      let latest = await deps.sessions.get(sessionId);
      if (!latest) throw new Error("BitFS 报价会话写入后无法读取");
      const quoteSummary = new TextEncoder().encode(JSON.stringify(view));
      const savedSummary = await deps.sessions.getEvidence(sessionId, "quote-summary");
      if (savedSummary && !equal(savedSummary, quoteSummary)) throw new Error("BitFS 静态报价摘要与已验签 Kind 1 不一致");
      if (!savedSummary) latest = await saveExactEvidence(latest, "quote-summary", quoteSummary);
      return view;
  };

  const task: BitfsBuyerTask = {
    async publishDemand() {
      deps.assertCurrentContext();
      if (currentDemandMessageId && deps.nowMs() < currentDemandExpiresAtMs) return currentDemandMessageId;
      currentDemandMessageId = "";
      currentDemandExpiresAtMs = 0;
      if (!deps.publishHashRequest) throw new Error("BitFS ChannelProtocol Hash request publisher is unavailable");
      let preparedMessageId = "";
      let published: { messageId: string };
      try {
        published = await deps.publishHashRequest(
          (messageId) => {
            preparedMessageId = assertMessageId(messageId);
            currentDemandMessageId = preparedMessageId;
            currentDemandExpiresAtMs = deps.nowMs() + HASH_REQUEST_LIFETIME_MS;
          },
          (messageId) => {
            if (currentDemandMessageId === messageId) {
              currentDemandMessageId = "";
              currentDemandExpiresAtMs = 0;
            }
          },
        );
      } catch (error) {
        throw error;
      }
      const messageId = assertMessageId(published.messageId);
      if (currentDemandMessageId && currentDemandMessageId !== messageId) {
        throw new Error("ChannelProtocol Hash request message_id changed during publish");
      }
      currentDemandMessageId = messageId;
      if (currentDemandExpiresAtMs <= deps.nowMs()) currentDemandExpiresAtMs = deps.nowMs() + HASH_REQUEST_LIFETIME_MS;
      return messageId;
    },

    async cancelDemand() {
      deps.assertCurrentContext();
      currentDemandMessageId = "";
      currentDemandExpiresAtMs = 0;
    },

    async acceptDiscoveredQuote(input) {
      const requestMessageId = assertMessageId(input.requestMessageId);
      if (!currentDemandMessageId || requestMessageId !== currentDemandMessageId) {
        throw new Error("Kind 1 quote does not reference this BitFS Hash request");
      }
      const quote = await acceptQuote(input);
      let session = await deps.sessions.get(quote.sessionId);
      if (!session) throw new Error("BitFS quote session was not persisted");
      const requestEvidence = new TextEncoder().encode(requestMessageId);
      const savedRequestEvidence = await deps.sessions.getEvidence(quote.sessionId, "hash-request-message-id");
      if (savedRequestEvidence && !equal(savedRequestEvidence, requestEvidence)) {
        throw new Error("BitFS quote session is bound to another Hash request");
      }
      if (!savedRequestEvidence) session = await saveExactEvidence(session, "hash-request-message-id", requestEvidence);
      return quote;
    },

    async listDiscoveredQuotes() {
      deps.assertCurrentContext();
      if (!currentDemandMessageId) return [];
      const sessions = await deps.sessions.list();
      const quotes: BitfsBuyerQuoteView[] = [];
      for (const session of sessions) {
        if (session.role !== "buyer" || session.ownerPublicKeyHex !== owner || session.seedHashHex !== seed) continue;
        const requestEvidence = await deps.sessions.getEvidence(session.sessionId, "hash-request-message-id");
        if (!requestEvidence || new TextDecoder("utf-8", { fatal: true }).decode(requestEvidence) !== currentDemandMessageId) continue;
        try {
          const { quote } = await readQuote(session);
          quotes.push(toQuoteView(session.sessionId, seed, quote));
        } catch (error) {
          if (error instanceof WireError && error.code === "expired") continue;
          throw error;
        }
      }
      return quotes;
    },

    acceptQuote,

    async resume(sessionId) {
      return readSession(sessionId);
    },

    async reconcileFunding(sessionId) {
      const session = await readSession(sessionId);
      if (session.phase !== "funding-unknown") return undefined;
      const evidence = await readOpeningEvidence(session);
      const fundingTxid = await assertFundingTxReserved(session, evidence.fundingTransactionRaw, true);
      const record = await deps.transactions.getTransactionRecord(fundingTxid);
      if (!record || record.state === "failed") {
        return {
          outcome: {
            status: "failed",
            txid: fundingTxid,
            attempts: record?.attempts ?? 0,
            reason: record?.lastError ?? "funding-transaction-outbox-missing",
          },
        };
      }
      // 此处只查询原 txid。即使 WoC 暂时查不到，也保留未知状态和输入保护。
      const outcome = await deps.broadcaster.reconcile(fundingTxid);
      if (outcome.status !== "confirmed") return { outcome };
      // 复用已确认路径同步 ledger 并保存确定的 Kind 4；此调用只会再次查询已确认 txid。
      return task.submitOrReconcileFunding(sessionId);
    },

    async prepareOpening(input) {
      const session = await readSession(input.sessionId);
      const existingKind2 = await deps.sessions.getEvidence(session.sessionId, "kind2-opening-request");
      const existingFunding = await deps.sessions.getEvidence(session.sessionId, "funding-transaction");
      if (existingKind2) {
        if (!existingFunding) throw new Error("已准备 Kind 2 缺少固定 FundingTx 原文");
        const fundingTxid = await assertFundingTxReserved(session, existingFunding, true);
        if (session.phase === "funding-prepared") {
          deps.assertCurrentContext();
          await deps.sessions.update(session.sessionId, session.revision, { phase: "opening-presign", pendingTxid: fundingTxid }, deps.nowMs());
        }
        return existingKind2;
      }
      const { raw: quoteRaw, quote } = await readQuote(session);
      if (session.phase !== "quote-selected" && session.phase !== "funding-prepared") throw new Error("当前买方会话阶段不允许准备 Kind 2");
      const arbiterPublicKeyHex = assertPublicKey(input.arbiterPublicKeyHex);
      const arbiter = hexToBytes(arbiterPublicKeyHex);
      if (!quote.allowsArbiter(arbiter)) throw new Error("选择的仲裁方不在签名报价允许列表内");
      const openingAmount = assertOpeningAmount(input.openingAmountSatoshis);
      if (BigInt(openingAmount) < quote.terms.seedPriceSatoshis) throw new Error("FundingTx 首个池输出低于报价 Seed 价格");
      if (input.expiryLockTime === 0 || !Number.isSafeInteger(input.expiryLockTime) || input.expiryLockTime < 0 || input.expiryLockTime > 0xffffffff) {
        throw new TypeError("BitFS 开池退款锁值无效");
      }
      if (input.minerFeeRateSatoshisPerKilobyte < 1n) throw new TypeError("BitFS 池内矿工费率必须大于 0");
      const openingConfiguration = new TextEncoder().encode(JSON.stringify({
        openingAmountSatoshis: openingAmount,
        expiryLockTime: input.expiryLockTime,
        minerFeeRateSatoshisPerKilobyte: input.minerFeeRateSatoshisPerKilobyte.toString(10),
        arbiterPublicKeyHex,
      }));
      const savedConfiguration = await deps.sessions.getEvidence(session.sessionId, "opening-configuration");
      if (savedConfiguration && !equal(savedConfiguration, openingConfiguration)) {
        throw new Error("已固定开池参数不能替换；请恢复原仲裁方、金额与退款时限");
      }
      let configuredSession = session;
      if (!savedConfiguration) {
        configuredSession = await saveExactEvidence(session, "opening-configuration", openingConfiguration);
      }

      const openingOutput = {
        valueSatoshis: openingAmount,
        scriptHex: bytesToHex(deriveBitfsPoolLockingScript({
          buyerPublicKeyHex: owner,
          sellerPublicKeyHex: session.counterpartyPublicKeyHex,
          arbiterPublicKeyHex,
        })),
      };
      const funding = await deps.prepareFunding({ sessionId: configuredSession.sessionId, openingOutput });
      const fundingTxid = await assertFundingTxReserved(session, funding.rawTransaction);
      if (funding.txid !== fundingTxid || funding.openingOutpoint.vout !== 0
        || funding.openingOutpoint.valueSatoshis !== openingAmount
        || funding.openingOutpoint.scriptHex.toLowerCase() !== openingOutput.scriptHex.toLowerCase()) {
        throw new Error("已准备 FundingTx 与买方推导的池脚本或金额不一致");
      }

      const openingSigner = createJournaledBitfsBuyerSigner({
        sessions: deps.sessions,
        sessionId: session.sessionId,
        signer: deps.signer,
        family: "kind2",
        assertCurrentContext: deps.assertCurrentContext,
        nowMs: deps.nowMs,
      });
      const prepared = await prepareBuyerOpening({
        quoteRaw,
        fundingTransactionRaw: funding.rawTransaction,
        expiryLockTime: input.expiryLockTime,
        minerFeeRateSatoshisPerKilobyte: input.minerFeeRateSatoshisPerKilobyte,
        sellerPublicKey: hexToBytes(session.counterpartyPublicKeyHex),
        arbiterPublicKey: arbiter,
      }, openingSigner);
      let latest = await deps.sessions.get(session.sessionId);
      if (!latest || latest.ownerPublicKeyHex !== owner || latest.seedHashHex !== seed
        || latest.pendingTxid !== fundingTxid || latest.phase !== "funding-prepared") {
        throw new Error("BitFS 买方会话在签署 Kind 2 时已变化");
      }
      latest = await saveExactEvidence(latest, "funding-transaction", funding.rawTransaction);
      latest = await saveExactEvidence(latest, "kind2-opening-request", prepared.outbound.bytes());
      deps.assertCurrentContext();
      await deps.sessions.update(latest.sessionId, latest.revision, { phase: "opening-presign", pendingTxid: fundingTxid }, deps.nowMs());
      return prepared.outbound.bytes();
    },

    async acceptOpeningResponse(input) {
      const session = await readSession(input.sessionId);
      const rawKind3 = input.rawKind3;
      if (!(rawKind3 instanceof Uint8Array) || rawKind3.byteLength === 0) throw new TypeError("Kind 3 exact 响应不能为空");
      if (session.phase !== "opening-presign" && session.phase !== "funding-prepared" && session.phase !== "funding-unknown" && session.phase !== "funded") {
        throw new Error("当前买方会话阶段不允许接收 Kind 3");
      }
      const existing = await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response");
      if (existing && !equal(existing, rawKind3)) throw new Error("同一买方会话收到冲突的 Kind 3 原文");
      const evidence = await readOpeningEvidence(session);
      if (evidence.rawKind3.byteLength > 0 && !equal(evidence.rawKind3, rawKind3)) throw new Error("开池证据中的 Kind 3 与新响应不一致");
      const completed = await completeBuyerOpening(evidence, rawKind3);
      let latest = session;
      if (!existing) latest = await saveExactEvidence(latest, "kind3-opening-response", rawKind3);
      if (latest.phase === "opening-presign") {
        deps.assertCurrentContext();
        await deps.sessions.update(latest.sessionId, latest.revision, { phase: "funding-prepared" }, deps.nowMs());
      }
      return completed.pool;
    },

    async cancelUnfundedOpening(sessionId) {
      const session = await readSession(sessionId);
      if (session.phase !== "cancel-opening" && session.phase !== "cancelled") {
        throw new Error("当前买方会话没有已保存的未开池取消意图");
      }
      if (session.evidence.includes("kind3-opening-response") || session.evidence.includes("kind4-funding-delivery")
        || await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response")
        || await deps.sessions.getEvidence(session.sessionId, "kind4-funding-delivery")) {
        throw new Error("卖方已完成开池预签；必须先核对资金交易，再通过关池回收");
      }

      const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
      const plan = account.transactions.find((item) => item.purpose === "opening" && item.poolId === session.sessionId);
      const rawFunding = await deps.sessions.getEvidence(session.sessionId, "funding-transaction");
      const finishCancellation = async (): Promise<void> => {
        const latest = await deps.sessions.get(session.sessionId);
        if (!latest) throw new Error("未开池取消期间买方会话记录消失");
        if (latest.phase !== "cancelled") {
          deps.assertCurrentContext();
          await deps.sessions.update(latest.sessionId, latest.revision, {
            phase: "cancelled",
            pendingTxid: undefined,
            pendingAuthorizationId: undefined,
          }, deps.nowMs());
        }
      };
      if (rawFunding && !plan) throw new Error("待取消 FundingTx 缺少专款占用记录；资金继续受保护");
      if (session.pendingTxid !== undefined && (!plan || session.pendingTxid !== plan.txid)) {
        throw new Error("待取消 FundingTx 与专款账本 txid 不一致；资金继续受保护");
      }
      if (!plan) {
        await finishCancellation();
        return;
      }

      const parsed = rawFunding ? deps.parseTransaction(toHex(rawFunding), plan.txid) : undefined;
      if (parsed && parsed.canonicalTxid !== plan.txid) throw new Error("待取消 FundingTx 原文与专款账本 txid 不一致");
      const outbox = await deps.transactions.getTransactionRecord(plan.txid);
      if (outbox && outbox.state !== "prepared") {
        throw new Error("FundingTx 已进入派发或链上核对阶段；不能按未开池取消释放资金");
      }
      if (!plan.p2pkhSubmissionId) throw new Error("FundingTx 缺少 P2PKH 提交编号；专款输入继续受保护");
      if (plan.state === "result-unknown" || plan.state === "observed") {
        throw new Error("FundingTx 已进入派发或链上核对阶段；专款输入继续受保护");
      }

      // P2PKH 释放会先把提交标为不可派发；账本稍后释放时，即使中途退出也仍能安全重试。
      deps.assertCurrentContext();
      await deps.releasePreparedSubmission({ ownerPublicKeyHex: owner, network, txid: plan.txid, submissionId: plan.p2pkhSubmissionId });
      if (plan.state === "prepared") {
        const latestAccount = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const latestPlan = latestAccount.transactions.find((item) => item.txid === plan.txid && item.purpose === "opening");
        if (latestPlan?.state === "prepared") {
          deps.assertCurrentContext();
          await deps.ledger.releaseDefinitelyUndispatchedTransaction({
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            network,
            expectedRevision: latestAccount.revision,
            txid: plan.txid,
            nowMs: deps.nowMs(),
          });
        } else if (!latestPlan || (latestPlan.state !== "failed" && latestPlan.state !== "observed")) {
          throw new Error("专款账本状态在取消过程中发生变化；资金继续受保护");
        }
      }
      await finishCancellation();
    },

    async submitOrReconcileFunding(sessionId) {
      const session = await readSession(sessionId);
      if (session.phase !== "funding-prepared" && session.phase !== "funding-unknown" && session.phase !== "funded") {
        throw new Error("只有已完成 Kind 2/3 预签的买方会话才能派发 FundingTx");
      }
      const evidence = await readOpeningEvidence(session);
      const fundingTxid = await assertFundingTxReserved(session, evidence.fundingTransactionRaw, true);
      if (session.phase === "funded") {
        const savedKind4 = await deps.sessions.getEvidence(session.sessionId, "kind4-funding-delivery");
        if (!savedKind4) throw new Error("已完成买方会话缺少持久化 Kind 4");
        deps.assertCurrentContext();
        const outcome = await deps.broadcaster.reconcile(fundingTxid);
        return { outcome, kind4: savedKind4 };
      }
      const record = await deps.transactions.getTransactionRecord(fundingTxid);
      deps.assertCurrentContext();
      const outcome = record?.state === "result-unknown"
        ? await deps.broadcaster.reconcile(fundingTxid)
        : record?.state === "confirmed"
          ? await deps.broadcaster.reconcile(fundingTxid)
          : record?.state === "failed"
            ? { status: "failed" as const, txid: fundingTxid, attempts: record.attempts, reason: "funding-transaction-already-failed" }
            : await deps.broadcaster.submit(evidence.fundingTransactionRaw);
      deps.assertCurrentContext();

      if (outcome.status === "result-unknown") {
        const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const plan = account.transactions.find((item) => item.txid === fundingTxid && item.purpose === "opening");
        if (plan?.state === "prepared") {
          deps.assertCurrentContext();
          await deps.ledger.markTransactionUnknown({ ownerPublicKeyHex: owner, seedHashHex: seed, network, txid: fundingTxid, nowMs: deps.nowMs() });
        }
        const latest = await deps.sessions.get(session.sessionId);
        if (latest && latest.phase !== "funding-unknown") {
          deps.assertCurrentContext();
          await deps.sessions.update(latest.sessionId, latest.revision, { phase: "funding-unknown", pendingTxid: fundingTxid }, deps.nowMs());
        }
        return { outcome };
      }

      if (outcome.status === "failed") {
        const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const plan = account.transactions.find((item) => item.txid === fundingTxid && item.purpose === "opening");
        if (plan && plan.state !== "failed" && plan.state !== "observed") {
          if (!plan.p2pkhSubmissionId) throw new Error("FundingTx 缺少 P2PKH 提交编号，保留输入占用等待人工恢复");
          deps.assertCurrentContext();
          await deps.releasePreparedSubmission({ ownerPublicKeyHex: owner, network, txid: fundingTxid, submissionId: plan.p2pkhSubmissionId });
          deps.assertCurrentContext();
          await deps.ledger.releaseDefinitelyUndispatchedTransaction({ ownerPublicKeyHex: owner, seedHashHex: seed, network, expectedRevision: account.revision, txid: fundingTxid, nowMs: deps.nowMs() });
        }
        const latest = await deps.sessions.get(session.sessionId);
        if (latest && latest.phase !== "failed") {
          deps.assertCurrentContext();
          await deps.sessions.update(latest.sessionId, latest.revision, { phase: "failed", failureCode: "funding-not-dispatched" }, deps.nowMs());
        }
        return { outcome };
      }

      const parsed = deps.parseTransaction(toHex(evidence.fundingTransactionRaw), fundingTxid);
      deps.assertCurrentContext();
      await deps.ledger.observePoolFunding({
        ownerPublicKeyHex: owner,
        seedHashHex: seed,
        network,
        poolId: session.sessionId,
        actualInputs: parsed.inputs,
        actualOutputs: parsed.outputs.map((item) => ({ txid: fundingTxid, vout: item.vout, valueSatoshis: String(item.valueSatoshis), scriptHex: item.scriptHex.toLowerCase() })),
        nowMs: deps.nowMs(),
      });
      const latest = await deps.sessions.get(session.sessionId);
      if (!latest) throw new Error("FundingTx 已观察但买方会话丢失");
      const openingWithKind3: BuyerOpeningEvidence = { ...evidence, rawKind3: (await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response")) ?? new Uint8Array() };
      const completed = await completeBuyerOpening(openingWithKind3, openingWithKind3.rawKind3);
      const kind4 = await prepareBuyerFundingDelivery(completed.pool);
      const committed = await saveExactEvidence(latest, "kind4-funding-delivery", kind4.bytes());
      if (committed.phase !== "funded") {
        deps.assertCurrentContext();
        await deps.sessions.update(committed.sessionId, committed.revision, { phase: "funded", pendingTxid: fundingTxid }, deps.nowMs());
      }
      return { outcome, kind4: kind4.bytes() };
    },

    async submitOrReconcilePoolRecovery(sessionId) {
      let session = await readSession(sessionId);
      const cancellationIntent = session.phase === "cancel-closing-pool"
        || session.phase === "cancel-close-unknown"
        || session.phase === "cancelled";
      if (!session.evidence.includes("kind13-close-response")) throw new Error("BitFS 关池广播缺少已验收的 Kind 13 证据");
      const responseRaw = await deps.sessions.getEvidence(session.sessionId, "kind13-close-response");
      if (!responseRaw) throw new Error("BitFS 关池 Kind 13 证据文件缺失");
      if (parse(responseRaw).kind !== 13) throw new Error("BitFS 关池响应不是 Kind 13");
      const openingEvidence = await readOpeningEvidence(session);
      const rawKind3 = await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response");
      if (!rawKind3) throw new Error("BitFS 关池恢复缺少已验收的 Kind 3");
      const completedOpening = await completeBuyerOpening({ ...openingEvidence, rawKind3 }, rawKind3);
      const current = await readBitfsBuyerLocalPaymentState({
        sessions: deps.sessions,
        session,
        completedOpening: completedOpening.pool,
        includeLegacyPaymentEvidence: true,
      });
      const bindingRaw = await deps.sessions.getEvidence(session.sessionId, "kind12-close-binding");
      const binding = bindingRaw === undefined ? undefined : parseBitfsBuyerCloseBinding(bindingRaw);
      const expectedSequence = binding?.paymentSequence ?? current.paymentSequence;
      const expectedAmount = binding === undefined ? current.sellerAmountSatoshis : BigInt(binding.sellerAmountSatoshis);
      if (binding !== undefined
        && (binding.paymentSequence !== current.paymentSequence
          || binding.sellerAmountSatoshis !== current.sellerAmountSatoshis.toString(10)
          || binding.authorizationIdHex !== (current.authorizationIdHex ?? null))) {
        throw new Error("BitFS 关池恢复绑定与当前 Kind 5/7 状态不一致");
      }
      const requestRaw = await deps.sessions.getEvidence(session.sessionId, "kind12-close-request");
      if (!requestRaw) throw new Error("BitFS 关池恢复缺少已保存的 Kind 12 请求");
      const rawTransaction = await verifyBuyerCompletedCloseArtifact({ pool: current.pool, responseRaw, requestRaw });
      await assertBitfsBuyerCloseBinding({
        pool: current.pool,
        closeTransactionRaw: rawTransaction,
        paymentSequence: expectedSequence,
        sellerAmountSatoshis: expectedAmount,
      });
      session = (await deps.sessions.get(session.sessionId)) ?? session;
      const priorClose = await deps.sessions.getEvidence(session.sessionId, "close-transaction");
      if (priorClose && !equal(priorClose, rawTransaction)) throw new Error("BitFS 已保存的关池交易与 Kind 13 验证结果不一致");
      if (!session.evidence.includes("close-transaction")) {
        session = await deps.sessions.putEvidence(session.sessionId, session.revision, "close-transaction", rawTransaction, deps.nowMs());
      }
      const txid = assertHash(bitfsTxidHex(rawTransaction));
      const pendingPhase = cancellationIntent ? "cancel-close-unknown" : "close-unknown";
      if (session.phase !== "completed" && session.phase !== "cancelled" && (session.phase !== pendingPhase || session.pendingTxid !== txid)) {
        session = await deps.sessions.update(session.sessionId, session.revision, { phase: pendingPhase, pendingTxid: txid }, deps.nowMs());
      }
      const parsed = deps.parseTransaction(toHex(rawTransaction), txid);
      if (parsed.canonicalTxid !== txid || parsed.inputs.length !== 1) {
        throw new Error("BitFS 关池交易 txid 或池输入数量无效");
      }
      const ownerOutputs = parsed.outputs
        .filter((output) => output.scriptHex.toLowerCase() === deps.ownerP2pkhScriptHex.toLowerCase())
        .map((output) => ({
          txid,
          vout: output.vout,
          valueSatoshis: String(output.valueSatoshis),
          scriptHex: output.scriptHex.toLowerCase(),
        }));
      let account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
      let ledgerPool = account.pools.find((item) => item.poolId === session.sessionId);
      if (!ledgerPool) throw new Error("BitFS 关池专款账本中找不到对应费用池");
      if (ledgerPool.state === "closed") {
        if (ledgerPool.recoveryTxid !== txid) throw new Error("BitFS 费用池已由另一笔交易关闭");
        const record = await deps.transactions.getTransactionRecord(txid);
        const outcome: BitfsBroadcastOutcome = { status: "confirmed", txid, attempts: record?.attempts ?? 1 };
        const finalPhase = cancellationIntent ? "cancelled" : "completed";
        if (session.phase !== finalPhase) {
          session = await deps.sessions.update(session.sessionId, session.revision, { phase: finalPhase, pendingTxid: undefined }, deps.nowMs());
        }
        return { outcome, closed: true };
      }
      if (ledgerPool.state !== "open" && ledgerPool.state !== "recovery-pending") {
        throw new Error("BitFS 费用池当前状态不能关池");
      }
      if (ledgerPool.state === "open") {
        deps.assertCurrentContext();
        account = await deps.ledger.preparePoolRecovery({
          ownerPublicKeyHex: owner,
          seedHashHex: seed,
          network,
          expectedRevision: account.revision,
          poolId: session.sessionId,
          purpose: "close",
          txid,
          spendingOutpoint: parsed.inputs[0]!,
          outputs: ownerOutputs,
          nowMs: deps.nowMs(),
        });
        ledgerPool = account.pools.find((item) => item.poolId === session.sessionId);
      }
      if (!ledgerPool || ledgerPool.state !== "recovery-pending" || ledgerPool.recoveryTxid !== txid) {
        throw new Error("BitFS 费用池恢复计划与 Kind 13 交易不一致");
      }
      const ledgerPlan = account.transactions.find((item) => item.txid === txid && item.purpose === "close");
      if (!ledgerPlan || ledgerPlan.poolId !== session.sessionId
        || !sameStrings(ledgerPlan.inputOutpoints, parsed.inputs)
        || !sameOutputs(ledgerPlan.expectedOutputs, ownerOutputs)) {
        throw new Error("BitFS 关池交易与专款账本计划不一致");
      }
      const savedRaw = await deps.transactions.getTransaction(txid);
      if (savedRaw && !equal(savedRaw, rawTransaction)) throw new Error("BitFS 关池 txid 已绑定不同交易原文");
      deps.assertCurrentContext();
      // 正常关池由卖方广播。买方只保存相同的完整交易并按 txid 观察，
      // 不对 WOC 提交池内付款或最终关池交易。
      await deps.transactions.putTransaction(txid, rawTransaction, deps.nowMs());
      const outcome = await deps.broadcaster.reconcile(txid);
      deps.assertCurrentContext();
      if (outcome.status === "confirmed") {
        await deps.ledger.observePoolRecovery({
          ownerPublicKeyHex: owner,
          seedHashHex: seed,
          network,
          poolId: session.sessionId,
          actualInputs: parsed.inputs,
          actualOutputs: ownerOutputs,
          nowMs: deps.nowMs(),
        });
        session = (await deps.sessions.get(session.sessionId)) ?? session;
        const finalPhase = cancellationIntent ? "cancelled" : "completed";
        if (session.phase !== finalPhase) {
          await deps.sessions.update(session.sessionId, session.revision, { phase: finalPhase, pendingTxid: undefined }, deps.nowMs());
        }
        return { outcome, closed: true };
      }
      if (outcome.status === "result-unknown" && ledgerPlan.state === "prepared") {
        const latestAccount = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const currentPlan = latestAccount.transactions.find((item) => item.txid === txid && item.purpose === "close");
        if (currentPlan?.state === "prepared") {
          await deps.ledger.markTransactionUnknown({ ownerPublicKeyHex: owner, seedHashHex: seed, network, txid, nowMs: deps.nowMs() });
        }
      }
      session = (await deps.sessions.get(session.sessionId)) ?? session;
      if (session.phase !== "completed" && session.phase !== "cancelled" && (session.phase !== pendingPhase || session.pendingTxid !== txid)) {
        await deps.sessions.update(session.sessionId, session.revision, { phase: pendingPhase, pendingTxid: txid }, deps.nowMs());
      }
      return { outcome, closed: false };
    },

    async recoverMaturedRefund(sessionId) {
      let session = await readSession(sessionId);
      if (session.phase === "completed" || session.phase === "cancelled" || session.phase === "refunded") return undefined;
      // 收到双方完整 Kind 13 后必须优先恢复已协商关池，不能另造一笔互相冲突的退款。
      if (session.evidence.includes("kind13-close-response")) return undefined;
      if (!deps.blockHeight || !deps.readPoolSpendChain) throw new Error("BitFS 到期退款缺少链高度或池状态查询端口");
      const openingEvidence = await readOpeningEvidence(session);
      const rawKind3 = await deps.sessions.getEvidence(session.sessionId, "kind3-opening-response");
      if (!rawKind3) return undefined;
      const completedOpening = await completeBuyerOpening({ ...openingEvidence, rawKind3: new Uint8Array() }, rawKind3);
      const fundingTxid = assertHash(bitfsTxidHex(openingEvidence.fundingTransactionRaw));
      const currentAccount = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
      let poolRecord = currentAccount.pools.find((item) => item.poolId === session.sessionId);
      if (!poolRecord || poolRecord.state === "funding-pending" || poolRecord.state === "funding-failed") return undefined;
      if (poolRecord.state === "closed") {
        const recovery = poolRecord.recoveryTxid
          ? currentAccount.transactions.find((item) => item.txid === poolRecord!.recoveryTxid)
          : undefined;
        if (recovery?.purpose !== "refund") return undefined;
        deps.assertCurrentContext();
        session = await deps.sessions.update(session.sessionId, session.revision, { phase: "refunded", pendingTxid: undefined }, deps.nowMs());
        const record = recovery ? await deps.transactions.getTransactionRecord(recovery.txid) : undefined;
        return { outcome: { status: "confirmed", txid: recovery!.txid, attempts: record?.attempts ?? 1 }, refunded: true };
      }

      let recoveryRaw = await deps.sessions.getEvidence(session.sessionId, "refund-transaction");
      let recoveryTxid: string | undefined;
      let constructedRefund = false;
      if (poolRecord.state === "recovery-pending") {
        recoveryTxid = poolRecord.recoveryTxid;
        const plan = recoveryTxid ? currentAccount.transactions.find((item) => item.txid === recoveryTxid) : undefined;
        if (plan?.purpose !== "refund" || !recoveryTxid) return undefined;
        const outboxRaw = await deps.transactions.getTransaction(recoveryTxid);
        if (!recoveryRaw) recoveryRaw = outboxRaw;
        if (!recoveryRaw || !outboxRaw || !equal(recoveryRaw, outboxRaw)) throw new Error("BitFS 到期退款账本与交易 outbox 原文不一致");
      } else {
        const observation = await deps.readPoolSpendChain(fundingTxid);
        if (observation.kind === "unknown" || observation.kind === "unchanged") return undefined;
        if (observation.kind === "spender") {
          const currentTxid = assertHash(observation.txid);
          if (assertHash(bitfsTxidHex(observation.rawTransaction)) !== currentTxid) {
            throw new Error("BitFS 当前池状态原文与节点 txid 不一致");
          }
          const currentState = await parsePaymentState(observation.rawTransaction, completedOpening.pool.opening);
          if (currentState.paymentSequence === 0xffff_ffff) {
            await verifyBuyerCompletedClose({ pool: completedOpening.pool, closeRaw: observation.rawTransaction });
          }
          return undefined;
        }
        try {
          const blockHeight = await deps.blockHeight();
          recoveryRaw = await buildBuyerMaturedRefund(bitfsWorkflowFacts(deps.nowMs(), blockHeight), completedOpening.pool);
        } catch (error) {
          if (error instanceof WireError && error.code === "not_matured") return undefined;
          throw error;
        }
        recoveryTxid = assertHash(bitfsTxidHex(recoveryRaw));
        constructedRefund = true;
        const parsed = deps.parseTransaction(toHex(recoveryRaw), recoveryTxid);
        if (parsed.canonicalTxid !== recoveryTxid || parsed.inputs.length !== 1
          || parsed.inputs[0] !== `${fundingTxid}:0`) {
          throw new Error("BitFS SDK 到期退款没有花费本费用池的开池输出");
        }
        const ownerOutputs = parsed.outputs.filter((output) => output.scriptHex.toLowerCase() === deps.ownerP2pkhScriptHex.toLowerCase());
        const otherPositiveOutputs = parsed.outputs.filter((output) => output.scriptHex.toLowerCase() !== deps.ownerP2pkhScriptHex.toLowerCase() && BigInt(output.valueSatoshis) > 0n);
        if (ownerOutputs.length === 0 || otherPositiveOutputs.length > 0) throw new Error("BitFS 到期退款输出没有全部退回当前买方 Key");
        const latestObservation = await deps.readPoolSpendChain(fundingTxid);
        if (latestObservation.kind !== "unspent") return undefined;
        const prior = await deps.sessions.getEvidence(session.sessionId, "refund-transaction");
        if (prior && !equal(prior, recoveryRaw)) throw new Error("BitFS 到期退款会话已固定另一笔退款交易");
        if (!prior) session = await saveExactEvidence(session, "refund-transaction", recoveryRaw);
        if (session.phase !== "refund-ready" || session.pendingTxid !== recoveryTxid) {
          deps.assertCurrentContext();
          session = await deps.sessions.update(session.sessionId, session.revision, { phase: "refund-ready", pendingTxid: recoveryTxid }, deps.nowMs());
        }
      }

      if (!recoveryRaw || !recoveryTxid) throw new Error("BitFS 到期退款缺少已保存的 exact 交易");
      const parsed = deps.parseTransaction(toHex(recoveryRaw), recoveryTxid);
      if (parsed.canonicalTxid !== recoveryTxid || parsed.inputs.length !== 1 || parsed.inputs[0] !== `${fundingTxid}:0`) {
        throw new Error("BitFS 待恢复退款交易与本费用池开池输出不一致");
      }
      const ownerOutputs = parsed.outputs
        .filter((output) => output.scriptHex.toLowerCase() === deps.ownerP2pkhScriptHex.toLowerCase() && BigInt(output.valueSatoshis) > 0n)
        .map((output) => ({ txid: recoveryTxid!, vout: output.vout, valueSatoshis: String(output.valueSatoshis), scriptHex: output.scriptHex.toLowerCase() }));
      if (ownerOutputs.length === 0 || parsed.outputs.some((output) => output.scriptHex.toLowerCase() !== deps.ownerP2pkhScriptHex.toLowerCase() && BigInt(output.valueSatoshis) > 0n)) {
        throw new Error("BitFS 待恢复退款交易没有把可退金额全部付回当前 Key");
      }
      if (constructedRefund) {
        const beforeSubmitObservation = await deps.readPoolSpendChain(fundingTxid);
        if (beforeSubmitObservation.kind !== "unspent") return undefined;
      }
      await deps.transactions.putTransaction(recoveryTxid, recoveryRaw, deps.nowMs());
      let account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
      poolRecord = account.pools.find((item) => item.poolId === session.sessionId);
      if (!poolRecord) throw new Error("BitFS 退款账本中找不到对应费用池");
      if (poolRecord.state === "open") {
        deps.assertCurrentContext();
        account = await deps.ledger.preparePoolRecovery({
          ownerPublicKeyHex: owner,
          seedHashHex: seed,
          network,
          expectedRevision: account.revision,
          poolId: session.sessionId,
          purpose: "refund",
          txid: recoveryTxid,
          spendingOutpoint: parsed.inputs[0]!,
          outputs: ownerOutputs,
          nowMs: deps.nowMs(),
        });
      }
      poolRecord = account.pools.find((item) => item.poolId === session.sessionId);
      const ledgerPlan = account.transactions.find((item) => item.txid === recoveryTxid && item.purpose === "refund");
      if (!poolRecord || poolRecord.state !== "recovery-pending" || poolRecord.recoveryTxid !== recoveryTxid
        || !ledgerPlan || !sameStrings(ledgerPlan.inputOutpoints, parsed.inputs) || !sameOutputs(ledgerPlan.expectedOutputs, ownerOutputs)) {
        throw new Error("BitFS 到期退款与专款账本恢复计划不一致");
      }
      const outboxRecord = await deps.transactions.getTransactionRecord(recoveryTxid);
      if (constructedRefund) {
        const beforeBroadcastObservation = await deps.readPoolSpendChain(fundingTxid);
        if (beforeBroadcastObservation.kind !== "unspent") return undefined;
      }
      deps.assertCurrentContext();
      let outcome = outboxRecord?.state === "result-unknown" || outboxRecord?.state === "confirmed"
        ? await deps.broadcaster.reconcile(recoveryTxid)
        : await deps.broadcaster.submit(recoveryRaw);
      if (outcome.status === "result-unknown" && outcome.retryable && outboxRecord
        && deps.nowMs() - Date.parse(outboxRecord.updatedAt) >= POOL_RECOVERY_RETRY_INTERVAL_MS) {
        outcome = await deps.broadcaster.retry(recoveryTxid);
      }
      deps.assertCurrentContext();
      if (outcome.status === "confirmed") {
        await deps.ledger.observePoolRecovery({
          ownerPublicKeyHex: owner,
          seedHashHex: seed,
          network,
          poolId: session.sessionId,
          actualInputs: parsed.inputs,
          actualOutputs: ownerOutputs,
          nowMs: deps.nowMs(),
        });
        const latest = await deps.sessions.get(session.sessionId);
        if (latest && latest.phase !== "refunded") {
          await deps.sessions.update(latest.sessionId, latest.revision, { phase: "refunded", pendingTxid: undefined }, deps.nowMs());
        }
        return { outcome, refunded: true };
      }
      if (outcome.status === "result-unknown" && ledgerPlan.state === "prepared") {
        const latestAccount = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const currentPlan = latestAccount.transactions.find((item) => item.txid === recoveryTxid && item.purpose === "refund");
        if (currentPlan?.state === "prepared") {
          await deps.ledger.markTransactionUnknown({ ownerPublicKeyHex: owner, seedHashHex: seed, network, txid: recoveryTxid, nowMs: deps.nowMs() });
        }
      }
      const latest = await deps.sessions.get(session.sessionId);
      if (latest && latest.phase !== "refund-unknown") {
        await deps.sessions.update(latest.sessionId, latest.revision, { phase: "refund-unknown", pendingTxid: recoveryTxid }, deps.nowMs());
      }
      return { outcome, refunded: false };
    },

    async resumePoolRecovery(sessionId) {
      let session = await readSession(sessionId);
      const responseRaw = await deps.sessions.getEvidence(session.sessionId, "kind13-close-response");
      if (!responseRaw) return undefined;
      if (!session.evidence.includes("kind13-close-response")) {
        session = await deps.sessions.putEvidence(session.sessionId, session.revision, "kind13-close-response", responseRaw, deps.nowMs());
      }
      // 双方签名和完整响应已持久化；恢复时只按 txid 观察卖方广播的交易。
      return task.submitOrReconcilePoolRecovery(sessionId);
    },
  };
  return task;
}

function toQuoteView(sessionId: string, seedHashHex: string, quote: VerifiedQuote): BitfsBuyerQuoteView {
  return {
    sessionId,
    seedHashHex,
    fileSizeBytes: quote.terms.fileSizeBytes.toString(10),
    sellerPublicKeyHex: bytesToHex(quote.sellerPublicKey),
    seedPriceSatoshis: quote.terms.seedPriceSatoshis.toString(10),
    fullBlockPriceSatoshis: quote.terms.fullBlockPriceSatoshis.toString(10),
    quoteExpiresAtUnixSeconds: quote.terms.quoteExpiresAtUnixSeconds.toString(10),
    recommendedFilename: quote.terms.recommendedFilename,
    supportedArbiterPublicKeys: quote.terms.supportedArbiterPublicKeys.map(bytesToHex),
  };
}

function assertSessionId(value: string): string {
  if (!/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(value)) throw new TypeError("BitFS 买方 session ID 无效");
  return value;
}
function assertMessageId(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new TypeError("ChannelProtocol message_id 无效");
  return value;
}
function assertPublicKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/u.test(normalized)) throw new TypeError("BitFS 买方公钥必须为 66 位压缩公钥 hex");
  return normalized;
}
function assertHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new TypeError("BitFS 买方 Seed Hash 必须为 64 位 hex");
  return normalized;
}
function assertOpeningAmount(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new TypeError("BitFS 开池金额必须为正整数聪字符串");
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("BitFS 开池金额超过安全整数范围");
  return amount.toString(10);
}
function assertNetwork(value: BsvNetwork): BsvNetwork {
  if (value !== "main" && value !== "test") throw new TypeError("BitFS 买方网络无效");
  return value;
}
function hexToBytes(value: string): Uint8Array {
  const normalized = value.toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/u.test(normalized)) throw new TypeError("BitFS 字节 hex 无效");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
function bytesToHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function toHex(value: Uint8Array): string { return bytesToHex(value); }
function equal(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameOutputs(
  left: readonly { txid: string; vout: number; valueSatoshis: string; scriptHex: string }[],
  right: readonly { txid: string; vout: number; valueSatoshis: string; scriptHex: string }[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const actual = right[index];
    return actual !== undefined && value.txid === actual.txid && value.vout === actual.vout
      && value.valueSatoshis === actual.valueSatoshis && value.scriptHex.toLowerCase() === actual.scriptHex.toLowerCase();
  });
}
