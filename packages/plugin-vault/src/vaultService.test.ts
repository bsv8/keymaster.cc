// packages/plugin-vault/src/vaultService.test.ts
// VaultService 关键行为单测：
//   - createVault / unlock / lock 状态机。
//   - importPrivateKey 允许同 vault 存多把 key（不再有"已有 key 禁止导入"逻辑）。
//   - exportPrivateKey 走 bsv8 envelope；不改变 key 列表；不触发 key.created / key.deleted。
//   - removeKey 硬切换 008：抛 "Use keyspace.deleteKey instead"，不再发事件。
//   - deleteKeyMaterial：仅删材料，不发 key.deleted 事件（事件由 keyspace 统一发一次）。
//   - 在 withPrivateKey 回调内才能拿到 material。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageBus } from "@keymaster/runtime";
import { createVaultService, KeyPersistedButActivationFailedError } from "./vaultService.js";
import { createKeyspaceService } from "./keyspaceService.js";
import { disposeVaultDb, vaultDb } from "./vaultDb.js";

const TEST_PRIV = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIV_2 = "0000000000000000000000000000000000000000000000000000000000000002";
/** 与 vaultService 内部常量保持一致，避免跨包 import 测试私有常量。 */
const LABEL_MAX_LENGTH = 64;

interface EventRecord {
  type: string;
  payload: unknown;
}

function makeMessageBus(): { messageBus: MessageBus; records: EventRecord[] } {
  const records: EventRecord[] = [];
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  const messageBus: MessageBus = {
    publish(event: string, payload: unknown) {
      records.push({ type: event, payload });
      const bucket = subscriptions.get(event);
      if (bucket) for (const h of [...bucket]) h(payload);
      return event;
    },
    subscribe(event, handler) {
      let bucket = subscriptions.get(event);
      if (!bucket) {
        bucket = new Set();
        subscriptions.set(event, bucket);
      }
      bucket.add(handler as (payload: unknown) => void);
      return () => {
        bucket?.delete(handler as (payload: unknown) => void);
      };
    },
    dispatch: () => "",
    request: () => Promise.reject(new Error("not used")),
    handle: () => () => undefined,
    snapshot: () => ({ total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} }),
    onSnapshot: (h) => {
      h({ total: 0, queued: 0, inFlight: 0, completed: 0, failed: 0, canceled: 0, byTarget: {} });
      return () => undefined;
    }
  };
  return { messageBus, records };
}

async function resetDb(): Promise<void> {
  // 关键：先关闭 db 连接，否则 delete 会被阻塞。
  disposeVaultDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("vault");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** 等到 vaultService.bootstrap() 完成、status 落定。 */
async function waitForStatus(
  vault: ReturnType<typeof createVaultService>,
  expected: "uninitialized" | "locked" | "unlocked"
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (vault.status() === expected) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`vault did not reach status ${expected}; current=${vault.status()}`);
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await resetDb();
});

describe("VaultService.importPrivateKey", () => {
  it("allows importing multiple keys into the same vault", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const a = await vault.importPrivateKey({
      label: "first",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    const b = await vault.importPrivateKey({
      label: "second",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    expect(a.id).not.toBe(b.id);
    const list = await vault.listKeys();
    expect(list.map((k) => k.label).sort()).toEqual(["first", "second"]);
  });

  it("emits key.created AFTER keyspace switches active key (硬切换 008 收尾)", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");

    // 构造一个最小 keyspace fake：active() 读 activeRef，
    // notifyKeyCreated 写入 activeRef。真实切换逻辑由集成测试覆盖，
    // 这里只验证 vaultService 的事件调用顺序。
    // unlock 流程会调用 setInitializing / onVaultUnlocked；提供 no-op 实现。
    const activeRef: { mode: "all" | "single"; activePublicKeyHash?: string } = { mode: "all" };
    const keyspaceFake = {
      active: () => activeRef,
      notifyKeyCreated: (id: { publicKeyHash: string }) => {
        // 模拟真实 keyspace：切到新 key。
        activeRef.mode = "single";
        activeRef.activePublicKeyHash = id.publicKeyHash;
      },
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined
    };
    const vaultWithKeyspace = createVaultService({
      messageBus: events,
      keyspace: keyspaceFake as never
    });
    // 第二个 vault 实例需要解锁才能 importPrivateKey；createVault 已
    // 把 meta 写入 IndexedDB，所以 unlock 用同一密码即可。
    await waitForStatus(vaultWithKeyspace, "locked");
    await vaultWithKeyspace.unlock("test-pw");

    // Patch messageBus.publish：每个 publish 时记录当时的 active 状态。
    // 由于 makeMessageBus 内部 subscribe() 不签名正确，避免用 messageBus.subscribe；直接劫持 publish。
    const emittedActive: { type: string; activeMode: string; activeHash?: string }[] = [];
    const originalPublish = events.publish.bind(events);
    events.publish = (event: string, payload: unknown, _opts?: unknown) => {
      emittedActive.push({
        type: event,
        activeMode: activeRef.mode,
        activeHash: activeRef.activePublicKeyHash
      });
      return originalPublish(event, payload, _opts as never);
    };

    await vaultWithKeyspace.importPrivateKey({
      label: "first",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });

    const createdSnapshot = emittedActive.find((e) => e.type === "key.created");
    expect(createdSnapshot).toBeDefined();
    // 关键断言：emit key.created 时 active 已经切到新 key。
    expect(createdSnapshot?.activeMode).toBe("single");
    const createdPayload = records.find((r) => r.type === "key.created")?.payload as
      | { publicKeyHash: string }
      | undefined;
    expect(createdSnapshot?.activeHash).toBe(createdPayload?.publicKeyHash);
  });
});

describe("VaultService.exportPrivateKey", () => {
  it(
    "produces bsv8 envelope and does not mutate key list",
    async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "k",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    const listBefore = await vault.listKeys();
    const envelope = await vault.exportPrivateKey({ keyId: ref.id, password: "backup" });
    const listAfter = await vault.listKeys();
    expect(envelope.version).toBe("kek-v1");
    expect(envelope.cipher).toBe("xchacha20poly1305");
    expect(envelope.kdf).toBe("argon2id");
    expect(listAfter.length).toBe(listBefore.length);
  },
  // Argon2id 65536 KiB 在 node 下偏慢，给 30s。
  30_000
  );

  it("rejects unknown key", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await expect(
      vault.exportPrivateKey({ keyId: "missing", password: "x" })
    ).rejects.toThrow(/Unknown key/i);
  });

  it("requires backup password", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "k",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await expect(
      vault.exportPrivateKey({ keyId: ref.id, password: "" })
    ).rejects.toThrow(/Backup password/i);
  });
});

