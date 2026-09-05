import { describe, expect, it } from "vitest";
import type { OwnerAppStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { openP2pkhStateRepository, createP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";

const OWNER = "02" + "11".repeat(32);

function makeStore(): OwnerAppStore {
  return createInMemoryKeyValueStore({
    scope: "key",
    ownerPublicKeyHex: OWNER,
    applicationStorageId: "UTXOS",
    schemaVersion: 1,
    bucketId: "test",
    bucketGeneration: 1
  }) as OwnerAppStore;
}

describe("P2PKH storage hard switch", () => {
  it("opens an empty K-V namespace without running a legacy migration", async () => {
    const bundle = await openP2pkhStateRepository(makeStore());
    const repository = createP2pkhStateRepository(bundle);
    expect(await repository.listAddresses()).toEqual([]);
    expect(bundle.getStore().objectStoreNames).toEqual(expect.arrayContaining([
      "p2pkh_addresses",
      "p2pkh_transactions",
      "p2pkh_owned_outpoints",
      "p2pkh_local_transactions",
      "p2pkh_protocol_submissions"
    ]));
    bundle.close();
  });
});
