// packages/plugin-vault/src/keyspaceService.test.ts
// KeyspaceService 删除流程集成测试（硬切换 008 + 硬切换 002 收尾）。
// 关键不变量：
//   - keyspace.deleteKey 入口**第一步**必须是
//     vault.verifyPassword(password)；密码错误 fail closed：不发
//     `key.deleting / key.deleted`、不取消 background、不删 namespace DB
//     与私钥（硬切换 002）。
//   - 走"prepareDeleteKey（cancelByKey + close handles）-> 删除 namespace
//     DB -> vault.deleteKeyMaterial -> emit key.deleted"全流程。
//   - key.deleted 事件 payload 仅携带 publicKeyHex（硬切换 002 收尾）。
//   - key.deleted 事件在整个流程中**仅发一次**。
//   - background.cancelByKey 在 prepareDeleteKey 阶段被调用；失败必须冒泡以
//     阻止 namespace DB / Vault 私钥被删（fail-closed）。
//   - 删除非 active key 时不切换 active；删除 active key 时切到下一把。
//   - 系统中不再存在 failed/uninitialized 稳态：所有 key 一律 ready +
//     publicKeyHex，listKeys 即 listManageableKeys。
//   - 删空最后一把 key 后必须调 vault.finalizeEmptyVaultAfterLastKeyDeletion
//     把 Vault 收回 uninitialized（硬切换 002）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageBus } from "@keymaster/runtime";
import type { BackgroundService, KeyIdentity } from "@keymaster/contracts";
import { createKeyspaceService } from "./keyspaceService.js";
import { createVaultService } from "./vaultService.js";
import { disposeVaultDb, vaultDb, type VaultKeyRecord } from "./vaultDb.js";

/** 测试用统一锁屏密码——seedVaultMeta / deleteKey 都用这个。 */
const TEST_PASSWORD = "test-pw";

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
    cancelByKey: async (publicKeyHex: string) => {
      cancelByKeyCalls.push(publicKeyHex);
      if (options.failCancel) {
        throw new Error("simulated cancelByKey failure");
      }
    },
    listSnapshots: () => [],
    onChange: () => () => undefined,
    trigger: () => undefined,
    cancel: async () => undefined,
    runNow: () => undefined,
    getScheduleSettings: () => ({ assetHoldingsIntervalMs: 900_000 }),
    updateScheduleSettings: () => undefined
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

/** 等待 vaultService.bootstrap() 完成。 */
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

/**
 * 硬切换 002 测试基础：建一把真正的空 Vault 并 unlock，让
 * `vault.verifyPassword(TEST_PASSWORD)` 能通过。所有 keyspace.delete*
 * 测试都需要在此之后再 seed key——直接 putKey 不动 meta，verifier
 * 仍由 createVault 写入的真实密码维持。
 */
async function seedVault(
  vault: ReturnType<typeof createVaultService>
): Promise<void> {
  await waitForStatus(vault, "uninitialized");
  await vault.createVault(TEST_PASSWORD);
  await waitForStatus(vault, "unlocked");
}

/** 直接在 vaultDb 预填一把"已 backfill"的 ready key（绕开 unlock）。 */
async function seedReadyKey(input: { publicKeyHex: string;
  label: string;
}): Promise<void> {
  await vaultDb.putKey({
    publicKeyHex: input.publicKeyHex,
    label: input.label,
    address: "",
    network: "main",
    format: "hex",
    capabilities: ["p2pkh"],
    createdAt: "2024-01-01T00:00:00.000Z",
    cipherSaltB64: "00",
    cipherIvB64: "00",
    cipherB64: "00"
  });
}

/**
 * 硬切换 002 收尾：不再有 "failed key" 稳态，所有 key 一律 ready +
 * publicKeyHex；以下所有 deleteKey 测试一律按 ready key 路径走，不再
 * 构造 `identityStatus=failed` 或 no-hash 记录。
 */

