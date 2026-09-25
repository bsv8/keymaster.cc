import { describe, expect, it, vi } from "vitest";
import { LockingScript, Transaction, UnlockingScript } from "@bsv/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MultisigPoolEngine,
  buildRefundSubmission,
  completeBuyerOpening,
  createSellerQuote,
  prepareBuyerOpening,
  prepareSellerPresign,
  type Signer,
} from "go-bitfs";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsBuyerTask } from "./buyerTask.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";
import { bitfsTxidHex } from "./txid.js";

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
    seedHash: new Uint8Array(32).fill(11), buyerPublicKey: buyer.publicKey(), seedPriceSatoshis: 1n,
    fullBlockPriceSatoshis: 1n, fileSizeBytes: 1n, quoteExpiresAtUnixSeconds: now + 3600n,
    supportedArbiterPublicKeys: [arbiter.publicKey()], recommendedFilename: "refund.bin",
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
  const completed = await completeBuyerOpening(prepared.opening, presigned.outbound.bytes());
  const rawKind2 = prepared.opening.rawKind2;
  const rawKind3 = presigned.outbound.bytes();
  const initial = await buildRefundSubmission(completed.pool.opening);
  const sessions = createBitfsSessionJournal(createInMemoryOwnerFileStore());
  let record = await sessions.create({
    sessionId: "refund-guard", role: "buyer", ownerPublicKeyHex: hex(buyer.publicKey()),
    counterpartyPublicKeyHex: hex(seller.publicKey()), seedHashHex: "11".repeat(32), generation: 1, phase: "funded",
  }, 1_000);
  record = await sessions.putEvidence(record.sessionId, record.revision, "kind1-quote", quote.outbound.bytes(), 1_000);
  record = await sessions.putEvidence(record.sessionId, record.revision, "kind2-opening-request", rawKind2, 1_000);
  record = await sessions.putEvidence(record.sessionId, record.revision, "kind3-opening-response", rawKind3, 1_000);
  record = await sessions.putEvidence(record.sessionId, record.revision, "funding-transaction", completed.opening.fundingTransactionRaw, 1_000);
  return { buyer, completed, initial, rawKind2: prepared.opening.rawKind2, rawKind3: presigned.outbound.bytes(), sessions, record };
}

describe("BitFS 到期退款池状态门禁", () => {
  it("未知或非最终 spender 都不会构造退款", async () => {
    const state = await fixture();
    const fundingTxid = bitfsTxidHex(state.completed.opening.fundingTransactionRaw);
    const account = {
      revision: 1,
      utxos: [],
      transactions: [],
      pools: [{ poolId: state.record.sessionId, fundingTxid, openingOutpoint: `${fundingTxid}:0`, inputOutpoints: [], state: "open" }],
    };
    const readPoolSpendChain = vi.fn()
      .mockResolvedValueOnce({ kind: "unknown", reason: "spender_raw_unavailable" })
      .mockResolvedValueOnce({ kind: "spender", txid: bitfsTxidHex(state.initial), rawTransaction: state.initial, status: "confirmed" });
    const task = createBitfsBuyerTask({
      sessions: state.sessions,
      ledger: { getAccount: vi.fn(async () => account) } as never,
      transactions: { getTransaction: vi.fn(async () => undefined), getTransactionRecord: vi.fn(async () => undefined), putTransaction: vi.fn(async () => undefined) } as never,
      broadcaster: {} as never,
      signer: state.buyer,
      prepareFunding: vi.fn(),
      releasePreparedSubmission: vi.fn(async () => undefined),
      ownerPublicKeyHex: hex(state.buyer.publicKey()),
      ownerP2pkhScriptHex: `76a914${"00".repeat(20)}88ac`,
      seedHashHex: "11".repeat(32),
      network: "test",
      generation: 1,
      parseTransaction: vi.fn(),
      assertCurrentContext: vi.fn(),
      nowMs: () => 2_000,
      blockHeight: async () => 900_000,
      readPoolSpendChain,
    });
    await expect(task.recoverMaturedRefund(state.record.sessionId)).resolves.toBeUndefined();
    await expect(state.sessions.getEvidence(state.record.sessionId, "refund-transaction")).resolves.toBeUndefined();
    await expect(state.sessions.get(state.record.sessionId)).resolves.toMatchObject({ phase: "funded" });
    await expect(task.recoverMaturedRefund(state.record.sessionId)).resolves.toBeUndefined();
    expect(readPoolSpendChain).toHaveBeenCalledTimes(2);
  });
});