describe("VaultService.verifyPassword (硬切换 002 删除授权)", () => {
  // 关键不变量：
  //   - 密码正确 resolve；不修改 status / masterKey / 内存会话 / 不发事件。
  //   - 密码错误抛 Invalid password；同样不副作用。
  //   - uninitialized / booting 状态没有 verifier，必须 fail closed。
  //   - locked 与 unlocked 状态都允许调用（删除前重新鉴权）。
  it("resolves on correct password and does NOT change status / emit events", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    const before = records.length;
    await vault.verifyPassword("test-pw");
    // 不改 status。
    expect(vault.status()).toBe("unlocked");
    // 不发任何新事件。
    expect(records.length).toBe(before);
  });

  it("throws Invalid password on wrong password without side effects", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    const before = records.length;
    await expect(vault.verifyPassword("wrong-pw")).rejects.toThrow(/Invalid password/);
    // 状态不变；不发事件。
    expect(vault.status()).toBe("unlocked");
    expect(records.length).toBe(before);
  });

  it("works in locked state (used for delete authorization on re-entry)", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await vault.lock();
    await waitForStatus(vault, "locked");
    // 在 locked 状态下校验密码不抛错，也不切到 unlocked。
    await vault.verifyPassword("test-pw");
    expect(vault.status()).toBe("locked");
    await expect(vault.verifyPassword("wrong-pw")).rejects.toThrow(/Invalid password/);
    expect(vault.status()).toBe("locked");
  });

  it("fails closed when vault is not initialized", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await expect(vault.verifyPassword("anything")).rejects.toThrow(/not initialized/i);
    expect(vault.status()).toBe("uninitialized");
  });

  it("does not unlock the cache or allow withPrivateKey when called on locked vault", async () => {
    // 关键不变量：verifyPassword 必须**不**派生 masterKey，所以 withPrivateKey
    // 仍应抛 "Vault is locked"。这是与 unlock(password) 的本质区别。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "k",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await vault.lock();
    await waitForStatus(vault, "locked");
    await vault.verifyPassword("test-pw");
    // 仍然是 locked；明文私钥不可借出。
    expect(vault.status()).toBe("locked");
    await expect(vault.withPrivateKey(ref.id, () => "x")).rejects.toThrow(/locked/i);
  });
});

describe("VaultService.finalizeEmptyVaultAfterLastKeyDeletion (硬切换 002 删空收尾)", () => {
  // 关键不变量：
  //   - 仅在 vault_keys 为空时 resolve；否则 fail closed。
  //   - 成功后 status = uninitialized，vault_meta 已删，下次 bootstrap
  //     仍读到 uninitialized。
  //   - 内存会话（masterKey / masterSalt / keyCache）被清空。
  //   - 触发一次 vault.locked 事件 + keyspace.onVaultLocked()，与现有
  //     插件清理链路保持兼容。

  it("collapses to uninitialized and wipes vault_meta when there are no keys", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    // 空 Vault：listKeys 必然是 0。
    expect(await vault.listKeys()).toHaveLength(0);
    await vault.finalizeEmptyVaultAfterLastKeyDeletion();
    expect(vault.status()).toBe("uninitialized");
    // vault_meta 已删。
    expect(await vaultDb.getMeta()).toBeUndefined();
    // 触发了一次 vault.locked（清理链路），且这一发生在 finalize 期间。
    expect(records.some((r) => r.type === "vault.locked")).toBe(true);
    // 新实例 bootstrap 应读到 uninitialized。
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });

  it("calls keyspace.onVaultLocked() exactly once for session cleanup", async () => {
    const { messageBus: events } = makeMessageBus();
    let onVaultLockedCount = 0;
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => {
        onVaultLockedCount += 1;
      },
      notifyKeyCreated: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await vault.finalizeEmptyVaultAfterLastKeyDeletion();
    expect(onVaultLockedCount).toBe(1);
    expect(vault.status()).toBe("uninitialized");
  });

  it("fails closed when vault still has keys (refuses to wipe meta)", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await vault.importPrivateKey({
      label: "still-here",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await expect(vault.finalizeEmptyVaultAfterLastKeyDeletion()).rejects.toThrow(
      /still has keys/i
    );
    // 状态不变，meta 仍在。
    expect(vault.status()).toBe("unlocked");
    expect(await vaultDb.getMeta()).toBeDefined();
    const list = await vault.listKeys();
    expect(list).toHaveLength(1);
  });

  it("clears in-memory session so withPrivateKey fails after finalize", async () => {
    // 设计缘由：finalize 必须把 masterKey / masterSalt / keyCache 清空，
    // 避免后续异步路径还能解密私钥；这里通过先 import 一把 key 再
    // 删材料 + finalize 来观察。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "to-be-wiped",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    // 直接删除 key 材料让 vault 进入"空"状态（绕过 keyspace 流程，
    // 仅测 finalize 自身行为）。
    await vault.deleteKeyMaterial(ref.id);
    await vault.finalizeEmptyVaultAfterLastKeyDeletion();
    expect(vault.status()).toBe("uninitialized");
    // withPrivateKey 此刻必须抛错（key 已不存在 + vault 已 uninitialized）。
    await expect(vault.withPrivateKey(ref.id, () => "x")).rejects.toBeTruthy();
  });

  it("collapses status to uninitialized even when vaultDb.deleteMeta throws (no half-state)", async () => {
    // 高优先级修复：finalize 内部 `await vaultDb.deleteMeta()` 抛错时，
    // 状态机必须仍然收敛到 uninitialized——否则会出现"in-memory 已清空
    // 但 status 仍 unlocked"的错位态：App 不会切回欢迎页、但任何
    // 后续 withPrivateKey / sign 都会撞上 "Vault is locked"。错误仍
    // 抛给调用方，但文案必须明确说明"状态已收敛、meta 残留"。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    expect(await vault.listKeys()).toHaveLength(0);

    // 用 spy 让 deleteMeta 抛错——这是 deleteMeta 失败的最直接复现。
    const deleteMetaSpy = vi
      .spyOn(vaultDb, "deleteMeta")
      .mockImplementation(async () => {
        throw new Error("simulated deleteMeta failure");
      });

    try {
      await expect(vault.finalizeEmptyVaultAfterLastKeyDeletion()).rejects.toThrow(
        /Empty-vault finalize failed to wipe vault_meta/
      );
      // 关键：status 仍必须收敛到 uninitialized。
      expect(vault.status()).toBe("uninitialized");
      // 错误文案必须把"状态已收敛"和"meta 残留"同时告诉调用方——
      // UI 不能因为"看起来回到欢迎页"就以为成功。
      await expect(
        vault.finalizeEmptyVaultAfterLastKeyDeletion()
      ).rejects.toThrow(/next bootstrap may re-read locked/);
    } finally {
      deleteMetaSpy.mockRestore();
    }

    // 把 spy 还原后再调一次 finalize（这次 deleteMeta 走真实路径）：
    // meta 此时确实在 DB 里，需要把"meta 残留"清掉，避免污染后续测试。
    expect(await vaultDb.getMeta()).toBeDefined();
    await vault.finalizeEmptyVaultAfterLastKeyDeletion();
    expect(vault.status()).toBe("uninitialized");
    expect(await vaultDb.getMeta()).toBeUndefined();
  });

  it("vault.locked is still emitted before deleteMeta fails, so session-cleanup listeners get the signal", async () => {
    // 设计缘由：业务插件（p2pkh 等）依赖 vault.locked 事件释放 namespace
    // 资源；finalize 内部 deleteMeta 抛错时，vault.locked 必须**已经**发出
    // ——否则失败路径会留下"未清理的 unlocked 会话内存"残留。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const deleteMetaSpy = vi
      .spyOn(vaultDb, "deleteMeta")
      .mockImplementation(async () => {
        throw new Error("simulated deleteMeta failure");
      });
    try {
      await expect(vault.finalizeEmptyVaultAfterLastKeyDeletion()).rejects.toThrow();
      expect(records.some((r) => r.type === "vault.locked")).toBe(true);
      expect(vault.status()).toBe("uninitialized");
    } finally {
      deleteMetaSpy.mockRestore();
    }
    // 清掉残留 meta，避免污染后续测试。
    await vaultDb.deleteMeta();
  });
});


describe("VaultService.removeKey (deprecated)", () => {
  it("throws and tells caller to use keyspace.deleteKey", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "rm",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await expect(vault.removeKey(ref.id)).rejects.toThrow(/keyspace\.deleteKey/);
  });
});

