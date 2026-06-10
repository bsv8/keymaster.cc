// packages/plugin-vault/src/keyspaceService.test.ts
// KeyspaceService 删除流程集成测试（硬切换 008 收尾）。
// 关键不变量：
//   - keyspace.deleteKey 走"prepareDeleteKey（cancelByKey + close handles）-> 删除
//     namespace DB -> vault.deleteKeyMaterial -> emit key.deleted"全流程。
//   - key.deleted 事件在整个流程中**仅发一次**。
//   - background.cancelByKey 在 prepareDeleteKey 阶段被调用；失败必须冒泡以
//     阻止 namespace DB / Vault 私钥被删（fail-closed）。
//   - 删除非 active key 时不切换 active；删除 active key 时切到下一把。
//   - listKeys 现在包含 ready + failed（listManageableKeys）。
//   - deleteKeyById 是管理入口：有 hash 走完整 namespace 清理
//     （cancelByKey + 删 namespace DB + 删私钥材料 + emit key.deleted），
//     无 hash 仅删私钥材料 + emit key.deleted。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageBus } from "@keymaster/runtime";
import type { BackgroundService, KeyIdentity } from "@keymaster/contracts";
import { createKeyspaceService } from "./keyspaceService.js";
import { createVaultService } from "./vaultService.js";
import { disposeVaultDb, vaultDb, type VaultKeyRecord } from "./vaultDb.js";

interface EventRecord {
  type: string;
  payload: unknown;
}

function makeMessageBus(): { messageBus: MessageBus; records: EventRecord[] } {
  const records: EventRecord[] = [];
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  const messageBus: MessageBus = {
    publish(event, payload) {
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

interface FakeBackgroundOptions {
  /** 当 true 时 cancelByKey 抛错（用于 fail-closed 测试）。 */
  failCancel?: boolean;
}

function makeFakeBackground(
  options: FakeBackgroundOptions = {}
): BackgroundService & { cancelByKeyCalls: string[] } {
  const cancelByKeyCalls: string[] = [];
  return {
    cancelByKeyCalls,
    cancelByKey: async (publicKeyHash: string) => {
      cancelByKeyCalls.push(publicKeyHash);
      if (options.failCancel) {
        throw new Error("simulated cancelByKey failure");
      }
    },
    listSnapshots: () => [],
    onChange: () => () => undefined,
    trigger: () => undefined,
    pause: async () => undefined,
    resume: () => undefined,
    cancel: async () => undefined,
    retry: () => undefined
  };
}

async function resetDb(): Promise<void> {
  disposeVaultDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("vault");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await resetDb();
});

/** 直接在 vaultDb 预填一把"已 backfill"的 ready key（绕开 unlock）。 */
async function seedReadyKey(input: {
  id: string;
  label: string;
  publicKeyHash: string;
}): Promise<void> {
  await vaultDb.putKey({
    id: input.id,
    label: input.label,
    address: "",
    network: "main",
    format: "hex",
    capabilities: ["p2pkh"],
    createdAt: "2024-01-01T00:00:00.000Z",
    cipherSaltB64: "00",
    cipherIvB64: "00",
    cipherB64: "00",
    publicKeyHex: "00",
    publicKeyHash: input.publicKeyHash,
    fingerprint: input.publicKeyHash.slice(0, 4) + ".." + input.publicKeyHash.slice(-4),
    identityStatus: "ready"
  });
}

/** 直接在 vaultDb 预填一把 failed-identity key（publicKeyHash 缺省）。 */
async function seedFailedKey(input: { id: string; label: string }): Promise<void> {
  await vaultDb.putKey({
    id: input.id,
    label: input.label,
    address: "",
    network: "main",
    format: "hex",
    capabilities: ["p2pkh"],
    createdAt: "2024-01-01T00:00:00.000Z",
    cipherSaltB64: "00",
    cipherIvB64: "00",
    cipherB64: "00",
    identityStatus: "failed",
    identityError: "simulated backfill failure"
  });
}

describe("keyspaceService.deleteKey (硬切换 008)", () => {
  it("emits key.deleted exactly once and calls background.cancelByKey", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedReadyKey({ id: "k1", label: "test", publicKeyHash: "a".repeat(64) });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });

    await keyspace.setActive("a".repeat(64));
    const deletedBefore = records.filter((r) => r.type === "key.deleted").length;
    expect(deletedBefore).toBe(0);

    await keyspace.deleteKey("a".repeat(64));

    // 1) cancelByKey 被调。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["a".repeat(64)]);
    // 2) key.deleted 事件恰好发一次。
    const deletedAfter = records.filter((r) => r.type === "key.deleted").length;
    expect(deletedAfter).toBe(1);
    // 3) vaultDb 中 key 已删。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.id === "k1")).toBeUndefined();
  });

  it("does not throw if background is not attached", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedReadyKey({ id: "k1", label: "test", publicKeyHash: "a".repeat(64) });
    // 不传 background，模拟未 attach 的场景。
    const keyspace = createKeyspaceService({ messageBus: events, vault });

    await keyspace.setActive("a".repeat(64));
    await keyspace.deleteKey("a".repeat(64));

    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
  });
});

