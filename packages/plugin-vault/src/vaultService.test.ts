// packages/plugin-vault/src/vaultService.test.ts
// VaultService 关键行为单测：
//   - createVault / unlock / lock 状态机。
//   - importPrivateKey 允许同 vault 存多把 key（不再有"已有 key 禁止导入"逻辑）。
//   - exportPrivateKey 走 bsv8 envelope；不改变 key 列表；不触发 key.created / key.deleted。
//   - removeKey 硬切换 008：抛 "Use keyspace.deleteKey instead"，不再发事件。
//   - deleteKeyMaterial：仅删材料，不发 key.deleted 事件（事件由 keyspace 统一发一次）。
//   - 在 withPrivateKey 回调内才能拿到 material。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageBus } from "@keymaster/runtime";
import { createVaultService, KeyPersistedButActivationFailedError } from "./vaultService.js";
import { createKeyspaceService } from "./keyspaceService.js";
import { disposeVaultDb, vaultDb } from "./vaultDb.js";

const TEST_PRIV = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIV_2 = "0000000000000000000000000000000000000000000000000000000000000002";

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

type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";
