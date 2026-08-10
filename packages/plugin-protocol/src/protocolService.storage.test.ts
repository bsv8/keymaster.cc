import { describe, expect, it, vi } from "vitest";
import type {
  ConnectSessionRecord,
  ProtocolResultMessage,
  ProtocolStorageDb,
  StorageAppContext,
  StorageListResult,
  StorageService,
  VaultService
} from "@keymaster/contracts";
import { PROTOCOL_VERSION, STORAGE_PART_SIZE_BYTES } from "@keymaster/contracts";
import { ProtocolServiceImpl } from "./protocolService.js";

const ORIGIN = "https://storage-app.example";
const SESSION_ID = "storage-session";
const OWNER_PUBLIC_KEY_HEX = `02${"11".repeat(32)}`;
const APP_IDENTITY = {
  version: 1 as const,
  publisherPublicKeyHex: `02${"22".repeat(32)}`,
  appId: "storage-app",
  appName: "Storage App",
  identityDigestHex: "aa".repeat(32)
};

function makeDb(session: ConnectSessionRecord | null): ProtocolStorageDb {
  const sessions = session ? new Map([[session.sessionId, session]]) : new Map<string, ConnectSessionRecord>();
  return {
    putCommand: async () => undefined,
    getCommand: async () => null,
    listCommandsByOrigin: async () => [],
    getOrigin: async () => null,
    putOrigin: async () => undefined,
    listOrigins: async () => [],
    getFeePool: async () => null,
    putFeePool: async () => undefined,
    deleteFeePool: async () => undefined,
    listFeePoolsByOrigin: async () => [],
    putConnectSession: async (value) => { sessions.set(value.sessionId, value); },
    getConnectSession: async (value) => sessions.get(value) ?? null,
    listConnectSessionsByOrigin: async (origin) => [...sessions.values()].filter((value) => value.origin === origin),
    putConnectSessionAndRevokeOriginPeers: async (value) => { sessions.set(value.sessionId, value); },
    putLaunchToken: async () => undefined,
    getLaunchToken: async () => null,
    consumeLaunchToken: async () => undefined,
    deleteLaunchToken: async () => undefined
  };
}

function makeVault(): VaultService {
  return {
    status: () => "unlocked",
    onLifecycleChange: () => () => undefined,
    getLifecycleSnapshot: () => ({ status: "unlocked", activePublicKeyHex: OWNER_PUBLIC_KEY_HEX, sessionEpoch: "epoch", vaultLifecycleRevision: 1 }),
    lock: vi.fn(async () => ({ status: "accepted" as const })),
    unlock: vi.fn(async () => ({ status: "accepted" as const })),
    verifyPassword: vi.fn(async () => undefined)
  } as unknown as VaultService;
}

function makeStorage(overrides: Partial<StorageService> = {}): StorageService {
  const emptyResult: StorageListResult = { prefix: "", parentPrefix: "", directories: [], files: [] };
  return {
    status: () => "ready",
    subscribe: () => () => undefined,
    getProviderSummary: async () => null,
    getProviderConnection: async () => null,
    cancelProbe: () => undefined,
    probeProvider: async () => ({ ok: true, providerId: "aws-s3", latencyMs: 0 }),
    activateProvider: async () => ({ ok: true, providerId: "aws-s3", latencyMs: 0 }),
    clearProviderConfig: async () => undefined,
    resetStorage: async () => undefined,
    abortSession: vi.fn(async () => undefined),
    list: vi.fn(async () => emptyResult),
    createDirectory: vi.fn(),
    deleteDirectory: vi.fn(),
    put: vi.fn(),
    getRange: vi.fn(),
    delete: vi.fn(),
    beginUpload: vi.fn(),
    uploadPart: vi.fn(),
    completeUpload: vi.fn(),
    abortUpload: vi.fn(),
    ...overrides
  } as unknown as StorageService;
}