describe("keyspaceService.prepareDeleteKey fail-closed (硬切换 008 收尾)", () => {
  it("aborts delete when background.cancelByKey throws", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedReadyKey({ id: "k1", label: "test", publicKeyHash: "a".repeat(64) });
    const fakeBackground = makeFakeBackground({ failCancel: true });
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive("a".repeat(64));

    // cancelByKey 抛错 → deleteKey 必须 reject，namespace DB 与 Vault 私钥都保留。
    await expect(keyspace.deleteKey("a".repeat(64))).rejects.toThrow(/simulated cancelByKey failure/);

    // 1) cancelByKey 被调过。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["a".repeat(64)]);
    // 2) namespace DB 未被删：registeredStorages 此时为空，所以这一断言退化为
    //    "没异常"；由 deleteDatabase 路径测覆盖。这里只断言 key 未删。
    // 3) Vault 私钥材料仍在。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.id === "k1")).toBeDefined();
    // 4) 不发 key.deleted。
    expect(records.some((r) => r.type === "key.deleted")).toBe(false);
    // 5) 也不再发 key.delete.background-failed（fail-closed 之后没有"保险 emit"）。
    expect(records.some((r) => r.type === "key.delete.background-failed")).toBe(false);
  });
});

describe("keyspaceService.listKeys (硬切换 008 收尾)", () => {
  it("includes failed-identity keys with identityStatus=failed", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedReadyKey({ id: "k-ok", label: "ok", publicKeyHash: "b".repeat(64) });
    // 失败的 key 也可以有 publicKeyHash：backfill 出了 hash 但 mark failed。
    // 这种情况必须出现在 listKeys，让 UI 显示"身份失败，可删除"；
    // 同时 deleteKey(publicKeyHash) 会被 listActiveCandidates 过滤掉，只能
    // 走 deleteKeyById 路径。
    await vaultDb.putKey({
      id: "k-fail",
      label: "fail",
      address: "",
      network: "main",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00",
      publicKeyHex: "00",
      publicKeyHash: "c".repeat(64),
      fingerprint: "cccc..cccc",
      identityStatus: "failed",
      identityError: "simulated"
    });
    const keyspace = createKeyspaceService({ messageBus: events, vault });

    const all: KeyIdentity[] = await keyspace.listKeys();
    const ids = all.map((k) => k.keyId);
    // 收尾后 ready + failed 都要出现，failed 通过 identityStatus 区分。
    expect(ids).toContain("k-ok");
    expect(ids).toContain("k-fail");
    const failed = all.find((k) => k.keyId === "k-fail");
    expect(failed?.identityStatus).toBe("failed");
  });

  it("lists failed keys without publicKeyHash for management", async () => {
    // 收尾：没有 publicKeyHash 的 failed key 也必须在 listKeys 暴露，
    // UI 才能在 VaultSettingsPage 显示"身份失败，可删除"。它们走
    // deleteKeyById(keyId) 清理，不会被 setActive / deleteKey(hash) 误选。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedFailedKey({ id: "k-fail-no-hash", label: "no-hash" });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    const all = await keyspace.listKeys();
    const failed = all.find((k) => k.keyId === "k-fail-no-hash");
    expect(failed).toBeDefined();
    expect(failed?.identityStatus).toBe("failed");
    expect(failed?.publicKeyHash).toBeUndefined();
    // 无 hash 的 failed key 天然不能 setActive（listActiveCandidates 已过滤）。
    await expect(keyspace.setActive("" as string)).rejects.toBeTruthy();
    // 但 deleteKeyById 可以删它。
    await keyspace.deleteKeyById("k-fail-no-hash");
    const remaining = await keyspace.listKeys();
    expect(remaining.find((k) => k.keyId === "k-fail-no-hash")).toBeUndefined();
  });

  it("setActive rejects failed key (filters via listActiveCandidates)", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    // 制造一把"有 hash 但 identityStatus=failed"的 key——listActiveCandidates 必须过滤。
    await vaultDb.putKey({
      id: "k-fail-hash",
      label: "fail",
      address: "",
      network: "main",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00",
      publicKeyHex: "00",
      publicKeyHash: "c".repeat(64),
      fingerprint: "cccc..cccc",
      identityStatus: "failed",
      identityError: "simulated"
    });
    const keyspace = createKeyspaceService({ messageBus: events, vault });

    await expect(keyspace.setActive("c".repeat(64))).rejects.toThrow(/not found/i);
  });

  it("setActive rejects unknown publicKeyHash", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await expect(keyspace.setActive("d".repeat(64))).rejects.toThrow(/not found/i);
  });
});