describe("keyspaceService.deleteKey (硬切换 008 + 002 密码鉴权)", () => {
  it("emits key.deleted exactly once and calls background.cancelByKey", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events, sessionCryptoEngineOptions: { allowLocalEngineForTests: true, mode: "appview" } });
    await seedVault(vault);
    // 多 seed 一把 key，避免删完后触发"空 Vault 收尾"路径，让本测试
    // 只覆盖 active fallback / 单 key 删除的事件语义。
    await seedReadyKey({ label: "test", publicKeyHex: "a".repeat(64) });
    await seedReadyKey({ label: "keep", publicKeyHex: "b".repeat(64) });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });

    await keyspace.setActive("a".repeat(64));
    const deletedBefore = records.filter((r) => r.type === "key.deleted").length;
    expect(deletedBefore).toBe(0);

    await keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD });

    // 1) cancelByKey 被调。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["a".repeat(64)]);
    // 2) key.deleted 事件恰好发一次，payload 仅含 publicKeyHex。
    const deletedAfter = records.filter((r) => r.type === "key.deleted").length;
    expect(deletedAfter).toBe(1);
    const deletedPayload = records.find((r) => r.type === "key.deleted")?.payload as
      | { publicKeyHex?: string }
      | undefined;
    expect(deletedPayload?.publicKeyHex).toBe("a".repeat(64));
    // 3) vaultDb 中 key 已删，但 keep key 仍在。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.publicKeyHex === "a".repeat(64))).toBeUndefined();
    expect(remaining.find((r) => r.publicKeyHex === "b".repeat(64))).toBeDefined();
    // 4) Vault 仍保持 unlocked（还有 key）。
    expect(vault.status()).toBe("unlocked");
  });

  it("does not throw if background is not attached", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "test", publicKeyHex: "a".repeat(64) });
    await seedReadyKey({ label: "keep", publicKeyHex: "b".repeat(64) });
    // 不传 background，模拟未 attach 的场景。
    const keyspace = createKeyspaceService({ messageBus: events, vault });

    await keyspace.setActive("a".repeat(64));
    await keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD });

    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
  });

  it("rejects with Invalid password and does NOT start the delete pipeline", async () => {
    // 硬切换 002：密码错时**完全不开始**——不发 key.deleting / key.deleted、
    // 不取消 background、不删 namespace DB、不删私钥。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "test", publicKeyHex: "a".repeat(64) });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive("a".repeat(64));

    await expect(
      keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: "wrong-pw" })
    ).rejects.toThrow(/Invalid password/);

    // 1) cancelByKey 未被调。
    expect(fakeBackground.cancelByKeyCalls).toEqual([]);
    // 2) 不发 key.deleting / key.deleted。
    expect(records.some((r) => r.type === "key.deleting")).toBe(false);
    expect(records.some((r) => r.type === "key.deleted")).toBe(false);
    // 3) key 仍在。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.publicKeyHex === "a".repeat(64))).toBeDefined();
    // 4) Vault 状态不变。
    expect(vault.status()).toBe("unlocked");
  });
});

describe("keyspaceService.prepareDeleteKey fail-closed (硬切换 008 收尾)", () => {
  it("aborts delete when background.cancelByKey throws", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "test", publicKeyHex: "a".repeat(64) });
    const fakeBackground = makeFakeBackground({ failCancel: true });
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive("a".repeat(64));

    // cancelByKey 抛错 → deleteKey 必须 reject，namespace DB 与 Vault 私钥都保留。
    await expect(
      keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD })
    ).rejects.toThrow(/simulated cancelByKey failure/);

    // 1) cancelByKey 被调过。
    expect(fakeBackground.cancelByKeyCalls).toEqual(["a".repeat(64)]);
    // 2) namespace DB 未被删：registeredStorages 此时为空，所以这一断言退化为
    //    "没异常"；由 deleteDatabase 路径测覆盖。这里只断言 key 未删。
    // 3) Vault 私钥材料仍在。
    const remaining = await vaultDb.listKeys();
    expect(remaining.find((r) => r.publicKeyHex === "a".repeat(64))).toBeDefined();
    // 4) 不发 key.deleted。
    expect(records.some((r) => r.type === "key.deleted")).toBe(false);
    // 5) 也不再发 key.delete.background-failed（fail-closed 之后没有"保险 emit"）。
    expect(records.some((r) => r.type === "key.delete.background-failed")).toBe(false);
  });
});

