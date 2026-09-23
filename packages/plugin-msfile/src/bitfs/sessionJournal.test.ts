import { describe, expect, it } from "vitest";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";

const SELLER = `02${"11".repeat(32)}`;
const BUYER = `03${"22".repeat(32)}`;

describe("BitFS 会话 journal", () => {
  it("以 revision 串行推进阶段并可分页恢复", async () => {
    const journal = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    const created = await journal.create({
      sessionId: "seller-001",
      role: "seller",
      ownerPublicKeyHex: SELLER,
      counterpartyPublicKeyHex: BUYER,
      seedHashHex: "aa".repeat(32),
      generation: 7,
      phase: "quoted",
    }, 1_000);
    expect(created).toMatchObject({ revision: 1, phase: "quoted", evidence: [] });

    const next = await journal.update("seller-001", 1, { phase: "opening-presigned" }, 2_000);
    expect(next.revision).toBe(2);
    await expect(journal.update("seller-001", 1, { phase: "failed" }, 3_000)).rejects.toThrow(/修订冲突/u);
    await expect(journal.list()).resolves.toEqual([expect.objectContaining({ sessionId: "seller-001", revision: 2 })]);
  });

  it("证据必须先可靠回读，同名不得覆盖不同 exact bytes", async () => {
    const journal = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    await journal.create({
      sessionId: "seller-002",
      role: "seller",
      ownerPublicKeyHex: SELLER,
      counterpartyPublicKeyHex: BUYER,
      seedHashHex: "bb".repeat(32),
      generation: 1,
      phase: "quoted",
    }, 1_000);
    const bytes = new Uint8Array([1, 2, 3]);
    const saved = await journal.putEvidence("seller-002", 1, "kind1-quote", bytes, 2_000);
    bytes[0] = 9;
    expect(saved).toMatchObject({ revision: 2, evidence: ["kind1-quote"] });
    await expect(journal.getEvidence("seller-002", "kind1-quote")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(journal.putEvidence("seller-002", 2, "kind1-quote", new Uint8Array([4]), 3_000)).rejects.toThrow(/exact bytes/u);
  });
});
