// packages/plugin-collectible-1satordinals/src/ordinalsSync.test.ts
// 1Sat Ordinals 后台同步任务回归测试：
//   - 正常流程：service.sync + assetDataNotifier.emit；
//   - signal 在 run 前 aborted：不调用 service.sync、不 emit；
//   - active key 在 sync 后变化：不 emit；
//   - 无 active key 时直接返回。

import { describe, expect, it, vi } from "vitest";
import type { AssetDataNotifier, KeyspaceService, VaultService, WocService } from "@keymaster/contracts";
import { createOrdinalsSyncTask } from "./ordinalsSync.js";
import type { OrdinalMintHistoryRepository, OrdinalMintHistoryRecord } from "./storage/ordinalMintHistoryRepository.js";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  let current = activePublicKeyHex;
  return {
    active: () => ({ activePublicKeyHex: current }),
    setActive(hex: string | undefined) { current = hex; }
  } as unknown as KeyspaceService & { setActive(hex: string | undefined): void };
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as AssetDataNotifier & { emit: ReturnType<typeof vi.fn> };
}

function fakeHistoryRepository(records: OrdinalMintHistoryRecord[]): OrdinalMintHistoryRepository & { put: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
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
  } as unknown as OrdinalMintHistoryRepository & { put: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
}

function fakeService(): OrdinalsServiceHandle & { sync: ReturnType<typeof vi.fn> } {
  return {
    listActiveKeyCollectibles: vi.fn(async () => []),
    getOutpoint: vi.fn(async () => null),
    getOutpointContent: vi.fn(async () => null),
    getTransactionOutputScript: vi.fn(async () => new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])),
    sync: vi.fn(async () => {}),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn()
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

