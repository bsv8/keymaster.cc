import { describe, expect, it } from "vitest";
import { LockingScript, Transaction, UnlockingScript } from "@bsv/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MultisigPoolEngine,
  acceptBuyerQuote,
  buildPaymentUpdate,
  buildRefundSubmission,
  completeBuyerOpening,
  completeSellerCloseArtifact,
  deriveOpeningDetails,
  deriveRefundTemplateTxID,
  createContentRequest,
  createSellerQuote,
  encodePaymentUpdate,
  inspectBuyerContentRequest,
  prepareBuyerClose,
  prepareBuyerCloseArtifact,
  prepareBuyerOpening,
  prepareBuyerFundingDelivery,
  prepareSellerPresign,
  verifyBuyerCompletedCloseArtifact,
  parsePaymentState,
  type Signer,
} from "go-bitfs";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import {
  assertBitfsBuyerCloseBinding,
  readBitfsBuyerLocalPaymentState,
} from "./buyerPoolState.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";
import { BitfsTransactionBroadcaster } from "./broadcast.js";
import { BitfsSellerProtocol } from "./sellerProtocol.js";

function signer(value: number): Signer {
  const secret = new Uint8Array(32);
  secret[31] = value;
  return {
    publicKey: () => secp256k1.getPublicKey(secret, true),
    async sign(request) { return secp256k1.sign(request.digest, secret, { prehash: false, lowS: true, format: "der" }); },
  };
}

function bytes(value: string): Uint8Array { return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16)); }
function hex(value: Uint8Array): string { return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join(""); }

async function fixture() {
  const buyer = signer(1);
  const seller = signer(2);
  const arbiter = signer(3);
  const now = 1_790_000_000n;
  const quote = await createSellerQuote({ nowUnixSeconds: now }, seller, {
    seedHash: new Uint8Array(32).fill(11),
    buyerPublicKey: buyer.publicKey(),
    seedPriceSatoshis: 1n,
    fullBlockPriceSatoshis: 1n,
    fileSizeBytes: 1n,
    quoteExpiresAtUnixSeconds: now + 3600n,
    supportedArbiterPublicKeys: [arbiter.publicKey()],
    recommendedFilename: "test.bin",
  });
  const engine = new MultisigPoolEngine({
    buyerPublicKey: buyer.publicKey(),
    sellerPublicKey: seller.publicKey(),
    arbiterPublicKey: arbiter.publicKey(),
  });
  const funding = new Transaction();
  funding.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() });
  funding.addOutput({ satoshis: 10_000, lockingScript: LockingScript.fromHex(hex(engine.lockingScript())) });
  const prepared = await prepareBuyerOpening({
    quoteRaw: quote.outbound.bytes(),
    fundingTransactionRaw: bytes(funding.toHex()),
    expiryLockTime: Number(now + 30n * 86400n),
    minerFeeRateSatoshisPerKilobyte: 100n,
    sellerPublicKey: seller.publicKey(),
    arbiterPublicKey: arbiter.publicKey(),
  }, buyer);
  const presigned = await prepareSellerPresign(prepared.outbound.bytes(), seller);
  const completed = await completeBuyerOpening(prepared.opening, presigned.outbound.bytes());
  const request = await createContentRequest(buyer, {
    fileQuoteTermsID: acceptBuyerQuote({ nowUnixSeconds: now }, quote.outbound.bytes()).termsID,
    refundTemplateTxID: await deriveRefundTemplateTxID(completed.pool.opening),
    paymentSequence: 3,
    sellerAmountAfterSatoshis: 1n,
    contentHashes: [new Uint8Array(32).fill(11)],
    deliveryDeadlineUnixSeconds: now + 60n,
  });
  const summary = await inspectBuyerContentRequest({ nowUnixSeconds: now }, {
    quoteRaw: quote.outbound.bytes(),
    pool: completed.pool,
    requestRaw: request.bytes(),
  });
  const initial = await buildRefundSubmission(completed.pool.opening);
  const initialState = await parsePaymentState(initial, completed.pool.opening);
  const firstUnsigned = await buildPaymentUpdate(completed.pool.opening, initialState, 3, 1n);
  const details = await deriveOpeningDetails(completed.pool.opening);
  const buyerSignature = await engine.signRole(buyer, "buyer", firstUnsigned, details.poolOutputSatoshis);
  const sellerSignature = await engine.signRole(seller, "seller", firstUnsigned, details.poolOutputSatoshis);
  const completePayment = engine.mergeBuyerSeller(firstUnsigned, Number(details.poolOutputSatoshis), buyerSignature, sellerSignature);
  const kind7 = encodePaymentUpdate(summary.paymentAuthorizationID, buyerSignature);
  const authorizationIdHex = hex(summary.paymentAuthorizationID);
  const sessions = createBitfsSessionJournal(createInMemoryOwnerFileStore());
  const record = await sessions.create({
    sessionId: "buyer-state",
    role: "buyer",
    ownerPublicKeyHex: hex(buyer.publicKey()),
    counterpartyPublicKeyHex: hex(seller.publicKey()),
    seedHashHex: "11".repeat(32),
    generation: 1,
    phase: "funded",
  }, 1_000);
  let current = await sessions.putEvidence(record.sessionId, record.revision, `kind5-content-request-${authorizationIdHex}`, request.bytes(), 1_000);
  current = await sessions.putEvidence(current.sessionId, current.revision, `kind7-payment-update-${authorizationIdHex}`, kind7.bytes(), 1_000);
  return { buyer, seller, engine, now, quote, completed, initial, request, kind7, authorizationIdHex, sessions, current, completePayment, details };
}

