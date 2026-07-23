// packages/plugin-token-bsv21/src/bsv21Sync.test.ts
// BSV-21 后台同步任务取消语义测试：
//   - 正常流程：replaceAll + emit data-changed。
//   - signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit。
//   - signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit。
//   - signal 在 replaceAll 后 aborted：不 emit。
//   - active key 在 replaceAll 后变化：不 emit（旧 key 任务不向新 key 发通知）。

import { describe, expect, it, vi } from "vitest";
import { createBsv21SyncTask } from "./bsv21Sync.js";
import type { Bsv21Db } from "./bsv21Db.js";
import type { Bsv21MintHistoryDb, Bsv21MintHistoryRecord } from "./bsv21MintHistoryDb.js";
import type { Bsv21ServiceHandle } from "./bsv21Service.js";
import type { AssetDataNotifier, KeyspaceService, VaultService, WocService } from "@keymaster/contracts";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  let current = activePublicKeyHex;
  return {
    active: () => ({ activePublicKeyHex: current }),
    setActive(hex: string | undefined) { current = hex; }
  } as unknown as KeyspaceService & { setActive(h: string | undefined): void };
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeDb(): Bsv21Db & { replaceAll: ReturnType<typeof vi.fn> } {
  return { replaceAll: vi.fn(async () => {}) } as unknown as Bsv21Db & { replaceAll: ReturnType<typeof vi.fn> };
}

function fakeService(tokens: Array<{ meta: { origin: string; symbol: string; issuer: string; decimals: number }; balance: { confirmed: string; unconfirmed: string; amount: string; display: string }; address: string; network: "main" | "test"; outpoint: string; observation?: "unconfirmed" | "confirmed"; canonicalTxid?: string }>): Bsv21ServiceHandle {
  return {
    listActiveKeyUnspentTokens: vi.fn(async () => tokens.map((t) => ({
      network: t.network,
      outpoint: t.outpoint,
      tokenId: t.meta.origin,
      amount: t.balance.amount,
      ownerAddress: t.address,
      observation: t.observation,
      canonicalTxid: t.canonicalTxid,
      current: { txid: t.meta.origin, txIndex: 0 }
    }))),
    listActiveKeyTokens: vi.fn(async () => tokens.map((t) => ({
      meta: t.meta,
      balance: t.balance,
      outpoint: t.outpoint,
      observation: t.observation,
      canonicalTxid: t.canonicalTxid,
      unspent: [{
        network: t.network,
        outpoint: t.outpoint,
        tokenId: t.meta.origin,
        amount: t.balance.amount,
        ownerAddress: t.address,
        observation: t.observation,
        canonicalTxid: t.canonicalTxid,
        current: { txid: t.meta.origin, txIndex: 0 }
      }],
      address: t.address,
      network: t.network
    }))),
    getToken: vi.fn(async () => null)
  };
}

function fakeWoc(observations: Record<string, "unconfirmed" | "confirmed" | undefined> = {}): WocService & { getTransactionObservation: ReturnType<typeof vi.fn> } {
  return {
    getTransactionObservation: vi.fn(async (_network: "main" | "test", canonicalTxid: string) => ({
      canonicalTxid,
      observation: observations[canonicalTxid]
    }))
  } as unknown as WocService & { getTransactionObservation: ReturnType<typeof vi.fn> };
}

function fakeNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as AssetDataNotifier & { emit: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
}