describe("keyspaceService.listKeys (硬切换 002 收尾)", () => {
  // 硬切换 002 收尾：所有 key 一律 ready + publicKeyHex；listKeys 与
  // listActiveCandidates 等价，不再需要 failed / no-hash 过滤分支。

  it("setActive rejects unknown publicKeyHex", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await expect(keyspace.setActive("d".repeat(64))).rejects.toThrow(/not found/i);
  });
});

// =====================================================================
// 硬切换 002：删空最后一把 Key 后回到 uninitialized
// =====================================================================

describe("keyspaceService delete -> empty-vault finalize (硬切换 002)", () => {
  it("deleting non-last ready key keeps Vault unlocked and falls back active to next ready", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "a", publicKeyHex: "a".repeat(64) });
    await seedReadyKey({ label: "b", publicKeyHex: "b".repeat(64) });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await keyspace.setActive("a".repeat(64));

    await keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD });

    // Vault 仍 unlocked。
    expect(vault.status()).toBe("unlocked");
    // active 切到 k-b。
    const next = keyspace.active();
    // 硬切换 005：active state 不再有 `mode` 字段；这里只断言
    // activePublicKeyHex 指向 k-b。
    expect(next.activePublicKeyHex).toBe("b".repeat(64));
    // vault_meta 仍在。
    expect(await vaultDb.getMeta()).toBeDefined();
  });

  it("deleting the LAST key collapses Vault to uninitialized and wipes vault_meta", async () => {
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "only", publicKeyHex: "a".repeat(64) });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await keyspace.setActive("a".repeat(64));

    await keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD });

    // 1) key.deleted 仍恰好发一次（先删 key 材料 + emit，再 finalize）。
    const deleted = records.filter((r) => r.type === "key.deleted");
    expect(deleted).toHaveLength(1);
    // 2) Vault 状态最终是 uninitialized，不是 locked 也不是仅 active=all。
    expect(vault.status()).toBe("uninitialized");
    // 3) vault_meta 已删——新实例 bootstrap 也读到 uninitialized。
    expect(await vaultDb.getMeta()).toBeUndefined();
    const fresh = createVaultService({ messageBus: events });
    await waitForStatus(fresh, "uninitialized");
    // 4) finalize 期间 emit 过 vault.locked，方便订阅者清理会话内存。
    expect(records.some((r) => r.type === "vault.locked")).toBe(true);
  });

  it("namespace DB blocked: keeps private key AND does NOT finalize Vault", async () => {
    // 施工单 §情况 2：namespace DB 删除 blocked / timeout 时，密码正确
    // 也不能继续删私钥；同样必须不 finalize Vault。
    //
    // 实现：registerPluginStorage 注册一个名字，再手动打开一个同名
    // IndexedDB 让 deleteDatabase 进入 onblocked。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    await seedReadyKey({ label: "only", publicKeyHex: "a".repeat(64) });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    keyspace.registerPluginStorage({ pluginId: "test-plugin", storageId: "store" });
    await keyspace.setActive("a".repeat(64));

    // 在外部打开同名 DB 让 deleteDatabase 进入 blocked（不关闭句柄）。
    const dbName = `keymaster.key.${"a".repeat(64)}.plugin.test-plugin.store`;
    const holder = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("kv")) {
          req.result.createObjectStore("kv");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    try {
      await expect(
        keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD })
      ).rejects.toThrow(/blocked|timed out|Failed to delete namespace/i);
      // 1) 私钥仍在。
      const remaining = await vaultDb.listKeys();
      expect(remaining.find((r) => r.publicKeyHex === "a".repeat(64))).toBeDefined();
      // 2) vault_meta 仍在；Vault 不被 finalize。
      expect(await vaultDb.getMeta()).toBeDefined();
      expect(vault.status()).toBe("unlocked");
      // 3) 没发 key.deleted。
      expect(records.some((r) => r.type === "key.deleted")).toBe(false);
    } finally {
      holder.close();
    }
  });
});

// =====================================================================
// 硬切换 010：删空最后一把 key 后必须 uninitialized——空 Vault 终态回归
// =====================================================================

