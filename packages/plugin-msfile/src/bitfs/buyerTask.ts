// BitFS 买方需求、报价发现与开池任务的本地编排。
//
// 中文说明：需求发布和报价发现通过 Coordinator 注入的 ChannelProtocol
// 端口完成；本模块保存已验签 Kind 1。当前开池仍必须由明确的后续买方操作
// 触发，需求和报价阶段不会拆分或广播资金。

import type { BsvNetwork } from "@keymaster/contracts";
import {
  acceptBuyerQuote,
  completeBuyerOpening,
  prepareBuyerFundingDelivery,
  prepareBuyerOpening,
  type BuyerOpeningEvidence,
  type BuyerPoolEvidence,
  type Signer,
  type VerifiedQuote,
} from "go-bitfs";
import type { BitfsFundingLedger, BitfsFundingTransactionView, PreparedBitfsFunding } from "./funding.js";
import type { BitfsBroadcastOutcome, BitfsTransactionBroadcaster, BitfsTransactionJournal } from "./broadcast.js";
import { bitfsWorkflowFacts, deriveBitfsPoolLockingScript } from "./sdk.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";

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
}

/** ChannelProtocol Hash 请求允许的最长有效期；单位毫秒。 */
const HASH_REQUEST_LIFETIME_MS = 10 * 60 * 1_000;

/** 已验证报价的简要视图；金额均为十进制聪字符串。 */
export interface BitfsBuyerQuoteView {
  /** 买方会话编号。 */
  sessionId: string;
  /** 固定报价对应的 Seed Hash。 */
  seedHashHex: string;
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
  /** 从报价和三方公钥推导池脚本，准备并保护 FundingTx，再持久化 exact Kind 2。 */
  prepareOpening(input: BitfsBuyerOpeningInput): Promise<Uint8Array>;
  /** 验证 exact Kind 3 并持久化；返回已验证的池证据。 */
  acceptOpeningResponse(input: { sessionId: string; rawKind3: Uint8Array }): Promise<BuyerPoolEvidence>;
  /** 首次提交 FundingTx，或只按 txid 对账未知结果；资金观察后返回 exact Kind 4。 */
  submitOrReconcileFunding(sessionId: string): Promise<{ outcome: BitfsBroadcastOutcome; kind4?: Uint8Array }>;
}

/** 创建固定 Key + Seed + 网络上下文的单报价买方任务。 */
export function createBitfsBuyerTask(deps: BitfsBuyerTaskDeps): BitfsBuyerTask {
  const owner = assertPublicKey(deps.ownerPublicKeyHex);
  const seed = assertHash(deps.seedHashHex);
  const network = assertNetwork(deps.network);
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
      return toQuoteView(sessionId, seed, quote);
  };

  return {
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
        const { quote } = await readQuote(session);
        quotes.push(toQuoteView(session.sessionId, seed, quote));
      }
      return quotes;
    },

    acceptQuote,

    async resume(sessionId) {
      return readSession(sessionId);
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

      const prepared = await prepareBuyerOpening({
        quoteRaw,
        fundingTransactionRaw: funding.rawTransaction,
        expiryLockTime: input.expiryLockTime,
        minerFeeRateSatoshisPerKilobyte: input.minerFeeRateSatoshisPerKilobyte,
        sellerPublicKey: hexToBytes(session.counterpartyPublicKeyHex),
        arbiterPublicKey: arbiter,
      }, deps.signer);
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
  };
}

function toQuoteView(sessionId: string, seedHashHex: string, quote: VerifiedQuote): BitfsBuyerQuoteView {
  return {
    sessionId,
    seedHashHex,
    sellerPublicKeyHex: bytesToHex(quote.sellerPublicKey),
    seedPriceSatoshis: quote.terms.seedPriceSatoshis.toString(10),
    fullBlockPriceSatoshis: quote.terms.fullBlockPriceSatoshis.toString(10),
    quoteExpiresAtUnixSeconds: quote.terms.quoteExpiresAtUnixSeconds.toString(10),
    recommendedFilename: quote.terms.recommendedFilename,
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