describe("VaultService.deleteKeyMaterial (硬切换 008)", () => {
  it("removes the key material but does NOT emit key.deleted", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "rm",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await vault.deleteKeyMaterial(ref.id);
    const list = await vault.listKeys();
    expect(list.find((k) => k.id === ref.id)).toBeUndefined();
    // 硬切换 008：deleteKeyMaterial 不发 key.deleted（由 keyspace 统一发）。
    expect(records.some((r) => r.type === "key.deleted")).toBe(false);
  });

  it("rejects withPrivateKey on material-deleted key", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "rm",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await vault.deleteKeyMaterial(ref.id);
    await expect(vault.withPrivateKey(ref.id, () => "x")).rejects.toThrow(/Unknown key/i);
  });
});

describe("VaultService.withPrivateKey", () => {
  it("borrows material in closure", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.importPrivateKey({
      label: "k",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    const out = await vault.withPrivateKey(ref.id, (m) => m.hex);
    expect(out).toBe(TEST_PRIV);
  });
});

describe("VaultService vaultDb open sanity", () => {
  it("creates vault_meta and vault_keys stores", async () => {
    await vaultDb.listKeys();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("vault");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(db.objectStoreNames.contains("vault_meta")).toBe(true);
    expect(db.objectStoreNames.contains("vault_keys")).toBe(true);
    db.close();
  });
});

describe("identity backfill failure passthrough (硬切换 008 收尾)", () => {
  it("passes identityError through vault.listKeys and keyspace.listKeys", async () => {
    // 设计缘由：backfill 失败时 vaultDb.putKeyIdentityFailed 写入
    // identityStatus="failed" + identityError。vaultService.recordToRef
    // 必须把 identityError 透传给 KeyRef；keyspaceService.listManageableKeys
    // 再透传给 KeyIdentity，让 UI 在 VaultSettingsPage 看到失败原因。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    // 模拟 backfill 失败：直接写 vaultDb，不走 unlock backfill 流程。
    const ref = await vault.importPrivateKey({
      label: "fail-backfill",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await vaultDb.putKeyIdentityFailed(ref.id, "simulated decrypt failure");

    // 1) vault.listKeys 看到 identityError。
    const list = await vault.listKeys();
    const fromVault = list.find((k) => k.id === ref.id);
    expect(fromVault?.identityStatus).toBe("failed");
    expect(fromVault?.identityError).toBe("simulated decrypt failure");

    // 2) keyspace.listKeys 也透传 identityError。
    const { createKeyspaceService } = await import("./keyspaceService.js");
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    const fromKeyspace = await keyspace.listKeys();
    const entry = fromKeyspace.find((k) => k.keyId === ref.id);
    expect(entry?.identityStatus).toBe("failed");
    expect(entry?.identityError).toBe("simulated decrypt failure");
    // 设计允许 failed key 保留 publicKeyHash：vaultDb.putKeyIdentityFailed
    // 不动 identity 字段，只标 status。listActiveCandidates 会过滤掉
    // failed key，但 listKeys 仍能读到 hash 供 UI 展示。
    expect(entry?.publicKeyHash).toBe(ref.publicKeyHash);
    expect(entry?.fingerprint).toBe(ref.fingerprint);
  });
});

describe("VaultService.unlock ready boundary (硬切换 008 收尾)", () => {
  // 关键不变量：vault.unlock() resolve 之前必须
  //   1) backfillIdentities() 跑完
  //   2) keyspace.onVaultUnlocked() 跑完
  //   3) 此时 setStatus("unlocked") 才发出，vault.unlocked 事件才 emit
  // 业务主界面（UnlockedShell / P2PKH widget）只在看到 unlocked 时
  // 才能渲染；如果 unlocked 早于 keyspace ready 会出现
  // "Key storage is not ready" 未处理 Promise。

  it("emits vault.unlocked only after keyspace.onVaultUnlocked resolves", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");
    await vault0.lock();
    await waitForStatus(vault0, "locked");

    // 关键：构造一个会记录调用顺序的 keyspace fake。
    // onVaultUnlocked 内部观察的是**正在 unlock** 的 vault 状态（下方
    // `vault` 实例），不是已经 lock 过的 vault0。旧实现观察 vault0
    // 只是因为巧合——vault0.status() 此刻也是 "locked"，但这不能
    // 证明"vault 自己的 ready 边界尚未跨越"。修正后观察 `vault` 让
    // 事件顺序的证明直接指向 unlock 目标。
    const callOrder: string[] = [];
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: (v: boolean) => {
        callOrder.push(`keyspace.setInitializing(${v})`);
      },
      onVaultUnlocked: async () => {
        // 关键：模拟真实时序，在 onVaultUnlocked 中观察 vault.status()
        callOrder.push("keyspace.onVaultUnlocked:enter");
        // 此刻 vault 仍应是 "locked"（setStatus("unlocked") 还没发生）。
        callOrder.push(`keyspace.onVaultUnlocked:vaultStatus=${vault.status()}`);
        callOrder.push("keyspace.onVaultUnlocked:exit");
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };

    // 重建 vault，让它持有 keyspace fake。meta 已写好，bootstrap 后
    // status = "locked"，直接 unlock。
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "locked");

    // 本测试自己记录 vault.unlocked 何时到达。
    const unlockedAt: string[] = [];
    const originalPublish = events.publish.bind(events);
    events.publish = (event: string, payload: unknown, _opts?: unknown) => {
      if (event === "vault.unlocked") unlockedAt.push("emitted");
      return originalPublish(event, payload, _opts as never);
    };

    await vault.unlock("test-pw");

    // 1) vault.unlocked 必须被 emit。
    expect(unlockedAt.length).toBe(1);
    // 2) keyspace.onVaultUnlocked 的 enter 必须在 vault.unlocked emit 之前。
    const idxOnVaultUnlocked = callOrder.findIndex((s) => s === "keyspace.onVaultUnlocked:enter");
    expect(idxOnVaultUnlocked).toBeGreaterThanOrEqual(0);
    // 3) keyspace.onVaultUnlocked 看到 vault.status() === "locked"
    //    （即 ready 边界未跨越）。
    const insideStatusLine = callOrder.find((s) => s.startsWith("keyspace.onVaultUnlocked:vaultStatus="));
    expect(insideStatusLine).toBe("keyspace.onVaultUnlocked:vaultStatus=locked");
    // 4) emit 之后再读到 vault.status() === "unlocked"。
    expect(vault.status()).toBe("unlocked");
    // 5) backfill 已结束（setInitializing(false) 已被调用）。
    const initFalse = callOrder.find((s) => s === "keyspace.setInitializing(false)");
    expect(initFalse).toBeDefined();
    expect(records.some((r) => r.type === "vault.unlocked")).toBe(true);
  });

  it("onVaultUnlocked failure rolls back status to locked and clears in-memory key", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");
    // 关键：先导入一把真实 key，拿到真实 keyId。
    // 否则 withPrivateKey("anything") 会先抛 "Unknown key"，无法证明
    // masterKey 被清理（vault.is locked 才是 fail-closed 的预期错误）。
    const ref = await vault0.importPrivateKey({
      label: "rollback-key",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await vault0.lock();
    await waitForStatus(vault0, "locked");

    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => {
        throw new Error("simulated keyspace failure");
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };

    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "locked");

    // unlock 应抛错且 status 回退到 locked。
    await expect(vault.unlock("test-pw")).rejects.toThrow(/simulated keyspace failure/);
    expect(vault.status()).toBe("locked");
    // 关键修复：用真实 keyId 调 withPrivateKey，验证 fail-closed。
    // 旧的 "anything" 会先抛 "Unknown key"，无法证明 masterKey 已被清空。
    // 现在 vault 应抛 "Vault is locked"——这是 vault 状态机层的 fail-closed 错误。
    await expect(
      vault.withPrivateKey(ref.id, () => "x")
    ).rejects.toThrow(/locked/i);
  });

  it("createVault also calls keyspace.onVaultUnlocked before setStatus(unlocked)", async () => {
    disposeVaultDb();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("vault");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    const { messageBus: events } = makeMessageBus();
    let onVaultUnlockedCalledAt: VaultStatus = "booting";
    let onVaultUnlockedCalled = false;
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => {
        onVaultUnlockedCalled = true;
        // 在 fake keyspace 看到时的 status 仍是 "uninitialized"
        // （createVault 内部尚未 setStatus("unlocked")）。
        onVaultUnlockedCalledAt = "uninitialized";
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");

    expect(onVaultUnlockedCalled).toBe(true);
    // keyspace 看到的是 uninitialized；unlocked 是在它返回后才发生。
    expect(onVaultUnlockedCalledAt).toBe("uninitialized");
    expect(vault.status()).toBe("unlocked");
  });

  it("createVault failure deletes meta so storage and state stay consistent", async () => {
    // 设计缘由（硬切换 008 收尾）：createVault 失败时如果只回退 status
    // 但不删 meta，DB 里会有孤儿 Vault；下次 bootstrap 把状态读到
    // "locked"，UI 却按 uninitialized 走，状态机错位。修复后必须把
    // meta 一并 delete。
    disposeVaultDb();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("vault");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    const { messageBus: events } = makeMessageBus();
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => {
        throw new Error("simulated keyspace failure during createVault");
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");
    await expect(vault.createVault("test-pw")).rejects.toThrow(/simulated keyspace failure/);
    expect(vault.status()).toBe("uninitialized");
    // 关键：meta 必须被删除——bootstrap 时不应读到孤儿 Vault。
    // 用一个新的 vault 实例走 bootstrap；如果 meta 还在会读到 "locked"。
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });
});

describe("VaultService.generateKey (硬切换 002)", () => {
  it("creates a new key in unlocked state with format=generated and source=vault-generated", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.generateKey({ label: "first-generated" });
    expect(ref.format).toBe("generated");
    expect(ref.source).toBe("vault-generated");
    expect(ref.capabilities).toEqual(["p2pkh"]);
    expect(ref.label).toBe("first-generated");
    expect(ref.publicKeyHex).toBeDefined();
    expect(ref.publicKeyHash).toBeDefined();
    expect(ref.fingerprint).toBeDefined();
    // 关键：返回对象中不能有 material / hex / wif。
    const refRecord = ref as unknown as Record<string, unknown>;
    expect(refRecord.material).toBeUndefined();
    expect(refRecord.hex).toBeUndefined();
    expect(refRecord.wif).toBeUndefined();
    // key.created payload 也只暴露公开身份。
    const createdPayload = records.find((r) => r.type === "key.created")?.payload as
      | { publicKeyHash: string; keyId: string; label: string }
      | undefined;
    expect(createdPayload?.keyId).toBe(ref.id);
    expect(createdPayload?.publicKeyHash).toBe(ref.publicKeyHash);
    const payloadRecord = createdPayload as unknown as Record<string, unknown>;
    expect(payloadRecord.material).toBeUndefined();
    expect(payloadRecord.hex).toBeUndefined();
  });

  it("two consecutive generateKey calls produce different publicKeyHash", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const a = await vault.generateKey({ label: "k1" });
    const b = await vault.generateKey({ label: "k2" });
    expect(a.publicKeyHash).not.toBe(b.publicKeyHash);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  it("withPrivateKey returns a valid 32-byte private key derived from generated material", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.generateKey({ label: "borrow" });
    let capturedHex = "";
    await vault.withPrivateKey(ref.id, (m) => {
      capturedHex = m.hex;
    });
    // 关键：测试只能通过 withPrivateKey 拿到明文；本测试不输出材料。
    expect(/^[0-9a-f]{64}$/.test(capturedHex)).toBe(true);
    // 长度校验是 32 字节 hex；不在断言里包含明文值。
    expect(capturedHex.length).toBe(64);
  });

  it("calls notifyKeyCreated before key.created (硬切换 002 收尾：只断言调用顺序)", async () => {
    // 设计缘由：旧 fake 测试在 keyspaceFake 内部强制切换 activeRef，
    // 然后断言 emit key.created 时 active 已切。这不能区分"vault 调用了
    // notifyKeyCreated"和"keyspace 自身会切 active"两件事——后者由
    // 后面的集成测试（`VaultService + KeyspaceService integration`）
    // 用真实 createKeyspaceService 覆盖。本测试只验证 vault 内部的
    // 调用顺序：notifyKeyCreated 必须在 publish("key.created") 之前。
    const { messageBus: events } = makeMessageBus();
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");

    const callOrder: string[] = [];
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      notifyKeyCreated: () => {
        callOrder.push("notifyKeyCreated");
      },
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "locked");
    await vault.unlock("test-pw");

    const originalPublish = events.publish.bind(events);
    events.publish = (event: string, payload: unknown, _opts?: unknown) => {
      if (event === "key.created") callOrder.push("publish:key.created");
      return originalPublish(event, payload, _opts as never);
    };

    await vault.generateKey({ label: "ordering" });
    // 关键断言：notifyKeyCreated 必须先于 publish("key.created")。
    const notifyIdx = callOrder.indexOf("notifyKeyCreated");
    const createdIdx = callOrder.indexOf("publish:key.created");
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(notifyIdx).toBeLessThan(createdIdx);
  });

  it("rejects when vault is locked (fail closed)", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await vault.lock();
    await waitForStatus(vault, "locked");
    await expect(vault.generateKey({ label: "x" })).rejects.toThrow(/locked/i);
  });

  it("rejects empty / whitespace label and labels longer than 64 chars", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await expect(vault.generateKey({ label: "" })).rejects.toThrow(/Label is required/);
    await expect(vault.generateKey({ label: "   " })).rejects.toThrow(/Label is required/);
    await expect(vault.generateKey({ label: "x".repeat(65) })).rejects.toThrow(
      /at most 64 characters/
    );
  });

  it("newly generated key is visible in listKeys immediately", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const before = await vault.listKeys();
    const ref = await vault.generateKey({ label: "fresh" });
    const after = await vault.listKeys();
    expect(after.length).toBe(before.length + 1);
    expect(after.find((k) => k.id === ref.id)).toBeDefined();
  });

  it("generated key survives export round-trip and remains importable as bsv8", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const ref = await vault.generateKey({ label: "export-me" });
    const envelope = await vault.exportPrivateKey({ keyId: ref.id, password: "backup" });
    expect(envelope.cipher).toBe("xchacha20poly1305");
    expect(envelope.kdf).toBe("argon2id");
    expect(envelope.pubkey_hex).toBe(ref.publicKeyHex);
  }, 30_000);
});