function makeHarness(storageService: StorageService, session: ConnectSessionRecord | null = {
  sessionId: SESSION_ID,
  origin: ORIGIN,
  ownerPublicKeyHex: OWNER_PUBLIC_KEY_HEX,
  ownerLabel: "Owner",
  claimsSnapshot: {},
  appIdentity: APP_IDENTITY,
  createdAt: 1,
  lastUsedAt: 1,
  revokedAt: null
}, getStorageService: () => StorageService | undefined = () => storageService) {
  const opener = { closed: false } as Window;
  const results: ProtocolResultMessage[] = [];
  const keyspace = {
    getKey: async (publicKeyHex: string) => publicKeyHex === OWNER_PUBLIC_KEY_HEX ? { publicKeyHex, label: "Owner", capabilities: [], createdAt: "now" } : undefined
  };
  const service = new ProtocolServiceImpl({
    vault: makeVault(),
    keyspace: keyspace as never,
    storageDb: makeDb(session),
    storageService,
    getStorageService,
    resolveOpener: () => opener,
    postReady: () => undefined,
    postResult: (_target, _origin, result) => { results.push(result); }
  });
  return { service, opener, results };
}

function storageRequest(id: string, extra: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: "request" as const,
    id,
    method: "storage.list" as const,
    params: { connectSessionId: SESSION_ID, ...extra }
  };
}

function storageMethodRequest(id: string, method: string, params: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: "request" as const,
    id,
    method,
    params: { connectSessionId: SESSION_ID, ...params }
  };
}

async function waitForResult(results: ProtocolResultMessage[]): Promise<ProtocolResultMessage> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = results[0];
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("protocol result timeout");
}

