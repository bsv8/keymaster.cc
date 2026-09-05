import { describe, expect, it } from "vitest";
import type { OwnerAppStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { createStasRepository, type StasTokenSnapshot } from "./storage/stasRepository.js";

const OWNER_A = "02" + "11".repeat(32);

function snapshot(symbol: string, address = "addr-1", issuer = "issuer-1"): StasTokenSnapshot {
  return { symbol, network: "main", address, balance: 100, issuer, syncedAt: "2026-01-01T00:00:00.000Z" };
}

function makeStore(): OwnerAppStore {
  return createInMemoryKeyValueStore({
    scope: "key", ownerPublicKeyHex: OWNER_A, applicationStorageId: "STAS", schemaVersion: 1,
    bucketId: "test", bucketGeneration: 1
  }) as OwnerAppStore;
}

describe("stasRepository", () => {
  it("supports atomic snapshot replacement in the injected owner store", async () => {
    const repository = createStasRepository(makeStore());
    await repository.replaceAll([snapshot("A"), snapshot("B", "addr-2")]);
    expect(await repository.list()).toHaveLength(2);
    await repository.put(snapshot("C"));
    expect((await repository.list()).map((item) => item.symbol).sort()).toEqual(["A", "B", "C"]);
    repository.close();
  });
});