describe("keyspaceService delete-last-key -> uninitialized (硬切换 010)", () => {
  // 设计缘由：施工单 §"特殊情况提前约定 情况 6" 明确：删除最后一把 key
  // 后系统锁屏密码必须一起消失，状态回到 uninitialized，下一次导入或
  // 新建必须重新决定系统锁屏密码。这与已存在的 keyspaceService 测试
  // "deleting the LAST key collapses Vault to uninitialized and wipes
  // vault_meta" 共同覆盖——下面这条新增测试断言新增的"下一轮必须重新
  // 决定密码"语义：删空后用新实例 bootstrap 仍然读到 uninitialized，
  // 此时再 createVault 不会被旧的 verifier 影响。

  it("deleting the last key resets to uninitialized and a new createVaultWithImportedKey is required for next setup", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events, sessionCryptoEngineOptions: { allowLocalEngineForTests: true, mode: "appview" } });
    await seedVault(vault);
    await seedReadyKey({ label: "only", publicKeyHex: "a".repeat(64) });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await keyspace.setActive("a".repeat(64));

    // 删除唯一一把 key。
    await keyspace.deleteKey({ publicKeyHex: "a".repeat(64), password: TEST_PASSWORD });
    expect(vault.status()).toBe("uninitialized");
    expect(await vaultDb.getMeta()).toBeUndefined();

    // 关键：下一次"新建"或"导入"必须重新决定系统锁屏密码——也就是
    // 必须能再走一次 createVaultWithImportedKey 拿到一把 key。这里用
    // 真实公钥对测试私钥。
    const IMPORT_PRIV =
      "0000000000000000000000000000000000000000000000000000000000000003";
    const ref = await vault.createVaultWithImportedKey({
      vaultPassword: "fresh-pw",
      key: {
        label: "fresh-imported",
        material: { hex: IMPORT_PRIV },
        format: "hex",
        capabilities: ["p2pkh"]
      }
    });
    expect(ref.publicKeyHex).toBeTruthy();
    expect(vault.status()).toBe("unlocked");
    // 旧密码已不再可用——用 seedVault 留下的 TEST_PASSWORD 调用
    // verifyPassword 必须抛错，证明旧锁屏密码已彻底消失。
    await expect(vault.verifyPassword(TEST_PASSWORD)).rejects.toThrow(/Invalid password/);
    // 新密码可用。
    await vault.verifyPassword("fresh-pw");
  });
});

// =====================================================================
// 硬切换 004：active 切换 / Vault 锁定共用 namespace quiesce 语义
// =====================================================================

