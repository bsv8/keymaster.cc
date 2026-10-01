import { describe, expect, it } from "vitest";
import { createIndexedDbWalletStore } from "../local/indexedDbWalletStore.js";
import { WALLET_KEYHOLD_FILE_PATH, createWalletKeyRepository } from "./walletKeyRepository.js";

function privateKey(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = value;
  return bytes;
}

function setup(label: string): ReturnType<typeof createIndexedDbWalletStore> {
  return createIndexedDbWalletStore({ databaseName: "keymaster-test-key-" + label + "-" + crypto.randomUUID() });
}

// KDF 迭代沿用既有 KeyHold 测试的参数,保证覆盖真实密码学路径。
const ITERATIONS = 600_000;

describe("wallet key repository", () => {
  it("stores the only key at the fixed key.json path", async () => {
    const store = setup("fixed");
    try {
      const repository = createWalletKeyRepository(store);
      await repository.create({ label: "主 Key", privateKeyBytes: privateKey(1), password: "key-password", iterations: ITERATIONS });
      expect(await store.get(WALLET_KEYHOLD_FILE_PATH)).toBeDefined();
      expect(WALLET_KEYHOLD_FILE_PATH).toBe("key.json");
      // 不再有公钥派生的文件名,根目录里也不存在第二把 Key。
      expect((await store.list()).objects.map((entry) => entry.path)).toEqual(["key.json"]);
      expect((await repository.read())?.document.label).toBe("主 Key");
    } finally {
      store.close();
    }
  });

  it("refuses to overwrite an existing key", async () => {
    const store = setup("single");
    try {
      const repository = createWalletKeyRepository(store);
      await repository.create({ label: "第一把", privateKeyBytes: privateKey(1), password: "pw", iterations: ITERATIONS });
      await expect(
        repository.create({ label: "第二把", privateKeyBytes: privateKey(2), password: "pw", iterations: ITERATIONS })
      ).rejects.toMatchObject({ code: "storage_conflict" });
      expect((await repository.read())?.document.label).toBe("第一把");
    } finally {
      store.close();
    }
  });

  it("lets only one concurrent initialization win", async () => {
    const databaseName = "keymaster-test-key-race-" + crypto.randomUUID();
    const first = createIndexedDbWalletStore({ databaseName });
    const second = createIndexedDbWalletStore({ databaseName });
    try {
      const results = await Promise.allSettled([
        createWalletKeyRepository(first).create({
          label: "甲",
          privateKeyBytes: privateKey(11),
          password: "pw",
          iterations: ITERATIONS,
        }),
        createWalletKeyRepository(second).create({
          label: "乙",
          privateKeyBytes: privateKey(12),
          password: "pw",
          iterations: ITERATIONS,
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await createWalletKeyRepository(first).read())?.document.label).toMatch(/^(?:甲|乙)$/u);
    } finally {
      first.close();
      second.close();
    }
  });

  it("unlocks with the key password and rejects a wrong one", async () => {
    const store = setup("unlock");
    try {
      const repository = createWalletKeyRepository(store);
      const secret = privateKey(2);
      await repository.create({ label: "解锁 Key", privateKeyBytes: secret, password: "right-pw", iterations: ITERATIONS });
      const unlocked = await repository.unlock("right-pw");
      expect(unlocked.privateKeyBytes).toEqual(secret);
      unlocked.privateKeyBytes.fill(0);
      await expect(repository.unlock("wrong-pw")).rejects.toMatchObject({ code: "storage_identity_required" });
    } finally {
      store.close();
    }
  });

  it("changes the password in place without changing the public key", async () => {
    const store = setup("change");
    try {
      const repository = createWalletKeyRepository(store);
      await repository.create({ label: "改密 Key", privateKeyBytes: privateKey(3), password: "old-pw", iterations: ITERATIONS });
      const before = await repository.read();
      await expect(repository.changePassword({ oldPassword: "wrong", newPassword: "new-pw" })).rejects.toMatchObject({
        code: "storage_identity_required",
      });
      const changed = await repository.changePassword({ oldPassword: "old-pw", newPassword: "new-pw", iterations: ITERATIONS });
      expect(changed.document.publicKeyHex).toBe(before?.document.publicKeyHex);
      expect(changed.revision).toBeGreaterThan(before?.revision ?? 0);
      const unlocked = await repository.unlock("new-pw");
      expect(unlocked.privateKeyBytes).toEqual(privateKey(3));
      unlocked.privateKeyBytes.fill(0);
      await expect(repository.unlock("old-pw")).rejects.toMatchObject({ code: "storage_identity_required" });
    } finally {
      store.close();
    }
  });

  it("renames the key without rotating the key material", async () => {
    const store = setup("rename");
    try {
      const repository = createWalletKeyRepository(store);
      await repository.create({ label: "旧名称", privateKeyBytes: privateKey(4), password: "pw", iterations: ITERATIONS });
      const renamed = await repository.rename("新名称");
      expect(renamed.document.label).toBe("新名称");
      const unlocked = await repository.unlock("pw");
      expect(unlocked.privateKeyBytes).toEqual(privateKey(4));
      unlocked.privateKeyBytes.fill(0);
    } finally {
      store.close();
    }
  });

  it("imports and exports the original KeyHold bytes unchanged", async () => {
    const store = setup("import");
    const source = createIndexedDbWalletStore({ databaseName: "keymaster-test-key-src-" + crypto.randomUUID() });
    try {
      const original = await createWalletKeyRepository(source).create({
        label: "导入 Key",
        privateKeyBytes: privateKey(5),
        password: "pw",
        iterations: ITERATIONS,
      });
      const repository = createWalletKeyRepository(store);
      const imported = await repository.import(original.bytes);
      expect(imported.document.publicKeyHex).toBe(original.document.publicKeyHex);
      // 导入不要求密码,也不重新加密。
      expect(await repository.export()).toEqual(original.bytes);
    } finally {
      source.close();
      store.close();
    }
  });

  it("reports a missing key instead of creating one implicitly", async () => {
    const store = setup("missing");
    try {
      const repository = createWalletKeyRepository(store);
      await expect(repository.read()).resolves.toBeUndefined();
      await expect(repository.unlock("pw")).rejects.toMatchObject({ code: "storage_not_found" });
      await expect(repository.export()).rejects.toMatchObject({ code: "storage_not_found" });
    } finally {
      store.close();
    }
  });

  it("treats a corrupt key.json as an error state rather than an uninitialized wallet", async () => {
    const store = setup("corrupt");
    try {
      await store.put(WALLET_KEYHOLD_FILE_PATH, new TextEncoder().encode("{ not json"));
      await expect(createWalletKeyRepository(store).read()).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    } finally {
      store.close();
    }
  });
});
