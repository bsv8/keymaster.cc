// packages/plugin-p2pkh/src/p2pkhDb.test.ts
// 硬切换 007 后单测：通过 fake keyspace 打开 key-scoped namespace db。
// 验证：v4 stores 全部建立、commitBackfillPage revision/rejection 校验、
// commitRecentSnapshot generation 校验。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createP2pkhDb, disposeP2pkhDb, openP2pkhDb, type P2pkhDbHandle } from "./p2pkhDb.js";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";
import type { KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const PUBLIC_KEY_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DB_NAME = `keymaster.key.${PUBLIC_KEY_HASH}.plugin.p2pkh.state`;

function makeResource(generation = 0): P2pkhKeyResource {
  return {
    resourceId: "key1:main",
    keyId: "key1",
    publicKeyHash: PUBLIC_KEY_HASH,
    label: "test",
    address: "addr-main",
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation
  };
}

function makeKeyspace(publicKeyHash: string): KeyspaceService {
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => ({ mode: "single", activePublicKeyHash: publicKeyHash }),
    setActive: async () => undefined,
    setAll: async () => undefined,
    requireActiveKey: () => ({
      keyId: "key1",
      publicKeyHex: "00",
      publicKeyHash,
      label: "test",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      identityStatus: "ready"
    }),
    onActiveChange: () => () => undefined,
    openKeyStorage: async (input) => {
      if (input.publicKeyHash !== publicKeyHash) {
        throw new Error("Key storage is not ready");
      }
      const name = `keymaster.key.${input.publicKeyHash}.plugin.${input.pluginId}.${input.storageId}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, input.version);
        r.onupgradeneeded = () => {
          input.upgrade(r.result, 0, input.version);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => db.close()
      };
      return handle;
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    // 硬切换 008 收尾：fake 上是 no-op。
    deleteKeyById: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    // 硬切换 008：attachBackgroundService 在测试 fake 上是 no-op。
    attachBackgroundService: () => undefined
  };
}

let bundle: P2pkhDbHandle | undefined;

async function openDb(): Promise<P2pkhDbHandle> {
  if (bundle) return bundle;
  const keyspace = makeKeyspace(PUBLIC_KEY_HASH);
  const nsHandle = await openP2pkhDb({ keyspace, publicKeyHash: PUBLIC_KEY_HASH });
  bundle = createP2pkhDb(nsHandle);
  return bundle;
}

async function resetDb(): Promise<void> {
  // 硬切换 008：必须调用 disposeP2pkhDb 清掉模块级 openHandle 缓存，
  // 否则下一轮 openP2pkhDb 会复用已关闭的 IDBDatabase，触发版本/升级错误。
  disposeP2pkhDb();
  bundle = undefined;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
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

describe("p2pkhDb v4 stores", () => {
  it("creates all required stores on first open", async () => {
    const db = await openDb();
    await db.listAddresses();
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const required = [
      "p2pkh_addresses",
      "p2pkh_balances",
      "p2pkh_utxos",
      "p2pkh_history",
      "p2pkh_history_backfill",
      "p2pkh_recent_sync",
      "p2pkh_pending_transfers",
      "p2pkh_utxo_reservations"
    ];
    for (const name of required) {
      expect(raw.objectStoreNames.contains(name), `missing store: ${name}`).toBe(true);
    }
    raw.close();
  });
});

describe("p2pkhDb commitBackfillPage", () => {
  it("persists page history and cursor atomically; rejects revision mismatch", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [{ txid: "tx-a", height: 100, status: "confirmed", source: "woc-confirmed" }],
      nextPageToken: "tok-1"
    });
    const history1 = await db.listHistory();
    expect(history1).toHaveLength(1);
    expect(history1[0]!.id).toBe("key1:main:tx-a");
    expect(history1[0]!.network).toBe("main");
    expect(history1[0]!.keyId).toBe("key1");
    const state1 = await db.getBackfillState(r.resourceId);
    expect(state1?.revision).toBe(1);
    expect(state1?.nextPageToken).toBe("tok-1");
    expect(state1?.status).toBe("running");

    // 重复提交同一页：revision mismatch 应被丢弃
    await expect(
      db.commitBackfillPage({
        resourceId: r.resourceId,
        expectedRevision: 0,
        expectedGeneration: 0,
        resource: r,
        page: [{ txid: "tx-a", height: 100, status: "confirmed", source: "woc-confirmed" }],
        nextPageToken: "tok-1"
      })
    ).rejects.toThrow();
    const historyAfterDup = await db.listHistory();
    expect(historyAfterDup).toHaveLength(1);
  });

  it("rejects generation mismatch when key is removed and re-derived", async () => {
    const db = await openDb();
    const r0 = makeResource(0);
    await db.putAddress(r0);
    // 模拟 key 删除 + 重新导入：resource 重新写入且 generation 自增。
    const r1 = makeResource(1);
    await db.putAddress(r1);

    // 旧 generation 的迟到响应被丢弃
    await expect(
      db.commitBackfillPage({
        resourceId: r0.resourceId,
        expectedRevision: 0,
        expectedGeneration: 0, // 旧的 generation
        resource: r0,
        page: [{ txid: "tx-late", height: 1, status: "confirmed", source: "woc-confirmed" }],
        nextPageToken: undefined
      })
    ).rejects.toThrow();
    const all = await db.listHistory();
    expect(all.find((h) => h.txid === "tx-late")).toBeUndefined();
  });

  it("marks complete when nextPageToken missing", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [],
      nextPageToken: undefined
    });
    const state = await db.getBackfillState(r.resourceId);
    expect(state?.status).toBe("complete");
  });
});

describe("p2pkhDb commitRecentSnapshot", () => {
  it("replaces UTXOs per resource and uses correct network", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      balance: { confirmed: 1000, unconfirmed: 200, spendable: 1000 },
      utxos: [
        {
          id: `${r.resourceId}:t1:0`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHash: r.publicKeyHash,
          network: "main",
          address: r.address,
          txid: "t1",
          vout: 0,
          value: 1000,
          height: 100,
          status: "confirmed",
          isSpentInMempoolTx: false,
          syncedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const utxos = await db.listUtxos();
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.network).toBe("main");
    const balance = await db.listBalances();
    expect(balance[0]!.network).toBe("main");
    expect(balance[0]!.confirmed).toBe(1000);
  });

  it("does not overwrite confirmed history with unconfirmed", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [{ txid: "t-conf", height: 10, status: "confirmed", source: "woc-confirmed" }],
      nextPageToken: undefined
    });
    // recent 不应把 confirmed 降级为 unconfirmed
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      unconfirmedHistory: [
        {
          id: `${r.resourceId}:t-conf`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHash: r.publicKeyHash,
          network: "main",
          address: r.address,
          txid: "t-conf",
          height: undefined,
          status: "unconfirmed",
          source: "woc-unconfirmed",
          syncedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const all = await db.listHistory();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("confirmed");
  });

  it("rejects generation mismatch", async () => {
    const db = await openDb();
    const r = makeResource(0);
    await db.putAddress(r);
    // resource 重建 generation=1
    await db.putAddress({ ...r, generation: 1 });
    await expect(
      db.commitRecentSnapshot({
        resourceId: r.resourceId,
        resource: r,
        expectedGeneration: 0, // 旧 generation
        balance: { confirmed: 1, unconfirmed: 0, spendable: 1 }
      })
    ).rejects.toThrow();
  });
});