describe("keyspaceService.setActive / onVaultLocked quiesce order (硬切换 004)", () => {
  // 设计缘由：硬切换 004 把 active 切换、Vault 锁定、删除 key 三条
  // 路径统一收口到 namespace quiesce 语义——先 cancelByKey + await
  // 旧 task 退出，再关 DB，最后才推进 active / 发布事件。本组测试
  // 用同步 record 的 fake background 来观察顺序：
  //   1) setActive(B) 必须先 cancelByKey(A)，再 setActiveInternal(B)；
  //   2) onVaultLocked() 必须先 cancelByKey(active)，再清 active；
  //   3) setActive 重复切到当前 active 必须 no-op；
  //   4) cancelByKey 抛错必须冒泡——禁止在 setActive / onVaultLocked
  //      内部 catch 成"已切换 active"。
  // 不变量要直接覆盖 history-backfill 撞 `database connection is
  // closing` 这条根本链路——只要"先 cancel 再关 DB"的顺序破了，这条
  // 路径就还会出错。

  it("setActive(B) cancels A's tasks before closing A's openDbs and switching active", async () => {
    // 1) 起一个 slow cancelByKey（挂 50ms 才 resolve），观察 setActive
    //    在 cancelByKey resolve 前是否已经 setActiveInternal。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    await seedReadyKey({ label: "b", publicKeyHex: hashB });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    // 2) 直接 open A 的 namespace DB 模拟业务插件缓存。
    const storageKeyA = keyspace.openKeyStorage({
      publicKeyHex: hashA,
      pluginId: "p2pkh",
      storageId: "main",
      version: 1,
      upgrade: () => undefined
    });
    await storageKeyA;

    // 3) 标记 setActiveInternal 的发生点：通过 activeKey.changed 事件
    //    反向观察 setActive 何时跨过 active 切换边界。
    let activeChangedAt = -1;
    let cancelResolvedAt = -1;
    let counter = 0;
    const originalCancel = fakeBackground.cancelByKey;
    fakeBackground.cancelByKey = async (h: string) => {
      await originalCancel(h);
      cancelResolvedAt = counter++;
      // 模拟 background 内部等待旧 task 退出（这里就是 cancelByKey resolve）。
    };
    events.subscribe("activeKey.changed", () => {
      activeChangedAt = counter++;
    });

    await keyspace.setActive(hashB);

    // 4) cancelByKey 必须先于 activeKey.changed。
    expect(cancelResolvedAt).toBeGreaterThanOrEqual(0);
    expect(activeChangedAt).toBeGreaterThanOrEqual(0);
    expect(cancelResolvedAt).toBeLessThan(activeChangedAt);
    // 5) setActive(B) 之后 active 必须是 B。
    expect(keyspace.active().activePublicKeyHex).toBe(hashB);
    // 6) cancelByKey 被调过一次，且参数是 A（旧 active）。
    expect(fakeBackground.cancelByKeyCalls).toContain(hashA);
    // 7) A 的 openDb 应该已被 quiesceNamespace 关掉（cache 中没有 A）。
    //    这里仅断言 B 能正常 open——间接证明 keyspace state 没坏。
    const reopened = await keyspace.openKeyStorage({
      publicKeyHex: hashB,
      pluginId: "p2pkh",
      storageId: "main",
      version: 1,
      upgrade: () => undefined
    });
    expect(reopened).toBeDefined();
    expect(records.some((r) => r.type === "activeKey.changed")).toBe(true);
  });

  it("setActive(currentActive) is a no-op (no cancel, no close, no second active event)", async () => {
    // 硬切换 004 情况 4：重复切到当前 active key 不应触发 cancel /
    // close，也不应重发 activeKey.changed，避免打断正在跑的同步任务。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);
    const before = fakeBackground.cancelByKeyCalls.length;
    const activeChangedBefore = records.filter((r) => r.type === "activeKey.changed").length;
    await keyspace.setActive(hashA);
    expect(fakeBackground.cancelByKeyCalls.length).toBe(before);
    const activeChangedAfter = records.filter((r) => r.type === "activeKey.changed").length;
    expect(activeChangedAfter).toBe(activeChangedBefore);
  });

  it("onVaultLocked() awaits cancelByKey(active) before clearing active", async () => {
    // 硬切换 004：onVaultLocked 必须先 await cancelByKey(active) resolve
    // 再清 active；否则下游 vaultService.lock 在 publish vault.locked
    // 之前，namespace DB 还在被未退出的 task 持有。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    let cancelResolvedAt = -1;
    let activeClearedAt = -1;
    let counter = 0;
    const originalCancel = fakeBackground.cancelByKey;
    fakeBackground.cancelByKey = async (h: string) => {
      await originalCancel(h);
      cancelResolvedAt = counter++;
    };
    // active 状态清空通过 activeKey.changed 事件观察。
    events.subscribe("activeKey.changed", (payload) => {
      if (!(payload as { activePublicKeyHex?: string }).activePublicKeyHex) {
        activeClearedAt = counter++;
      }
    });

    await keyspace.onVaultLocked();

    // 1) cancelByKey 必须先于 active 清空。
    expect(cancelResolvedAt).toBeGreaterThanOrEqual(0);
    expect(activeClearedAt).toBeGreaterThanOrEqual(0);
    expect(cancelResolvedAt).toBeLessThan(activeClearedAt);
    // 2) active 已清空。
    expect(keyspace.active().activePublicKeyHex).toBeUndefined();
    // 3) cancelByKey 参数是 A。
    expect(fakeBackground.cancelByKeyCalls).toContain(hashA);
  });

  it("onVaultLocked() with no active key still resolves (no cancel called)", async () => {
    // 硬切换 004 情况 3：没有 active key 时 onVaultLocked 必须直接
    // 关 openDbs + 清 active；调 background.cancelByKey 应被跳过。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await expect(keyspace.onVaultLocked()).resolves.toBeUndefined();
    expect(fakeBackground.cancelByKeyCalls).toEqual([]);
    expect(keyspace.active().activePublicKeyHex).toBeUndefined();
  });

  it("prepareDeleteKey() and setActive() reuse the same quiesce helper", async () => {
    // 硬切换 004：删除 key 路径不能继续手写"先 cancel 再 close"。本
    // 测试用同一个 fake background 走两条路径，断言它们都触发了
    // cancelByKey(hash) 并完成了后续顺序——证明两条路径共用同一条
    // namespace quiesce 语义。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    await seedReadyKey({ label: "b", publicKeyHex: hashB });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    // 1) setActive(B) 触发 cancelByKey(A)。
    await keyspace.setActive(hashB);
    expect(fakeBackground.cancelByKeyCalls).toContain(hashA);

    // 2) prepareDeleteKey(A) 也走同一条路径：cancelByKey(A)。
    const callsBefore = fakeBackground.cancelByKeyCalls.length;
    await keyspace.prepareDeleteKey(hashA);
    expect(fakeBackground.cancelByKeyCalls.length).toBeGreaterThan(callsBefore);
    expect(fakeBackground.cancelByKeyCalls[fakeBackground.cancelByKeyCalls.length - 1]).toBe(hashA);
  });

  it("setActive() fails closed when cancelByKey throws (does not switch active)", async () => {
    // 硬切换 004：cancelByKey 抛错时，setActive 必须冒泡——禁止 catch
    // 后继续 setActiveInternal；那样会让 active 切到目标 key，但旧 key
    // 的 task 仍在跑，竞态原封不动留下来。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    await seedReadyKey({ label: "b", publicKeyHex: hashB });
    const fakeBackground = makeFakeBackground({ failCancel: true });
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    await expect(keyspace.setActive(hashB)).rejects.toThrow(/simulated cancelByKey failure/);
    // active 必须仍是 A——setActiveInternal 不能在 cancelByKey 失败后
    // 仍然执行。
    expect(keyspace.active().activePublicKeyHex).toBe(hashA);
  });

  it("activateCreatedKey(NewKey) cancels old active's tasks before switching active (硬切换 004 收尾)", async () => {
    // 设计缘由：vaultService 在 importPrivateKey / generateKey 后会
    // 调 notifyKeyCreated -> activateCreatedKey 把新 key 切为 active。
    // 这条"自动激活"路径必须与手动 setActive 共用同一条 namespace
    // quiesce 语义——否则旧 key 的 history-backfill 仍在跑就被踢出
    // namespace，复现 `database connection is closing` 竞态。
    const { messageBus: events, records } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    await seedReadyKey({ label: "b", publicKeyHex: hashB });
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    let cancelResolvedAt = -1;
    let activeChangedAt = -1;
    let counter = 0;
    const originalCancel = fakeBackground.cancelByKey;
    fakeBackground.cancelByKey = async (h: string) => {
      await originalCancel(h);
      cancelResolvedAt = counter++;
    };
    events.subscribe("activeKey.changed", () => {
      activeChangedAt = counter++;
    });

    await keyspace.activateCreatedKey({
      label: "b",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString()
,
      publicKeyHex: hashB    });

    // 1) cancelByKey(A) 必须先于 activeKey.changed。
    expect(cancelResolvedAt).toBeGreaterThanOrEqual(0);
    expect(activeChangedAt).toBeGreaterThanOrEqual(0);
    expect(cancelResolvedAt).toBeLessThan(activeChangedAt);
    // 2) activateCreatedKey 调用过 cancelByKey(A)。
    expect(fakeBackground.cancelByKeyCalls).toContain(hashA);
    // 3) active 切到了新 key。
    expect(keyspace.active().activePublicKeyHex).toBe(hashB);
    // 4) activeKey.changed 事件至少发了一次。
    expect(records.some((r) => r.type === "activeKey.changed")).toBe(true);
  });

  it("activateCreatedKey() returns a Promise (硬切换 004 收尾)", async () => {
    // 设计缘由：vaultService.persistPrivateKey 现在 await
    // notifyKeyCreated；如果 activateCreatedKey 不返回 Promise，
    // 那个 await 就只是同步拿个 void、cancelByKey 没真正等。
    // 本测试断言 KeyspaceHandle.activateCreatedKey 的运行时类型是
    // async function，避免被悄悄改成 sync。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    const ret = keyspace.activateCreatedKey({
      label: "x",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString()
,
      publicKeyHex: "c".repeat(64)    });
    expect(ret).toBeInstanceOf(Promise);
    await ret;
  });

  it("activateCreatedKey() with no previous active skips cancelByKey", async () => {
    // 首启 / 0 残留时 activateCreatedKey 没有任何 prev.active 等着
    // 停任务——直接 setActiveInternal 即可；cancelByKey 不应被调。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const fakeBackground = makeFakeBackground();
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.activateCreatedKey({
      label: "n",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString()
,
      publicKeyHex: "f".repeat(64)    });
    expect(fakeBackground.cancelByKeyCalls).toEqual([]);
    expect(keyspace.active().activePublicKeyHex).toBe("f".repeat(64));
  });

  it("activateCreatedKey() fails closed when cancelByKey throws (does not switch active)", async () => {
    // 与 setActive 一致：cancelByKey 抛错时，activateCreatedKey 必须
    // 冒泡——禁止 catch 后继续 setActiveInternal；那样会让 active 切
    // 到目标 key，但旧 key 的 task 仍在跑，竞态原封不动留下来。
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    const fakeBackground = makeFakeBackground({ failCancel: true });
    const keyspace = createKeyspaceService({ messageBus: events, vault, background: fakeBackground });
    await keyspace.setActive(hashA);

    await expect(
      keyspace.activateCreatedKey({
        label: "b",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString()
,
      publicKeyHex: "b".repeat(64)      })
    ).rejects.toThrow(/simulated cancelByKey failure/);
    // active 仍指向 A——setActiveInternal 不能在 cancelByKey 失败后
    // 仍然执行。
    expect(keyspace.active().activePublicKeyHex).toBe(hashA);
  });
});

