import { describe, expect, it, vi } from "vitest";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createJournaledBitfsBuyerSigner } from "./signerJournal.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";

const BUYER = `03${"22".repeat(32)}`;
const SELLER = `02${"11".repeat(32)}`;

describe("BitFS 买方签名 journal", () => {
  it("会话 CAS 冲突时重试证据落钉且只调用一次签名器", async () => {
    const journal = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    await journal.create({
      sessionId: "buyer-signer-retry",
      role: "buyer",
      ownerPublicKeyHex: BUYER,
      counterpartyPublicKeyHex: SELLER,
      seedHashHex: "aa".repeat(32),
      generation: 1,
      phase: "request-prepared",
    }, 1_000);
    let conflictOnce = true;
    const sessions = {
      ...journal,
      async putEvidence(sessionId: string, expectedRevision: number, name: Parameters<typeof journal.putEvidence>[2], bytes: Uint8Array, nowMs: number) {
        if (conflictOnce) {
          conflictOnce = false;
          await journal.update(sessionId, expectedRevision, { phase: "funded" }, nowMs);
        }
        return journal.putEvidence(sessionId, expectedRevision, name, bytes, nowMs);
      },
    };
    const authorizationIdHex = "ab".repeat(32);
    const sign = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const signer = createJournaledBitfsBuyerSigner({
      sessions,
      sessionId: "buyer-signer-retry",
      signer: { publicKey: () => new Uint8Array(33).fill(2), sign },
      family: "kind7-payment",
      authorizationIdHex,
      assertCurrentContext: () => undefined,
      nowMs: () => 2_000,
    });
    const result = await signer.sign({ purpose: "transaction", wireKind: 0, digest: new Uint8Array(32).fill(7) });
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(sign).toHaveBeenCalledTimes(1);
    await expect(journal.getEvidence("buyer-signer-retry", `kind7-payment-sign-digest-${authorizationIdHex}`)).resolves.toEqual(new Uint8Array(32).fill(7));
    await expect(journal.getEvidence("buyer-signer-retry", `kind7-payment-signature-${authorizationIdHex}`)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
