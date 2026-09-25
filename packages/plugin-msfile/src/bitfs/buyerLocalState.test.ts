import { describe, expect, it } from "vitest";
import { LockingScript, Transaction, UnlockingScript } from "@bsv/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MultisigPoolEngine, acceptBuyerQuote, buildPaymentUpdate, buildRefundSubmission,
  completeBuyerOpening, createContentRequest, createSellerQuote, deriveOpeningDetails,
  encodePaymentUpdate, inspectBuyerContentRequest, inspectBuyerPool, parsePaymentState,
  prepareBuyerClose, prepareBuyerOpening, prepareSellerPresign,
  type Signer,
} from "go-bitfs";

function signer(value: number): Signer {
  const secret = new Uint8Array(32);
  secret[31] = value;
  return {
    publicKey: () => secp256k1.getPublicKey(secret, true),
    async sign(request) { return secp256k1.sign(request.digest, secret, { prehash: false, lowS: true, format: "der" }); },
  };
}

function bytes(hex: string): Uint8Array { return Uint8Array.from(hex.match(/../gu) ?? [], (part) => Number.parseInt(part, 16)); }
function hex(value: Uint8Array): string { return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join(""); }

describe("BitFS 买方本地递进状态", () => {
  it("由 Kind 5/7 重建与卖方双签完全相同的下一候选和最终关池", async () => {
    const buyer = signer(1);
    const seller = signer(2);
    const arbiter = signer(3);
    const now = 1_790_000_000n;
    const quote = await createSellerQuote({ nowUnixSeconds: now }, seller, {
      seedHash: new Uint8Array(32).fill(11), buyerPublicKey: buyer.publicKey(),
      seedPriceSatoshis: 1n, fullBlockPriceSatoshis: 1n, fileSizeBytes: 1n,
      quoteExpiresAtUnixSeconds: now + 3600n, supportedArbiterPublicKeys: [arbiter.publicKey()],
      recommendedFilename: "test.bin",
    });
    const engine = new MultisigPoolEngine({ buyerPublicKey: buyer.publicKey(), sellerPublicKey: seller.publicKey(), arbiterPublicKey: arbiter.publicKey() });
    const funding = new Transaction();
    funding.addInput({ sourceTXID: "11".repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new UnlockingScript() });
    funding.addOutput({ satoshis: 10_000, lockingScript: LockingScript.fromHex(hex(engine.lockingScript())) });
    const prepared = await prepareBuyerOpening({
      quoteRaw: quote.outbound.bytes(), fundingTransactionRaw: bytes(funding.toHex()),
      expiryLockTime: Number(now + 30n * 86400n), minerFeeRateSatoshisPerKilobyte: 100n,
      sellerPublicKey: seller.publicKey(), arbiterPublicKey: arbiter.publicKey(),
    }, buyer);
    const presigned = await prepareSellerPresign(prepared.outbound.bytes(), seller);
    const { pool } = await completeBuyerOpening(prepared.opening, presigned.outbound.bytes());
    const details = await deriveOpeningDetails(pool.opening);
    const firstRequest = await createContentRequest(buyer, {
      fileQuoteTermsID: acceptBuyerQuote({ nowUnixSeconds: now }, quote.outbound.bytes()).termsID,
      refundTemplateTxID: details.refundTemplateTxId, paymentSequence: 3,
      sellerAmountAfterSatoshis: 1n, contentHashes: [new Uint8Array(32).fill(11)],
      deliveryDeadlineUnixSeconds: now + 60n,
    });
    const summary = await inspectBuyerContentRequest({ nowUnixSeconds: now }, {
      quoteRaw: quote.outbound.bytes(), pool, requestRaw: firstRequest.bytes(),
    });
    const initialRaw = await buildRefundSubmission(pool.opening);
    const initial = await parsePaymentState(initialRaw, pool.opening);
    const firstUnsigned = await buildPaymentUpdate(pool.opening, initial, 3, 1n);
    const buyerSignature = await engine.signRole(buyer, "buyer", firstUnsigned, details.poolOutputSatoshis);
    const sellerSignature = await engine.signRole(seller, "seller", firstUnsigned, details.poolOutputSatoshis);
    const firstComplete = engine.mergeBuyerSeller(firstUnsigned, Number(details.poolOutputSatoshis), buyerSignature, sellerSignature);
    const firstUpdate = encodePaymentUpdate(summary.paymentAuthorizationID, buyerSignature);
    const localPool = { ...pool, latestBuyerPayment: { rawKind5: firstRequest.bytes(), rawKind7: firstUpdate.bytes() } };
    await expect(inspectBuyerPool(localPool)).resolves.toEqual({ paymentSequence: 3, sellerAmountSatoshis: 1n });
    const localNext = await engine.buildState({
      previousRaw: firstUnsigned, paymentSequence: 4, sellerAmountSatoshis: 2,
      poolOutputSatoshis: Number(details.poolOutputSatoshis), minerFeeRateSatoshisPerKilobyte: 100, lockTime: 0,
    });
    const sellerNext = await buildPaymentUpdate(pool.opening, await parsePaymentState(firstComplete, pool.opening), 4, 2n);
    expect(localNext).toEqual(sellerNext);
    const localClose = await prepareBuyerClose({ nowUnixSeconds: now }, { pool: localPool, targetSellerAmountSatoshis: 1n }, buyer);
    const signedClose = await prepareBuyerClose({ nowUnixSeconds: now }, { pool: { ...pool, latestPaymentRawTx: firstComplete }, targetSellerAmountSatoshis: 1n }, buyer);
    expect(localClose.unsignedRaw).toEqual(signedClose.unsignedRaw);
    expect(localClose.buyerSignature).toEqual(signedClose.buyerSignature);
  });
});