/**
 * 硬切换 002 收尾：`openKeyStorage` 硬门禁收紧。
 *   - 没有 active key 时，开任何 namespace DB 一律拒绝
 *     （防止「无 active + 知道 hex 就能开库」被滥用）。
 *   - active 切走后，新 active 不等于已开 handle 的 publicKeyHex
 *     时必须拒绝（防止跨 key 复用）。
 * 不传 new fake keyspace，直接用 createKeyspaceService + IndexedDB
 * 真路径（fake-indexeddb）。
 */
describe("keyspaceService.openKeyStorage hard gate (硬切换 002 收尾)", () => {
  async function freshKeyspaceNoActive(): Promise<ReturnType<typeof createKeyspaceService>> {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    return createKeyspaceService({ messageBus: events, vault });
  }

  it("rejects openKeyStorage when no active key is set", async () => {
    const keyspace = await freshKeyspaceNoActive();
    expect(keyspace.active().activePublicKeyHex).toBeUndefined();
    await expect(
      keyspace.openKeyStorage({
        publicKeyHex: "a".repeat(64),
        pluginId: "p2pkh",
        storageId: "state",
        version: 1,
        upgrade: () => undefined
      })
    ).rejects.toThrow(/Key storage is not ready/);
  });

  it("rejects openKeyStorage when input.publicKeyHex does not match active", async () => {
    const { messageBus: events } = makeMessageBus();
    const vault = createVaultService({ messageBus: events });
    await seedVault(vault);
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await seedReadyKey({ label: "a", publicKeyHex: hashA });
    await seedReadyKey({ label: "b", publicKeyHex: hashB });
    const keyspace = createKeyspaceService({ messageBus: events, vault });
    await keyspace.setActive(hashA);
    // 用 hashB 开库：active=A，B != A，必须拒绝。
    await expect(
      keyspace.openKeyStorage({
        publicKeyHex: hashB,
        pluginId: "p2pkh",
        storageId: "state",
        version: 1,
        upgrade: () => undefined
      })
    ).rejects.toThrow(/Key storage is not ready/);
    // 同 active 调用允许通过。
    await expect(
      keyspace.openKeyStorage({
        publicKeyHex: hashA,
        pluginId: "p2pkh",
        storageId: "state",
        version: 1,
        upgrade: () => undefined
      })
    ).resolves.toBeDefined();
  });
});

// 占位：seedKeyWithIdentity 旧 helper 不再使用；保留引用以便审计。
void (null as unknown as VaultKeyRecord);