describe("keyspaceService.deleteKeyById (硬切换 008 收尾)", () => {
  it("deletes a failed-identity key by keyId without cancelByKey", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedFailedKey({ id: "k-fail", label: "fail" });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });

    await keyspace.deleteKeyById("k-fail");

    // 1) cancelByKey 未被调（无 hash 不走 background cancel）。
    expect(fakeBackground.cancelByKeyCalls).toEqual([]);
    // 2) vaultDb 中 key 已删。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.id === "k-fail")).toBeUndefined();
    // 3) key.deleted 恰发一次，payload 带 keyId。
    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
    const payload = deleted[0]?.payload as { keyId?: string; publicKeyHash?: string } | undefined;
    expect(payload?.keyId).toBe("k-fail");
    expect(payload?.publicKeyHash).toBeUndefined();
  });

  it("throws when keyId not found", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await expect(keyspace.deleteKeyById("missing")).rejects.toThrow(/not found/i);
  });

  it("delegates to deleteKey when publicKeyHash is present", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedReadyKey({ id: "k1", label: "test", publicKeyHash: "a".repeat(64) });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive("a".repeat(64));

    await keyspace.deleteKeyById("k1");

    // 1) 走完整路径：cancelByKey 被调。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["a".repeat(64)]);
    // 2) vaultDb 中 key 已删。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.id === "k1")).toBeUndefined();
    // 3) key.deleted 恰发一次，payload 带 publicKeyHash + keyId。
    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
    const payload = deleted[0]?.payload as { keyId?: string; publicKeyHash?: string } | undefined;
    expect(payload?.keyId).toBe("k1");
    expect(payload?.publicKeyHash).toBe("a".repeat(64));
  });

  it("deletes a failed key that still has publicKeyHash (full namespace cleanup)", async () => {
    // 高优先级修复：identityStatus="failed" + 仍有 publicKeyHash 的 key
    // 必须能通过 deleteKeyById(keyId) 删除。之前 deleteKey(hash) 走
    // listActiveCandidates 会过滤掉 failed，UI 上这类 key 删不掉。
    // deleteKeyById 现在走 deleteKeyRecord（不依赖 listActiveCandidates），
    // 因此 failed+hash 也能走完整 namespace 清理。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    // 预填一把 failed 但有 hash 的 key（模拟 backfill 后又失败的情况）。
    await vaultDb.putKey({
      id: "k-fail-hash",
      label: "fail-with-hash",
      address: "",
      network: "main",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      cipherSaltB64: "00",
      cipherIvB64: "00",
      cipherB64: "00",
      publicKeyHex: "00",
      publicKeyHash: "c".repeat(64),
      fingerprint: "cccc..cccc",
      identityStatus: "failed",
      identityError: "simulated"
    });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });

    // deleteKey(publicKeyHash) 仍然拒绝（保持 ready-only 语义）。
    await expect(keyspace.deleteKey("c".repeat(64))).rejects.toThrow(/not found/i);

    // deleteKeyById(keyId) 必须能删。
    await keyspace.deleteKeyById("k-fail-hash");

    // 1) cancelByKey 被调（有 hash 走 background cancel）。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["c".repeat(64)]);
    // 2) vaultDb 中 key 已删。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.id === "k-fail-hash")).toBeUndefined();
    // 3) key.deleted 恰发一次，payload 同时带 keyId 和 publicKeyHash。
    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
    const payload = deleted[0]?.payload as { keyId?: string; publicKeyHash?: string } | undefined;
    expect(payload?.keyId).toBe("k-fail-hash");
    expect(payload?.publicKeyHash).toBe("c".repeat(64));
  });
});

// 占位：seedKeyWithIdentity 旧 helper 不再使用；保留引用以便审计。
void (null as unknown as VaultKeyRecord);