describe("createOrdinalsSyncTask", () => {
  it("正常流程：service.sync + emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({}),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(notifier.emit).toHaveBeenCalledTimes(1);
    expect(notifier.emit.mock.calls[0]![0]).toMatchObject({
      providerId: "1satordinals",
      publicKeyHex: "pk1",
      kinds: ["holding"]
    });
  });

  it("history 会在 WOC 命中后从 pending 升级为 observed-unconfirmed", async () => {
    const service = fakeService();
    (service.listActiveKeyCollectibles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        outpoint: "tx0:0",
        network: "main",
        address: "addr1",
        observation: "unconfirmed",
        canonicalTxid: "tx0",
        inscription: {
          inscriptionId: "insc-tx0_0",
          outpoint: "tx0_0",
          contentType: "text/plain",
          origin: "hello",
          preview: "hello",
          owner: "owner",
          observation: "unconfirmed",
          canonicalTxid: "tx0"
        }
      }
    ]);
    const notifier = fakeNotifier();
    const historyRepository = fakeHistoryRepository([
      {
        id: "mint-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "broadcast-pending-woc",
        request: {
          network: "main",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
          dataSize: 5,
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        preview: {
          inscriptionId: "tx0_0",
          outputScriptHex: "6a",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          inscriptionId: "tx0_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "broadcast-pending-woc",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tx0"
          }
        }
      } as OrdinalMintHistoryRecord
    ]);
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({ tx0: "unconfirmed" }),
      historyRepository,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    const updated = await historyRepository.list();
    expect(updated[0]?.status).toBe("woc-observed-unconfirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("unconfirmed");
  });

  it("history 会在 WOC confirmed 命中后升级为 woc-confirmed", async () => {
    const service = fakeService();
    (service.listActiveKeyCollectibles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        outpoint: "tx0:0",
        network: "main",
        address: "addr1",
        observation: "confirmed",
        canonicalTxid: "tx0",
        inscription: {
          inscriptionId: "insc-tx0_0",
          outpoint: "tx0_0",
          contentType: "text/plain",
          origin: "hello",
          preview: "hello",
          owner: "owner",
          observation: "confirmed",
          canonicalTxid: "tx0"
        }
      }
    ]);
    const notifier = fakeNotifier();
    const historyRepository = fakeHistoryRepository([
      {
        id: "mint-1c",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "broadcast-pending-woc",
        request: {
          network: "main",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
          dataSize: 5,
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        preview: {
          inscriptionId: "tx0_0",
          outputScriptHex: "6a",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          inscriptionId: "tx0_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "broadcast-pending-woc",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tx0"
          }
        }
      } as OrdinalMintHistoryRecord
    ]);
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({ tx0: "confirmed" }),
      historyRepository,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    const updated = await historyRepository.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("history 已 confirmed 后即便 holdings 消失也保持 woc-confirmed", async () => {
    const service = fakeService();
    (service.listActiveKeyCollectibles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const notifier = fakeNotifier();
    const historyRepository = fakeHistoryRepository([
      {
        id: "mint-2",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-confirmed",
        request: {
          network: "main",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
          dataSize: 5,
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        preview: {
          inscriptionId: "tx1_0",
          outputScriptHex: "6a",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview-2",
            rawTxHex: "00"
          }
        },
        submit: {
          inscriptionId: "tx1_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-confirmed",
            txid: "tx-preview-2",
            rawTxHex: "00",
            canonicalTxid: "tx1",
            observation: "confirmed"
          }
        }
      } as OrdinalMintHistoryRecord
    ]);
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({}),
      historyRepository,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    const updated = await historyRepository.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("history 只有先 observed-unconfirmed、随后交易级 observation 消失时才会 dropped", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const historyRepository = fakeHistoryRepository([
      {
        id: "mint-2d",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-observed-unconfirmed",
        request: {
          network: "main",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
          dataSize: 5,
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        preview: {
          inscriptionId: "tx2_0",
          outputScriptHex: "6a",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview-2d",
            rawTxHex: "00"
          }
        },
        submit: {
          inscriptionId: "tx2_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-observed-unconfirmed",
            txid: "tx-preview-2d",
            rawTxHex: "00",
            canonicalTxid: "tx2",
            observation: "unconfirmed"
          }
        }
      } as OrdinalMintHistoryRecord
    ]);
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({}),
      historyRepository,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    const updated = await historyRepository.list();
    expect(updated[0]?.status).toBe("woc-dropped");
    expect(updated[0]?.submit?.spend.observation).toBeUndefined();
    expect(updated[0]?.submit?.spend.droppedReason).toBe("woc-dropped");
  });

  it("history 会在 WOC later confirmed 命中时从 woc-dropped 恢复为 woc-confirmed", async () => {
    const service = fakeService();
    (service.listActiveKeyCollectibles as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        outpoint: "tx-restore:0",
        network: "main",
        address: "addr1",
        observation: "confirmed",
        canonicalTxid: "tx-restore",
        inscription: {
          inscriptionId: "insc-tx-restore_0",
          outpoint: "tx-restore_0",
          contentType: "text/plain",
          origin: "hello",
          preview: "hello",
          owner: "owner",
          observation: "confirmed",
          canonicalTxid: "tx-restore"
        }
      }
    ]);
    const notifier = fakeNotifier();
    const historyRepository = fakeHistoryRepository([
      {
        id: "mint-restore",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "woc-dropped",
        request: {
          network: "main",
          contentType: "text/plain",
          dataBase64: "aGVsbG8=",
          dataSize: 5,
          feeRateSatoshisPerKb: 1000,
          ownerPublicKeyHex: "pk1"
        } as never,
        preview: {
          inscriptionId: "tx-restore_0",
          outputScriptHex: "6a",
          spend: {
            ownerPublicKeyHex: "pk1",
            network: "main",
            inputs: [],
            outputs: [],
            changeSatoshis: 0,
            estimatedFeeSatoshis: 0,
            serializedSizeBytes: 0,
            txid: "tx-preview",
            rawTxHex: "00"
          }
        },
        submit: {
          inscriptionId: "tx-restore_0",
          submittedAt: "2024-01-01T00:00:00.000Z",
          spend: {
            status: "woc-dropped",
            txid: "tx-preview",
            rawTxHex: "00",
            canonicalTxid: "tx-restore"
          }
        }
      } as OrdinalMintHistoryRecord
    ]);
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc({ "tx-restore": "confirmed" }),
      historyRepository,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    const updated = await historyRepository.list();
    expect(updated[0]?.status).toBe("woc-confirmed");
    expect(updated[0]?.submit?.spend.observation).toBe("confirmed");
  });

  it("signal 在 run 前 aborted：service.sync 仍会收到 aborted signal，但不 emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    ac.abort();
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc(),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(service.sync).toHaveBeenCalledWith(ac.signal);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("active key 在 sync 后变化：不 emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const ks = fakeKeyspace("pk-old") as KeyspaceService & { setActive(hex: string | undefined): void };
    (service.sync as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ks.setActive("pk-new");
    });
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc(),
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("无 active key 时直接返回", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const task = createOrdinalsSyncTask({
      service,
      woc: fakeWoc(),
      keyspace: fakeKeyspace(undefined),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });
});