describe("BitFS 买方本地状态与关池绑定", () => {
  it("无 latest-payment-transaction 时从 Kind 5/7 恢复并拒绝旧状态关池", async () => {
    const state = await fixture();
    const restored = await readBitfsBuyerLocalPaymentState({
      sessions: state.sessions,
      session: state.current,
      completedOpening: state.completed.pool,
      includeLegacyPaymentEvidence: true,
    });
    expect(restored).toMatchObject({ source: "local", paymentSequence: 3, authorizationIdHex: state.authorizationIdHex });
    expect(restored.sellerAmountSatoshis).toBe(1n);

    const close = await prepareBuyerClose({ nowUnixSeconds: state.now }, {
      pool: restored.pool,
      targetSellerAmountSatoshis: 1n,
    }, state.buyer);
    const sellerSignature = await state.engine.signRole(state.seller, "seller", close.unsignedRaw, state.details.poolOutputSatoshis);
    const closeRaw = state.engine.mergeBuyerSeller(close.unsignedRaw, Number(state.details.poolOutputSatoshis), close.buyerSignature, sellerSignature);
    await expect(assertBitfsBuyerCloseBinding({
      pool: restored.pool,
      closeTransactionRaw: closeRaw,
      paymentSequence: restored.paymentSequence,
      sellerAmountSatoshis: restored.sellerAmountSatoshis,
    })).resolves.toBeUndefined();

    const staleClose = await prepareBuyerClose({ nowUnixSeconds: state.now }, {
      pool: state.completed.pool,
      targetSellerAmountSatoshis: 0n,
    }, state.buyer);
    const staleSellerSignature = await state.engine.signRole(state.seller, "seller", staleClose.unsignedRaw, state.details.poolOutputSatoshis);
    const staleRaw = state.engine.mergeBuyerSeller(staleClose.unsignedRaw, Number(state.details.poolOutputSatoshis), staleClose.buyerSignature, staleSellerSignature);
    await expect(assertBitfsBuyerCloseBinding({
      pool: restored.pool,
      closeTransactionRaw: staleRaw,
      paymentSequence: restored.paymentSequence,
      sellerAmountSatoshis: restored.sellerAmountSatoshis,
    })).rejects.toThrow(/Kind 5\/7/u);
  });

  it("拒绝金额相同但由旧 Kind 5/7 状态构造的 Kind 13", async () => {
    const state = await fixture();
    const first = await readBitfsBuyerLocalPaymentState({
      sessions: state.sessions,
      session: state.current,
      completedOpening: state.completed.pool,
    });
    const secondRequest = await createContentRequest(state.buyer, {
      fileQuoteTermsID: acceptBuyerQuote({ nowUnixSeconds: state.now }, state.quote.outbound.bytes()).termsID,
      refundTemplateTxID: await deriveRefundTemplateTxID(state.completed.pool.opening),
      paymentSequence: 4,
      sellerAmountAfterSatoshis: 1n,
      contentHashes: [new Uint8Array(32).fill(11)],
      deliveryDeadlineUnixSeconds: state.now + 60n,
    });
    const secondSummary = await inspectBuyerContentRequest({ nowUnixSeconds: state.now }, {
      quoteRaw: state.quote.outbound.bytes(),
      pool: first.pool,
      requestRaw: secondRequest.bytes(),
    });
    const secondUnsigned = await buildPaymentUpdate(
      state.completed.pool.opening,
      await parsePaymentState(state.completePayment, state.completed.pool.opening),
      4,
      1n,
    );
    const secondBuyerSignature = await state.engine.signRole(state.buyer, "buyer", secondUnsigned, state.details.poolOutputSatoshis);
    const secondKind7 = encodePaymentUpdate(secondSummary.paymentAuthorizationID, secondBuyerSignature);
    const secondId = hex(secondSummary.paymentAuthorizationID);
    let record = await state.sessions.get(state.current.sessionId);
    record = await state.sessions.putEvidence(record!.sessionId, record!.revision, `kind5-content-request-${secondId}`, secondRequest.bytes(), 2_000);
    await state.sessions.putEvidence(record.sessionId, record.revision, `kind7-payment-update-${secondId}`, secondKind7.bytes(), 2_000);
    const latestRecord = await state.sessions.get(state.current.sessionId);
    const latest = await readBitfsBuyerLocalPaymentState({
      sessions: state.sessions,
      session: latestRecord!,
      completedOpening: state.completed.pool,
    });
    const staleKind12 = await prepareBuyerCloseArtifact({ nowUnixSeconds: state.now }, {
      pool: first.pool,
      targetSellerAmountSatoshis: 1n,
    }, state.buyer);
    const staleResponse = await completeSellerCloseArtifact({ nowUnixSeconds: state.now }, {
      pool: { ...state.completed.pool, fundingTransactionRaw: state.completed.opening.fundingTransactionRaw, latestPaymentRawTx: state.completePayment },
      requestRaw: staleKind12.bytes(),
    }, state.seller);
    const staleCloseRaw = await verifyBuyerCompletedCloseArtifact({ pool: latest.pool, responseRaw: staleResponse.bytes(), requestRaw: staleKind12.bytes() });
    await expect(assertBitfsBuyerCloseBinding({
      pool: latest.pool,
      closeTransactionRaw: staleCloseRaw,
      paymentSequence: first.paymentSequence,
      sellerAmountSatoshis: first.sellerAmountSatoshis,
    })).rejects.toThrow(/Kind 5\/7/u);
  });

  it("卖方拒绝重复付款序号，不能用最大序号掩盖日志断层", async () => {
    const state = await fixture();
    const sellerSessions = state.sessions;
    const sellerId = "seller-payment-history";
    const seller = state.seller;
    const buyer = state.buyer;
    let record = await sellerSessions.create({
      sessionId: sellerId,
      role: "seller",
      ownerPublicKeyHex: hex(seller.publicKey()),
      counterpartyPublicKeyHex: hex(buyer.publicKey()),
      seedHashHex: "11".repeat(32),
      generation: 1,
      phase: "funded",
    }, 1_000);
    const kind4 = await prepareBuyerFundingDelivery(state.completed.pool);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, "kind1-quote", state.quote.outbound.bytes(), 1_000);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, "kind2-opening-request", state.completed.opening.rawKind2, 1_000);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, "kind3-opening-response", state.completed.opening.rawKind3, 1_000);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, "kind4-funding-delivery", kind4.bytes(), 1_000);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, "funding-transaction", state.completed.opening.fundingTransactionRaw, 1_000);
    const requestId = "11".repeat(32);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, `kind5-content-request-${requestId}`, state.request.bytes(), 1_000);
    record = await sellerSessions.putEvidence(record.sessionId, record.revision, `latest-payment-transaction-${requestId}`, state.completePayment, 1_000);
    await sellerSessions.putEvidence(record.sessionId, record.revision, `latest-payment-transaction-${"22".repeat(32)}`, state.completePayment, 1_000);
    const protocol = new BitfsSellerProtocol({
      signer: seller,
      sessions: sellerSessions,
      content: { ready: true, async resolve() { throw new Error("content must not be read"); } },
      broadcaster: {} as BitfsTransactionBroadcaster,
      ownerPublicKeyHex: hex(seller.publicKey()),
      generation: () => 1,
      nowMs: () => 2_000,
      blockHeight: async () => 900_000,
    });
    await expect(protocol.onFrame({ sessionId: sellerId, kind: 5, bytes: state.request.bytes() })).rejects.toThrow(/序号不连续/u);
  });

  it("兼容旧会话的完整付款交易证据，但不把它作为新流程唯一来源", async () => {
    const state = await fixture();
    await state.sessions.putEvidence(state.current.sessionId, state.current.revision, `latest-payment-transaction-${state.authorizationIdHex}`, state.completePayment, 2_000);
    const latest = await state.sessions.get(state.current.sessionId);
    const restored = await readBitfsBuyerLocalPaymentState({
      sessions: state.sessions,
      session: latest!,
      completedOpening: state.completed.pool,
      includeLegacyPaymentEvidence: true,
    });
    expect(restored.source).toBe("local");
    expect(restored.paymentSequence).toBe(3);
  });
});
