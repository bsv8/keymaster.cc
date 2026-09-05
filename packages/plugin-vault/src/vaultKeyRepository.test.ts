import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { vaultKeyRepository, configureVaultKeyRepository, type VaultKeyRecord } from "./storage/vaultKeyRepository.js";

function keyRecord(publicKeyHex = "02".padEnd(66, "a")): VaultKeyRecord {
  return {
    publicKeyHex,
    label: "测试 Key",
    address: "",
    network: "main",
    format: "keyhold-v2",
    capabilities: ["p2pkh"],
    createdAt: "2026-09-04T00:00:00.000Z",
    storageVersion: "keyhold-v2",
    keyholdDocument: { version: 1, label: "测试 Key", encrypted: "test" } as never
  };
}

describe("vaultKeyRepository", () => {
  beforeEach(() => {
    configureVaultKeyRepository(createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: "keys", schemaVersion: 1, bucketId: "test", bucketGeneration: 1 }));
  });

  it("persists canonical key and removes its sidecars atomically", async () => {
    const publicKeyHex = keyRecord().publicKeyHex;
    await vaultKeyRepository.putKey(keyRecord(publicKeyHex));
    await vaultKeyRepository.putSidecar({ publicKeyHex, id: "credential", label: "Passkey", credentialIdB64: "credential", prfSaltB64: "salt", rpId: "keymaster.cc", createdAt: new Date().toISOString(), cipherVersion: "webauthn-prf-v1", cipherIvB64: "00", cipherB64: "00" });
    expect(await vaultKeyRepository.getKey(publicKeyHex)).toMatchObject({ publicKeyHex, storageVersion: "keyhold-v2" });
    expect(await vaultKeyRepository.listSidecars(publicKeyHex)).toHaveLength(1);
    await vaultKeyRepository.deleteKeyAndSidecars(publicKeyHex);
    expect(await vaultKeyRepository.getKey(publicKeyHex)).toBeUndefined();
    expect(await vaultKeyRepository.listSidecars(publicKeyHex)).toHaveLength(0);
  });
});