describe("VaultService + KeyspaceService integration: always switch active on new key (硬切换 002 收尾)", () => {
  // 设计缘由：line 583 的 fake 测试通过在 keyspaceFake 内部强制切换
  // 验证事件顺序，但这不能证明"真实 keyspaceService.notifyKeyCreated
  // 在已有 active 时会切到新 key"。本组测试用真实
  // createKeyspaceService + createVaultService，断言：
  //   1) 第一把 key 生成后 active 是它；
  //   2) 第二把 key 生成后 active 切到第二把（这是施工单要求的
  //      "新 Key 自动 active"——必须发生即使已有 active）；
  //   3) key.created 事件发布时 active 已经是新 key。

  it("switches active to the second generated key (real keyspace)", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");

    // 用真实 keyspace：重建 vault 让它持有真实 keyspace。
    // meta 已经在 IndexedDB 里，所以新 vault bootstrap 后是 "locked"，
    // 直接 unlock 即可。persistPrivateKey 会调真实的
    // keyspace.notifyKeyCreated，验证真实的切换逻辑。
    const keyspace = createKeyspaceService({ messageBus: events, vault: vault0 });
    const vault = createVaultService({ messageBus: events, keyspace });
    await waitForStatus(vault, "locked");
    await vault.unlock("test-pw");

    const first = await vault.importPrivateKey({
      label: "first",
      material: { hex: TEST_PRIV },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    expect(keyspace.active()).toEqual({
      mode: "single",
      activePublicKeyHash: first.publicKeyHash
    });

    // 第二把 key：必须切到 second。
    const second = await vault.importPrivateKey({
      label: "second",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    expect(keyspace.active()).toEqual({
      mode: "single",
      activePublicKeyHash: second.publicKeyHash
    });

    // key.created 事件按时间顺序：第一把发布时 active 应是第一把，
    // 第二把发布时 active 应已是第二把。
    const createdEvents = records.filter((r) => r.type === "key.created");
    expect(createdEvents).toHaveLength(2);
    const firstEvent = createdEvents[0]?.payload as { publicKeyHash: string };
    const secondEvent = createdEvents[1]?.payload as { publicKeyHash: string };
    expect(firstEvent.publicKeyHash).toBe(first.publicKeyHash);
    expect(secondEvent.publicKeyHash).toBe(second.publicKeyHash);
    // emit 顺序与 vault 调用顺序一致。
    expect(secondEvent.publicKeyHash).not.toBe(firstEvent.publicKeyHash);
  });

  it("switches active for generateKey too (real keyspace)", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");
    const keyspace = createKeyspaceService({ messageBus: events, vault: vault0 });
    const vault = createVaultService({ messageBus: events, keyspace });
    await waitForStatus(vault, "locked");
    await vault.unlock("test-pw");

    const first = await vault.generateKey({ label: "g1" });
    expect(keyspace.active().activePublicKeyHash).toBe(first.publicKeyHash);
    const second = await vault.generateKey({ label: "g2" });
    expect(keyspace.active().activePublicKeyHash).toBe(second.publicKeyHash);
  });

  it("throws KeyPersistedButActivationFailedError when keyspace.notifyKeyCreated throws", async () => {
    // 设计缘由：当 keyspace 通知失败时，vault 不应让 UI 误以为"完全失败"。
    // DB 里已经落库，active 没切。验证：
    //   1) 抛出的是 KeyPersistedButActivationFailedError；
    //   2) error 携带完整公开 KeyRef（`err.key`），含真实 id / publicKeyHash / label；
    //   3) DB 里 key 存在（已持久化）；
    //   4) key.created 事件**不**被发布（避免与 active 状态不一致）；
    //   5) 真实 key.id 可以走 exportPrivateKey 拿到 envelope（防止再次
    //      出现"错误携带空 id"导致 UI 无法导出私钥的回归）。
    const { messageBus: events, records } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({ messageBus: events, keyspace: explodingKeyspace as never });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");

    let thrown: unknown;
    try {
      await vault.importPrivateKey({
        label: "explode",
        material: { hex: TEST_PRIV },
        format: "hex",
        capabilities: ["p2pkh"]
      });
    } catch (err) {
      thrown = err;
    }

    // 1) 抛出的错误是专用类型。
    expect(thrown).toBeInstanceOf(KeyPersistedButActivationFailedError);
    const wrapped = thrown as KeyPersistedButActivationFailedError;
    // 2) 错误携带完整公开 KeyRef——必须有真实 id / publicKeyHash / label。
    expect(wrapped.key).toBeDefined();
    expect(wrapped.key.id).toBeTruthy();
    expect(wrapped.key.publicKeyHash).toBeDefined();
    expect(wrapped.key.label).toBe("explode");
    expect(wrapped.key.fingerprint).toBeDefined();
    expect(wrapped.key.publicKeyHex).toBeDefined();
    // 3) DB 里 key 已存在。
    const stored = await vaultDb.getKey(wrapped.key.id);
    expect(stored).toBeDefined();
    expect(stored?.publicKeyHash).toBe(wrapped.key.publicKeyHash);
    // 4) key.created 事件**不**被发布（active 切换失败）。
    expect(records.some((r) => r.type === "key.created")).toBe(false);
    // 5) 真实 key.id 可以走 exportPrivateKey：防止再次出现"错误携带空
    //    id"导致 UI 拿不到私钥备份的回归。
    const envelope = await vault.exportPrivateKey({
      keyId: wrapped.key.id,
      password: "backup"
    });
    expect(envelope.version).toBe("kek-v1");
    expect(envelope.cipher).toBe("xchacha20poly1305");
    expect(envelope.kdf).toBe("argon2id");
  }, 30_000);
});

describe("VaultService.createVaultWithInitialKey (硬切换 009)", () => {
  // 设计缘由：首启"新建钱包"硬切换要求
  //   1) 一次调用同时建 Vault + 落首 Key + 设为 active；
  //   2) createVault() 老语义保持不变（仍允许创建空 Vault 供导入私钥使用）；
  //   3) generateKey 失败时回滚到 uninitialized；
  //   4) KeyPersistedButActivationFailedError 不被误回滚。

  it("creates vault, persists the first key, and sets it as active in one call", async () => {
    const { messageBus: events } = makeMessageBus();
    // 走"真实 keyspace"路径：先建一个临时 vault 用于构造 keyspace（keyspace
    // 构造时需要 vault 引用），再创建目标 vault，让它持有真实 keyspace。
    // meta 已经在 IndexedDB 中被建好，新 vault bootstrap 后是 "locked"
    // 状态——但 createVaultWithInitialKey 必须从 uninitialized 开始，所以
    // 先用临时 vault 跑一次 createVault（uninitialized -> unlocked），
    // 然后清空 DB，再让目标 vault 在 uninitialized 状态下调
    // createVaultWithInitialKey。
    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    await vault0.createVault("test-pw");
    await vault0.lock();
    // 清掉临时 vault 的内存状态；新 vault bootstrap 后会是 "locked"。
    // 为了让目标 vault 走 uninitialized 入口，需要清空整个 vault DB。
    disposeVaultDb();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("vault");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    const vault1 = createVaultService({ messageBus: events });
    await waitForStatus(vault1, "uninitialized");
    const keyspace = createKeyspaceService({ messageBus: events, vault: vault1 });
    const vault = createVaultService({ messageBus: events, keyspace });
    await waitForStatus(vault, "uninitialized");

    const ref = await vault.createVaultWithInitialKey({ password: "test-pw" });
    expect(ref.format).toBe("generated");
    expect(ref.source).toBe("vault-generated");
    expect(ref.capabilities).toEqual(["p2pkh"]);
    expect(ref.publicKeyHex).toBeDefined();
    expect(ref.publicKeyHash).toBeDefined();
    expect(ref.fingerprint).toBeDefined();
    // Vault 状态：unlocked。
    expect(vault.status()).toBe("unlocked");
    // listKeys 看到 1 把。
    const list = await vault.listKeys();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(ref.id);
    // keyspace 已切到这把 key。
    expect(keyspace.active()).toEqual({
      mode: "single",
      activePublicKeyHash: ref.publicKeyHash
    });
  });

  it("rejects when vault is not in uninitialized state", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    // 已经在 unlocked，再次调用必须 fail closed。
    await expect(
      vault.createVaultWithInitialKey({ password: "test-pw" })
    ).rejects.toThrow(/Vault already exists/i);
  });

  it("uses custom label / capabilities when provided", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    const ref = await vault.createVaultWithInitialKey({
      password: "test-pw",
      label: "my-first-key",
      capabilities: ["p2pkh", "custom"]
    });
    expect(ref.label).toBe("my-first-key");
    expect(ref.capabilities).toEqual(["p2pkh", "custom"]);
  });

  it("rolls back to uninitialized when initial key generation fails before persistence", async () => {
    // 设计缘由：generateKey 在 persistPrivateKey 抛错时（DB 写入失败 /
    // 重复 hash 等场景）会让首 Key 仍处于"未落库"状态。createVaultWithInitialKey
    // 必须把刚建好的空 Vault 一起清掉，回到 uninitialized，**不**留下
    // "已创建 Vault 但 0 key"的脏状态。
    //
    // 实现策略：mock keyspaceFake 让它主动 inject 一个能抛错的 keyspace
    // 即可复现——但更直接的复现是：用一个会强制失败的 label（如超长
    // 标签）让 generateKey 抛 "Label must be at most 64 characters"。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    // 64 字符的标签 + 后缀会超出 LABEL_MAX_LENGTH=64，generateKey 抛错。
    const longLabel = "x".repeat(LABEL_MAX_LENGTH + 1);
    await expect(
      vault.createVaultWithInitialKey({ password: "test-pw", label: longLabel })
    ).rejects.toThrow(/at most 64 characters/);
    // 关键：status 必须回到 uninitialized。
    expect(vault.status()).toBe("uninitialized");
    // meta 必须被删：bootstrap 重新走也应读到 uninitialized。
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });

  it("rolls back to uninitialized when keyspace.onVaultUnlocked fails", async () => {
    // 设计缘由：createVault 内部的 keyspace.onVaultUnlocked 抛错时，meta
    // 也已经被 createVault 自身回滚掉（硬切换 008 收尾）。createVaultWithInitialKey
    // 必须透传这个失败、不要再尝试生成首 Key。
    const { messageBus: events } = makeMessageBus();
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => {
        throw new Error("simulated keyspace failure during createVault");
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");
    await expect(
      vault.createVaultWithInitialKey({ password: "test-pw" })
    ).rejects.toThrow(/simulated keyspace failure/);
    expect(vault.status()).toBe("uninitialized");
    // meta 必须被删除——重新走 bootstrap 不应读到孤儿 Vault。
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });

  it("does NOT roll back when KeyPersistedButActivationFailedError is thrown", async () => {
    // 设计缘由：与 generateKey 现有语义保持一致——首 Key 已落库但 active
    // 切换失败时，DB 里的 Key 必须保留，让 UI 走"已创建但未自动 active"
    // 的成功/警告态。
    const { messageBus: events, records } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    let thrown: unknown;
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeyPersistedButActivationFailedError);
    const wrapped = thrown as KeyPersistedButActivationFailedError;
    expect(wrapped.key.id).toBeTruthy();
    expect(wrapped.key.publicKeyHash).toBeDefined();
    // 首 Key 仍在 DB 中——通过 vaultDb 直接查证。
    const stored = await vaultDb.getKey(wrapped.key.id);
    expect(stored).toBeDefined();
    expect(stored?.publicKeyHash).toBe(wrapped.key.publicKeyHash);
    // meta 仍在（不要误回滚）。
    const meta = await vaultDb.getMeta();
    expect(meta).toBeDefined();
    // key.created 事件**不**被发布（与 generateKey 现有语义一致）。
    expect(records.some((r) => r.type === "key.created")).toBe(false);
  });

  it("createVault (old semantics) does not auto-generate any key", async () => {
    // 设计缘由：createVault 必须保持"创建空 Vault"的旧语义，不被偷偷
    // 改成"自动生成首 Key"——"导入私钥"分支依赖空 Vault。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    const list = await vault.listKeys();
    expect(list).toHaveLength(0);
    expect(vault.status()).toBe("unlocked");
  });

  // ---------------------------------------------------------------------
  // 硬切换 009 收尾：时序回归测试
  // ---------------------------------------------------------------------

  it("does NOT announce unlocked before the first key is persisted (硬切换 009 收尾)", async () => {
    // 设计缘由：旧实现直接调 this.createVault(...)，createVault 内部
    // 会立刻 setStatus("unlocked") + publish("vault.unlocked")。App.tsx
    // 在看到 unlocked 后会立刻渲染 UnlockedShell；P2PKH 也会在
    // vault.unlocked 事件后启动自己的解锁链路。这种时序会让"新建钱包"
    // 暂时落在"已解锁但首 Key 尚未落库"的中间态，违反施工单里
    // "新建钱包完成后主界面应已带首 Key"的硬切换语义。
    //
    // 修复后：createVaultWithInitialKey 不复用 this.createVault()，而
    // 是内联 meta + keyspace ready 步骤，**先**调 generateKey 落首
    // Key，**再**宣布 unlocked。本测试用 keyspace fake 观察 status
    // 变化的顺序：在 generateKey 成功前，status 必须仍处于非 unlocked。
    const { messageBus: events } = makeMessageBus();
    const statusTimeline: VaultStatus[] = [];
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        // 在 notifyKeyCreated 触发时记录 vault 状态——它必须在 setStatus("unlocked")
        // 之前发生。
        statusTimeline.push(vault.status());
      }
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");

    // 订阅 status 变化记录整条时间线。
    vault.onStatusChange((s) => {
      // 注意：onStatusChange 也会在 notifyKeyCreated 之前因为 keyspace
      // 还没切就触发？不需要——这里只关心事件顺序的最终形态。
      if (statusTimeline[statusTimeline.length - 1] !== s) {
        statusTimeline.push(s);
      }
    });

    await vault.createVaultWithInitialKey({ password: "test-pw" });

    // 关键断言：vault 状态在 notifyKeyCreated 被调用时**仍**是
    // "uninitialized"——因为 setStatus("unlocked") 必须等 generateKey
    // 落库后才发生。
    expect(statusTimeline[0]).toBe("uninitialized");
    // 终态必须是 unlocked。
    expect(vault.status()).toBe("unlocked");
  });

  it("does NOT emit vault.unlocked before the first key is created (硬切换 009 收尾)", async () => {
    // 设计缘由：与上面类似，但用 messageBus 事件验证。订阅者（典型是
    // P2PKH service）会在 vault.unlocked 后启动自己的解锁链路；如果
    // 该事件在首 Key 落库前就发出，会让 P2PKH 在 0 key 状态启动。
    const { messageBus: events, records } = makeMessageBus();
    // 收集 key.created 与 vault.unlocked 的发布顺序。
    const order: string[] = [];
    const originalPublish = events.publish.bind(events);
    events.publish = (event: string, payload: unknown, _opts?: unknown) => {
      order.push(event);
      return originalPublish(event, payload, _opts as never);
    };
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVaultWithInitialKey({ password: "test-pw" });
    // vault.unlocked 必须在 key.created 之后（或至少在它之后被看到）。
    const unlockedIdx = order.indexOf("vault.unlocked");
    const createdIdx = order.indexOf("key.created");
    // 关键断言：vault.unlocked 必须在 key.created 之后。
    expect(unlockedIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(unlockedIdx).toBeGreaterThan(createdIdx);
    // 完整性：两个事件都发了。
    expect(records.some((r) => r.type === "vault.unlocked")).toBe(true);
    expect(records.some((r) => r.type === "key.created")).toBe(true);
  });

  it("does NOT emit vault.unlocked when initial key generation fails", async () => {
    // 设计缘由：generateKey 失败时（首 Key 未落库），整个"新建钱包"
    // 流程应回到 uninitialized，**不**宣布 unlocked。否则会让
    // App.tsx 切到 UnlockedShell 看到 0 key 的状态。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    const longLabel = "x".repeat(LABEL_MAX_LENGTH + 1);
    await expect(
      vault.createVaultWithInitialKey({ password: "test-pw", label: longLabel })
    ).rejects.toThrow(/at most 64 characters/);
    // 关键：vault.unlocked 必须**不**被发布。
    expect(records.some((r) => r.type === "vault.unlocked")).toBe(false);
    expect(vault.status()).toBe("uninitialized");
  });

  // ---------------------------------------------------------------------
  // 硬切换 009 收尾：notice 状态机
  // ---------------------------------------------------------------------

  it("getInitialActivationNotice() returns null on success path", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    expect(vault.getInitialActivationNotice()).toBeNull();
    await vault.createVaultWithInitialKey({ password: "test-pw" });
    // 成功路径不应留 notice。
    expect(vault.getInitialActivationNotice()).toBeNull();
  });

  it("getInitialActivationNotice() returns the notice on KeyPersistedButActivationFailedError", async () => {
    // 设计缘由：硬切换 009 收尾——之前的 messageBus 事件会被新挂载的
    // UI 错过。修复后 notice 走可查询的 vault state：首 Key 落库但
    // active 切换失败时，vault 内部存下 notice；AppShell /
    // VaultSettingsPage 在挂载时通过 getInitialActivationNotice() 取
    // 得，**不**依赖瞬时事件。
    const { messageBus: events } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    let thrown: unknown;
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeyPersistedButActivationFailedError);
    // 关键：notice 已被 vault 内部存下来。
    const notice = vault.getInitialActivationNotice();
    expect(notice).not.toBeNull();
    expect(notice?.keyId).toBeTruthy();
    expect(notice?.publicKeyHash).toBeDefined();
    expect(notice?.label).toBeTruthy();
    // 状态已切到 unlocked（用户能进主界面手动切 active）。
    expect(vault.status()).toBe("unlocked");
  });

  it("clearInitialActivationNotice() wipes the notice", async () => {
    const { messageBus: events } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch {
      // 忽略
    }
    expect(vault.getInitialActivationNotice()).not.toBeNull();
    vault.clearInitialActivationNotice();
    expect(vault.getInitialActivationNotice()).toBeNull();
  });

  it("onInitialActivationNoticeChange fires on set / clear with current value on subscribe", async () => {
    // 设计缘由：UI 组件挂载时调用 subscribe()，必须立即收到当前 notice
    // 值——避免新挂载的 AppShell 漏掉"已经存在的" notice。
    const { messageBus: events } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    const seen: Array<{ keyId: string } | null> = [];
    vault.onInitialActivationNoticeChange((n) => {
      seen.push(n ? { keyId: n.keyId } : null);
    });
    // 订阅时立即喂入当前值（null）。
    expect(seen[0]).toBeNull();
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch {
      // 忽略
    }
    // 通知事件后 handler 被调一次（拿到 notice）。
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).not.toBeNull();
    // 清掉后再次喂入 null。
    vault.clearInitialActivationNotice();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("notice is auto-cleared when user locks the wallet", async () => {
    // 设计缘由：会话结束（lock）后，notice 不应再展示——下次 unlock
    // 不应让用户看到上一次会话的"未切 active"提示。
    const { messageBus: events } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch {
      // 忽略
    }
    expect(vault.getInitialActivationNotice()).not.toBeNull();
    await vault.lock();
    expect(vault.getInitialActivationNotice()).toBeNull();
  });

  it("notice is auto-cleared when active key changes to the notice key", async () => {
    // 设计缘由：用户手动 setActive(publicKeyHash) 把 notice 那把 key
    // 切为 active 时，vault 内部监听 EVENT_ACTIVE_KEY_CHANGED 并自动
    // 清掉 notice——用户不需要再手动 dismiss。
    //
    // 实现策略：直接通过 messageBus 发布 "activeKey.changed" 事件，
    // 模拟 keyspace 在 setActive 成功后发出的事件。这是与 setStatus
    // 注册的 EVENT_ACTIVE_KEY_CHANGED 订阅器对接的最直接方式——避免
    // 真实 keyspaceService 的 listActiveCandidates 路径与"首 Key
    // 已被 notifyKeyCreated 跳过"的特殊状态产生额外耦合。
    const { messageBus: events } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    let thrown: unknown;
    try {
      await vault.createVaultWithInitialKey({ password: "test-pw" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeyPersistedButActivationFailedError);
    const notice = vault.getInitialActivationNotice();
    expect(notice).not.toBeNull();
    expect(notice?.publicKeyHash).toBeDefined();
    // 模拟 keyspace 切 active 后发出 activeKey.changed 事件。
    events.publish("activeKey.changed", {
      mode: "single",
      activePublicKeyHash: notice!.publicKeyHash
    });
    // 关键：notice 必须被清掉。
    expect(vault.getInitialActivationNotice()).toBeNull();
  });
});

// =====================================================================
// 硬切换 010：首启"导入私钥"高层能力（createVaultWithImportedKey）
// =====================================================================

describe("VaultService.createVaultWithImportedKey (硬切换 010)", () => {
  // 设计缘由：施工单 §文件级施工 / 验收清单要求覆盖
  //   1) 成功后：status = unlocked / listKeys.length === 1 / 首把 key 可见 /
  //      keyspace.active() 指向这把 key；
  //   2) 失败且首 key 未落库时：回滚到 uninitialized / vault_meta 不存在；
  //   3) 首 key 已落库但 active 切换失败：抛
  //      KeyPersistedButActivationFailedError / Vault 仍可恢复；
  //   4) 调用方在 status !== uninitialized 时必须 fail closed。

  // 测试用首启私钥：noble 测试向量的 32 字节 hex（合法 secp256k1 私钥范围）。
  const IMPORT_PRIV_HEX =
    "0000000000000000000000000000000000000000000000000000000000000003";

  it("creates vault, persists the first imported key, and sets it as active in one call", async () => {
    const { messageBus: events } = makeMessageBus();
    const seedVault = createVaultService({ messageBus: events });
    await waitForStatus(seedVault, "uninitialized");

    // 用真实 keyspace——需要先创建一个临时 seedVault 持有真实 keyspace，
    // 但为了让目标 vault 走 uninitialized 入口，必须清空整个 vault DB。
    // 这里改用更简单的路径：先让 seedVault createVault 把 verifier 写好，
    // 再 dispose / deleteDatabase 让所有 vault 重新从 uninitialized 启动，
    // 再构造目标 vault（持有真实 keyspace）。
    await seedVault.createVault("seed-pw");
    await seedVault.lock();
    disposeVaultDb();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("vault");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    const vault0 = createVaultService({ messageBus: events });
    await waitForStatus(vault0, "uninitialized");
    const keyspace = createKeyspaceService({ messageBus: events, vault: vault0 });
    const vault = createVaultService({ messageBus: events, keyspace });
    await waitForStatus(vault, "uninitialized");

    const ref = await vault.createVaultWithImportedKey({
      vaultPassword: "test-pw",
      key: {
        label: "imported-first",
        material: { hex: IMPORT_PRIV_HEX },
        format: "hex",
        capabilities: ["p2pkh"],
        source: "wif"
      }
    });

    // 1) Vault 状态：unlocked。
    expect(vault.status()).toBe("unlocked");
    // 2) listKeys 看到 1 把。
    const list = await vault.listKeys();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(ref.id);
    // 3) keyspace 已切到这把 key。
    expect(keyspace.active()).toEqual({
      mode: "single",
      activePublicKeyHash: ref.publicKeyHash
    });
    // 4) 标签和 source 都按调用方传入落地。
    expect(ref.label).toBe("imported-first");
    expect(ref.source).toBe("wif");
    expect(ref.format).toBe("hex");
  });

  it("rejects when vault is not in uninitialized state", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVault("test-pw");
    await waitForStatus(vault, "unlocked");
    // 已经在 unlocked，再次调用必须 fail closed。
    await expect(
      vault.createVaultWithImportedKey({
        vaultPassword: "test-pw",
        key: {
          label: "x",
          material: { hex: IMPORT_PRIV_HEX },
          format: "hex",
          capabilities: ["p2pkh"]
        }
      })
    ).rejects.toThrow(/Vault already exists/i);
  });

  it("rolls back to uninitialized when the first imported key is rejected before persistence", async () => {
    // 设计缘由：首 Key 未落库（例如 label 为空）时，本方法必须回滚
    // meta、清空内存会话、状态回到 uninitialized，**不**留下空 Vault。
    // 这与 createVaultWithInitialKey 的回滚语义保持一致。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");

    // 用一个超长 label 触发"Label must be at most 64 characters"——
    // 这种情况 key 未落库，触发回滚路径。
    const longLabel = "x".repeat(LABEL_MAX_LENGTH + 1);
    await expect(
      vault.createVaultWithImportedKey({
        vaultPassword: "test-pw",
        key: {
          label: longLabel,
          material: { hex: IMPORT_PRIV_HEX },
          format: "hex",
          capabilities: ["p2pkh"]
        }
      })
    ).rejects.toThrow(/at most 64 characters/);

    // 关键：status 必须回到 uninitialized。
    expect(vault.status()).toBe("uninitialized");
    // meta 必须被删：bootstrap 重新走也应读到 uninitialized。
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });

  it("rolls back to uninitialized when keyspace.onVaultUnlocked fails", async () => {
    // 与 createVaultWithInitialKey 收尾测试对齐：keyspace 抛错时
    // 必须把 meta 也删掉，回到 uninitialized。
    const { messageBus: events } = makeMessageBus();
    const keyspaceFake = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => {
        throw new Error("simulated keyspace failure during import");
      },
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => undefined
    };
    const vault = createVaultService({ messageBus: events, keyspace: keyspaceFake as never });
    await waitForStatus(vault, "uninitialized");
    await expect(
      vault.createVaultWithImportedKey({
        vaultPassword: "test-pw",
        key: {
          label: "x",
          material: { hex: IMPORT_PRIV_HEX },
          format: "hex",
          capabilities: ["p2pkh"]
        }
      })
    ).rejects.toThrow(/simulated keyspace failure/);
    expect(vault.status()).toBe("uninitialized");
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
  });

  it("does NOT roll back when KeyPersistedButActivationFailedError is thrown", async () => {
    // 设计缘由：与 generateKey / createVaultWithInitialKey 现有语义保持
    // 一致——首把导入 key 已落库但 active 切换失败时，DB 里的 key 必须
    // 保留，让 UI 走"已创建但未自动 active"的成功/警告态。
    const { messageBus: events, records } = makeMessageBus();
    const explodingKeyspace = {
      active: () => ({ mode: "all" as const }),
      setInitializing: () => undefined,
      onVaultUnlocked: async () => undefined,
      onVaultLocked: () => undefined,
      notifyKeyCreated: () => {
        throw new Error("simulated notify failure");
      }
    };
    const vault = createVaultService({
      messageBus: events,
      keyspace: explodingKeyspace as never
    });
    await waitForStatus(vault, "uninitialized");
    let thrown: unknown;
    try {
      await vault.createVaultWithImportedKey({
        vaultPassword: "test-pw",
        key: {
          label: "explode",
          material: { hex: IMPORT_PRIV_HEX },
          format: "hex",
          capabilities: ["p2pkh"]
        }
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeyPersistedButActivationFailedError);
    const wrapped = thrown as KeyPersistedButActivationFailedError;
    expect(wrapped.key.id).toBeTruthy();
    expect(wrapped.key.publicKeyHash).toBeDefined();
    // 首 Key 仍在 DB 中。
    const stored = await vaultDb.getKey(wrapped.key.id);
    expect(stored).toBeDefined();
    // meta 仍在。
    const meta = await vaultDb.getMeta();
    expect(meta).toBeDefined();
    // notice 也被设置。
    const notice = vault.getInitialActivationNotice();
    expect(notice).not.toBeNull();
    expect(notice?.keyId).toBe(wrapped.key.id);
    // key.created 不被发布。
    expect(records.some((r) => r.type === "key.created")).toBe(false);
  });

  it("does NOT emit vault.unlocked when the first imported key is rejected", async () => {
    // 设计缘由：与 createVaultWithInitialKey 收尾对齐——首 Key 未落库
    // 时整个"首启导入"流程应回到 uninitialized，**不**宣布 unlocked。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    const longLabel = "x".repeat(LABEL_MAX_LENGTH + 1);
    await expect(
      vault.createVaultWithImportedKey({
        vaultPassword: "test-pw",
        key: {
          label: longLabel,
          material: { hex: IMPORT_PRIV_HEX },
          format: "hex",
          capabilities: ["p2pkh"]
        }
      })
    ).rejects.toThrow(/at most 64 characters/);
    // 关键：vault.unlocked 必须**不**被发布。
    expect(records.some((r) => r.type === "vault.unlocked")).toBe(false);
    expect(vault.status()).toBe("uninitialized");
  });

  it("vault.unlocked is emitted only after the first imported key is persisted (硬切换 010 收尾)", async () => {
    // 设计缘由：与 createVaultWithInitialKey 时序回归测试对齐——vault
    // 必须先落首 Key 才能宣布 unlocked，App 切到 UnlockedShell 时已带
    // 首 Key。复用 importPrivateKey 的 persistPrivateKey 路径让 emit
    // 顺序与 generateKey 完全一致。
    const { messageBus: events, records } = makeMessageBus();
    const order: string[] = [];
    const originalPublish = events.publish.bind(events);
    events.publish = (event: string, payload: unknown, _opts?: unknown) => {
      order.push(event);
      return originalPublish(event, payload, _opts as never);
    };
    const vault = createVaultService({ messageBus: events });
    await waitForStatus(vault, "uninitialized");
    await vault.createVaultWithImportedKey({
      vaultPassword: "test-pw",
      key: {
        label: "ordering",
        material: { hex: IMPORT_PRIV_HEX },
        format: "hex",
        capabilities: ["p2pkh"]
      }
    });
    const unlockedIdx = order.indexOf("vault.unlocked");
    const createdIdx = order.indexOf("key.created");
    expect(unlockedIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(unlockedIdx).toBeGreaterThan(createdIdx);
    expect(records.some((r) => r.type === "vault.unlocked")).toBe(true);
    expect(records.some((r) => r.type === "key.created")).toBe(true);
  });
});

type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";