async function waitForResultCount(results: ProtocolResultMessage[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (results.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("protocol result count timeout");
}

describe("ProtocolService storage adapter", () => {
  it("dispatches storage methods with session-bound identity and no caller namespace fields", async () => {
    let receivedContext: StorageAppContext | undefined;
    let receivedInput: Record<string, unknown> | undefined;
    const storage = makeStorage({
      list: vi.fn(async (context, input) => {
        receivedContext = context;
        receivedInput = input as unknown as Record<string, unknown>;
        return { prefix: "docs/", parentPrefix: "", directories: [], files: [] };
      })
    });
    const harness = makeHarness(storage);
    harness.service.startSession();
    await harness.service.handleMessage({ data: storageRequest("list-1", { prefix: "docs", limit: 10 }), origin: ORIGIN, source: harness.opener } as MessageEvent);
    const result = await waitForResult(harness.results);
    expect(result.ok).toBe(true);
    expect(receivedContext).toMatchObject({ connectSessionId: SESSION_ID, transportOrigin: ORIGIN, appIdentity: APP_IDENTITY });
    expect(receivedInput).toMatchObject({ prefix: "docs", limit: 10 });
    expect(receivedInput).not.toHaveProperty("connectSessionId");
  });

  it("fails closed when the persisted session has no verified identity", async () => {
    const storage = makeStorage();
    const harness = makeHarness(storage, { ...makeSessionWithoutIdentity(), appIdentity: undefined });
    harness.service.startSession();
    await harness.service.handleMessage({ data: storageRequest("list-identity-required"), origin: ORIGIN, source: harness.opener } as MessageEvent);
    const result = await waitForResult(harness.results);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("storage_identity_required");
    expect(storage.list).not.toHaveBeenCalled();
  });

  it("resolves a newly enabled Storage service after the old one is replaced", async () => {
    const first = makeStorage();
    const second = makeStorage();
    let current: StorageService | undefined = first;
    const harness = makeHarness(first, undefined, () => current);
    harness.service.startSession();
    await harness.service.handleMessage({ data: storageRequest("list-first"), origin: ORIGIN, source: harness.opener } as MessageEvent);
    await waitForResultCount(harness.results, 1);
    current = second;
    await harness.service.handleMessage({ data: storageRequest("list-second"), origin: ORIGIN, source: harness.opener } as MessageEvent);
    await waitForResultCount(harness.results, 2);
    expect(first.list).toHaveBeenCalledTimes(1);
    expect(second.list).toHaveBeenCalledTimes(1);
  });

  it("dispatches every Storage method through the session-bound service", async () => {
    const storage = makeStorage({
      createDirectory: vi.fn(async () => ({ path: "dir/", created: true })),
      deleteDirectory: vi.fn(async () => ({ path: "dir/", deleted: true })),
      put: vi.fn(async () => ({ path: "file", size: 1, updatedAt: 1 })),
      getRange: vi.fn(async () => ({ path: "file", content: { $type: "binary" as const, bytes: new Uint8Array([1]).buffer }, offset: 0, totalSize: 1, eof: true })),
      delete: vi.fn(async () => ({ path: "file", deleted: true as const, updatedAt: 1 })),
      beginUpload: vi.fn(async () => ({ uploadId: "upload", partSize: STORAGE_PART_SIZE_BYTES, maxParts: 10_000 as 10_000 })),
      uploadPart: vi.fn(async () => ({ uploadId: "upload", partNumber: 1, size: 1 })),
      completeUpload: vi.fn(async () => ({ path: "file", size: 1, updatedAt: 1 })),
      abortUpload: vi.fn(async () => ({ uploadId: "upload", aborted: true as const }))
    });
    const harness = makeHarness(storage);
    harness.service.startSession();
    const requests = [
      storageRequest("m-list"),
      storageMethodRequest("m-create", "storage.directory.create", { path: "dir" }),
      storageMethodRequest("m-delete-dir", "storage.directory.delete", { path: "dir" }),
      storageMethodRequest("m-put", "storage.put", { path: "file", content: { $type: "binary", bytes: new Uint8Array([1]).buffer } }),
      storageMethodRequest("m-get", "storage.get", { path: "file" }),
      storageMethodRequest("m-delete", "storage.delete", { path: "file" }),
      storageMethodRequest("m-begin", "storage.upload.begin", { path: "file", size: 1 }),
      storageMethodRequest("m-part", "storage.upload.part", { uploadId: "upload", partNumber: 1, content: { $type: "binary", bytes: new Uint8Array([1]).buffer } }),
      storageMethodRequest("m-complete", "storage.upload.complete", { uploadId: "upload" }),
      storageMethodRequest("m-abort", "storage.upload.abort", { uploadId: "upload" })
    ];
    for (const request of requests) {
      await harness.service.handleMessage({ data: request, origin: ORIGIN, source: harness.opener } as MessageEvent);
    }
    await waitForResultCount(harness.results, requests.length);
    expect(harness.results.every((result) => result.ok)).toBe(true);
    expect(storage.createDirectory).toHaveBeenCalled();
    expect(storage.deleteDirectory).toHaveBeenCalled();
    expect(storage.put).toHaveBeenCalled();
    expect(storage.getRange).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalled();
    expect(storage.beginUpload).toHaveBeenCalled();
    expect(storage.uploadPart).toHaveBeenCalled();
    expect(storage.completeUpload).toHaveBeenCalled();
    expect(storage.abortUpload).toHaveBeenCalled();
  });

  it("fails closed when the current Storage provider is unavailable", async () => {
    const storage = makeStorage();
    const harness = makeHarness(storage, undefined, () => undefined);
    harness.service.startSession();
    await harness.service.handleMessage({ data: storageRequest("provider-missing"), origin: ORIGIN, source: harness.opener } as MessageEvent);
    const result = await waitForResult(harness.results);
    expect(result).toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
  });

  it("aborts only the cancelled provider request, without session-wide multipart cleanup", async () => {
    let resolveList!: () => void;
    let signal: AbortSignal | undefined;
    const storage = makeStorage({
      list: vi.fn(async (_context, input) => {
        signal = input.signal;
        await new Promise<void>((resolve) => { resolveList = resolve; });
        return { prefix: "", parentPrefix: "", directories: [], files: [] };
      })
    });
    const harness = makeHarness(storage);
    harness.service.startSession();
    const request = storageRequest("list-cancel");
    const handling = harness.service.handleMessage({ data: request, origin: ORIGIN, source: harness.opener } as MessageEvent);
    for (let attempt = 0; attempt < 100 && !signal; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.service.handleMessage({ data: { v: PROTOCOL_VERSION, type: "cancel", id: "list-cancel" }, origin: ORIGIN, source: harness.opener } as MessageEvent);
    expect(signal?.aborted).toBe(true);
    expect(storage.abortSession).not.toHaveBeenCalled();
    resolveList();
    await handling;
  });
});

function makeSessionWithoutIdentity(): ConnectSessionRecord {
  return {
    sessionId: SESSION_ID,
    origin: ORIGIN,
    ownerPublicKeyHex: OWNER_PUBLIC_KEY_HEX,
    ownerLabel: "Owner",
    claimsSnapshot: {},
    createdAt: 1,
    lastUsedAt: 1,
    revokedAt: null
  };
}