function fakeHistoryDb(records: Bsv21MintHistoryRecord[]): Bsv21MintHistoryDb & { put: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
  const store = [...records];
  return {
    async get(id: string) {
      return store.find((record) => record.id === id);
    },
    put: vi.fn(async (record) => {
      const idx = store.findIndex((item) => item.id === record.id);
      if (idx >= 0) store[idx] = record;
      else store.push(record);
    }),
    list: vi.fn(async () => [...store]),
    close() {}
  } as unknown as Bsv21MintHistoryDb & { put: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
}

const SAMPLE_TOKENS = [{
  meta: { origin: "tok1_0", symbol: "T1", issuer: "", decimals: 0 },
  balance: { confirmed: "100", unconfirmed: "0", amount: "100", display: "100 T1" },
  outpoint: "tok1_0",
  address: "addr1",
  observation: "unconfirmed" as const,
  canonicalTxid: "tok1",
      network: "main" as const
}];

describe("createBsv21SyncTask", () => {
  it("正常流程：replaceAll + emit data-changed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ks = fakeKeyspace("pk1");
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      woc: fakeWoc({ tok1: "unconfirmed" }),
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).toHaveBeenCalledTimes(1);
    expect(notifier.emit.mock.calls[0]![0].publicKeyHex).toBe("pk1");
    expect((db.replaceAll as ReturnType<typeof vi.fn>).mock.calls[0]![0][0]).toMatchObject({
      outpoint: "tok1_0",
      observation: "unconfirmed",
      canonicalTxid: "tok1"
    });
  });

  it("history 会在 WOC 命中后从 pending 升级为 observed-unconfirmed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const historyDb = fakeHistoryDb([
      {
        id: "mint-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "broadcast-pending-woc",
        request: {
          network: "main",
          amount: "1",
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        payload: { p: "bsv-20", op: "deploy+mint", amt: "1" } as never,
        preview: {
          tokenId: "tok1_0",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeAddress: undefined,
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          tokenId: "tok1_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "broadcast-pending-woc",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tok1"
          }
        }
      } as Bsv21MintHistoryRecord
    ]);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      historyDb,
      service: fakeService([
        {
          meta: { origin: "tok1", symbol: "T1", issuer: "", decimals: 0 },
          balance: { confirmed: "100", unconfirmed: "0", amount: "100", display: "100 T1" },
          outpoint: "tok1_0",
          address: "addr1",
          observation: "unconfirmed",
          canonicalTxid: "tok1",
          network: "main"
        }
      ]),
      woc: fakeWoc({ tok1: "unconfirmed" }),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
    const updated = await historyDb.list();
    expect(updated[0]?.status).toBe("woc-observed-unconfirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("unconfirmed");
  });

  it("history 会在 WOC confirmed 命中后升级为 woc-confirmed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const historyDb = fakeHistoryDb([
      {
        id: "mint-1c",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "broadcast-pending-woc",
        request: {
          network: "main",
          amount: "1",
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        payload: { p: "bsv-20", op: "deploy+mint", amt: "1" } as never,
        preview: {
          tokenId: "tok1_0",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeAddress: undefined,
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          tokenId: "tok1_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "broadcast-pending-woc",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tok1"
          }
        }
      } as Bsv21MintHistoryRecord
    ]);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      historyDb,
      service: fakeService([
        {
          meta: { origin: "tok1", symbol: "T1", issuer: "", decimals: 0 },
          balance: { confirmed: "100", unconfirmed: "0", amount: "100", display: "100 T1" },
          outpoint: "tok1_0",
          address: "addr1",
          observation: "confirmed",
          canonicalTxid: "tok1",
          network: "main"
        }
      ]),
      woc: fakeWoc({ tok1: "confirmed" }),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
    const updated = await historyDb.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("history 已 confirmed 后即便 holdings 消失也保持 woc-confirmed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const historyDb = fakeHistoryDb([
      {
        id: "mint-2",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-confirmed",
        request: {
          network: "main",
          amount: "1",
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        payload: { p: "bsv-20", op: "deploy+mint", amt: "1" } as never,
        preview: {
          tokenId: "tok2_0",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeAddress: undefined,
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview-2",
            rawTxHex: "00"
          }
        },
        submit: {
          tokenId: "tok2_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-confirmed",
            txid: "tx-preview-2",
            rawTxHex: "00",
            canonicalTxid: "tok2",
            observation: "confirmed"
          }
        }
      } as Bsv21MintHistoryRecord
    ]);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      historyDb,
      service: fakeService([]),
      woc: fakeWoc({}),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
    const updated = await historyDb.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("history 只有先 observed-unconfirmed、随后交易级 observation 消失时才会 dropped", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const historyDb = fakeHistoryDb([
      {
        id: "mint-2d",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-observed-unconfirmed",
        request: {
          network: "main",
          amount: "1",
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        payload: { p: "bsv-20", op: "deploy+mint", amt: "1" } as never,
        preview: {
          tokenId: "tok2d_0",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeAddress: undefined,
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview-2d",
            rawTxHex: "00"
          }
        },
        submit: {
          tokenId: "tok2d_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-observed-unconfirmed",
            txid: "tx-preview-2d",
            rawTxHex: "00",
            canonicalTxid: "tok2d",
            observation: "unconfirmed"
          }
        }
      } as Bsv21MintHistoryRecord
    ]);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      historyDb,
      service: fakeService([]),
      woc: fakeWoc({}),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
    const updated = await historyDb.list();
    expect(updated[0]?.status).toBe("woc-dropped");
    expect(updated[0]?.submit?.spend.observation).toBeUndefined();
    expect(updated[0]?.submit?.spend.droppedReason).toBe("woc-dropped");
  });

  it("history 会在 WOC later confirmed 命中时从 woc-dropped 恢复为 woc-confirmed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const historyDb = fakeHistoryDb([
      {
        id: "mint-restore",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-dropped",
        request: {
          network: "main",
          amount: "1",
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        payload: { p: "bsv-20", op: "deploy+mint", amt: "1" } as never,
        preview: {
          tokenId: "tok-restore",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeAddress: undefined,
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          tokenId: "tok-restore",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-dropped",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tok-restore"
          }
        }
      } as Bsv21MintHistoryRecord
    ]);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      historyDb,
      service: fakeService([
        {
          meta: { origin: "tok-restore", symbol: "T1", issuer: "", decimals: 0 },
          balance: { confirmed: "100", unconfirmed: "0", amount: "100", display: "100 T1" },
          outpoint: "tok-restore_0",
          address: "addr1",
          observation: "confirmed",
          canonicalTxid: "tok-restore",
          network: "main"
        }
      ]),
      woc: fakeWoc({ "tok-restore": "confirmed" }),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
    const updated = await historyDb.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    ac.abort();
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      woc: fakeWoc(),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    const svc = fakeService(SAMPLE_TOKENS);
    (svc.listActiveKeyTokens as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
      return SAMPLE_TOKENS;
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: svc,
      woc: fakeWoc(),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 replaceAll 后 aborted：不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    (db.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      woc: fakeWoc(),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("active key 在 replaceAll 后变化：不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    let currentKey = "pk-old";
    const ks = {
      active: () => ({ activePublicKeyHex: currentKey })
    } as unknown as KeyspaceService;
    (db.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // replaceAll 完成后 active key 切换
      currentKey = "pk-new";
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      woc: fakeWoc(),
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("无 active key 时直接返回，不调用 service", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const svc = fakeService(SAMPLE_TOKENS);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: svc,
      woc: fakeWoc(),
      keyspace: fakeKeyspace(undefined),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(svc.listActiveKeyTokens).not.toHaveBeenCalled();
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });
});
