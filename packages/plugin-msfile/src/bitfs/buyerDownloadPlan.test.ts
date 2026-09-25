import { expect, it } from "vitest";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsBuyerDownloadPlan } from "./buyerDownloadPlan.js";

it("连续 Block 付款按整数累加且重放不会重复扣款", async () => {
  const plan = createBitfsBuyerDownloadPlan({
    ownerPublicKeyHex: `02${"11".repeat(32)}`, seedHashHex: "22".repeat(32),
    fileSizeBytes: "786432", recommendedFilename: "three-blocks.bin", store: createInMemoryOwnerFileStore(),
  });
  await plan.registerPool({
    sessionId: "pool-1", sellerPublicKeyHex: `03${"33".repeat(32)}`,
    seedPriceSatoshis: "1", fullBlockPriceSatoshis: "1", contentBudgetSatoshis: "4",
    seedBudgetSatoshis: "1", seedBudgetReserved: true, blockBudgetSatoshis: "3", recentBytesPerSecond: null,
  });
  await plan.activatePool("pool-1");
  expect(await plan.claimSeed("pool-1", "price")).toBe("assigned");
  await plan.completeSeed("pool-1", "1");
  await plan.completeSeed("pool-1", "1");
  const hashes = ["44", "55", "66"].map(byte => byte.repeat(32));
  await plan.setBlockHashes(hashes);
  for (const hash of hashes) {
    expect(await plan.claimNextBlock("pool-1", "price")).toBe(hash);
    await plan.completeBlock("pool-1", hash, "1");
    await plan.completeBlock("pool-1", hash, "1");
  }
  expect(await plan.snapshot()).toMatchObject({
    completedBlockCount: 3, seedCompleted: true,
    pools: [{ seedCommittedSatoshis: "1", blockCommittedSatoshis: "3", committedSatoshis: "4" }],
  });
  expect(await plan.claimNextBlock("pool-1", "price")).toBeUndefined();
});

it("多个卖家原子认领不同批次，整批付款幂等，关池释放未付款批次", async () => {
  const plan = createBitfsBuyerDownloadPlan({
    ownerPublicKeyHex: `02${"11".repeat(32)}`, seedHashHex: "22".repeat(32),
    fileSizeBytes: String(6 * 262_144), recommendedFilename: "six-blocks.bin", store: createInMemoryOwnerFileStore(),
  });
  for (const sessionId of ["pool-1", "pool-2"]) {
    await plan.registerPool({
      sessionId, sellerPublicKeyHex: `03${"33".repeat(32)}`,
      seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", contentBudgetSatoshis: "13",
      seedBudgetSatoshis: "1", seedBudgetReserved: true, blockBudgetSatoshis: "12", recentBytesPerSecond: null,
    });
    await plan.activatePool(sessionId);
  }
  expect(await plan.claimSeed("pool-1", "price")).toBe("assigned");
  await plan.completeSeed("pool-1", "1");
  const hashes = ["44", "55", "66", "77", "88", "99"].map((byte) => byte.repeat(32));
  await plan.setBlockHashes(hashes);
  const [first, initialSecond] = await Promise.all([
    plan.claimNextBlocks("pool-1", "price", 3),
    plan.claimNextBlocks("pool-2", "price", 3),
  ]);
  const second = initialSecond.length > 0 ? initialSecond : await plan.claimNextBlocks("pool-2", "price", 3);
  expect(first).toEqual(hashes.slice(0, 3));
  expect(second).toEqual(hashes.slice(3));
  expect(await plan.claimNextBlocks("pool-1", "price", 1)).toEqual(first);
  const payment = first.map((blockHashHex) => ({ blockHashHex, paidSatoshis: "2" }));
  await plan.completeBlocks("pool-1", payment);
  await plan.completeBlocks("pool-1", payment);
  await plan.closePool("pool-2");
  expect(await plan.snapshot()).toMatchObject({
    completedBlockCount: 3,
    pools: [
      { sessionId: "pool-1", blockCommittedSatoshis: "6" },
      { sessionId: "pool-2", blockCommittedSatoshis: "0", closed: true },
    ],
  });
  expect(await plan.claimNextBlocks("pool-1", "price", 10)).toEqual(hashes.slice(3));
});
