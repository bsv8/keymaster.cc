import { describe, expect, it } from "vitest";
import type { OwnerAppStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { createBsv21StateRepository, type Bsv21TokenSnapshot } from "./storage/bsv21StateRepository.js";

const OWNER_A = "02" + "11".repeat(32);

function snapshot(origin: string, outpoint = `${origin}:0`): Bsv21TokenSnapshot {
  return {
    origin,
    outpoint,
    network: "main",
    address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    amount: "110",
    meta: { origin, symbol: "TOK" },
    syncedAt: "2026-01-01T00:00:00.000Z"
  };
}

function makeStore(): OwnerAppStore {
  return createInMemoryKeyValueStore({ scope: "key", ownerPublicKeyHex: OWNER_A, applicationStorageId: "BSV21", schemaVersion: 1, bucketId: "test", bucketGeneration: 1 }) as OwnerAppStore;
}

describe("bsv21StateRepository", () => {
  it("writes snapshots to the injected owner store", async () => {
    const repository = createBsv21StateRepository(makeStore());
    await repository.put(snapshot("token-a"));
    expect((await repository.list()).map((item) => item.origin)).toEqual(["token-a"]);
    repository.close();
  });

  it("replaces one snapshot partition atomically", async () => {
    const repository = createBsv21StateRepository(makeStore());
    await repository.replaceAll([snapshot("token-a"), snapshot("token-b")]);
    expect((await repository.list()).map((item) => item.origin).sort()).toEqual(["token-a", "token-b"]);
    await repository.replaceAll([snapshot("token-c")]);
    expect(await repository.list()).toEqual([snapshot("token-c")]);
    await expect(repository.put({ ...snapshot("token-d"), amount: "1.2" })).rejects.toThrow("invalid");
    repository.close();
  });
});
