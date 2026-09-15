import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  hexToBytes,
} from "@keymaster/plugin-vault/coordinator";
import type { CoordinatorClientRequest, CoordinatorRpcRequest, CoordinatorSatEvent, CoordinatorSessionBinding, CoordinatorSessionCloseRequest, CoordinatorSessionOpenRequest, CoordinatorStorageControl, ExistingRemoteStorageConnectResult, InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupResult, JSONValue, StorageBucketCatalogEntryV2, StorageBucketConnectionConfigV1, StorageCatalogV2 } from "@keymaster/contracts";
import { parseCoordinatorResponseFor } from "@keymaster/contracts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  __testAcquireExecutorLease,
  __testPublishSatState,
  __testWindowP2pInboundBridgePressure,
  __testWindowP2pResponseBridgePressure,
  __testStartSatInboundHandler,
  __testCancelSatInboundHandler,
  __testRevokeWindowP2pExecutorLease,
  __testChangeSatInboundGeneration,
  __testSatInboundHandlerSnapshot,
  __testSetSatInboundResponseDispatcher,
  __testExecutorSignNoise,
  __testExecutorSignPeerRecord,
  __testReleaseExecutorLease,
  __testDispatchMsfileControl,
  __testDispatchMsfileControlWithEpoch,
  __testDispatchMsfileData,
  __testDispatchMsfileGrant,
  __testDispatchMsfileSessionAbort,
  __testReleaseMsfileRuntime,
  __testSetMsfileReadConcurrencySettings,
  __testSetMsfileRuntimeOverride,
  __testBuildChannelPublicMessageTimes,
  __testBuildChannelSeenMessageKey,
} from "./keymasterSessionCoordinator.worker.js";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { newMessageID, newSessionID } from "bsv8-channel-protocol";
import { parseBodyValue as parseWebrtcBodyValue } from "bsv8-channel-protocol/webrtc-signal";
import { verifySignedPrivateMessage } from "bsv8-channel-protocol/inbox";
import { PUBLIC_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/public-message";
import {
  __testBackgroundRunNow,
  __testCancelByKey,
  __testCreateVault,
  __testCreateEmptyVault,
  __testChangePassword,
  __testDeleteVault,
  __testExportKeyBackup,
  __testExportCurrentKeyBackup,
  __testDeleteKeyMaterial,
  __testFinalizeEmptyVaultAfterLastKeyDeletion,
  __testCollectCoordinatorKeyValueGarbage,
  __testGetActivePublicKeyHex,
  __testOwnerStoragePut,
  __testGetConnectedPortCount,
  __testDispatchStorageGrant,
  __testDispatchStorageData,
  __testDispatchStorageControl,
  __testDispatchStorageCancel,
  __testDispatchStorageAbort,
  __testResolveStorageGrant,
  __testSeedStorageRequest,
  __testSeedOwnerStorageRequest,
  __testSetStorageRuntime,
  __testClearCentralNamespace,
  __testSetStorageStartupFailure,
  __testReleaseStorageRuntime,
  __testStorageMutationBarrierProbe,
  __testStorageQueueAdmission,
  __testStorageQueueSnapshot,
  __testStorageSlotErrorCodes,
  __testStorageCancelKeepsPhysicalSlots,
  __testStorageFairDispatch,
  __testPublishStorageState,
  __testStorageTransfer,
  __testAttachPort,
  __testInstallCoordinatorBridgePeer,
  __testHandleCoordinatorSessionRpc,
  __testAwaitCoordinatorPeerDrain,
  __testRequestCoordinatorLocalStorageBridge,
  __testCloseCoordinatorBridgePeer,
  __testDispatchStorageMessage,
  __testFenceCoordinatorAuthority,
  __testHoldCoordinatorFinalIoLease,
  __testGetCoordinatorUpgradePartition,
  __testSetStorageSessionResolver,
  __testGetSnapshot,
  __testGetVaultStatus,
  __testGetVaultAuthMetadata,
  __testGetVaultKeyIndex,
  __testListKeyLifecycleJournals,
  __testOwnerStorageNamespaceExists,
  __testClearVaultHold,
  __testImportKeyBackup,
  __testImportPrivateKey,
  __testListVaultKeys,
  __testInvalidateSession,
  __testLock,
  __testRegisterTask,
  __testResetState,
  __testRestartWorker,
  __testRunTask,
  __testSetVaultStatus,
  __testFailNextCoordinatorSnapshotPersist,
  __testFailAfterCatalogBindingPublish,
  __testFailKeyLifecycleJournalAfterHold,
  __testFailNextOwnerStorageActivation,
  __testMaterializeNextOwnerStorageActivation,
  __testFailNextOwnerStorageDeletion,
  __testFailAfterOwnerStorageActivation,
  __testBlockNextCatalogHoldPublish,
  __testBlockNextCatalogHoldRollback,
  __testBlockNextKeyLifecycleOwnerSideEffect,
  __testFailNextHoldRollbackCas,
  __testSetLocalStorageBridgeOverride,
  __testInitialSetupBucketId,
  __testInitialSetupCatalogEntryFingerprint,
  __testPrepareInitialSetup,
  __testColdStartFromDeviceHint,
  __testFailColdStartInstall,
  __testSetS3BucketProviderOptionsFactory,
  __testFailAfterBucketPasswordCatalogUpdate,
  __testFailAfterBucketConfigCatalogUpdate,
  __testFailNextVaultAuthMetadataRollback,
  __testFailNextVaultAuthMetadataRestore,
  __testFailNextBucketPasswordDeviceRollback,
  __testSeedInitialSetupRecoveryRecord,
  __testInstallCatalogLocalBinding,
  __testReleaseCatalogLocalBinding,
  __testSwitchCatalogBucket,
  __testP2pkhProviderConfigGet,
  __testP2pkhProviderConfigUpdate,
  __testP2pkhProvidersUpdate,
  __testSeedP2pkhLocalSubmission,
  __testFinishP2pkhLocalSubmission,
  __testSetP2pkhChainResolution,
  __testListP2pkhLocalTransactions,
  __testListP2pkhLocalOutpoints,
  __testListP2pkhLocalInputClaims,
  __testP2pkhBroadcast,
  __testSetP2pkhBroadcastProvider,
  __testSetActive,
  __testSealLocalSecret,
  __testEncodeChannelPrivateBody,
  __testValidateChannelPrivateProtocol,
  __testSignChannelPrivateMessage,
  __testUnlock,
  __testUpdateScheduleSettings,
  __testReloadCoordinatorMeta,
  __testCoordinatorSnapshotMetrics,
  __testSeedCoordinatorKeyValueGarbage,
  __testCoordinatorKeyValueObjectExists,
} from "./keymasterSessionCoordinator.worker.js";
import { createBucketCryptoContext, encryptBucketConfig, createDeviceBootstrapRepository, createLocalStorageBucketProvider, readStorageBootstrap, createS3BucketProvider, sameStorageCatalogDeviceProjection, StorageRuntimeError } from "@keymaster/platform-storage/coordinator";
import type { LocalStorageBridgeRequest, LocalStorageBridgeResponse } from "@keymaster/platform-storage/coordinator";
import { type BucketObjectStore, type BucketGetOutput, type LocalStorageLike, type LocalStorageLocks } from "@keymaster/platform-storage";
import { createBucketObjectStoreCapabilityState, setBucketObjectStoreCapabilityMode } from "@keymaster/platform-storage";
import type { PeerController } from "webloom-framework";

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  start(): void {}
  close(): void { this.onclose?.(); }
  postMessage(message: unknown): void { this.messages.push(message); }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(message: unknown): void {
    const event = { data: message } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener(event);
  }
}

/**
 * Unit tests enter the Coordinator through an explicit test sink. This keeps
 * the production Worker free of a second raw MessagePort router while still
 * allowing existing domain tests to observe typed stream projections.
 */
function attachTestPort(clientId: string, port = new TestPort()): TestPort {
  __testAttachPort(clientId, (message) => port.messages.push(message));
  port.onmessage = (event) => {
    void __testDispatchStorageMessage(clientId, event.data as CoordinatorClientRequest);
  };
  port.onclose = () => {
    void __testDispatchStorageMessage(clientId, { kind: "disconnect", clientId: "test-spoof", requestId: `disconnect-${clientId}` });
  };
  return port;
}

// metadata snapshot validator 会校验 secp256k1 曲线点；测试 fixture 使用
// 确定性私钥派生真实压缩公钥，只有显式 malformed case 才使用无效值。
function validPublisherKey(seed: number): string {
  const privateKey = new Uint8Array(32);
  privateKey[31] = seed;
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}

const VALID_PUBLISHER_KEYS = [1, 2, 3, 4, 5, 6].map(validPublisherKey);

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

type CoordinatorTestPeer = Pick<PeerController, "peerId" | "scope" | "capability" | "exposeGroup">;
type CoordinatorBridgeCall = (request: unknown, signal: AbortSignal) => Promise<LocalStorageBridgeResponse>;

interface CoordinatorTestPeerHarness {
  peer: CoordinatorTestPeer;
  bridgeCalls: Array<{ request: unknown; signal: AbortSignal }>;
  exposureCount: number;
  exposureRevocationCount: number;
}

const EMPTY_STORAGE_CATALOG: StorageCatalogV2 = {
  format: "keymaster.storage.catalog",
  version: 2,
  buckets: [],
};

function makeCoordinatorTestPeer(peerId: string, bridgeCall: CoordinatorBridgeCall = async () => ({
  type: "catalog-state",
  catalog: structuredClone(EMPTY_STORAGE_CATALOG),
})): CoordinatorTestPeerHarness {
  const bridgeCalls: CoordinatorTestPeerHarness["bridgeCalls"] = [];
  let exposureCount = 0;
  let exposureRevocationCount = 0;
  const scope = {
    state: "active" as const,
    onRevoke: (_listener: (reason: string) => void) => () => undefined,
  } as unknown as PeerController["scope"];
  const peer = {
    peerId,
    scope,
    exposeGroup: () => {
      exposureCount += 1;
      let revoked = false;
      return {
        revoke: () => {
          if (revoked) return;
          revoked = true;
          exposureRevocationCount += 1;
        },
      };
    },
    capability: (() => ({
      call: (request: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal ?? new AbortController().signal;
        bridgeCalls.push({ request, signal });
        return bridgeCall(request, signal);
      },
    })) as unknown as PeerController["capability"],
  } as CoordinatorTestPeer;
  return {
    peer,
    bridgeCalls,
    get exposureCount() { return exposureCount; },
    get exposureRevocationCount() { return exposureRevocationCount; },
  };
}

function installCoordinatorSessionInitializationBridge(): void {
  // session.open 的初始化只使用这个已有 bridge override；open 之后测试
  // 会清除 override，再让 LocalStorage 请求经由 fake peer capability 走真实
  // requestLocalStorageBridge pending/response/fence 路径。
  __testSetLocalStorageBridgeOverride(async (input) => {
    if (input.type === "device-bootstrap-read") {
      return { type: "device-bootstrap", catalog: null };
    }
    if (input.type === "catalog-read") {
      return { type: "catalog-state", catalog: structuredClone(EMPTY_STORAGE_CATALOG) };
    }
    throw new Error(`unexpected session initialization bridge request: ${input.type}`);
  });
}

type CoordinatorSessionRpcResponse = Awaited<ReturnType<typeof __testHandleCoordinatorSessionRpc>>;

function sessionBindingFromOpenResponse(response: CoordinatorSessionRpcResponse): CoordinatorSessionBinding {
  const result = response.operationResult as { sessionBinding?: CoordinatorSessionBinding } | undefined;
  if (!result?.sessionBinding) throw new Error("session.open did not return a session binding");
  return result.sessionBinding;
}

function sessionOpen(leaseId: string): CoordinatorSessionOpenRequest {
  return { kind: "session.open", leaseId };
}

function sessionClose(binding: CoordinatorSessionBinding): CoordinatorSessionCloseRequest {
  return { kind: "session.close", ...binding };
}

class CatalogBridgeStorage implements LocalStorageLike {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  snapshot(): ReadonlyArray<readonly [string, string]> { return [...this.values.entries()].sort(([left], [right]) => left.localeCompare(right)); }
}

const catalogBridgeLocks = {
  request: async <T>(_name: string, callback: () => Promise<T>) => callback()
} as LocalStorageLocks;

async function makeEncryptedLocalCatalogEntry(
  bucketId: string,
  label: string,
  password: string,
): Promise<StorageBucketCatalogEntryV2> {
  const context = await createBucketCryptoContext(password);
  try {
    const encryptedConfig = await encryptBucketConfig({ kind: "local" } satisfies StorageBucketConnectionConfigV1, context);
    return {
      bucketId,
      label,
      backend: "local",
      configRevision: 1,
      keyDerivation: { ...context.keyDerivation },
      encryptedConfig,
      snapshotRevision: 0,
      createdAt: 1,
      updatedAt: 1
    };
  } finally {
    context.dispose();
  }
}

async function makeEncryptedS3CatalogEntry(
  bucketId: string,
  label: string,
  password: string,
): Promise<StorageBucketCatalogEntryV2> {
  const context = await createBucketCryptoContext(password);
  try {
    const encryptedConfig = await encryptBucketConfig({
      kind: "s3",
      endpoint: "https://objects.example.test",
      region: "us-east-1",
      bucket: "same-physical-target",
      accessKeyId: "access",
      secretAccessKey: "secret",
    } satisfies StorageBucketConnectionConfigV1, context);
    return {
      bucketId,
      label,
      backend: "s3",
      configRevision: 2,
      keyDerivation: { ...context.keyDerivation },
      encryptedConfig,
      snapshotRevision: 1,
      createdAt: 1,
      updatedAt: 1
    };
  } finally {
    context.dispose();
  }
}

function makeCatalogBridgeFixture(current: StorageBucketCatalogEntryV2, target: StorageBucketCatalogEntryV2) {
  const storage = new CatalogBridgeStorage();
  const state = {
    catalog: {
      format: "keymaster.storage.catalog" as const,
      version: 2 as const,
      selectedBucketId: current.bucketId,
      buckets: [current, target]
    },
    lease: { bucketId: current.bucketId, bucketGeneration: 1 }
  };

  const bridge = async (input: LocalStorageBridgeRequest): Promise<LocalStorageBridgeResponse> => {
    if (input.type === "catalog-select") {
      const isRollback = input.rollbackFromSelectedBucketId !== undefined;
      const expected = isRollback ? input.rollbackFromSelectedBucketId : input.expectedSelectedBucketId;
      if (state.catalog.selectedBucketId !== expected) throw new Error("catalog selection conflict");
      const selected = state.catalog.buckets.find((bucket) => bucket.bucketId === input.targetBucket.bucketId);
      if (!selected || JSON.stringify(selected) !== JSON.stringify(input.targetBucket)) throw new Error("catalog target conflict");
      if (!isRollback) {
        if (state.lease.bucketId !== input.expectedSelectedBucketId || input.bucketGeneration !== state.lease.bucketGeneration + 1) throw new Error("invalid forward lease generation");
      } else if (state.lease.bucketId !== input.rollbackFromSelectedBucketId || input.bucketGeneration !== state.lease.bucketGeneration - 1) {
        throw new Error("invalid rollback lease generation");
      }
      state.catalog = { ...state.catalog, selectedBucketId: selected.bucketId };
      state.lease = { bucketId: selected.bucketId, bucketGeneration: input.bucketGeneration };
      return { type: "catalog", bucket: selected };
    }
    if (input.type === "catalog-update") {
      const current = state.catalog.buckets.find((bucket) => bucket.bucketId === input.expectedBucket.bucketId);
      if (!current || JSON.stringify(current) !== JSON.stringify(input.expectedBucket)) throw new Error("catalog update conflict");
      state.catalog = {
        ...state.catalog,
        buckets: state.catalog.buckets.map((bucket) => bucket.bucketId === input.nextBucket.bucketId ? structuredClone(input.nextBucket) : bucket),
      };
      return { type: "catalog", bucket: structuredClone(input.nextBucket) };
    }
    if (input.type === "catalog-commit") throw new Error("catalog-commit is not used by this fixture");
    if (input.type !== "get" && input.type !== "list" && input.type !== "put" && input.type !== "delete") {
      throw new Error(`unsupported bridge request: ${input.type}`);
    }

    const provider = createLocalStorageBucketProvider({
      storage,
      locks: catalogBridgeLocks,
      bucketId: input.bucketId,
      bucketGeneration: input.bucketGeneration
    });
    try {
      if (input.type === "get") return { type: "object", object: await provider.get(input.path, input.ifMatch ? { ifMatch: input.ifMatch } : {}) };
      if (input.type === "list") return { type: "list", ...(await provider.list(input)) };
      if (input.type === "put") return { type: "write", ...(await provider.put(input.path, input.bytes, input.condition ?? {})) };
      await provider.delete(input.path, input.ifMatch ? { ifMatch: input.ifMatch } : {});
      return { type: "void" };
    } finally {
      provider.dispose();
    }
  };
  return { state, bridge };
}

/**
 * 模拟真实页面的设备目录投影：设备连接 upsert 后，目录条目随连接密文更新。
 * 真实实现中目录由设备连接派生；测试夹具把两者分开保存，因此需要在
 * connection upsert 后同步投影，才能覆盖“连接后再次提交目录”的幂等路径。
 */
function projectCatalogFromDeviceConnection(
  fixture: ReturnType<typeof makeInitialSetupWorkerBridge>,
): (input: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse> {
  return async (input) => {
    const response = await fixture.bridge(input);
    if (input.type === "device-bootstrap-connection-upsert") {
      const current = fixture.getCatalog().buckets.find((candidate) => candidate.bucketId === input.connection.remoteStorageId);
      if (current) {
        fixture.setCatalog({
          format: "keymaster.storage.catalog",
          version: 2,
          selectedBucketId: input.connection.remoteStorageId,
          buckets: [{
            ...current,
            label: input.connection.displayName,
            backend: input.connection.providerId,
            keyDerivation: structuredClone(input.connection.keyDerivation),
            encryptedConfig: structuredClone(input.connection.encryptedConfig),
            updatedAt: input.connection.updatedAt,
          }],
        });
      }
    }
    return response;
  };
}

/**
 * 最小内存 S3 对象存储：支持条件写、ETag 与分页 list。
 * 每个 Provider 拿到独立实例，但共享同一个对象 Map 以模拟同一物理远端。
 */
function createMemoryBucketObjectStore(objects: Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>): BucketObjectStore {
  let disposed = false;
  const assertOpen = (): void => { if (disposed) throw new Error("memory bucket object store is disposed"); };
  const conflict = (): StorageRuntimeError => new StorageRuntimeError("storage_conflict", "memory object changed");
  const notFound = (): StorageRuntimeError => new StorageRuntimeError("storage_not_found", "memory object was not found");
  return {
    async probe(): Promise<void> { assertOpen(); },
    async list(input: Parameters<BucketObjectStore["list"]>[0]) {
      assertOpen();
      const prefix = input.prefix ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort((left, right) => left.localeCompare(right));
      const start = input.continuationToken ? Number(input.continuationToken) : 0;
      const pageKeys = keys.slice(start, start + input.maxKeys);
      return {
        objects: pageKeys.map((key) => ({ key, size: objects.get(key)!.bytes.byteLength, etag: objects.get(key)!.etag, lastModified: objects.get(key)!.lastModified })),
        commonPrefixes: [],
        ...(start + pageKeys.length < keys.length ? { nextContinuationToken: String(start + pageKeys.length) } : {}),
      };
    },
    async put(input: Parameters<BucketObjectStore["put"]>[0]) {
      assertOpen();
      const existing = objects.get(input.key);
      if (input.ifNoneMatch === "*" && existing) throw conflict();
      if (input.ifMatch !== undefined && (!existing || existing.etag !== input.ifMatch)) throw conflict();
      const entry = { bytes: input.bytes.slice(), etag: crypto.randomUUID(), lastModified: new Date() };
      objects.set(input.key, entry);
      return { etag: entry.etag, lastModified: entry.lastModified };
    },
    async head(input: Parameters<BucketObjectStore["head"]>[0]) {
      assertOpen();
      return objects.has(input.key);
    },
    async get(input: Parameters<BucketObjectStore["get"]>[0]) {
      assertOpen();
      const existing = objects.get(input.key);
      if (!existing || (input.ifMatch !== undefined && existing.etag !== input.ifMatch)) throw notFound();
      return { bytes: existing.bytes.slice(), offset: 0, contentLength: existing.bytes.byteLength, totalSize: existing.bytes.byteLength, etag: existing.etag, lastModified: existing.lastModified };
    },
    async delete(input: Parameters<BucketObjectStore["delete"]>[0]) {
      assertOpen();
      const existing = objects.get(input.key);
      if (existing && input.ifMatch !== undefined && existing.etag !== input.ifMatch) throw conflict();
      objects.delete(input.key);
    },
    async createMultipart(): Promise<string> { assertOpen(); return crypto.randomUUID(); },
    async uploadPart(input: Parameters<BucketObjectStore["uploadPart"]>[0]) { assertOpen(); const entry = { bytes: input.bytes.slice(), etag: crypto.randomUUID(), lastModified: new Date() }; objects.set(`${input.key}/${input.partNumber}`, entry); return entry.etag; },
    async completeMultipart(input: Parameters<BucketObjectStore["completeMultipart"]>[0]) { assertOpen(); return { etag: input.parts[0]?.etag ?? crypto.randomUUID(), lastModified: new Date() }; },
    async abortMultipart(): Promise<void> { assertOpen(); },
    dispose(): void { disposed = true; },
  } as BucketObjectStore;
}

type TestS3ProviderConfig = Parameters<typeof createS3BucketProvider>[0];

/**
 * 内存 S3 Provider 选项工厂：同一份对象 Map 按 accessKeyId 共享，
 * 被撤销的凭据返回拒绝所有操作的对象存储。
 */
function makeFakeS3ProviderOptionsFactory(
  objects: Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>,
  revokedKeys: Set<string>,
  observedKeys: string[],
  wrapStore?: (store: BucketObjectStore) => BucketObjectStore,
): (config: TestS3ProviderConfig) => { store: BucketObjectStore; capabilityState: ReturnType<typeof createBucketObjectStoreCapabilityState> } {
  return (config) => {
    const accessKeyId = config.credentials.kind === "access-key" ? config.credentials.accessKeyId : "unknown";
    observedKeys.push(accessKeyId);
    const capabilityState = createBucketObjectStoreCapabilityState();
    setBucketObjectStoreCapabilityMode(capabilityState, "put", "native", "manual");
    setBucketObjectStoreCapabilityMode(capabilityState, "complete", "native", "manual");
    if (revokedKeys.has(accessKeyId)) {
      const reject = (): never => { throw new Error("injected revoked S3 credentials"); };
      const store = {
        probe: reject, list: reject, put: reject, head: reject, get: reject, delete: reject,
        createMultipart: reject, uploadPart: reject, completeMultipart: reject, abortMultipart: reject,
        dispose: () => undefined,
      } as unknown as BucketObjectStore;
      return { store, capabilityState };
    }
    const store = createMemoryBucketObjectStore(objects);
    return { store: wrapStore ? wrapStore(store) : store, capabilityState };
  };
}

/** 只拦截 manifest 路径的对象存储包装，用于注入并发替换/响应丢失/读回谎言。 */
function makeHookedManifestStore(
  base: BucketObjectStore,
  hook: {
    armed: boolean;
    onPut?: (
      input: { key: string; bytes: Uint8Array; ifMatch?: string },
      base: BucketObjectStore,
      manifestPutIndex: number,
    ) => Promise<void>;
    onGet?: (
      input: { key: string },
      base: BucketObjectStore,
    ) => Promise<BucketGetOutput | undefined>;
  },
): BucketObjectStore {
  let manifestPuts = 0;
  return {
    ...base,
    async put(input: Parameters<BucketObjectStore["put"]>[0]) {
      if (hook.armed && input.key.endsWith(".keymaster/root/v1")) {
        manifestPuts += 1;
        if (hook.onPut) await hook.onPut(input, base, manifestPuts);
      }
      return base.put(input);
    },
    async get(input: Parameters<BucketObjectStore["get"]>[0]) {
      if (hook.armed && hook.onGet && input.key.endsWith(".keymaster/root/v1")) {
        const override = await hook.onGet(input, base);
        if (override !== undefined) return override;
      }
      return base.get(input);
    },
  };
}

function makeInitialSetupWorkerBridge(initialCatalog: StorageCatalogV2 = { format: "keymaster.storage.catalog", version: 2, buckets: [] }) {
  const storage = new CatalogBridgeStorage();
  let catalog: StorageCatalogV2 = structuredClone(initialCatalog);
  const recovery = new Map<string, InitialSetupRecoveryRecordV1>();
  const events: string[] = [];
  const writeOperations: Array<{ type: "put" | "delete"; path: string }> = [];
  const conflict = (message: string): Error & { code: string } => Object.assign(new Error(message), { code: "storage_conflict" });
  const bridge = async (input: LocalStorageBridgeRequest): Promise<LocalStorageBridgeResponse> => {
    if (input.type === "device-bootstrap-read"
      || input.type === "device-bootstrap-connection-upsert"
      || input.type === "device-bootstrap-recovery-upsert"
      || input.type === "device-bootstrap-recovery-delete"
      || input.type === "device-bootstrap-rotation-upsert"
      || input.type === "device-bootstrap-rotation-delete") {
      const repository = createDeviceBootstrapRepository({ storage, locks: catalogBridgeLocks });
      let deviceCatalog;
      if (input.type === "device-bootstrap-connection-upsert") await repository.upsertConnection(input.connection, input.select ?? true);
      else if (input.type === "device-bootstrap-recovery-upsert") await repository.upsertRecovery(input.recovery);
      else if (input.type === "device-bootstrap-recovery-delete") deviceCatalog = await repository.removeRecovery(input.operationId);
      else if (input.type === "device-bootstrap-rotation-upsert") await repository.upsertRotation(input.rotation);
      else if (input.type === "device-bootstrap-rotation-delete") deviceCatalog = await repository.removeRotation(input.operationId);
      return { type: "device-bootstrap", catalog: deviceCatalog ?? repository.read() };
    }
    if (input.type === "catalog-read") return { type: "catalog-state", catalog: structuredClone(catalog) };
    if (input.type === "catalog-update") {
      const current = catalog.buckets.find((bucket) => bucket.bucketId === input.expectedBucket.bucketId);
      // 与真实页面一致：目录 CAS 只比较设备投影（标签/后端/KDF/密文），不比较 revision。
      if (!current || !sameStorageCatalogDeviceProjection(current, input.expectedBucket)) throw conflict("catalog update conflict");
      catalog = {
        ...catalog,
        buckets: catalog.buckets.map((bucket) => bucket.bucketId === input.nextBucket.bucketId ? structuredClone(input.nextBucket) : bucket),
      };
      // 真实页面 writeStorageCatalog 会把设备连接密文更新为 nextBucket 的密文。
      const repository = createDeviceBootstrapRepository({ storage, locks: catalogBridgeLocks });
      const deviceCatalog = repository.read();
      const existing = deviceCatalog?.connections.find((connection) => connection.remoteStorageId === input.nextBucket.bucketId);
      if (deviceCatalog && existing) {
        await repository.upsertConnection({
          ...existing,
          displayName: input.nextBucket.label,
          keyDerivation: structuredClone(input.nextBucket.keyDerivation),
          encryptedConfig: structuredClone(input.nextBucket.encryptedConfig),
          updatedAt: input.nextBucket.updatedAt,
        });
      }
      return { type: "catalog", bucket: structuredClone(input.nextBucket) };
    }
    if (input.type === "catalog-commit") {
      if (input.rollback) {
        events.push("catalog-rollback");
        if (catalog.buckets.length === 0 && catalog.selectedBucketId === undefined) return { type: "catalog", bucket: input.targetBucket };
        if (catalog.selectedBucketId !== input.targetBucket.bucketId || catalog.buckets.length !== 1 || JSON.stringify(catalog.buckets[0]) !== JSON.stringify(input.targetBucket)) {
          throw conflict("catalog rollback conflict");
        }
        catalog = { format: "keymaster.storage.catalog", version: 2, buckets: [] };
        return { type: "catalog", bucket: input.targetBucket };
      }
      if (catalog.buckets.length > 0 || catalog.selectedBucketId !== undefined) {
        if (catalog.selectedBucketId === input.targetBucket.bucketId && catalog.buckets.length === 1 && JSON.stringify(catalog.buckets[0]) === JSON.stringify(input.targetBucket)) return { type: "catalog", bucket: input.targetBucket };
        throw conflict("catalog commit conflict");
      }
      catalog = { format: "keymaster.storage.catalog", version: 2, selectedBucketId: input.targetBucket.bucketId, buckets: [structuredClone(input.targetBucket)] };
      return { type: "catalog", bucket: input.targetBucket };
    }
    if (input.type === "get" || input.type === "list" || input.type === "put" || input.type === "delete") {
      if (input.type === "put") { events.push("put"); writeOperations.push({ type: "put", path: input.path }); }
      if (input.type === "delete") { events.push("delete"); writeOperations.push({ type: "delete", path: input.path }); }
      const provider = createLocalStorageBucketProvider({ storage, locks: catalogBridgeLocks, bucketId: input.bucketId, bucketGeneration: input.bucketGeneration });
      try {
        if (input.type === "get") return { type: "object", object: await provider.get(input.path, input.ifMatch ? { ifMatch: input.ifMatch } : {}) };
        if (input.type === "list") return { type: "list", ...(await provider.list(input)) } as LocalStorageBridgeResponse;
        if (input.type === "put") return { type: "write", ...(await provider.put(input.path, input.bytes, input.condition ?? {})) };
        await provider.delete(input.path, input.ifMatch ? { ifMatch: input.ifMatch } : {});
        return { type: "void" };
      } finally { provider.dispose(); }
    }
    throw new Error(`unsupported initial setup bridge request: ${input.type}`);
  };
  return {
    storage,
    recovery,
    events,
    writeOperations,
    getCatalog: () => structuredClone(catalog),
    setCatalog: (next: StorageCatalogV2) => { catalog = structuredClone(next); },
    bridge,
  };
}

describe("Coordinator ChannelProtocol 私信编码边界", () => {
  it("通过真实 WebRTC parser 编码 bsv8.webrtc.signal.v1 的全部信令分支", () => {
    const requestMessageId = newMessageID();
    const sessionId = newSessionID();
    const body = __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", {
      request_message_id: requestMessageId,
      session_id: sessionId,
      signal: { type: "offer", sdp: "v=0\\r\\nm=audio 9 RTP/AVP 0" }
    });

    expect(parseWebrtcBodyValue(body as unknown as JSONValue)).toMatchObject({
      request_message_id: requestMessageId,
      session_id: sessionId,
      signal: { type: "offer", sdp: "v=0\\r\\nm=audio 9 RTP/AVP 0" }
    });
    const branches: JSONValue[] = [
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: { type: "answer", sdp: "v=0" }
      },
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: {
          type: "ice-candidate",
          candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host", sdp_mid: null, sdp_m_line_index: 0 }
        }
      },
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: { type: "end-of-candidates" }
      }
    ];
    for (const branch of branches) {
      const encoded = __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", branch);
      expect(() => parseWebrtcBodyValue(encoded as unknown as JSONValue)).not.toThrow();
    }
    expect(() => __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", {
      schema: "keymaster.webrtc.v1",
      type: "offer",
      sessionId,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      sdp: "v=0"
    })).toThrow();
  });

  it("按 Host 绑定的 caller 身份限制私有协议发布", () => {
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "message" },
      "bsv8.message.v1"
    )).not.toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "webrtc" },
      "bsv8.webrtc.signal.v1"
    )).not.toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "system", systemId: "contacts-presence" },
      "bsv8.ping.v1"
    )).not.toThrow();

    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "message" },
      "bsv8.webrtc.signal.v1"
    )).toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "bsv-price" },
      "bsv8.ping.v1"
    )).toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "connect", connectSessionId: "session", origin: "https://app.example" },
      "bsv8.message.v1"
    )).toThrow();
  });

  it("使用 ChannelProtocol TTL 完成真实私密消息签名与验证", () => {
    const nowMs = 1_700_000_000_000;
    const privateKeyHex = "0000000000000000000000000000000000000000000000000000000000000001";
    const recipientPublicKeyHex = validPublisherKey(2);
    const cases = [
      {
        protocol: "bsv8.ping.v1",
        content: { type: "ping" } as JSONValue,
        lifetimeMs: 60_000
      },
      {
        protocol: "bsv8.webrtc.signal.v1",
        content: {
          request_message_id: newMessageID(),
          session_id: newSessionID(),
          signal: { type: "offer", sdp: "v=0\\r\\nm=application 9 DTLS/SCTP 5000" }
        } as JSONValue,
        lifetimeMs: 120_000
      },
      {
        protocol: "bsv8.message.v1",
        content: { type: "deliver", content: { hello: "world" } } as JSONValue,
        lifetimeMs: 24 * 60 * 60 * 1000
      }
    ];

    for (const item of cases) {
      const signed = __testSignChannelPrivateMessage({
        recipientPublicKeyHex,
        protocol: item.protocol,
        content: item.content,
        nowMs,
        privateKeyHex
      });
      expect(signed.expires_at_ms - signed.issued_at_ms).toBe(item.lifetimeMs);
      expect(() => verifySignedPrivateMessage(signed, nowMs + 1)).not.toThrow();
    }
  });

  it("公开消息时间只读取一次系统时钟", () => {
    const clocks = [1_700_000_000_000, 1_700_000_000_001];
    const times = __testBuildChannelPublicMessageTimes(() => clocks.shift() ?? 0);
    expect(times).toEqual({
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_000_000 + PUBLIC_MESSAGE_MAX_LIFETIME_MS
    });
    // 第二个值故意存在：如果实现再次读取 Date.now，这个测试的输入就会被消耗。
    expect(clocks).toEqual([1_700_000_000_000 + 1]);
  });

  it("公共、私密与 Hash Request 消息使用独立的本地去重命名空间", () => {
    const sharedFirstPart = "bsv8.ping.v1";
    const publisherPublicKey = validPublisherKey(1);
    const messageId = newMessageID();

    const privateSeenKey = __testBuildChannelSeenMessageKey(
      "private",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    );
    const publicSeenKey = __testBuildChannelSeenMessageKey(
      "public",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    );
    const hashRequestSeenKey = __testBuildChannelSeenMessageKey(
      "hash-request",
      `${publisherPublicKey}\u0000${messageId}`
    );

    expect(new Set([privateSeenKey, publicSeenKey, hashRequestSeenKey]).size).toBe(3);
    expect(__testBuildChannelSeenMessageKey(
      "public",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    )).toBe(publicSeenKey);
  });
});

describe("Session Coordinator worker", () => {
  it("真实 session handler：同一 peer 的旧 binding close 后 fresh lease open 产生新的 binding/owner", async () => {
    __testResetState();
    await __testDeleteVault();
    const harness = makeCoordinatorTestPeer("session-fresh-lease-peer");
    installCoordinatorSessionInitializationBridge();
    await __testCreateVault("session-test-password");

    try {
      const oldResponse = await __testHandleCoordinatorSessionRpc(harness.peer, sessionOpen("lease-old"));
      const oldBinding = sessionBindingFromOpenResponse(oldResponse);

      await __testHandleCoordinatorSessionRpc(harness.peer, sessionClose(oldBinding));
      await __testAwaitCoordinatorPeerDrain(harness.peer.peerId);

      const freshResponse = await __testHandleCoordinatorSessionRpc(harness.peer, sessionOpen("lease-fresh"));
      const freshBinding = sessionBindingFromOpenResponse(freshResponse);
      expect(freshBinding).not.toEqual(oldBinding);
      expect(freshBinding.peerGeneration).toBeGreaterThan(oldBinding.peerGeneration);
      expect(freshBinding.leaseId).toBe("lease-fresh");
      expect(harness.exposureCount).toBe(2);
      expect(harness.exposureRevocationCount).toBe(1);

      // 清除初始化 override 后不传 peerId；默认 owner 必须是 fresh lease。
      __testSetLocalStorageBridgeOverride(undefined);
      await expect(__testRequestCoordinatorLocalStorageBridge({ type: "catalog-read" })).resolves.toMatchObject({
        type: "catalog-state",
      });
      expect(harness.bridgeCalls).toHaveLength(1);
      expect(harness.bridgeCalls[0]?.request).toMatchObject(freshBinding);
    } finally {
      __testSetLocalStorageBridgeOverride(undefined);
      await __testAwaitCoordinatorPeerDrain(harness.peer.peerId);
      await __testDeleteVault();
      __testResetState();
    }
  });

  it("真实 session handler：旧 binding 的 late close 不能 revoke fresh session", async () => {
    __testResetState();
    await __testDeleteVault();
    const harness = makeCoordinatorTestPeer("session-late-close-peer");
    installCoordinatorSessionInitializationBridge();
    await __testCreateVault("session-test-password");

    try {
      const oldBinding = sessionBindingFromOpenResponse(
        await __testHandleCoordinatorSessionRpc(harness.peer, sessionOpen("lease-old")),
      );
      const freshBinding = sessionBindingFromOpenResponse(
        await __testHandleCoordinatorSessionRpc(harness.peer, sessionOpen("lease-fresh")),
      );
      expect(freshBinding.peerGeneration).toBeGreaterThan(oldBinding.peerGeneration);

      await __testHandleCoordinatorSessionRpc(harness.peer, sessionClose(oldBinding));
      await __testAwaitCoordinatorPeerDrain(harness.peer.peerId);

      __testSetLocalStorageBridgeOverride(undefined);
      await expect(__testRequestCoordinatorLocalStorageBridge({ type: "catalog-read" })).resolves.toMatchObject({
        type: "catalog-state",
      });
      expect(harness.bridgeCalls).toHaveLength(1);
      expect(harness.bridgeCalls[0]?.request).toMatchObject(freshBinding);
      // replacement open 已撤销旧 exposure；late close 不能再撤销 fresh exposure。
      expect(harness.exposureRevocationCount).toBe(1);
    } finally {
      __testSetLocalStorageBridgeOverride(undefined);
      await __testAwaitCoordinatorPeerDrain(harness.peer.peerId);
      await __testDeleteVault();
      __testResetState();
    }
  });

  it("真实 session handler：关闭当前 owner 后 LocalStorage ownership handoff 到另一个 open peer", async () => {
    __testResetState();
    await __testDeleteVault();
    const first = makeCoordinatorTestPeer("session-owner-first-peer");
    const second = makeCoordinatorTestPeer("session-owner-second-peer");
    installCoordinatorSessionInitializationBridge();
    await __testCreateVault("session-test-password");

    try {
      const firstBinding = sessionBindingFromOpenResponse(
        await __testHandleCoordinatorSessionRpc(first.peer, sessionOpen("lease-first")),
      );
      const secondBinding = sessionBindingFromOpenResponse(
        await __testHandleCoordinatorSessionRpc(second.peer, sessionOpen("lease-second")),
      );
      expect(first.exposureCount).toBe(1);
      expect(second.exposureCount).toBe(1);

      // second 是最新提交的 owner；close 仍经真实 session.close handler。
      await __testHandleCoordinatorSessionRpc(second.peer, sessionClose(secondBinding));
      await __testAwaitCoordinatorPeerDrain(second.peer.peerId);

      __testSetLocalStorageBridgeOverride(undefined);
      await expect(__testRequestCoordinatorLocalStorageBridge({ type: "catalog-read" })).resolves.toMatchObject({
        type: "catalog-state",
      });
      expect(first.bridgeCalls).toHaveLength(1);
      expect(second.bridgeCalls).toHaveLength(0);
      expect(first.bridgeCalls[0]?.request).toMatchObject(firstBinding);
    } finally {
      __testSetLocalStorageBridgeOverride(undefined);
      await __testAwaitCoordinatorPeerDrain(first.peer.peerId);
      await __testAwaitCoordinatorPeerDrain(second.peer.peerId);
      await __testDeleteVault();
      __testResetState();
    }
  });

  it("真实 session.close handler：bridge response in-flight 时 fence 后拒绝旧响应", async () => {
    __testResetState();
    let releaseBridge!: (response: LocalStorageBridgeResponse) => void;
    const bridgeResponse = new Promise<LocalStorageBridgeResponse>((resolve) => {
      releaseBridge = resolve;
    });
    const harness = makeCoordinatorTestPeer("session-inflight-fence-peer", async (_request, _signal) => bridgeResponse);
    installCoordinatorSessionInitializationBridge();

    try {
      const binding = sessionBindingFromOpenResponse(
        await __testHandleCoordinatorSessionRpc(harness.peer, sessionOpen("lease-inflight")),
      );
      __testSetLocalStorageBridgeOverride(undefined);

      const oldResponse = __testRequestCoordinatorLocalStorageBridge({ type: "catalog-read" }, harness.peer.peerId);
      expect(harness.bridgeCalls).toHaveLength(1);
      const bridgeSignal = harness.bridgeCalls[0]!.signal;
      let closeSettled = false;
      const closing = __testHandleCoordinatorSessionRpc(
        harness.peer,
        sessionClose(binding),
        undefined,
        { waitForDrain: true },
      ).then(() => { closeSettled = true; });
      await flush();
      expect(closeSettled).toBe(false);
      expect(bridgeSignal.aborted).toBe(true);

      releaseBridge({ type: "catalog-state", catalog: structuredClone(EMPTY_STORAGE_CATALOG) });
      await expect(oldResponse).rejects.toMatchObject({ code: "service_reference_stale" });
      await closing;
      expect(closeSettled).toBe(true);
    } finally {
      // releaseBridge 在断言失败时也要释放 fake capability，避免 reset 遗留 drain。
      releaseBridge?.({ type: "catalog-state", catalog: structuredClone(EMPTY_STORAGE_CATALOG) });
      await __testAwaitCoordinatorPeerDrain(harness.peer.peerId);
      __testSetLocalStorageBridgeOverride(undefined);
      __testResetState();
    }
  });

  it("同步抛出的 LocalStorage bridge call 会清理 pending 并允许 close drain 完成", async () => {
    __testResetState();
    const peerId = "sync-throw-bridge-peer";
    const binding: CoordinatorSessionBinding = {
      peerGeneration: 1,
      sessionEpoch: "sync-throw-epoch",
      leaseId: "sync-throw-lease",
    };
    const source = new AbortController();
    const syncError = new Error("synchronous bridge dispatch failure");
    const removeAbortListener = vi.spyOn(source.signal, "removeEventListener");
    const scope = {
      state: "active" as const,
      onRevoke: () => () => undefined,
    } as unknown as PeerController["scope"];
    const peer = {
      peerId,
      scope,
      capability: (() => ({ call: () => { throw syncError; } })) as unknown as PeerController["capability"],
    } as Pick<PeerController, "peerId" | "scope" | "capability">;

    try {
      __testInstallCoordinatorBridgePeer(peer, binding);
      const request = __testRequestCoordinatorLocalStorageBridge({ type: "catalog-read", signal: source.signal } satisfies LocalStorageBridgeRequest, peerId);
      expect(request).toBeInstanceOf(Promise);
      await expect(request).rejects.toBe(syncError);
      expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
      await expect(__testCloseCoordinatorBridgePeer(peerId, binding)).resolves.toBeUndefined();
    } finally {
      __testResetState();
    }
  });

  it("绑定已发布后初始化失败时回滚目录、Root 和 Worker 会话", async () => {
    __testResetState();
    const password = "catalog-switch-password";
    const current = await makeEncryptedLocalCatalogEntry("catalog-current", "当前桶", password);
    const target = await makeEncryptedLocalCatalogEntry("catalog-target", "目标桶", password);
    const fixture = makeCatalogBridgeFixture(current, target);
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    try {
      await __testInstallCatalogLocalBinding(current);
      __testSetVaultStatus("uninitialized");
      __testFailAfterCatalogBindingPublish();

      await expect(__testSwitchCatalogBucket(target, password)).rejects.toThrow("injected catalog binding initialization failure");
      expect(fixture.state.catalog.selectedBucketId).toBe(current.bucketId);
      expect(fixture.state.lease).toEqual({ bucketId: current.bucketId, bucketGeneration: 1 });
      expect(__testGetSnapshot()).toMatchObject({
        storageBucketId: current.bucketId,
        storageBucketGeneration: 1,
        vaultStatus: "uninitialized"
      });
    } finally {
      await __testReleaseCatalogLocalBinding();
      __testResetState();
    }
  }, 20_000);

  it("切换 Key 前先排空旧 owner 请求，Provider 忽略 AbortSignal 也不能越过 fence", async () => {
    await __testDeleteVault();
    __testResetState();
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", {
      label: "second",
      material: { hex: "2".padStart(64, "0") },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    const oldOwner = second.publicKeyHex;
    const release = __testSeedOwnerStorageRequest(oldOwner);
    const switching = __testSetActive(first.publicKeyHex!);
    await flush();
    expect(__testGetActivePublicKeyHex()).toBe(oldOwner);
    release();
    await switching;
    expect(__testGetActivePublicKeyHex()).toBe(first.publicKeyHex);
  });

  it("lock 后的旧 owner drain 未完成时不能提前 unlock", async () => {
    await __testDeleteVault();
    __testResetState();
    const key = await __testCreateVault("pw", { label: "lock-drain" });
    const release = __testSeedOwnerStorageRequest(key.publicKeyHex!);
    await __testLock();
    expect(__testGetVaultStatus()).toBe("locked");

    const unlocking = __testUnlock("pw", key.publicKeyHex);
    await flush();
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    release();
    await unlocking;
    expect(__testGetVaultStatus()).toBe("unlocked");
    expect(__testGetActivePublicKeyHex()).toBe(key.publicKeyHex);
  });

  it("lock(A) → unlock(B) → switch(A) 后仍可写入 A 的 owner K-V", async () => {
    await __testDeleteVault();
    __testResetState();
    const first = await __testCreateVault("pw", { label: "first-owner" });
    const second = await __testImportPrivateKey("pw", {
      label: "second-owner",
      material: { hex: "2".padStart(64, "0") },
      format: "hex",
      capabilities: ["p2pkh"]
    });
    await __testSetActive(first.publicKeyHex!);
    await __testLock();
    await __testUnlock("pw", second.publicKeyHex);
    await __testSetActive(first.publicKeyHex!);
    await expect(__testOwnerStoragePut("after-lock-switch", { owner: "first" })).resolves.toBeUndefined();
  });

  it("普通 lock→unlock 不写 Coordinator 固定对象，真实变化只写所属对象", async () => {
    await __testDeleteVault();
    __testResetState();
    const first = await __testCreateVault("pw", { label: "snapshot-first" });
    const second = await __testImportPrivateKey("pw", {
      label: "snapshot-second",
      material: { hex: "3".padStart(64, "0") },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await __testSetActive(first.publicKeyHex!);

    const beforeLifecycle = __testCoordinatorSnapshotMetrics();
    await __testLock();
    await __testUnlock("pw", first.publicKeyHex);
    expect(__testCoordinatorSnapshotMetrics()).toEqual(beforeLifecycle);

    await __testSetActive(second.publicKeyHex);
    const afterSelection = __testCoordinatorSnapshotMetrics();
    expect(afterSelection.selection).toEqual({ revision: beforeLifecycle.selection.revision + 1, writes: beforeLifecycle.selection.writes + 1 });
    expect(afterSelection.settings).toEqual(beforeLifecycle.settings);
    expect(afterSelection.pluginIntent).toEqual(beforeLifecycle.pluginIntent);

    await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 61_000 });
    const afterSettings = __testCoordinatorSnapshotMetrics();
    expect(afterSettings.settings).toEqual({ revision: afterSelection.settings.revision + 1, writes: afterSelection.settings.writes + 1 });
    expect(afterSettings.selection).toEqual(afterSelection.selection);
    expect(afterSettings.pluginIntent).toEqual(afterSelection.pluginIntent);

    const messages: unknown[] = [];
    __testAttachPort("snapshot-intent-port", (message) => messages.push(message));
    const snapshot = __testGetSnapshot();
    await __testDispatchStorageMessage("snapshot-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "snapshot-intent-port",
      requestId: "snapshot-intent-change",
      command: {
        commandId: "snapshot-intent-change:1",
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: "background",
        desiredEnabled: false,
      },
    });
    expect(messages.find((message) => (message as { requestId?: string }).requestId === "snapshot-intent-change")).toMatchObject({ operationResult: { status: "accepted" } });
    const afterIntent = __testCoordinatorSnapshotMetrics();
    expect(afterIntent.pluginIntent).toEqual({ revision: afterSettings.pluginIntent.revision + 1, writes: afterSettings.pluginIntent.writes + 1 });
    expect(afterIntent.selection).toEqual(afterSettings.selection);
    expect(afterIntent.settings).toEqual(afterSettings.settings);
  });

  it("Provider 忽略 AbortSignal 时，lock→unlock 仍等待真实 storage.data 结束", async () => {
    await __testDeleteVault();
    __testResetState();
    const key = await __testCreateVault("pw", { label: "provider-drain" });
    const ownerPublicKeyHex = key.publicKeyHex!;
    const identity = {
      version: 1 as const,
      publisherPublicKeyHex: ownerPublicKeyHex,
      appId: "provider-drain",
      appName: "Provider Drain",
      identityDigestHex: "ab".repeat(32)
    };
    let releaseProvider!: () => void;
    const providerPending = new Promise<void>((resolve) => { releaseProvider = resolve; });
    __testSetStorageSessionResolver(async (sessionId) => ({
      sessionId,
      origin: "https://provider-drain.example",
      ownerPublicKeyHex,
      appIdentity: identity,
      revokedAt: null
    }));
    __testSetStorageRuntime({
      list: async () => {
        await providerPending;
        return { prefix: "", parentPrefix: "", directories: [], files: [] };
      },
      abortSession: async () => undefined
    });

    try {
      const grant = await __testDispatchStorageGrant("provider-drain-session", "provider-drain-port");
      expect(grant.ack.status).toBe("ok");
      const request = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "provider-drain-port" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      await __testLock();
      const unlocking = __testUnlock("pw", ownerPublicKeyHex);
      await flush();
      expect(__testGetVaultStatus()).toBe("locked");
      expect(__testGetActivePublicKeyHex()).toBeUndefined();

      releaseProvider();
      expect((await request).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
      expect((await unlocking).ack.status).toBe("accepted");
      expect(__testGetActivePublicKeyHex()).toBe(ownerPublicKeyHex);
    } finally {
      __testSetStorageSessionResolver(undefined);
      __testSetStorageRuntime(undefined);
    }
  });

  it("rejects forged client ownership and revoked/changed Storage grants", async () => {
    __testResetState();
    const ownerPublicKeyHex = VALID_PUBLISHER_KEYS[2]!;
    __testSetVaultStatus("unlocked", ownerPublicKeyHex);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[0]!, appId: "app", appName: "App", identityDigestHex: "aa".repeat(32) };
    let revoked = false;
    __testSetStorageSessionResolver(async (id) => revoked ? null : { sessionId: id, origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const granted = await __testDispatchStorageGrant("session-a", "port-a", "forged-client");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    expect((await __testDispatchStorageData({ grantId, actualPortId: "forged-client", requestClientId: "port-a" })).ack.status).toBe("error");
    revoked = true;
    expect((await __testDispatchStorageGrant("session-a", "port-a")).ack.status).toBe("error");
    await expect(__testResolveStorageGrant(grantId, "port-a")).rejects.toThrow();
    __testSetStorageRuntime(undefined);
    __testSetStorageSessionResolver(undefined);
  });

  it("rejects unknown and identity-less sessions and binds grants to unchanged origin/identity", async () => {
    __testResetState();
    const ownerPublicKeyHex = VALID_PUBLISHER_KEYS[2]!;
    __testSetVaultStatus("unlocked", ownerPublicKeyHex);
    __testSetStorageSessionResolver(async () => null);
    expect((await __testDispatchStorageGrant("missing", "port-a")).ack.status).toBe("error");
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[1]!, appId: "app", appName: "App", identityDigestHex: "bb".repeat(32) };
    let origin = "https://one.example";
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, ownerPublicKeyHex, appIdentity: identity, revokedAt: null }));
    const granted = await __testDispatchStorageGrant("session-b", "port-a");
    expect(granted.ack.status).toBe("ok");
    origin = "https://two.example";
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-a")).rejects.toThrow();
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: { ...identity, publisherPublicKeyHex: "22".repeat(32) }, revokedAt: null }));
    expect((await __testDispatchStorageGrant("short-key", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: undefined as never, revokedAt: null }));
    expect((await __testDispatchStorageGrant("no-identity", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
  });

  it("enforces cancel owner and aborts only the selected session", async () => {
    __testResetState();
    __testSetStorageRuntime({ abortSession: async () => undefined });
    const a = __testSeedStorageRequest("a", "port-a", "session-a");
    const b = __testSeedStorageRequest("b", "port-b", "session-b");
    const collisionA = __testSeedStorageRequest("same", "port-a", "session-a");
    const collisionB = __testSeedStorageRequest("same", "port-b", "session-b");
    await __testDispatchStorageCancel("a", "port-b");
    expect(a.aborted).toBe(false);
    await __testDispatchStorageCancel("a", "port-a");
    expect(a.aborted).toBe(true);
    await __testDispatchStorageCancel("same", "port-a");
    expect(collisionA.aborted).toBe(true);
    expect(collisionB.aborted).toBe(false);
    await __testDispatchStorageAbort("session-b", "port-b");
    expect(b.aborted).toBe(true);
    __testSetStorageRuntime(undefined);
  });

  it("uses transferables without mutating the receiver payload", () => {
    const result = __testStorageTransfer(new Uint8Array([1, 2, 3]).buffer);
    expect(result.transferCount).toBe(1);
    expect(result.inputDetachedByteLength).toBe(0);
    expect(result.detachedByteLength).toBe(0);
    expect(result.receivedByteLength).toBe(3);
  });

  it("aborts a slow Storage data lane when the global lock preempts it", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", VALID_PUBLISHER_KEYS[2]!);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[2]!, appId: "app", appName: "App", identityDigestHex: "cc".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slow.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[2]!, appIdentity: identity, revokedAt: null }));
    __testSetStorageRuntime({ list: async (_ctx, input) => await new Promise((_, reject) => { input.signal?.addEventListener("abort", () => { reject(new Error("storage_unavailable")); }); }), abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("slow-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testReleaseStorageRuntime();
    expect((await pending).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
    __testSetStorageRuntime(undefined);
  });

  it("keeps physical slots occupied until ignored-AbortSignal Providers settle", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", VALID_PUBLISHER_KEYS[3]!);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[3]!, appId: "app", appName: "App", identityDigestHex: "ff".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slots.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[3]!, appIdentity: identity, revokedAt: null }));
    const releases: Array<() => void> = [];
    __testSetStorageRuntime({ list: async () => await new Promise<never>((resolve) => { releases.push(() => resolve(undefined as never)); }), abortSession: async () => undefined });
    const ports = ["port-a", "port-b", "port-c", "port-d"];
    const grants = await Promise.all(ports.map((port) => __testDispatchStorageGrant("slots-session", port)));
    const pending = grants.map((grant, index) => __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: ports[index]! }));
    await new Promise((resolve) => setTimeout(resolve, 20)); await __testReleaseStorageRuntime();
    expect((await Promise.all(pending)).every((response) => response.ack.status === "error")).toBe(true);
    expect(__testStorageQueueSnapshot().globalActive).toBe(4);
    releases.forEach((release) => release());
    await vi.waitFor(() => expect(__testStorageQueueSnapshot().globalActive).toBe(0));
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    const nextGrant = await __testDispatchStorageGrant("slots-session", "port-a");
    expect((await __testDispatchStorageData({ grantId: nextGrant.operationResult as string, actualPortId: "port-a" })).ack.status).toBe("ok");
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("取消四个忽略 AbortSignal 的操作后，第五个仍等待真实物理完成", async () => {
    await expect(__testStorageCancelKeepsPhysicalSlots()).resolves.toEqual({
      activeAfterCancel: 4,
      queuedAfterCancel: 1,
      fifthStartedAfterCancel: false,
      activeDuringFifth: 1,
      fifthStartedAfterPhysicalRelease: true,
      finalActive: 0
    });
  });

  it("rejects a late provider success after session epoch or generation changes", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", VALID_PUBLISHER_KEYS[4]!);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appId: "app", appName: "App", identityDigestHex: "dd".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appIdentity: identity, revokedAt: null }));
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let generation = 1;
    __testSetStorageRuntime({ getProviderSummary: async () => ({ generation, providerId: "aws-s3", bucketHint: "b", accessKeyHint: "k", secretConfigured: true, updatedAt: 1 }), list: async () => { await delayed; return { prefix: "", parentPrefix: "", directories: [], files: [] }; }, abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("late-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = 2;
    release();
    expect((await pending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testResetState();
    __testSetVaultStatus("unlocked", VALID_PUBLISHER_KEYS[4]!);
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appIdentity: identity, revokedAt: null }));
    let releaseEpoch!: () => void;
    const delayedEpoch = new Promise<void>((resolve) => { releaseEpoch = resolve; });
    __testSetStorageRuntime({ getProviderSummary: async () => ({ generation: 1, providerId: "aws-s3", bucketHint: "b", accessKeyHint: "k", secretConfigured: true, updatedAt: 1 }), list: async () => { await delayedEpoch; return { prefix: "", parentPrefix: "", directories: [], files: [] }; }, abortSession: async () => undefined });
    const epochGrant = await __testDispatchStorageGrant("late-epoch", "port-a");
    const epochPending = __testDispatchStorageData({ grantId: epochGrant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    __testInvalidateSession(); releaseEpoch();
    expect((await epochPending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("serializes password-rotation mutation with Storage controls", async () => {
    __testResetState();
    __testSetStorageRuntime({ status: () => "unconfigured", getProviderSummary: async () => null });
    const result = await __testStorageMutationBarrierProbe();
    expect(result).toEqual({ blockedBeforeRelease: true, completedAfterRelease: true });
    __testSetStorageRuntime(undefined);
  });

  it("keeps Storage startup failures isolated from Vault state", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const messages: unknown[] = [];
    __testAttachPort("startup-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("startup-port", { kind: "subscribe", clientId: "spoof", requestId: "sub-startup", topics: ["storage.state"] });
    __testSetStorageStartupFailure(true);
    const response = await __testDispatchStorageControl({ type: "status" });
    expect(response.ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    expect(__testGetVaultStatus()).toBe("unlocked");
    expect(messages.some((message) => (message as { status?: string }).status === "degraded")).toBe(true);
    __testSetStorageStartupFailure(false);
  });

  it("persists plugin intent in the Coordinator and rejects the old authority after restart", async () => {
    __testResetState();
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-port", (message) => messages.push(message));
    const first = __testGetSnapshot();
    const command = {
      commandId: "plugin-intent-test:1",
      authorityInstanceId: first.authorityInstanceId,
      expectedRevision: first.pluginIntent?.revision ?? 0,
      pluginId: "background",
      desiredEnabled: true,
    } as const;

    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-1",
      command,
    });
    const accepted = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-1") as {
      ack?: { status?: string };
      operationResult?: { status?: string; persisted?: boolean; snapshot?: { revision?: number; desiredEnabled?: Record<string, boolean> } };
    } | undefined;
    expect(accepted?.ack).toEqual({ status: "ok" });
    expect(accepted?.operationResult).toMatchObject({
      status: "accepted",
      persisted: true,
      snapshot: { desiredEnabled: { background: true } },
    });
    expect(__testGetSnapshot().pluginIntent?.desiredEnabled.background).toBe(true);

    __testResetState();
    const afterRestart = __testGetSnapshot();
    expect(afterRestart.authorityInstanceId).not.toBe(first.authorityInstanceId);
    messages.length = 0;
    __testAttachPort("plugin-intent-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-old-authority",
      command,
    });
    const stale = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-old-authority") as {
      operationResult?: { status?: string; expectedAuthorityInstanceId?: string };
    } | undefined;
    expect(stale?.operationResult).toMatchObject({
      status: "stale-authority",
      expectedAuthorityInstanceId: afterRestart.authorityInstanceId,
    });

    messages.length = 0;
    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-unknown-product",
      command: {
        ...command,
        commandId: "plugin-intent-test:unknown-product",
        authorityInstanceId: afterRestart.authorityInstanceId,
        expectedRevision: afterRestart.pluginIntent?.revision ?? 0,
        pluginId: "not-registered-product",
      },
    });
    const unknownProduct = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-unknown-product") as {
      ack?: { status?: string };
      operationResult?: { status?: string; message?: string };
    } | undefined;
    expect(unknownProduct?.ack).toEqual({ status: "ok" });
    expect(unknownProduct?.operationResult).toMatchObject({
      status: "command-conflict",
      message: "插件产品未在 Coordinator 内置清单注册",
    });
  });

  it("Root 重装从空 snapshot 恢复默认 settings 和新的 plugin-intent controller", async () => {
    __testResetState();
    await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 60_000 });
    const messages: unknown[] = [];
    __testAttachPort("root-reload-intent-port", (message) => messages.push(message));
    const before = __testGetSnapshot();
    await __testDispatchStorageMessage("root-reload-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "root-reload-intent-port",
      requestId: "root-reload-intent-disable",
      command: {
        commandId: "root-reload-intent:disable",
        authorityInstanceId: before.authorityInstanceId,
        expectedRevision: before.pluginIntent?.revision ?? 0,
        pluginId: "p2pkh",
        desiredEnabled: false,
      },
    });
    expect(__testGetSnapshot()).toMatchObject({
      scheduleSettings: { assetHoldingsIntervalMs: 60_000 },
      pluginIntent: { desiredEnabled: { p2pkh: false } },
    });

    const password = "root-reload-password";
    const current = await makeEncryptedLocalCatalogEntry("root-reload-current", "重装桶", password);
    const target = await makeEncryptedLocalCatalogEntry("root-reload-unused", "未使用桶", password);
    const bridge = makeCatalogBridgeFixture(current, target);
    __testSetLocalStorageBridgeOverride(bridge.bridge);
    try {
      await __testInstallCatalogLocalBinding(current);
      await __testReloadCoordinatorMeta();
      expect(__testGetSnapshot()).toMatchObject({
        scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
        pluginIntent: { revision: 0, desiredEnabled: {}, desiredRevision: {} },
      });
    } finally {
      await __testReleaseCatalogLocalBinding();
      __testResetState();
    }
  });

  it("blocks Coordinator tasks after product intent is persisted and resumes only after re-enable", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.transactions-sync",
      pluginId: "p2pkh",
      publicKeyHex: "a".repeat(64),
      run: async () => { runs += 1; },
    });
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-task-port", (message) => messages.push(message));
    const submit = async (desiredEnabled: boolean, requestId: string, commandId: string) => {
      const snapshot = __testGetSnapshot();
      await __testDispatchStorageMessage("plugin-intent-task-port", {
        kind: "plugin.intent.submit",
        clientId: "plugin-intent-task-port",
        requestId,
        command: {
          commandId,
          authorityInstanceId: snapshot.authorityInstanceId,
          expectedRevision: snapshot.pluginIntent?.revision ?? 0,
          pluginId: "p2pkh",
          desiredEnabled,
        },
      });
      return [...messages].reverse().find((message) => (message as { requestId?: string }).requestId === requestId) as { operationResult?: { status?: string } } | undefined;
    };

    await expect(submit(false, "plugin-intent-task-disable", "plugin-intent-task:disable")).resolves.toMatchObject({ operationResult: { status: "accepted" } });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({
      state: "blocked",
      blockedReason: { fallback: "Plugin disabled: p2pkh" },
      unitId: "p2pkh.coordinator-worker",
      instanceId: expect.any(String),
    });
    expect(__testGetSnapshot().coordinatorWorkerUnits?.some((unit) => unit.unitId === "p2pkh.coordinator-worker")).toBe(false);
    await __testRunTask("p2pkh.transactions-sync");
    expect(runs).toBe(0);
    await expect(__testBackgroundRunNow("p2pkh.transactions-sync")).resolves.toMatchObject({
      ack: { status: "blocked", reason: { fallback: "Plugin disabled: p2pkh" } },
    });

    await expect(submit(true, "plugin-intent-task-enable", "plugin-intent-task:enable")).resolves.toMatchObject({ operationResult: { status: "accepted" } });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({ state: "idle" });
    expect(__testGetSnapshot().coordinatorWorkerUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: "p2pkh",
        unitId: "p2pkh.coordinator-worker",
        state: "ready",
        instanceId: expect.any(String),
      }),
    ]));
    const enabledSnapshot = __testGetSnapshot();
    const enabledUnit = enabledSnapshot.coordinatorWorkerUnits?.find((unit) => unit.unitId === "p2pkh.coordinator-worker");
    const enabledTask = enabledSnapshot.taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync");
    expect(enabledUnit?.instanceId).toBe(enabledTask?.instanceId);
    await __testRunTask("p2pkh.transactions-sync");
    expect(runs).toBe(1);
  });

  it("projects WOC product intent to provider registry and token task gates", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    await __testP2pkhProvidersUpdate("main", { syncProviderId: "junglebus", broadcastProviderId: "woc" });
    // 只验证投影，不触发真实网络同步；锁定会让 provider change 的补偿
    // 调度保持在门禁状态，避免测试把外部供应商当成 fixture。
    __testSetVaultStatus("locked");

    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-provider-port", (message) => messages.push(message));
    const submit = async (desiredEnabled: boolean, commandId: string): Promise<void> => {
      const snapshot = __testGetSnapshot();
      await __testDispatchStorageMessage("plugin-intent-provider-port", {
        kind: "plugin.intent.submit",
        clientId: "plugin-intent-provider-port",
        requestId: commandId,
        command: {
          commandId,
          authorityInstanceId: snapshot.authorityInstanceId,
          expectedRevision: snapshot.pluginIntent?.revision ?? 0,
          pluginId: "woc",
          desiredEnabled,
        },
      });
      expect([...messages].reverse().find((message) => (message as { requestId?: string }).requestId === commandId)).toMatchObject({
        operationResult: { status: "accepted" },
      });
    };

    await submit(false, "plugin-intent-provider:disable");
    const disabled = __testGetSnapshot();
    expect(disabled.p2pkhProviders?.syncProviders.some((provider) => provider.id === "woc")).toBe(false);
    expect(disabled.p2pkhProviders?.broadcastProviders.some((provider) => provider.id === "woc")).toBe(false);
    const blockedTokenTasks = disabled.taskSnapshots.filter((task) => ["token-bsv21.sync", "token-stas.sync", "collectible-1satordinals.sync"].includes(task.id));
    expect(blockedTokenTasks).toHaveLength(3);
    for (const task of blockedTokenTasks) {
      expect(task).toMatchObject({ state: "blocked", blockedReason: { fallback: "Plugin disabled: woc" } });
    }

    await submit(true, "plugin-intent-provider:enable");
    const enabled = __testGetSnapshot();
    expect(enabled.p2pkhProviders?.syncProviders.some((provider) => provider.id === "woc")).toBe(true);
    expect(enabled.p2pkhProviders?.broadcastProviders.some((provider) => provider.id === "woc")).toBe(true);
  });

  it("refuses disabling a Coordinator product marked always-on", async () => {
    __testResetState();
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-always-on-port", (message) => messages.push(message));
    const snapshot = __testGetSnapshot();
    await __testDispatchStorageMessage("plugin-intent-always-on-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-always-on-port",
      requestId: "plugin-intent-always-on",
      command: {
        commandId: "plugin-intent-always-on:disable",
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: "sat-subscription",
        desiredEnabled: false,
      },
    });
    const response = [...messages].reverse().find((message) => (message as { requestId?: string }).requestId === "plugin-intent-always-on") as { operationResult?: { status?: string; message?: string } } | undefined;
    expect(response?.operationResult).toEqual({
      status: "command-conflict",
      commandId: "plugin-intent-always-on:disable",
      message: "该插件产品属于系统必需组件，不能关闭",
    });
  });

  it("does not persist a temporary final-I/O lease across Worker restart", async () => {
    __testResetState();
    const release = await __testHoldCoordinatorFinalIoLease();
    // 运行锁由浏览器 WebLoom 管理，Worker 重启不会读取旧桶内租约，
    // 因此旧 I/O 不会把新 Worker 卡在 recovery-required。
    await __testRestartWorker();
    expect(__testGetSnapshot().authorityRecovery).toBeUndefined();
    await release();
  }, 15_000);

  it("keeps the storage retry command idempotent without a persisted authority lease", async () => {
    __testResetState();
    const release = await __testHoldCoordinatorFinalIoLease();
    await __testRestartWorker();
    const retry = await __testDispatchStorageControl({ type: "retry" } satisfies CoordinatorStorageControl);
    expect(retry.ack.status).toBe("ok");
    expect(__testGetSnapshot().authorityRecovery).toBeUndefined();
    await release();
  }, 15_000);

  it("does not create coordinator-upgrade K-V revisions for temporary I/O admission", async () => {
    __testResetState();
    const before = await __testGetCoordinatorUpgradePartition();
    const release = await __testHoldCoordinatorFinalIoLease();
    await __testRestartWorker();
    await release();
    const after = await __testGetCoordinatorUpgradePartition();
    expect(after).toEqual(before);
    expect(after.entryCount).toBe(0);
  });

  it("keeps per-port queue admission fair and bounded", () => {
    __testResetState();
    const result = __testStorageQueueAdmission("port-a");
    expect(result.firstPortAccepted).toBe(16);
    expect(result.firstPortRejected).toBe(true);
    expect(result.secondPortAccepted).toBe(true);
    expect(result.remaining).toEqual({});
  });

  it("keeps storage queue and cancellation errors typed", async () => {
    const result = await __testStorageSlotErrorCodes();
    expect(result).toEqual({ queueFull: "storage_limit_exceeded", queuedAbort: "storage_unavailable", activeAbort: "storage_unavailable" });
  });

  it("schedules a competing port ahead of a saturated port's waiters", async () => {
    const order = await __testStorageFairDispatch();
    expect(order.slice(0, 4)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("releases a port explicitly before close", async () => {
    __testResetState();
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[5]!, appId: "app", appName: "App", identityDigestHex: "ee".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://disconnect.example", appIdentity: identity, revokedAt: null }));
    const pending = __testSeedStorageRequest("active", "port-z", "disconnect-session");
    const granted = await __testDispatchStorageGrant("disconnect-session", "port-z");
    __testAttachPort("port-z", () => undefined);
    await __testDispatchStorageMessage("port-z", { kind: "disconnect", clientId: "spoof", requestId: "release" });
    expect(pending.aborted).toBe(true);
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-z")).rejects.toThrow();
    __testSetStorageSessionResolver(undefined);
    const port = attachTestPort("port-z");
    port.send({ kind: "disconnect", clientId: "spoof", requestId: "release" });
    await flush();
    expect(__testGetConnectedPortCount()).toBe(0);
  });

  it("returns matching storage.state baselines to two ports", async () => {
    __testResetState();
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb", topics: ["storage.state"] });
    await flush();
    const baseline = (port: TestPort, id: string) => (port.messages.find((m) => (m as { requestId?: string }).requestId === id) as { operationResult?: { baselines?: Array<{ baselineRevision: number; snapshot: { storageRevision?: number } }> } } | undefined)?.operationResult?.baselines?.[0];
    const ba = baseline(a, "sa"); const bb = baseline(b, "sb");
    expect(ba?.baselineRevision).toBe(ba?.snapshot.storageRevision);
    expect(bb?.baselineRevision).toBe(bb?.snapshot.storageRevision);
    expect(ba?.baselineRevision).toBe(bb?.baselineRevision);
    a.send({ kind: "disconnect", clientId: "a", requestId: "da" }); b.send({ kind: "disconnect", clientId: "b", requestId: "db" });
  });

  it("publishes one strictly increasing storage revision to every subscribed port", async () => {
    __testResetState();
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa2", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb2", topics: ["storage.state"] });
    await flush();
    a.messages.length = 0; b.messages.length = 0;
    await __testPublishStorageState(); await __testPublishStorageState();
    const revisions = (port: TestPort) => port.messages.filter((m) => (m as { topic?: string; type?: string }).topic === "storage.state" && (m as { type?: string }).type === "storage.state.changed").map((m) => (m as { storageRevision: number }).storageRevision);
    const ra = revisions(a); const rb = revisions(b);
    expect(ra.length).toBeGreaterThanOrEqual(2); expect(rb).toEqual(ra);
    expect(ra[1]).toBeGreaterThan(ra[0]!);
  });

  it("broadcasts one Worker-owned sat.events stream to both tabs", async () => {
    __testResetState();
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sat-sub-a", topics: ["sat.events"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sat-sub-b", topics: ["sat.events"] });
    await flush();
    a.messages.length = 0;
    b.messages.length = 0;

    const event: CoordinatorSatEvent = {
      type: "incoming",
      event: {
        deliveryId: "delivery-test-1",
        ingressSupplierId: "supplier-a",
        channel: "bsv8.inbox.test",
        requestIdHex: "01",
        contentJson: new Uint8Array([1, 2, 3]),
        chargedAmount: "0",
        receivedAtMs: 1,
      },
    };
    __testPublishSatState(event);
    const onlySatEvent = (port: TestPort) => port.messages.find((message) => (message as { topic?: string }).topic === "sat.events") as { satRevision: number; event: CoordinatorSatEvent } | undefined;
    const receivedA = onlySatEvent(a);
    const receivedB = onlySatEvent(b);
    expect(receivedA?.event).toEqual(event);
    expect(receivedB?.event).toEqual(event);
    expect(receivedA?.satRevision).toBe(receivedB?.satRevision);
  });

  it("cancels only the matching key and waits for the handler completion", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    __testRegisterTask({ id: "test-a", publicKeyHex: "a".repeat(64), run: async ({ signal }) => { await released; aborted = signal.aborted; } });
    __testRegisterTask({ id: "test-b", publicKeyHex: "b".repeat(64), run: async () => undefined });
    const running = __testRunTask("test-a");
    await Promise.resolve();
    const cancelling = __testCancelByKey("a".repeat(64));
    release();
    await cancelling;
    await running;
    expect(aborted).toBe(true);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "test-b")?.state).toBe("idle");
  });

  it("uses the task-start owner when cancelling a dynamic key-scoped task", async () => {
    __testResetState();
    let activeOwner = "a".repeat(64);
    __testSetVaultStatus("unlocked", activeOwner);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    __testRegisterTask({
      id: "dynamic-owner-task",
      publicKeyHex: activeOwner,
      keyScope: () => ({ publicKeyHex: activeOwner }),
      run: async ({ signal }) => {
        await released;
        aborted = signal.aborted;
      }
    });
    const running = __testRunTask("dynamic-owner-task");
    await Promise.resolve();
    activeOwner = "b".repeat(64);
    const cancelling = __testCancelByKey("a".repeat(64));
    release();
    await cancelling;
    await running;
    expect(aborted).toBe(true);
  });

  it("rejects a late handler freshness check after session invalidation", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let committed = false;
    __testRegisterTask({ id: "late", publicKeyHex: "a".repeat(64), run: async ({ assertSessionFresh }) => { await Promise.resolve(); assertSessionFresh(); committed = true; } });
    const running = __testRunTask("late");
    __testInvalidateSession();
    await running;
    expect(committed).toBe(false);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "late")?.error).toMatch(/stale/i);
  });

  it("fans out global lock to both ports and does not lock when one port closes", async () => {
    // The module's one-time platform K-V bootstrap is asynchronous. Let it finish
    // before installing this test's synthetic session state.
    await new Promise((resolve) => setTimeout(resolve, 30));
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = attachTestPort("a");
    const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["session.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sub-b", topics: ["session.state"] });
    await flush();
    a.close();
    expect(__testGetSnapshot().vaultStatus).toBe("unlocked");
    // 锁定是收敛型安全操作：旧页面也必须能锁定新 epoch 的全局会话。
    b.send({ kind: "lock", clientId: "b", requestId: "lock", expectedSessionEpoch: "stale-page-epoch" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.messages.some((message) => (message as { type?: string; vaultStatus?: string }).type === "session.state.changed" && (message as { vaultStatus?: string }).vaultStatus === "locked")).toBe(true);
  });

  it("returns immediate accepted/already-running acknowledgements for concurrent runNow", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    __testRegisterTask({ id: "once", publicKeyHex: "a".repeat(64), run: async () => { runs++; await gate; } });
    const first = await __testBackgroundRunNow("once");
    const second = await __testBackgroundRunNow("once");
    expect(first.ack.status).toBe("accepted");
    expect(second.ack.status).toBe("already-running");
    expect(runs).toBe(1);
    release();
    await flush();
  });

  it("exposes only public locked snapshot state", () => {
    __testResetState();
    __testSetVaultStatus("locked");
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    expect(JSON.stringify(snapshot)).not.toMatch(/password|privateKey|token/i);
  });

  it("persists schedule settings and restores locked state after Worker restart", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const ack = await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 60_000 });
    expect(ack.ack.status).toBe("accepted");
    expect(__testGetSnapshot().scheduleSettings.assetHoldingsIntervalMs).toBe(60_000);
    await __testRestartWorker();
    expect(__testGetSnapshot().vaultStatus).not.toBe("unlocked");
    expect(__testGetSnapshot().scheduleSettings.assetHoldingsIntervalMs).toBe(60_000);
  });

  it("does not publish an in-memory schedule change when persistence fails", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const before = __testGetSnapshot().scheduleSettings;
    __testFailNextCoordinatorSnapshotPersist();

    await expect(__testUpdateScheduleSettings({ assetHoldingsIntervalMs: 180_000 })).rejects.toThrow(/injected coordinator snapshot persist failure/);
    expect(__testGetSnapshot().scheduleSettings).toEqual(before);

    await __testRestartWorker();
    expect(__testGetSnapshot().scheduleSettings).toEqual(before);
  });

  it("marks tasks as blocked when vault is locked", async () => {
    __testResetState();
    __testSetVaultStatus("locked");
    __testRegisterTask({ id: "task-1", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟 performGlobalLock 的行为
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "task-1");
    expect(task?.state).toBe("idle"); // 初始状态是 idle
    // 锁定时任务应该变为 blocked
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "task-2", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 验证解锁状态下的任务是 idle
    expect(__testGetSnapshot().taskSnapshots.find((t) => t.id === "task-2")?.state).toBe("idle");
  });

  it("locks running tasks to blocked after performGlobalLock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    __testRegisterTask({ id: "running-task", publicKeyHex: "a".repeat(64), run: async () => { await gate; } });
    void __testRunTask("running-task");
    await Promise.resolve();
    // 锁定
    __testSetVaultStatus("locked");
    release();
    await flush();
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "running-task");
    expect(task?.state).toBe("blocked");
    expect(task?.blockedReason).toMatchObject({ key: "background.blocked.task", fallback: "Vault is locked" });
  });

  it("broadcasts background snapshot immediately on lock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = attachTestPort("a");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["background.snapshot"] });
    await flush();
    a.messages.length = 0;
    // 锁定
    a.send({ kind: "lock", clientId: "a", requestId: "lock", expectedSessionEpoch: __testGetSnapshot().sessionEpoch });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (a.messages.some((message) => (message as { type?: string }).type === "background.snapshot.changed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const backgroundEvents = a.messages.filter((m) => (m as { type?: string }).type === "background.snapshot.changed");
    expect(backgroundEvents.length).toBeGreaterThan(0);
  });

  it("restores tasks to idle and reschedules after unlock", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "blocked-task", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟锁定
    const snapshot1 = __testGetSnapshot();
    expect(snapshot1.taskSnapshots.find((t) => t.id === "blocked-task")?.state).toBe("idle");
    // 解锁后任务应该保持 idle
    const snapshot2 = __testGetSnapshot();
    const task = snapshot2.taskSnapshots.find((t) => t.id === "blocked-task");
    expect(task?.state).toBe("idle");
    expect(task?.blockedReason).toBeUndefined();
  });

  it("uses persisted interval for nextRunAt", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    await __testUpdateScheduleSettings({ assetHoldingsIntervalMs: 120_000 });
    // 验证设置已持久化
    const snapshot = __testGetSnapshot();
    expect(snapshot.scheduleSettings.assetHoldingsIntervalMs).toBe(120_000);
  });

  it("merges provider config updates without clearing the selected provider", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    await __testP2pkhProviderConfigUpdate("junglebus", {
      enabled: true,
      mainEndpoint: "https://main.example/v1",
      testEndpoint: "https://test.example/v1",
      timeoutMs: 1_111,
      maxRetries: 4,
      requestsPerSecond: 7
    });
    await __testP2pkhProviderConfigUpdate("junglebus", { endpoint: "https://alias.example/v1" });
    const config = await __testP2pkhProviderConfigGet("junglebus");
    expect(config).toMatchObject({ enabled: true, endpoint: "https://alias.example/v1", mainEndpoint: "https://main.example/v1", testEndpoint: "https://test.example/v1", timeoutMs: 1_111, maxRetries: 4, requestsPerSecond: 7 });
    const after = __testGetSnapshot();
    expect(after.p2pkhProviders?.selection.main.syncProviderId).toBe(before.p2pkhProviders?.selection.main.syncProviderId);
    expect(after.p2pkhProviders?.selection.test.syncProviderId).toBe(before.p2pkhProviders?.selection.test.syncProviderId);
  });

  it("keeps provider selection unchanged when its metadata persistence fails", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    const beforeConfig = await __testP2pkhProviderConfigGet("woc");
    __testFailNextCoordinatorSnapshotPersist();
    await expect(__testP2pkhProviderConfigUpdate("woc", { endpoint: "https://should-not-apply.example/v1" })).rejects.toThrow(/persist/i);
    const after = __testGetSnapshot();
    expect(after.p2pkhProviders?.selection).toEqual(before.p2pkhProviders?.selection);
    expect(await __testP2pkhProviderConfigGet("woc")).toEqual(beforeConfig);
  });

  it("keeps provider selection unchanged when a selection persistence fails", async () => {
    __testResetState();
    await __testRestartWorker();
    const before = __testGetSnapshot();
    const generation = before.p2pkhProviders?.selection.generation ?? 0;
    __testFailNextCoordinatorSnapshotPersist();
    await expect(__testP2pkhProvidersUpdate("main", { syncProviderId: "junglebus", broadcastProviderId: "woc" })).rejects.toThrow(/persist/i);
    expect(__testGetSnapshot().p2pkhProviders?.selection).toEqual(before.p2pkhProviders?.selection);
    expect(__testGetSnapshot().p2pkhProviders?.selection.generation).toBe(generation);
  });

  it("aborts stale-generation P2PKH submissions before any provider call", async () => {
    __testResetState();
    const owner = "c".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const submissionId = `stale-${Date.now()}`;
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ab".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["cd".repeat(32) + ":0"], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cd".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    const currentGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: currentGeneration + 1 });
    expect(response.operationResult).toMatchObject({ status: "not-dispatched", reason: "stale-provider-generation" });
    expect((await __testListP2pkhLocalTransactions(owner)).some((row) => (row as { id?: string }).id === submissionId)).toBe(false);
  });

  it("retains an unknown submission when a rebroadcast is not dispatched", async () => {
    __testResetState();
    const owner = "d".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const submissionId = `unknown-rebroadcast-${Date.now()}`;
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "de".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["ef".repeat(32) + ":0"], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ef".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    const currentGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: currentGeneration + 1, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "not-dispatched", reason: "stale-provider-generation" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "submitting", chainResolution: "unresolved", attempts: [] });
  });

  it("preserves local-confirmed state when a rebroadcast provider fails", async () => {
    __testResetState();
    const owner = "e".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const submissionId = `failed-rebroadcast-${Date.now()}`;
    const txid = "fa".repeat(32);
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      localOutpoints: [{ id: `p2pkh:main:${txid}:0`, resourceId: "p2pkh:main", txid, vout: 0, value: 1, scriptHex: "", submissionId, state: "unavailable", createdAt: "now", updatedAt: "now" }]
    });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId, localState: "local-confirmed" });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-failing-provider", label: "Test failing provider", supportedNetworks: ["main", "test"] },
      broadcast: async () => { throw new Error("provider unavailable"); }
    });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "rebroadcast-failed", txid, reason: "provider unavailable" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "isolated" }] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("broadcasts a double-axis submission without relying on legacy state", async () => {
    __testResetState();
    const owner = "f".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const submissionId = `double-axis-${Date.now()}`;
    const txid = "fb".repeat(32);
    const providerBroadcast = vi.fn(async () => ({ canonicalTxid: txid, status: "accepted" as const, providerReference: "provider-ref" }));
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["fc".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "fc".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }],
      localOutpoints: [{ id: `p2pkh:main:${txid}:0`, resourceId: "p2pkh:main", txid, vout: 0, value: 1, scriptHex: "", submissionId, state: "unavailable", createdAt: "now", updatedAt: "now" }]
    });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-double-axis-provider", label: "Double-axis test provider", supportedNetworks: ["main", "test"] },
      broadcast: providerBroadcast
    });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, expectedProviderGeneration: generation });
    expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid });
    expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: txid, rawTxHex: "00" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "accepted" }] });
    expect((await __testListP2pkhLocalOutpoints(owner)).find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "available" });
    expect((await __testListP2pkhLocalInputClaims(owner)).find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "active" });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("skips a chain-confirmed ancestor and broadcasts the unresolved child once", async () => {
    __testResetState();
    const owner = "1".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const parentTxid = "10".repeat(32);
    const childTxid = "11".repeat(32);
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "confirmed-parent", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: parentTxid, rawTxHex: "parent", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "confirmed-parent", localState: "local-confirmed" });
    await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: "confirmed-parent", chainResolution: "chain-confirmed" });
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "unresolved-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "unresolved-child", localState: "local-confirmed" });
    const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-ancestor-skip", label: "Ancestor skip", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "unresolved-child", expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid: childTxid });
    expect(providerBroadcast).toHaveBeenCalledTimes(1);
    expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: childTxid, rawTxHex: "child" });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === "confirmed-parent")).toMatchObject({ chainResolution: "chain-confirmed", attempts: [] });
    expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === "unresolved-child")).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "accepted" }] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("blocks a conflicted ancestor before invoking the provider", async () => {
    __testResetState();
    const owner = "2".repeat(64);
    __testSetVaultStatus("unlocked", owner);
    const parentTxid = "20".repeat(32);
    const childTxid = "21".repeat(32);
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "conflicted-parent", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: parentTxid, rawTxHex: "parent", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "conflicted-parent", localState: "local-confirmed" });
    await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: "conflicted-parent", chainResolution: "conflicted", conflictSourceTxids: ["ff".repeat(32)] });
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "blocked-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [parentTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "blocked-child", localState: "local-confirmed" });
    const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-ancestor-block", label: "Ancestor block", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
    const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "blocked-child", expectedProviderGeneration: generation, rebroadcast: true });
    expect(response.operationResult).toMatchObject({ status: "isolated", txid: parentTxid, reason: "conflicted-ancestor" });
    expect(providerBroadcast).not.toHaveBeenCalled();
    expect((await __testListP2pkhLocalTransactions(owner)).every((row) => (row as { attempts?: unknown[] }).attempts?.length === 0)).toBe(true);
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("裁决重复 txid sibling 不受返回顺序影响且只阻断一次逻辑交易", async () => {
    for (const [owner, insertionOrder] of [["3".repeat(64), ["normal", "conflict"]], ["4".repeat(64), ["conflict", "normal"]]] as const) {
      __testResetState();
      __testSetVaultStatus("unlocked", owner);
      const txid = "30".repeat(32);
      const childTxid = "31".repeat(32);
      const seed = async (kind: "normal" | "conflict") => {
        const id = kind === "normal" ? "a-sibling" : "z-sibling";
        await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex: kind, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
        await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: id, localState: "local-confirmed" });
        if (kind === "conflict") await __testSetP2pkhChainResolution({ ownerPublicKeyHex: owner, submissionId: id, chainResolution: "conflicted", conflictSourceTxids: ["ee".repeat(32)] });
      };
      for (const kind of insertionOrder) await seed(kind);
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submission: { id: "sibling-child", resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: childTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [txid], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: owner, submissionId: "sibling-child", localState: "local-confirmed" });
      const providerBroadcast = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
      __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-sibling-order", label: "Sibling order", supportedNetworks: ["main", "test"] }, broadcast: providerBroadcast });
      const generation = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId: "sibling-child", expectedProviderGeneration: generation, rebroadcast: true });
      expect(response.operationResult).toMatchObject({ status: "isolated", txid, reason: "conflicted-ancestor" });
      expect(providerBroadcast).not.toHaveBeenCalled();
      __testSetP2pkhBroadcastProvider(undefined);
    }
    __testResetState();
    const normalOwner = "5".repeat(64);
    __testSetVaultStatus("unlocked", normalOwner);
    const normalTxid = "50".repeat(32);
    const normalChildTxid = "51".repeat(32);
    for (const [id, rawTxHex] of [["first-sibling", "z-raw"], ["second-sibling", "a-raw"]] as const) {
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: normalOwner, network: "main", txid: normalTxid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submissionId: id, localState: "local-confirmed" });
    }
    await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submission: { id: "unresolved-child", resourceId: "p2pkh:main", publicKeyHex: normalOwner, network: "main", txid: normalChildTxid, rawTxHex: "child", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [normalTxid], createdAt: "now", updatedAt: "now", attempts: [] } });
    await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: normalOwner, submissionId: "unresolved-child", localState: "local-confirmed" });
    const normalProvider = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-sibling-single", label: "Sibling single", supportedNetworks: ["main", "test"] }, broadcast: normalProvider });
    const normalGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    await __testP2pkhBroadcast({ ownerPublicKeyHex: normalOwner, network: "main", submissionId: "unresolved-child", expectedProviderGeneration: normalGeneration, rebroadcast: true });
    expect(normalProvider).toHaveBeenCalledTimes(2);
    expect(normalProvider).toHaveBeenNthCalledWith(1, { network: "main", canonicalTxid: normalTxid, rawTxHex: "a-raw" });
    expect(normalProvider).toHaveBeenNthCalledWith(2, { network: "main", canonicalTxid: normalChildTxid, rawTxHex: "child" });
    __testSetP2pkhBroadcastProvider(undefined);

    __testResetState();
    const targetOwner = "6".repeat(64);
    __testSetVaultStatus("unlocked", targetOwner);
    const targetTxid = "60".repeat(32);
    for (const [id, rawTxHex] of [["canonical-sibling", "a-raw"], ["requested-sibling", "z-raw"]] as const) {
      await __testSeedP2pkhLocalSubmission({ ownerPublicKeyHex: targetOwner, submission: { id, resourceId: "p2pkh:main", publicKeyHex: targetOwner, network: "main", txid: targetTxid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] } });
      await __testFinishP2pkhLocalSubmission({ ownerPublicKeyHex: targetOwner, submissionId: id, localState: "local-confirmed" });
    }
    const targetProvider = vi.fn(async (request: { canonicalTxid: string }) => ({ canonicalTxid: request.canonicalTxid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({ descriptor: { id: "test-target-boundary", label: "Target boundary", supportedNetworks: ["main", "test"] }, broadcast: targetProvider });
    const targetGeneration = __testGetSnapshot().p2pkhProviders?.selection.generation ?? 0;
    await __testP2pkhBroadcast({ ownerPublicKeyHex: targetOwner, network: "main", submissionId: "requested-sibling", expectedProviderGeneration: targetGeneration, rebroadcast: true });
    expect(targetProvider).toHaveBeenCalledTimes(1);
    expect(targetProvider).toHaveBeenCalledWith({ network: "main", canonicalTxid: targetTxid, rawTxHex: "z-raw" });
    expect((await __testListP2pkhLocalTransactions(targetOwner)).find((row) => (row as { id?: string }).id === "requested-sibling")).toMatchObject({ localState: "local-confirmed", attempts: [{ status: "accepted" }] });
    expect((await __testListP2pkhLocalTransactions(targetOwner)).find((row) => (row as { id?: string }).id === "canonical-sibling")).toMatchObject({ localState: "local-confirmed", attempts: [] });
    __testSetP2pkhBroadcastProvider(undefined);
  });

  it("keeps an explicitly selected provider id while the optional provider is disabled", async () => {
    __testResetState();
    await __testRestartWorker();
    await __testP2pkhProvidersUpdate("main", { syncProviderId: "junglebus", broadcastProviderId: "woc" });
    await __testP2pkhProviderConfigUpdate("junglebus", { enabled: false });
    const disabled = __testGetSnapshot().p2pkhProviders;
    expect(disabled?.selection.main.syncProviderId).toBe("junglebus");
    expect(disabled?.syncProviders.some((provider) => provider.id === "junglebus")).toBe(false);
    await __testP2pkhProviderConfigUpdate("junglebus", { enabled: true });
    const enabled = __testGetSnapshot().p2pkhProviders;
    expect(enabled?.selection.main.syncProviderId).toBe("junglebus");
    expect(enabled?.syncProviders.some((provider) => provider.id === "junglebus")).toBe(true);
  });

  it("blocks the transaction sync task when its selected provider is unavailable", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({
      id: "p2pkh.transactions-sync",
      publicKeyHex: "a".repeat(64),
      run: async () => { throw Object.assign(new Error("JungleBus is unavailable"), { code: "provider-unavailable" }); }
    });
    await __testRunTask("p2pkh.transactions-sync");
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({
      state: "blocked",
      blockedReason: { fallback: "JungleBus is unavailable" }
    });
  });
});

describe("Session Coordinator initial setup transaction", () => {
  const makePlan = (transactionId: string): InitialSetupPlan => ({
    transactionId,
    bucketLabel: "首个本地桶",
    backend: "local",
    connection: { kind: "local" },
    bucketPassword: "initial-setup-password",
    firstKey: { kind: "generate", label: "主 Key", capabilities: ["p2pkh"] },
  });

  const makeSucceededRecord = (entry: StorageBucketCatalogEntryV2, transactionId: string): InitialSetupRecoveryRecordV1 => ({
    format: "keymaster.storage.initial-setup-recovery",
    version: 1,
    transactionId,
    bucketId: entry.bucketId,
    catalogEntryFingerprint: __testInitialSetupCatalogEntryFingerprint(entry),
    configRevision: entry.configRevision,
    snapshotRevision: entry.snapshotRevision,
    backend: "local",
    connectionFingerprint: "b".repeat(64),
    phase: "complete",
    catalog: "committed",
    runtimeInstalled: true,
    cleanup: "confirmed",
    status: "succeeded",
    success: {
      bucketLabel: entry.label,
      publicKeyHex: bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true)),
      label: "恢复的主 Key",
      address: "recovery-address",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2026-09-08T00:00:00.000Z",
    },
    updatedAt: 1,
  });

  beforeEach(async () => {
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
  });

  afterEach(async () => {
    await __testReleaseCatalogLocalBinding();
    __testResetState();
  });

  it("在真实 Coordinator 路径中提交 Local 桶、Hold、Vault 和首 Key", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const plan = makePlan("initial-setup-commit-001");

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan });
    expect(response.ack.status).toBe("ok");
    const result = response.operationResult as InitialSetupResult;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.summary);
    expect(fixture.getCatalog()).toMatchObject({
      selectedBucketId: result.bucket.bucketId,
      buckets: [result.bucket],
    });
    expect(result.bucket.snapshotRevision).toBeGreaterThan(0);
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: result.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: result.firstKey.publicKeyHex,
    });
    expect(fixture.storage.length).toBeGreaterThan(0);
    expect(plan.bucketPassword).toBe("");
  }, 20_000);

  it("真实 Coordinator 连接入口调用只读 lifecycle 并在认证后安装运行态", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createResponse = await __testDispatchStorageControl({
      type: "initial-setup",
      plan: makePlan("initial-setup-connect-source-001"),
    });
    const created = createResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const remoteWriteCount = fixture.writeOperations.length;
    const plan = {
      operationId: "connect-existing-remote-001",
      remoteStorageId: created.bucket.bucketId,
      displayName: "重新连接的远端",
      backend: "local" as const,
      connection: { kind: "local" as const },
      bucketPassword: "initial-setup-password",
    };

    const connectResponse = await __testDispatchStorageControl({ type: "connect-existing-remote", plan });
    expect(connectResponse.ack.status).toBe("ok");
    expect(connectResponse.operationResult).toMatchObject({
      ok: true,
      bucket: { bucketId: created.bucket.bucketId, label: "重新连接的远端" },
      activeKey: { publicKeyHex: created.firstKey.publicKeyHex },
    });
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "locked",
    });
    expect(__testGetSnapshot().activePublicKeyHex).toBeUndefined();
    expect(fixture.writeOperations.slice(remoteWriteCount)).toEqual([]);
    expect(plan.bucketPassword).toBe("");
  }, 30_000);

  it("已有远端缺少 schema namespace 时连接失败且对象与 ETag 完全不变", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createdResponse = await __testDispatchStorageControl({
      type: "initial-setup",
      plan: makePlan("initial-setup-connect-schema-gap-001"),
    });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    const provider = createLocalStorageBucketProvider({
      storage: fixture.storage,
      locks: catalogBridgeLocks,
      bucketId: created.bucket.bucketId,
      bucketGeneration: 1,
    });
    const schema = await provider.get(".keymaster/schema");
    if (!schema?.etag) throw new Error("created schema is missing an ETag");
    const parsed = JSON.parse(new TextDecoder().decode(schema.bytes)) as { namespaces: Record<string, number> };
    const removed = Object.keys(parsed.namespaces)[0];
    if (!removed) throw new Error("created schema has no namespace");
    delete parsed.namespaces[removed];
    await provider.put(".keymaster/schema", new TextEncoder().encode(JSON.stringify(parsed)), { ifMatch: schema.etag });
    provider.dispose();

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const before = fixture.storage.snapshot();
    const response = await __testDispatchStorageControl({
      type: "connect-existing-remote",
      plan: {
        operationId: "connect-existing-schema-gap-001",
        remoteStorageId: created.bucket.bucketId,
        displayName: "缺少 schema 的远端",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: "initial-setup-password",
      },
    });
    expect(response.operationResult).toMatchObject({ ok: false, error: { code: "storage_remote_corrupt" } });
    expect(fixture.storage.snapshot()).toEqual(before);
  }, 30_000);

  it("initial-setup adopted Local provider follows the current owner after tab handoff", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    const first = makeCoordinatorTestPeer("test", (input) => fixture.bridge(input as LocalStorageBridgeRequest));
    __testInstallCoordinatorBridgePeer(first.peer, {
      peerGeneration: 1,
      sessionEpoch: __testGetSnapshot().sessionEpoch,
      leaseId: "initial-setup-first",
    });

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-handoff-001") });
    expect(response.operationResult).toMatchObject({ ok: true });
    const firstCallCount = first.bridgeCalls.length;

    const second = makeCoordinatorTestPeer("test-second", (input) => fixture.bridge(input as LocalStorageBridgeRequest));
    __testInstallCoordinatorBridgePeer(second.peer, {
      peerGeneration: 1,
      sessionEpoch: __testGetSnapshot().sessionEpoch,
      leaseId: "initial-setup-second",
    });

    const exportResponse = await __testDispatchStorageControl({ type: "cold-export" });
    expect(exportResponse.ack.status).toBe("ok");
    expect(first.bridgeCalls).toHaveLength(firstCallCount);
    expect(second.bridgeCalls.length).toBeGreaterThan(0);
  }, 20_000);

  it("Root 发布后运行态安装失败会保留远端与目录并要求同事务重试", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const plan = makePlan("initial-setup-runtime-failure-001");
    __testFailNextCoordinatorSnapshotPersist();

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan });
    expect(response.ack.status).toBe("ok");
    expect(response.operationResult).toMatchObject({ ok: false, error: { phase: "runtime", rollback: "not-started" } });
    expect(fixture.getCatalog()).toMatchObject({ format: "keymaster.storage.catalog", version: 2, buckets: [expect.any(Object)] });
    expect(fixture.storage.length).toBeGreaterThan(0);
    expect(plan.bucketPassword).toBe("");
  }, 20_000);

  it("root 已发布但设备提交丢失后跨 Worker 重启按同一事务恢复且不生成第二把 Key", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    let rejectDeviceConnection = true;
    __testSetLocalStorageBridgeOverride(async (input) => {
      if (rejectDeviceConnection && input.type === "device-bootstrap-connection-upsert") {
        throw new Error("injected device connection loss");
      }
      return fixture.bridge(input);
    });
    const transactionId = "initial-setup-published-restart-001";
    __testFailNextCoordinatorSnapshotPersist();
    const first = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(first.operationResult).toMatchObject({ ok: false, error: { rollback: "not-started" } });
    const bootstrapBeforeRestart = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read();
    expect(bootstrapBeforeRestart?.connections).toHaveLength(0);
    expect(bootstrapBeforeRestart?.recoveries).toEqual([
      expect.objectContaining({ operationId: transactionId, remoteStorageId: __testInitialSetupBucketId(transactionId), status: "attention-required" }),
    ]);
    const writesAfterPublication = fixture.writeOperations.length;

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    rejectDeviceConnection = false;
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const retry = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(retry.operationResult).toMatchObject({
      ok: true,
      bucket: { bucketId: __testInitialSetupBucketId(transactionId) },
      firstKey: { publicKeyHex: expect.stringMatching(/^[0-9a-f]{66}$/u) },
    });
    expect(fixture.writeOperations).toHaveLength(writesAfterPublication);
    const bootstrapAfterRecovery = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read();
    expect(bootstrapAfterRecovery?.connections).toHaveLength(1);
    expect(bootstrapAfterRecovery?.recoveries).toEqual([]);
  }, 30_000);

  it("成功响应丢失后跨 Worker 重启从设备连接恢复同一首 Key且不写远端", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const transactionId = "initial-setup-success-response-loss-001";
    const first = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    const firstResult = first.operationResult as InitialSetupResult;
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error(firstResult.error.summary);
    const writesAfterSuccess = fixture.writeOperations.length;

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(async (input) => {
      const response = await fixture.bridge(input);
      if (input.type === "device-bootstrap-connection-upsert") {
        const current = fixture.getCatalog().buckets.find((candidate) => candidate.bucketId === input.connection.remoteStorageId);
        if (!current) throw new Error("response-loss fixture lost its committed catalog projection");
        fixture.setCatalog({
          format: "keymaster.storage.catalog",
          version: 2,
          selectedBucketId: input.connection.remoteStorageId,
          buckets: [{
            ...current,
            label: input.connection.displayName,
            backend: input.connection.providerId,
            keyDerivation: structuredClone(input.connection.keyDerivation),
            encryptedConfig: structuredClone(input.connection.encryptedConfig),
            updatedAt: input.connection.updatedAt,
          }],
        });
      }
      return response;
    });
    const retry = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    const retryResult = retry.operationResult as InitialSetupResult;
    if (!retryResult.ok) throw new Error(JSON.stringify(retryResult.error));
    expect(retry.operationResult).toMatchObject({
      ok: true,
      bucket: { bucketId: firstResult.bucket.bucketId },
      firstKey: { publicKeyHex: firstResult.firstKey.publicKeyHex },
    });
    expect(fixture.writeOperations).toHaveLength(writesAfterSuccess);
  }, 30_000);

  it("冷启动只用设备引导做提示：认证前零远端写入并按 Hold 权威 revision 解锁", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-cold-start-hint-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);
    const writesAfterCreate = fixture.writeOperations.length;

    // Worker 真重启：丢弃全部内存运行态，只保留页面设备引导存储。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const hint = readStorageBootstrap(fixture.storage);
    expect(hint).toMatchObject({
      selectedBackend: "local",
      selectedBucket: { bucketId: created.bucket.bucketId, configRevision: 0, snapshotRevision: 0 },
    });

    // 无密码冷启动只能做 validate-only 只读装配，认证前不得有任何远端写入。
    await __testColdStartFromDeviceHint(hint);
    expect(fixture.writeOperations).toHaveLength(writesAfterCreate);

    // 解锁必须先重新认证远端 Hold，再按认证得到的 revision 安装可写运行态。
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: "initial-setup-password" });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: created.firstKey.publicKeyHex,
    });

    // 冷启动后的受保护写入也要成功：目录 revision 必须用设备投影做 CAS。
    const imported = await __testImportPrivateKey("initial-setup-password", {
      label: "冷启动后的第二把",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).toContain(imported.publicKeyHex);
  }, 30_000);

  it("连接已有远端后运行态绑定 Hold 权威记录，可再次解锁并受保护读取", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-reconnect-unlock-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const connect = await __testDispatchStorageControl({
      type: "connect-existing-remote",
      plan: {
        operationId: "connect-existing-unlock-001",
        remoteStorageId: created.bucket.bucketId,
        displayName: "再次连接的远端",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: "initial-setup-password",
      },
    });
    const connected = connect.operationResult as ExistingRemoteStorageConnectResult;
    expect(connected).toMatchObject({ ok: true, bucket: { bucketId: created.bucket.bucketId } });
    if (!connected.ok) throw new Error("connect-existing-remote failed");

    // 设备目录只保存本机重新加密的连接密文（随机 IV），运行态必须绑定
    // Hold 提交的 storage record，否则下一次 unlock 的密文比较会误报冲突。
    const deviceConnection = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceConnection?.encryptedConfig).not.toEqual(connected.bucket.encryptedConfig);

    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: "initial-setup-password" });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: created.firstKey.publicKeyHex,
    });
    const keys = await __testListVaultKeys();
    expect(keys.map((key) => key.publicKeyHex)).toContain(created.firstKey.publicKeyHex);

    // 受保护写入必须继续可用：发布 Hold 后目录修订也要成功。
    const imported = await __testImportPrivateKey("initial-setup-password", {
      label: "连接后的第二把",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).toContain(imported.publicKeyHex);
    // 目录修订只推进 revision，不得把 Hold 权威密文写回设备引导。
    const deviceAfterWrite = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceAfterWrite?.encryptedConfig).toEqual(deviceConnection?.encryptedConfig);

    // 改名同样属于目录 CAS：标签更新但设备连接密文保持不变。
    const renamed = await __testDispatchStorageControl({ type: "rename-bucket", label: "连接后改名" });
    expect(renamed.operationResult).toMatchObject({ bucketId: created.bucket.bucketId, label: "连接后改名" });
    const deviceAfterRename = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceAfterRename).toMatchObject({ displayName: "连接后改名" });
    expect(deviceAfterRename?.encryptedConfig).toEqual(deviceConnection?.encryptedConfig);
  }, 30_000);

  it("Root 发布后同进程按同一事务重试幂等成功且不增加远端写入与 Key 数量", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const transactionId = "initial-setup-same-process-retry-001";
    __testFailNextCoordinatorSnapshotPersist();
    const first = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(first.operationResult).toMatchObject({ ok: false, error: { phase: "runtime", rollback: "not-started" } });
    expect(__testGetSnapshot().vaultStatus).not.toBe("unlocked");
    const writesAfterFirst = fixture.writeOperations.length;

    // 页面目录由设备连接派生：设备连接 upsert 后目录投影随之更新。
    __testSetLocalStorageBridgeOverride(projectCatalogFromDeviceConnection(fixture));

    const retry = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    const retried = retry.operationResult as InitialSetupResult;
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error(JSON.stringify(retried.error));
    expect(retried.bucket.bucketId).toBe(__testInitialSetupBucketId(transactionId));
    // 同事务重试只重建本机运行态，不得重复写远端或生成第二把 Key。
    expect(fixture.writeOperations).toHaveLength(writesAfterFirst);
    const keys = await __testListVaultKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.publicKeyHex).toBe(retried.firstKey.publicKeyHex);
  }, 30_000);

  it("设备恢复指针写入失败时同进程重试仍走只读重建而不是重放失败", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    const transactionId = "initial-setup-same-process-no-pointer-001";
    const failRecoveryPointer = async (input: LocalStorageBridgeRequest): Promise<LocalStorageBridgeResponse> => {
      if (input.type === "device-bootstrap-recovery-upsert") throw new Error("injected recovery pointer loss");
      return fixture.bridge(input);
    };
    __testSetLocalStorageBridgeOverride(failRecoveryPointer);
    __testFailNextCoordinatorSnapshotPersist();
    const first = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(first.operationResult).toMatchObject({ ok: false, error: { phase: "runtime", rollback: "not-started" } });
    const bootstrapBeforeRetry = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read();
    expect(bootstrapBeforeRetry?.recoveries ?? []).toHaveLength(0);
    const writesAfterFirst = fixture.writeOperations.length;

    __testSetLocalStorageBridgeOverride(async (input) => {
      if (input.type === "device-bootstrap-recovery-upsert") throw new Error("injected recovery pointer loss");
      return projectCatalogFromDeviceConnection(fixture)(input);
    });

    // 没有设备恢复指针时，仍必须识别同进程残留绑定并走只读重建。
    const retry = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    const retried = retry.operationResult as InitialSetupResult;
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error(JSON.stringify(retried.error));
    expect(fixture.writeOperations).toHaveLength(writesAfterFirst);
    const keys = await __testListVaultKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.publicKeyHex).toBe(retried.firstKey.publicKeyHex);
  }, 30_000);

  it("凭据更新后重启冷启动仍能用新 Hold 记录解锁并写入", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-reconfigure-restart-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    // 配置更新会重新加密连接并同时更新 Hold 与目录，设备连接随之收敛。
    const updated = await __testDispatchStorageControl({
      type: "change-bucket-config",
      config: { kind: "local" },
      label: "凭据更新后",
      password: "initial-setup-password",
    });
    expect(updated.operationResult).toMatchObject({ bucketId: created.bucket.bucketId, label: "凭据更新后" });

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const hint = readStorageBootstrap(fixture.storage);
    expect(hint?.selectedBucket).toMatchObject({ bucketId: created.bucket.bucketId, configRevision: 0, snapshotRevision: 0 });
    await __testColdStartFromDeviceHint(hint);
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: "initial-setup-password" });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: created.firstKey.publicKeyHex,
    });
    const imported = await __testImportPrivateKey("initial-setup-password", {
      label: "凭据更新后的第二把",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).toContain(imported.publicKeyHex);
  }, 30_000);

  it("设备引导无密码时保持 authentication，不安装 Root 也不恢复 Journal", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const password = "initial-setup-password";
    const transactionId = "initial-setup-nopassword-journal-001";
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    // 留下一个已提交 Hold、等待 Owner/Journal 清理的删除事务。
    const second = await __testImportPrivateKey(password, {
      label: "待恢复删除",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await __testLock();
    __testFailKeyLifecycleJournalAfterHold();
    await expect(__testDeleteKeyMaterial(second.publicKeyHex, password)).rejects.toThrow("injected key lifecycle Journal persist failure");
    expect(await __testListKeyLifecycleJournals()).toEqual([
      expect.objectContaining({ publicKeyHex: second.publicKeyHex, operation: "delete" }),
    ]);

    // 真重启：只保留页面设备引导存储。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const remoteBefore = fixture.storage.snapshot();
    const writesBefore = fixture.writeOperations.length;

    const hint = readStorageBootstrap(fixture.storage);
    expect(hint?.selectedBucket).toMatchObject({ bucketId: created.bucket.bucketId, configRevision: 0, snapshotRevision: 0 });
    await __testColdStartFromDeviceHint(hint);

    // 无密码：停在 authentication，没有 Root、没有 Vault/Journal 恢复、零远端写入。
    const status = await __testDispatchStorageControl({ type: "status" });
    expect(status.operationResult).toBe("authentication");
    expect(__testGetSnapshot().storageBucketId).toBeUndefined();
    expect(__testGetVaultStatus()).not.toBe("locked");
    expect(fixture.storage.snapshot()).toEqual(remoteBefore);
    expect(fixture.writeOperations).toHaveLength(writesBefore);

    // 认证成功后 Journal 才恢复，删除事务收敛完成。
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).not.toContain(second.publicKeyHex);
  }, 30_000);

  it("健康运行态收到同 ID connect 请求返回冲突且保持可用", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-healthy-connect-conflict-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);
    const keysBefore = (await __testListVaultKeys()).map((key) => key.publicKeyHex);

    const connectPlan = (bucketPassword: string, operationId: string) => ({
      type: "connect-existing-remote" as const,
      plan: {
        operationId,
        remoteStorageId: created.bucket.bucketId,
        displayName: "同 ID 连接请求",
        backend: "local" as const,
        connection: { kind: "local" as const },
        bucketPassword,
      },
    });

    // 错误密码和正确密码都不得拆除健康运行态。
    const wrongPassword = await __testDispatchStorageControl(connectPlan("wrong-password", "connect-existing-healthy-wrong-001"));
    expect(wrongPassword.operationResult).toMatchObject({ ok: false, error: { code: "storage_conflict" } });
    const correctPassword = await __testDispatchStorageControl(connectPlan("initial-setup-password", "connect-existing-healthy-correct-001"));
    expect(correctPassword.operationResult).toMatchObject({ ok: false, error: { code: "storage_conflict" } });

    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: created.firstKey.publicKeyHex,
    });
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).toEqual(keysBefore);

    // 冲突请求没有把运行态切到 locked：受保护写入仍可用。
    const imported = await __testImportPrivateKey("initial-setup-password", {
      label: "冲突后仍可写入",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    expect((await __testListVaultKeys()).map((key) => key.publicKeyHex)).toContain(imported.publicKeyHex);
  }, 30_000);

  it("S3 冷启动认证后继续使用设备新凭据，不回退 Hold 旧凭据", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const password = "s3-cold-start-password";
    const newConnection = () => ({
      kind: "s3" as const,
      endpoint: "https://new.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "new-key",
      secretAccessKey: "new-secret",
    });
    const oldConnection = () => ({ ...newConnection(), endpoint: "https://old.example.test", accessKeyId: "old-key", secretAccessKey: "old-secret" });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const revokedKeys = new Set<string>();
    const observedKeys: string[] = [];
    __testSetS3BucketProviderOptionsFactory(makeFakeS3ProviderOptionsFactory(sharedObjects, revokedKeys, observedKeys));
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-cold-start-001",
          bucketLabel: "S3 冷启动桶",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: password,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      // 远端换成旧凭据；另一台设备重启并撤销旧凭据。
      const reconfigured = await __testDispatchStorageControl({ type: "change-bucket-config", config: oldConnection(), password });
      expect(reconfigured.operationResult).toMatchObject({ bucketId: created.bucket.bucketId });
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      revokedKeys.add("old-key");

      // 用新凭据重新连接：设备目录写回新凭据，运行态绑定 Hold 旧记录。
      fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
      const connected = await __testDispatchStorageControl({
        type: "connect-existing-remote",
        plan: {
          operationId: "s3-connect-new-creds-001",
          remoteStorageId: created.bucket.bucketId,
          displayName: "S3 新凭据",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: password,
        },
      });
      expect(connected.operationResult).toMatchObject({ ok: true });

      // 真重启冷启动：认证必须继续使用设备新凭据。
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      const callsBeforeColdStart = observedKeys.length;
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
      expect(observedKeys.slice(callsBeforeColdStart)).toEqual(["new-key"]);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("S3 冷启动安装失败后重试仍只使用设备新凭据", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const password = "s3-cold-start-retry-password";
    const newConnection = () => ({
      kind: "s3" as const,
      endpoint: "https://new.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "new-key",
      secretAccessKey: "new-secret",
    });
    const oldConnection = () => ({ ...newConnection(), endpoint: "https://old.example.test", accessKeyId: "old-key", secretAccessKey: "old-secret" });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const revokedKeys = new Set<string>();
    const observedKeys: string[] = [];
    __testSetS3BucketProviderOptionsFactory(makeFakeS3ProviderOptionsFactory(sharedObjects, revokedKeys, observedKeys));
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-cold-start-retry-001",
          bucketLabel: "S3 重试桶",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: password,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      const reconfigured = await __testDispatchStorageControl({ type: "change-bucket-config", config: oldConnection(), password });
      expect(reconfigured.operationResult).toMatchObject({ bucketId: created.bucket.bucketId });
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      revokedKeys.add("old-key");

      fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
      const connected = await __testDispatchStorageControl({
        type: "connect-existing-remote",
        plan: {
          operationId: "s3-connect-retry-setup-001",
          remoteStorageId: created.bucket.bucketId,
          displayName: "S3 重试前连接",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: password,
        },
      });
      expect(connected.operationResult).toMatchObject({ ok: true });

      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);

      // 第一次解锁在认证成功后、Root 安装前注入失败；状态必须仍是设备提示。
      const callsBeforeFirstUnlock = observedKeys.length;
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      __testFailColdStartInstall();
      const first = await __testDispatchStorageControl({ type: "unlock-bucket", password });
      expect(first.operationResult).toMatchObject({ ok: false });
      expect(observedKeys.slice(callsBeforeFirstUnlock)).not.toContain("old-key");

      // 重试重新走只读发现→认证，只能触碰设备新凭据。
      const callsBeforeRetry = observedKeys.length;
      const retry = await __testDispatchStorageControl({ type: "unlock-bucket", password });
      expect(retry.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
      expect(observedKeys.slice(callsBeforeRetry)).toEqual(["new-key"]);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("S3 密码轮转后设备仍保留新凭据，冷启动不回退旧凭据", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-rotation-old-password";
    const newPassword = "s3-rotation-new-password";
    const newConnection = () => ({
      kind: "s3" as const,
      endpoint: "https://new.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "new-key",
      secretAccessKey: "new-secret",
    });
    const oldConnection = () => ({ ...newConnection(), endpoint: "https://old.example.test", accessKeyId: "old-key", secretAccessKey: "old-secret" });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const revokedKeys = new Set<string>();
    const observedKeys: string[] = [];
    __testSetS3BucketProviderOptionsFactory(makeFakeS3ProviderOptionsFactory(sharedObjects, revokedKeys, observedKeys));
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rotation-001",
          bucketLabel: "S3 轮转桶",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      const reconfigured = await __testDispatchStorageControl({ type: "change-bucket-config", config: oldConnection(), password: oldPassword });
      expect(reconfigured.operationResult).toMatchObject({ bucketId: created.bucket.bucketId });
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      revokedKeys.add("old-key");

      fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
      const connected = await __testDispatchStorageControl({
        type: "connect-existing-remote",
        plan: {
          operationId: "s3-connect-before-rotation-001",
          remoteStorageId: created.bucket.bucketId,
          displayName: "S3 轮转前连接",
          backend: "s3",
          connection: newConnection(),
          bucketPassword: oldPassword,
        },
      });
      expect(connected.operationResult).toMatchObject({ ok: true });

      // 密码轮转：远端 Hold 重加密旧连接，设备层独立重加密新凭据。
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword });
      expect(rotated.operationResult).toMatchObject({ ok: true });

      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      const callsBeforeColdStart = observedKeys.length;
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: newPassword });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
      expect(observedKeys.slice(callsBeforeColdStart)).toEqual(["new-key"]);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("Hold 发布后不再二次读取提交头 ETag", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-head-read-old-password";
    const newPassword = "s3-head-read-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://head-read.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "head-read-key",
      secretAccessKey: "head-read-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    let blockHeadReads = false;
    let headPublishedAfterBlock = false;
    let unexpectedHeadRead = false;
    const holdHeadSuffix = ".keymaster/hold/v1/head.json";
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (base) => ({
        ...base,
        async put(input: Parameters<BucketObjectStore["put"]>[0]) {
          const result = await base.put(input);
          if (blockHeadReads && input.key.endsWith(holdHeadSuffix)) headPublishedAfterBlock = true;
          return result;
        },
        async get(input: Parameters<BucketObjectStore["get"]>[0]) {
          if (blockHeadReads && headPublishedAfterBlock && input.key.endsWith(holdHeadSuffix)) {
            unexpectedHeadRead = true;
            throw new StorageRuntimeError("storage_unavailable", "injected post-publication Hold head read failure");
          }
          return base.get(input);
        },
      })),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-head-read-001",
          bucketLabel: "S3 提交头读取桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      blockHeadReads = true;
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword });
      expect(rotated.operationResult).toMatchObject({ ok: true, bucket: { bucketId: created.bucket.bucketId } });
      expect(unexpectedHeadRead).toBe(false);
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(0);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("密码轮转读回期间并发替换进入 pending，不单边回滚 Hold", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-race-old-password";
    const newPassword = "s3-race-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://race.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "race-key",
      secretAccessKey: "race-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
      ) => Promise<void>;
    } = {
      armed: false,
      onPut: async () => { throw new Error("manifest hook is not armed"); },
    };
    let forgedBytes: Uint8Array | undefined;
    hook.onPut = async (input, base) => {
      const current = sharedObjects.get(input.key);
      if (!current) throw new Error("manifest is missing for forgery");
      const forged = current.bytes.slice();
      forged[16] = (forged[16] ?? 0) ^ 0xff;
      forgedBytes = forged;
      // 并发写入先提交：轮转的 CAS 写入必然冲突，读回看到的是别人的版本。
      await createMemoryBucketObjectStore(sharedObjects).put({
        namespaceRoot: "",
        key: input.key,
        bytes: forged,
        ifMatch: current.etag,
      });
      void base;
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rotation-race-001",
          bucketLabel: "S3 并发桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      const manifestKey = `.keymaster/buckets/${created.bucket.bucketId}/.keymaster/root/v1`;
      const headKey = `.keymaster/buckets/${created.bucket.bucketId}/.keymaster/hold/v1/head.json`;
      const headBefore = JSON.parse(new TextDecoder().decode(sharedObjects.get(headKey)?.bytes ?? new Uint8Array()));
      const deviceBefore = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];

      hook.armed = true;
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in rotated) {
        expect(rotated.ack).toMatchObject({ status: "error" });
      }
      const failureText = "ack" in rotated
        ? JSON.stringify(rotated.ack)
        : (rotated as { message: string }).message;
      expect(failureText).toContain("pending");

      // 没有单边回滚：Hold 仍是新文档，manifest 仍是并发版本，设备目录未动。
      const headAfter = JSON.parse(new TextDecoder().decode(sharedObjects.get(headKey)?.bytes ?? new Uint8Array()));
      expect(headAfter.configRevision).toBe(headBefore.configRevision + 1);
      expect(sharedObjects.get(manifestKey)?.bytes).toEqual(forgedBytes);
      const deviceAfter = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
      expect(deviceAfter?.encryptedConfig).toEqual(deviceBefore?.encryptedConfig);

      // 进入 degraded，可观测。
      const status = await __testDispatchStorageControl({ type: "status" });
      expect(status.ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("密码轮转 manifest 写入响应丢失但已提交时继续完成", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-lost-old-password";
    const newPassword = "s3-lost-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://lost.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "lost-key",
      secretAccessKey: "lost-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
      ) => Promise<void>;
    } = {
      armed: false,
      onPut: async () => { throw new Error("manifest hook is not armed"); },
    };
    hook.onPut = async (input, base) => {
      // 先真实提交，再丢弃响应：调用方只能读回逐字节确认。
      await base.put({ namespaceRoot: "", ...input });
      throw new StorageRuntimeError("storage_unavailable", "injected lost manifest write response");
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rotation-lost-001",
          bucketLabel: "S3 丢失响应桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword });
      expect(rotated.operationResult).toMatchObject({ ok: true });

      // 轮转完整成功：新密码冷启动可用。
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: newPassword });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("跨 Worker 重启后 resume 真正完成悬挂轮转，新密码可解锁", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-resume-old-password";
    const newPassword = "s3-resume-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://resume.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "resume-key",
      secretAccessKey: "resume-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
      onGet?: (
        input: { key: string },
        base: BucketObjectStore,
      ) => Promise<BucketGetOutput | undefined>;
    } = { armed: false };
    let putDone = false;
    let liedBytes: Uint8Array | undefined;
    hook.onPut = async (input, base) => {
      // manifest 写入真实提交，但调用方收不到响应。
      await base.put({ namespaceRoot: "", ...input });
      putDone = true;
      throw new StorageRuntimeError("storage_unavailable", "injected lost manifest write response");
    };
    hook.onGet = async (input, base) => {
      // 仅对写入后的第一次读回撒谎：看到的既不是新版也不是旧版。
      if (!putDone || liedBytes) return undefined;
      const real = await base.get({ namespaceRoot: "", key: input.key });
      const forged = real.bytes.slice();
      forged[16] = (forged[16] ?? 0) ^ 0xff;
      liedBytes = forged;
      return { ...real, bytes: forged };
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rotation-resume-001",
          bucketLabel: "S3 恢复桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in rotated) {
        expect(rotated.ack).toMatchObject({ status: "error" });
      }
      const failureText = "ack" in rotated
        ? JSON.stringify(rotated.ack)
        : (rotated as { message: string }).message;
      expect(failureText).toContain("pending");

      // 事务已持久化：阶段、KDF、指纹齐全。
      const persisted = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks })
        .read()?.rotations?.find((candidate) => candidate.bucketId === created.bucket.bucketId);
      expect(persisted).toMatchObject({
        phase: "manifest-unconfirmed",
        bucketId: created.bucket.bucketId,
        oldConfigRevision: created.bucket.configRevision,
        newConfigRevision: created.bucket.configRevision + 1,
      });
      expect(persisted?.newManifestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      expect(persisted?.deviceCiphertextFingerprint).toMatch(/^[0-9a-f]{64}$/u);
      const operationId = persisted?.operationId;
      if (!operationId) throw new Error("rotation record was not persisted");

      // Hold 的 keys.json 保持 JSON 格式但修改业务字段；这样只能破坏完整
      // 文档 HMAC，不能靠“头部 revision/KDF 看起来正确”把它误判为新版本。
      const holdHeadKey = `.keymaster/buckets/${created.bucket.bucketId}/.keymaster/hold/v1/head.json`;
      const holdHead = JSON.parse(new TextDecoder().decode(sharedObjects.get(holdHeadKey)?.bytes ?? new Uint8Array())) as { snapshotId?: string };
      if (!holdHead.snapshotId) throw new Error("committed Hold head is missing");
      const holdHeaderKey = `.keymaster/buckets/${created.bucket.bucketId}/.keymaster/hold/v1/snapshots/${holdHead.snapshotId}/header.json`;
      const holdHeader = JSON.parse(new TextDecoder().decode(sharedObjects.get(holdHeaderKey)?.bytes ?? new Uint8Array())) as { keysPath?: string };
      if (!holdHeader.keysPath) throw new Error("committed Hold header is missing");
      const holdKeysKey = `.keymaster/buckets/${created.bucket.bucketId}/${holdHeader.keysPath}`;
      const holdKeysObject = sharedObjects.get(holdKeysKey);
      if (!holdKeysObject) throw new Error("committed Hold keys are missing");
      const originalHoldKeysBytes = holdKeysObject.bytes.slice();
      const tamperedHoldKeys = JSON.parse(new TextDecoder().decode(originalHoldKeysBytes)) as Array<Record<string, unknown>>;
      const firstHoldKey = tamperedHoldKeys[0];
      if (!firstHoldKey || typeof firstHoldKey.label !== "string") throw new Error("committed Hold key is missing");
      firstHoldKey.label = `${firstHoldKey.label}-tampered`;
      holdKeysObject.bytes = new TextEncoder().encode(JSON.stringify(tamperedHoldKeys));

      // 真重启：内存 pending 标记丢失，只能靠持久化事务恢复。
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);

      const tamperedResume = await __testDispatchStorageControl({
        type: "resume-bucket-password-rotation",
        operationId,
        oldPassword,
        newPassword,
      }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in tamperedResume) {
        expect(tamperedResume.ack).toMatchObject({ status: "error" });
      }
      const tamperedResumeText = "ack" in tamperedResume
        ? JSON.stringify(tamperedResume.ack)
        : (tamperedResume as { message: string }).message;
      expect(tamperedResumeText).toContain("pending");
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(1);

      // 修复测试注入的数据后再次恢复，证明 pending 不是永久卡死。
      holdKeysObject.bytes = originalHoldKeysBytes;
      const resumed = await __testDispatchStorageControl({
        type: "resume-bucket-password-rotation",
        operationId,
        oldPassword,
        newPassword,
      });
      if (!(resumed.operationResult as { ok?: boolean } | undefined)?.ok) throw new Error(JSON.stringify(resumed.ack));
      expect(resumed.operationResult).toMatchObject({ ok: true, outcome: "completed", bucket: { bucketId: created.bucket.bucketId } });
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(0);

      // 恢复后新密码冷启动可用，旧密码已被替换。
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: newPassword });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
      expect(__testGetSnapshot()).toMatchObject({
        storageBucketId: created.bucket.bucketId,
        vaultStatus: "unlocked",
        activePublicKeyHex: created.firstKey.publicKeyHex,
      });
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("密码轮转回滚 manifest 响应丢失但已提交时确认完成", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-rollback-old-password";
    const newPassword = "s3-rollback-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://rollback.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "rollback-key",
      secretAccessKey: "rollback-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
    } = { armed: false };
    // 第二次 manifest 写入才是回滚：先真实提交再丢弃响应。
    hook.onPut = async (input, base, manifestPutIndex) => {
      if (manifestPutIndex !== 2) return;
      await base.put({ namespaceRoot: "", ...input });
      throw new StorageRuntimeError("storage_unavailable", "injected lost manifest rollback response");
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rollback-lost-001",
          bucketLabel: "S3 回滚桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      const manifestKey = `.keymaster/buckets/${created.bucket.bucketId}/.keymaster/root/v1`;
      const manifestBefore = sharedObjects.get(manifestKey)?.bytes.slice();
      const deviceBefore = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
      if (!manifestBefore || !deviceBefore) throw new Error("rotation precondition is missing");

      hook.armed = true;
      __testFailAfterBucketPasswordCatalogUpdate();
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in rotated) {
        expect(rotated.ack).toMatchObject({ status: "error" });
      }
      const failureText = "ack" in rotated
        ? JSON.stringify(rotated.ack)
        : (rotated as { message: string }).message;
      expect(failureText).toContain("injected bucket password rotation failure after catalog update");

      // 回滚完整确认：manifest 回到旧字节，事务记录已清理。
      expect(sharedObjects.get(manifestKey)?.bytes).toEqual(manifestBefore);
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(0);
      const deviceAfter = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
      expect(deviceAfter?.encryptedConfig).toEqual(deviceBefore.encryptedConfig);

      // 旧密码冷启动仍可用。
      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: oldPassword });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("密码轮转回滚 manifest 未落地时保留事务，随后 resume 安全撤销", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-rollback-miss-old";
    const newPassword = "s3-rollback-miss-new";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://rollback-miss.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "rollback-miss-key",
      secretAccessKey: "rollback-miss-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
    } = { armed: false };
    // 第二次 manifest 写入（回滚）直接失败且不落地：读回仍是新版。
    hook.onPut = async (input, base, manifestPutIndex) => {
      if (manifestPutIndex !== 2) return;
      throw new StorageRuntimeError("storage_unavailable", "injected manifest rollback transport failure");
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rollback-miss-001",
          bucketLabel: "S3 回滚未落地桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      __testFailAfterBucketPasswordCatalogUpdate();
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in rotated) {
        expect(rotated.ack).toMatchObject({ status: "error" });
      }
      const failureText = "ack" in rotated
        ? JSON.stringify(rotated.ack)
        : (rotated as { message: string }).message;
      expect(failureText).toContain("rollback was not fully confirmed");

      // 事务保留：Hold 已回滚为旧版，manifest 仍是新版。
      const persisted = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks })
        .read()?.rotations?.find((candidate) => candidate.bucketId === created.bucket.bucketId);
      expect(persisted?.phase).toBe("hold-published");
      if (!persisted) throw new Error("rotation record was not kept");

      // resume 把 manifest 安全改回旧版后撤销，旧密码冷启动可用。
      const resumed = await __testDispatchStorageControl({
        type: "resume-bucket-password-rotation",
        operationId: persisted.operationId,
        oldPassword,
        newPassword,
      });
      expect(resumed.operationResult).toMatchObject({ ok: true, outcome: "revoked" });

      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);
      const hint = readStorageBootstrap(fixture.storage);
      await __testColdStartFromDeviceHint(hint);
      const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: oldPassword });
      expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("密码轮转回滚读回期间并发替换进入 pending，resume 保持 pending", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-rollback-race-old";
    const newPassword = "s3-rollback-race-new";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://rollback-race.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "rollback-race-key",
      secretAccessKey: "rollback-race-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
    } = { armed: false };
    let forgedBytes: Uint8Array | undefined;
    hook.onPut = async (input, base, manifestPutIndex) => {
      if (manifestPutIndex !== 2) return;
      // 回滚写入前先被并发替换：回滚 CAS 冲突，读回是别人的版本。
      const current = sharedObjects.get(input.key);
      if (!current) throw new Error("manifest is missing for forgery");
      const forged = current.bytes.slice();
      forged[24] = (forged[24] ?? 0) ^ 0xff;
      forgedBytes = forged;
      await createMemoryBucketObjectStore(sharedObjects).put({
        namespaceRoot: "",
        key: input.key,
        bytes: forged,
        ifMatch: current.etag,
      });
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rollback-race-001",
          bucketLabel: "S3 回滚并发桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      __testFailAfterBucketPasswordCatalogUpdate();
      const rotated = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in rotated) {
        expect(rotated.ack).toMatchObject({ status: "error" });
      }
      const failureText = "ack" in rotated
        ? JSON.stringify(rotated.ack)
        : (rotated as { message: string }).message;
      expect(failureText).toContain("pending");

      const persisted = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks })
        .read()?.rotations?.find((candidate) => candidate.bucketId === created.bucket.bucketId);
      expect(persisted?.phase).toBe("manifest-rollback-unconfirmed");
      expect(sharedObjects.get(`.keymaster/buckets/${created.bucket.bucketId}/.keymaster/root/v1`)?.bytes).toEqual(forgedBytes);
      if (!persisted) throw new Error("rotation record was not kept");

      // 外来 manifest 无法分类：resume 同样保持 pending，不做破坏性写入。
      const before = fixture.storage.snapshot();
      const resumed = await __testDispatchStorageControl({
        type: "resume-bucket-password-rotation",
        operationId: persisted.operationId,
        oldPassword,
        newPassword,
      }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in resumed) {
        expect(resumed.ack).toMatchObject({ status: "error" });
      }
      const resumeText = "ack" in resumed
        ? JSON.stringify(resumed.ack)
        : (resumed as { message: string }).message;
      expect(resumeText).toContain("pending");
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations?.length).toBe(1);
      expect(fixture.storage.snapshot()).toEqual(before);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("resume 使用错误密码时不做任何写入且保留事务", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-resume-pw-old-password";
    const newPassword = "s3-resume-pw-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://resume-pw.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "resume-pw-key",
      secretAccessKey: "resume-pw-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
    } = { armed: false };
    hook.onPut = async (input, base) => {
      const current = sharedObjects.get(input.key);
      if (!current) throw new Error("manifest is missing for forgery");
      const forged = current.bytes.slice();
      forged[16] = (forged[16] ?? 0) ^ 0xff;
      await createMemoryBucketObjectStore(sharedObjects).put({
        namespaceRoot: "",
        key: input.key,
        bytes: forged,
        ifMatch: current.etag,
      });
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-resume-pw-001",
          bucketLabel: "S3 密码桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch(() => undefined);
      const persisted = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks })
        .read()?.rotations?.find((candidate) => candidate.bucketId === created.bucket.bucketId);
      if (!persisted) throw new Error("rotation record was not persisted");
      const writesBefore = fixture.writeOperations.length;

      await __testReleaseCatalogLocalBinding();
      __testResetState();
      __testPrepareInitialSetup();
      __testSetLocalStorageBridgeOverride(fixture.bridge);

      // 新旧密码都错：认证设备连接即失败，不触碰远端。
      const callsBefore = observedKeys.length;
      const resumed = await __testDispatchStorageControl({
        type: "resume-bucket-password-rotation",
        operationId: persisted.operationId,
        oldPassword: "wrong-old-password-1",
        newPassword: "wrong-new-password-1",
      }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in resumed) {
        expect(resumed.ack).toMatchObject({ status: "error" });
      }
      const resumeText = "ack" in resumed
        ? JSON.stringify(resumed.ack)
        : (resumed as { message: string }).message;
      expect(resumeText).toMatch(/password|identity/i);
      expect(observedKeys.slice(callsBefore)).toEqual([]);
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations?.length).toBe(1);
      expect(fixture.writeOperations).toHaveLength(writesBefore);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("resume 未知操作 ID 时直接返回不存在", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const resumed = await __testDispatchStorageControl({
      type: "resume-bucket-password-rotation",
      operationId: "rotation-unknown-0001",
      oldPassword: "some-old-password",
      newPassword: "some-new-password",
    }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    if ("ack" in resumed) {
      expect(resumed.ack).toMatchObject({ status: "error" });
    }
    const resumeText = "ack" in resumed
      ? JSON.stringify(resumed.ack)
      : (resumed as { message: string }).message;
    expect(resumeText).toMatch(/not found|不存在/i);
  });

  it("同一桶已有未决轮转时拒绝开始新轮转", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "s3-dup-old-password";
    const newPassword = "s3-dup-new-password";
    const connection = () => ({
      kind: "s3" as const,
      endpoint: "https://dup.example.test",
      region: "us-east-1",
      bucket: "shared-bucket",
      accessKeyId: "dup-key",
      secretAccessKey: "dup-secret",
    });
    const sharedObjects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
    const observedKeys: string[] = [];
    const hook: {
      armed: boolean;
      onPut?: (
        input: { key: string; bytes: Uint8Array; ifMatch?: string },
        base: BucketObjectStore,
        manifestPutIndex: number,
      ) => Promise<void>;
    } = { armed: false };
    hook.onPut = async (input, base) => {
      const current = sharedObjects.get(input.key);
      if (!current) throw new Error("manifest is missing for forgery");
      const forged = current.bytes.slice();
      forged[16] = (forged[16] ?? 0) ^ 0xff;
      await createMemoryBucketObjectStore(sharedObjects).put({
        namespaceRoot: "",
        key: input.key,
        bytes: forged,
        ifMatch: current.etag,
      });
    };
    __testSetS3BucketProviderOptionsFactory(
      makeFakeS3ProviderOptionsFactory(sharedObjects, new Set<string>(), observedKeys, (store) => makeHookedManifestStore(store, hook)),
    );
    try {
      const createdResponse = await __testDispatchStorageControl({
        type: "initial-setup",
        plan: {
          transactionId: "initial-setup-s3-rotation-dup-001",
          bucketLabel: "S3 并发轮转桶",
          backend: "s3",
          connection: connection(),
          bucketPassword: oldPassword,
          firstKey: { kind: "generate", label: "S3 主 Key", capabilities: ["p2pkh"] },
        },
      });
      const created = createdResponse.operationResult as InitialSetupResult;
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.summary);

      hook.armed = true;
      await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch(() => undefined);
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(1);

      // 未决事务未恢复前，同一桶的新轮转必须拒绝，而不是交错写入。
      const again = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
        .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
      if ("ack" in again) {
        expect(again.ack).toMatchObject({ status: "error" });
      }
      const againText = "ack" in again
        ? JSON.stringify(again.ack)
        : (again as { message: string }).message;
      expect(againText).toMatch(/recovery|conflict|恢复/i);
      expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(1);
    } finally {
      __testSetS3BucketProviderOptionsFactory(undefined);
    }
  }, 30_000);

  it("配置更新失败回滚恢复原设备投影而不是 Hold 记录", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const password = "initial-setup-password";
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-config-rollback-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    // 重启后用同一远端连接，产生“设备密文 ≠ 运行态 Hold 记录”。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const connected = await __testDispatchStorageControl({
      type: "connect-existing-remote",
      plan: {
        operationId: "connect-existing-before-config-rollback-001",
        remoteStorageId: created.bucket.bucketId,
        displayName: "配置回滚前连接",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: password,
      },
    });
    expect(connected.operationResult).toMatchObject({ ok: true });
    const deviceBefore = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    const runtimeCipher = (connected.operationResult as ExistingRemoteStorageConnectResult & { ok: true }).bucket.encryptedConfig;
    expect(deviceBefore?.encryptedConfig).not.toEqual(runtimeCipher);

    // 注入配置更新目录提交后的失败：回滚必须把设备层恢复为原投影。
    __testFailAfterBucketConfigCatalogUpdate();
    const configResult = await __testDispatchStorageControl({
      type: "change-bucket-config",
      config: { kind: "local" },
      label: "失败后回滚",
      password,
    }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    if ("ack" in configResult) {
      expect(configResult.ack).toMatchObject({ status: "error", message: "injected bucket configuration update failure after catalog update" });
    } else {
      expect(configResult.message).toContain("injected bucket configuration update failure after catalog update");
    }

    const deviceAfter = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceAfter?.encryptedConfig).toEqual(deviceBefore?.encryptedConfig);
    expect(__testGetSnapshot().storageBucketId).toBe(created.bucket.bucketId);
  }, 30_000);

  it("密码轮转失败回滚恢复原设备投影，旧密码仍可冷启动解锁", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "initial-setup-password";
    const newPassword = "initial-setup-rotated-password";
    const createdResponse = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan("initial-setup-rotation-rollback-001") });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const connected = await __testDispatchStorageControl({
      type: "connect-existing-remote",
      plan: {
        operationId: "connect-existing-before-rotation-rollback-001",
        remoteStorageId: created.bucket.bucketId,
        displayName: "轮转回滚前连接",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: oldPassword,
      },
    });
    expect(connected.operationResult).toMatchObject({ ok: true });
    const deviceBefore = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];

    __testFailAfterBucketPasswordCatalogUpdate();
    const rotationResult = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
      .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    if ("ack" in rotationResult) {
      expect(rotationResult.ack).toMatchObject({ status: "error", message: "injected bucket password rotation failure after catalog update" });
    } else {
      expect(rotationResult.message).toContain("injected bucket password rotation failure after catalog update");
    }

    const deviceAfter = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceAfter?.encryptedConfig).toEqual(deviceBefore?.encryptedConfig);

    // 回滚后旧密码、旧设备连接仍可冷启动解锁。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const hint = readStorageBootstrap(fixture.storage);
    await __testColdStartFromDeviceHint(hint);
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: oldPassword });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
    expect(__testGetSnapshot()).toMatchObject({
      storageBucketId: created.bucket.bucketId,
      vaultStatus: "unlocked",
      activePublicKeyHex: created.firstKey.publicKeyHex,
    });
  }, 30_000);

  it("Vault verifier 回滚失败后重启恢复并安全撤销，旧密码仍可解锁", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "initial-setup-vault-rollback-old";
    const newPassword = "initial-setup-vault-rollback-new";
    const createdResponse = await __testDispatchStorageControl({
      type: "initial-setup",
      plan: {
        transactionId: "initial-setup-vault-rollback-001",
        bucketLabel: "Verifier 回滚桶",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: oldPassword,
        firstKey: { kind: "generate", label: "主 Key", capabilities: ["p2pkh"] },
      },
    });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    fixture.setCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const connected = await __testDispatchStorageControl({
      type: "connect-existing-remote",
      plan: {
        operationId: "connect-existing-before-vault-rollback-001",
        remoteStorageId: created.bucket.bucketId,
        displayName: "Verifier 回滚前连接",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: oldPassword,
      },
    });
    expect(connected.operationResult).toMatchObject({ ok: true });
    expect(await __testGetVaultAuthMetadata()).toBeDefined();

    __testFailNextVaultAuthMetadataRollback();
    __testFailAfterBucketPasswordCatalogUpdate();
    const rotationResult = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
      .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    const failureText = "ack" in rotationResult
      ? JSON.stringify(rotationResult.ack)
      : (rotationResult as { message: string }).message;
    expect(failureText).toContain("rollback was not fully confirmed");

    const persisted = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks })
      .read()?.rotations?.find((candidate) => candidate.bucketId === created.bucket.bucketId);
    expect(persisted?.phase).toBe("hold-published");
    if (!persisted) throw new Error("rotation record was not persisted");

    // 真重启后只凭事务记录重新分类；旧 Hold/manifest 已恢复，因此结果必须是 revoked。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const resumed = await __testDispatchStorageControl({
      type: "resume-bucket-password-rotation",
      operationId: persisted.operationId,
      oldPassword,
      newPassword,
    });
    expect(resumed.operationResult).toMatchObject({ ok: true, outcome: "revoked" });
    expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(0);

    const hint = readStorageBootstrap(fixture.storage);
    await __testColdStartFromDeviceHint(hint);
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: oldPassword });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
  }, 30_000);

  it("撤销恢复设备已写回后 verifier 失败，重启再次 resume 仍可完成", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const oldPassword = "initial-setup-device-restore-old";
    const newPassword = "initial-setup-device-restore-new";
    const createdResponse = await __testDispatchStorageControl({
      type: "initial-setup",
      plan: {
        transactionId: "initial-setup-device-restore-001",
        bucketLabel: "设备恢复幂等桶",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: oldPassword,
        firstKey: { kind: "generate", label: "主 Key", capabilities: ["p2pkh"] },
      },
    });
    const created = createdResponse.operationResult as InitialSetupResult;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error.summary);
    const deviceBefore = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    if (!deviceBefore) throw new Error("initial device connection is missing");

    // 正向流程已写入新设备密文，但设备回滚 CAS 失败；Hold/manifest 已回到旧版本，
    // 因而下一次 resume 会进入 revoked 分支并需要把设备写回旧密码。
    __testFailAfterBucketPasswordCatalogUpdate();
    __testFailNextBucketPasswordDeviceRollback();
    const rotationResult = await __testDispatchStorageControl({ type: "change-bucket-password", oldPassword, newPassword })
      .catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    const failureText = "ack" in rotationResult
      ? JSON.stringify(rotationResult.ack)
      : (rotationResult as { message: string }).message;
    expect(failureText).toContain("rollback was not fully confirmed");
    const pending = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations?.[0];
    expect(pending).toBeDefined();
    const deviceAfterForwardFailure = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    expect(deviceAfterForwardFailure?.encryptedConfig).not.toEqual(deviceBefore.encryptedConfig);
    if (!pending) throw new Error("rotation record was not persisted");

    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    __testFailNextVaultAuthMetadataRestore();
    const firstResume = await __testDispatchStorageControl({
      type: "resume-bucket-password-rotation",
      operationId: pending.operationId,
      oldPassword,
      newPassword,
    }).catch((error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }));
    const firstResumeText = "ack" in firstResume
      ? JSON.stringify(firstResume.ack)
      : (firstResume as { message: string }).message;
    expect(firstResumeText).toContain("injected Vault auth metadata restore failure");

    const afterDeviceRestoreFailure = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read();
    const restoredRecord = afterDeviceRestoreFailure?.rotations?.find((candidate) => candidate.operationId === pending.operationId);
    const restoredConnection = afterDeviceRestoreFailure?.connections.find((candidate) => candidate.remoteStorageId === created.bucket.bucketId);
    expect(restoredRecord?.restoredDeviceCiphertextFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(restoredRecord?.restoredDeviceEncryptedConfig).toEqual(restoredConnection?.encryptedConfig);
    expect(restoredConnection?.encryptedConfig).not.toEqual(deviceBefore.encryptedConfig);

    // 事务内部仍保留两项恢复识别材料，但生产列表只能输出独立安全投影；
    // 这里沿真实 response parser 再过一次，确保页面重载时恢复入口不会因
    // 内部字段不成对而整批解析失败。
    const pendingList = await __testDispatchStorageControl({ type: "list-pending-password-rotations" });
    const pendingView = (pendingList.operationResult as Array<Record<string, unknown>>)[0];
    if (!pendingView) throw new Error("pending rotation safety projection is missing");
    expect(pendingView).toMatchObject({
      format: "keymaster.storage.password-rotation-view",
      version: 1,
      operationId: pending.operationId,
      bucketId: pending.bucketId,
      backend: pending.backend,
      phase: pending.phase,
      createdAt: pending.createdAt,
    });
    expect(pendingView).toHaveProperty("updatedAt", expect.any(Number));
    expect(Object.keys(pendingView).sort()).toEqual([
      "backend", "bucketId", "createdAt", "format", "operationId", "phase", "updatedAt", "version",
    ]);
    expect(pendingView).not.toHaveProperty("restoredDeviceEncryptedConfig");
    expect(pendingView).not.toHaveProperty("restoredDeviceCiphertextFingerprint");
    const parsedPendingList = parseCoordinatorResponseFor({
      kind: "storage.control",
      control: { type: "list-pending-password-rotations" },
    } as unknown as CoordinatorRpcRequest, {
      sessionEpoch: pendingList.sessionEpoch,
      ack: pendingList.ack,
      operationResult: pendingList.operationResult,
    });
    expect(parsedPendingList.operationResult).toEqual([pendingView]);

    // 真正再次重启：本次不重新生成恢复密文，直接识别上一次已经成功的设备 CAS。
    await __testReleaseCatalogLocalBinding();
    __testResetState();
    __testPrepareInitialSetup();
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const resumed = await __testDispatchStorageControl({
      type: "resume-bucket-password-rotation",
      operationId: pending.operationId,
      oldPassword,
      newPassword,
    });
    expect(resumed.operationResult).toMatchObject({ ok: true, outcome: "revoked" });
    expect(createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.rotations ?? []).toHaveLength(0);
    const finalConnection = createDeviceBootstrapRepository({ storage: fixture.storage, locks: catalogBridgeLocks }).read()?.connections[0];
    // 撤销恢复使用随机 IV；第二次 resume 应保留第一次已确认写回的
    // 本事务密文，而不是再次生成另一份密文或回退到旧随机 IV。
    expect(finalConnection?.encryptedConfig).toEqual(restoredRecord?.restoredDeviceEncryptedConfig);

    const hint = readStorageBootstrap(fixture.storage);
    await __testColdStartFromDeviceHint(hint);
    const unlock = await __testDispatchStorageControl({ type: "unlock-bucket", password: oldPassword });
    expect(unlock.operationResult).toMatchObject({ ok: true, vaultUnlocked: true });
  }, 30_000);

  it("响应丢失后按同一 transactionId 返回已提交结果，不重新暂存第二把 Key", async () => {
    const transactionId = "initial-setup-recovery-001";
    const entry = await makeEncryptedLocalCatalogEntry("setup-recovery-001", "已提交首桶", "recovery-password");
    const fixture = makeInitialSetupWorkerBridge({
      format: "keymaster.storage.catalog",
      version: 2,
      selectedBucketId: entry.bucketId,
      buckets: [entry],
    });
    __testSeedInitialSetupRecoveryRecord(makeSucceededRecord(entry, transactionId));
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(response.ack.status).toBe("ok");
    expect(response.operationResult).toMatchObject({
      ok: true,
      bucket: entry,
      firstKey: { label: "恢复的主 Key", format: "hex" },
    });
    expect(fixture.storage.length).toBe(0);
    expect(__testGetSnapshot().storageBucketId).toBeUndefined();
  });

  it("成功恢复记录无法验证目录时返回不可重试结果，不执行新计划", async () => {
    const transactionId = "initial-setup-recovery-mismatch-001";
    const entry = await makeEncryptedLocalCatalogEntry("setup-recovery-mismatch-001", "缺失目录首桶", "recovery-password");
    const fixture = makeInitialSetupWorkerBridge();
    __testSeedInitialSetupRecoveryRecord(makeSucceededRecord(entry, transactionId));
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan: makePlan(transactionId) });
    expect(response.ack.status).toBe("ok");
    expect(response.operationResult).toMatchObject({
      ok: false,
      error: { phase: "runtime", rollback: "not-started", code: "storage_conflict" },
    });
    expect((response.operationResult as InitialSetupResult).ok ? "" : (response.operationResult as Extract<InitialSetupResult, { ok: false }>).error.diagnostic)
      .toContain("succeeded-record-catalog-mismatch");
    expect(fixture.storage.length).toBe(0);
    expect(fixture.getCatalog()).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
  });

  it("恢复记录读取失败时 fail-closed，不把未知 transactionId 当成新事务重跑", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    __testSetLocalStorageBridgeOverride(async (input) => {
      if (input.type === "device-bootstrap-read") throw new Error("recovery bridge unavailable");
      return fixture.bridge(input);
    });
    const plan = makePlan("initial-setup-recovery-unavailable-001");

    const response = await __testDispatchStorageControl({ type: "initial-setup", plan });
    expect(response.ack.status).toBe("ok");
    expect(response.operationResult).toMatchObject({ ok: false, error: { code: "storage_unavailable", rollback: "not-started" } });
    expect(fixture.storage.length).toBe(0);
    expect(fixture.getCatalog()).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    expect(plan.bucketPassword).toBe("");
  });

  it("Worker 端也阻止绕过页面创建新的初始化事务", async () => {
    const fixture = makeInitialSetupWorkerBridge();
    const blockingEntry = await makeEncryptedLocalCatalogEntry("setup-blocking-recovery-001", "待恢复桶", "recovery-password");
    const blockingTransactionId = "initial-setup-blocking-recovery-001";
    const blockingRecord: InitialSetupRecoveryRecordV1 = {
      ...makeSucceededRecord(blockingEntry, blockingTransactionId),
      phase: "rollback",
      status: "failed",
      cleanup: "unconfirmed",
      error: {
        title: "初始化失败",
        summary: "候选数据尚未清理",
        action: "请先重试清理",
        code: "storage_provider_error",
        incidentId: "blocking-recovery-incident",
        transactionId: blockingTransactionId,
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt: Date.now(),
    };
    delete blockingRecord.success;
    __testSeedInitialSetupRecoveryRecord(blockingRecord);
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const plan = makePlan("initial-setup-bypass-block-001");
    const response = await __testDispatchStorageControl({ type: "initial-setup", plan });
    expect(response.ack.status).toBe("ok");
    expect(response.operationResult).toMatchObject({
      ok: false,
      error: { code: "storage_conflict", rollback: "not-started" },
    });
    expect(fixture.storage.length).toBe(0);
    expect(fixture.getCatalog()).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
  });

  it("使用完整 transactionId 的 SHA-256 生成不碰撞的初始化桶 ID", () => {
    const prefix = "a".repeat(112);
    const left = prefix + "-winner";
    const right = prefix + "-loser";
    expect(__testInitialSetupBucketId(left)).toHaveLength(70);
    expect(__testInitialSetupBucketId(left)).toBe(__testInitialSetupBucketId(left));
    expect(__testInitialSetupBucketId(left)).not.toBe(__testInitialSetupBucketId(right));
  });

  it.each(["local", "s3"] as const)("拒绝 %s 恢复记录中与事务不匹配的桶 ID，且不清理赢家", async (backend) => {
    const winnerTransactionId = "a".repeat(112) + "-winner";
    const loserTransactionId = "a".repeat(112) + "-loser";
    const legacyCollidingBucketId = "setup-" + "a".repeat(112);
    const winnerBase = backend === "s3"
      ? await makeEncryptedS3CatalogEntry(legacyCollidingBucketId, "赢家 S3 桶", "recovery-password")
      : await makeEncryptedLocalCatalogEntry(legacyCollidingBucketId, "赢家 Local 桶", "recovery-password");
    const winner = { ...winnerBase, configRevision: 1, snapshotRevision: 1 };
    const fixture = makeInitialSetupWorkerBridge({
      format: "keymaster.storage.catalog",
      version: 2,
      selectedBucketId: winner.bucketId,
      buckets: [winner],
    });
    __testSeedInitialSetupRecoveryRecord({
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId: loserTransactionId,
      bucketId: legacyCollidingBucketId,
      catalogEntryFingerprint: "c".repeat(64),
      configRevision: winner.configRevision,
      snapshotRevision: winner.snapshotRevision,
      backend,
      connectionFingerprint: "d".repeat(64),
      phase: "rollback",
      catalog: "committed",
      runtimeInstalled: false,
      cleanup: "unconfirmed",
      status: "failed",
      error: {
        title: "初始化失败",
        summary: "需要清理候选数据",
        action: "重试清理",
        code: "storage_provider_error",
        incidentId: "s3-collision-incident",
        transactionId: loserTransactionId,
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt: Date.now(),
    });
    const sentinelPath = `keymaster.bucket.${winner.bucketId}.candidate/winner-sentinel`;
    const sentinelValue = btoa("winner-sentinel");
    fixture.storage.setItem(sentinelPath, sentinelValue);
    const catalogBeforeCleanup = fixture.getCatalog();
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const response = await __testDispatchStorageControl({
      type: "initial-setup-cleanup",
      transactionId: loserTransactionId,
      password: "recovery-password",
      ...(backend === "s3" ? {
        connection: {
          kind: "s3" as const,
          endpoint: "https://objects.example.test",
          region: "us-east-1",
          bucket: "same-physical-target",
          accessKeyId: "access",
          secretAccessKey: "secret",
        },
      } : {}),
    });
    expect(response.operationResult).toMatchObject({
      status: "cleanup-required",
      error: { code: "storage_conflict" },
    });
    expect(fixture.events).not.toContain("delete");
    expect(fixture.getCatalog()).toEqual(catalogBeforeCleanup);
    expect(fixture.storage.getItem(sentinelPath)).toBe(sentinelValue);
    expect(__testInitialSetupBucketId(winnerTransactionId)).not.toBe(__testInitialSetupBucketId(loserTransactionId));
  });

  it("清理接口区分已成功初始化、已确认清理和仍需清理", async () => {
    const entry = await makeEncryptedLocalCatalogEntry("recovery-result-001", "恢复结果桶", "recovery-password");
    const fixture = makeInitialSetupWorkerBridge({
      format: "keymaster.storage.catalog",
      version: 2,
      selectedBucketId: entry.bucketId,
      buckets: [entry],
    });
    const succeeded = makeSucceededRecord(entry, "initial-setup-recovery-success-result-001");
    __testSeedInitialSetupRecoveryRecord(succeeded);
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const succeededResponse = await __testDispatchStorageControl({ type: "initial-setup-cleanup", transactionId: succeeded.transactionId });
    expect(succeededResponse.operationResult).toMatchObject({
      status: "setup-succeeded",
      result: { ok: true, bucket: entry, firstKey: { label: "恢复的主 Key" } },
    });

    const pending = {
      ...succeeded,
      transactionId: "initial-setup-recovery-pending-result-001",
      bucketId: __testInitialSetupBucketId("initial-setup-recovery-pending-result-001"),
      phase: "rollback" as const,
      catalog: "empty" as const,
      cleanup: "not-started" as const,
      status: "pending" as const,
    };
    delete pending.success;
    delete pending.error;
    __testSeedInitialSetupRecoveryRecord(pending);
    const cleanupResponse = await __testDispatchStorageControl({ type: "initial-setup-cleanup", transactionId: pending.transactionId, password: "recovery-password" });
    expect(cleanupResponse.operationResult).toEqual({ status: "cleanup-confirmed" });
  });

  it("真实账本校验下恢复清理先撤销目录引用，再删除候选对象", async () => {
    const entry = await makeEncryptedLocalCatalogEntry(__testInitialSetupBucketId("initial-setup-recovery-order-001"), "清理顺序桶", "recovery-password");
    const fixture = makeInitialSetupWorkerBridge({
      format: "keymaster.storage.catalog",
      version: 2,
      selectedBucketId: entry.bucketId,
      buckets: [entry],
    });
    const record = {
      ...makeSucceededRecord(entry, "initial-setup-recovery-order-001"),
      phase: "rollback" as const,
      status: "failed" as const,
      cleanup: "unconfirmed" as const,
      error: {
        title: "初始化失败",
        summary: "需要清理候选数据",
        action: "重试清理",
        code: "storage_provider_error",
        incidentId: "recovery-order-incident",
        transactionId: "initial-setup-recovery-order-001",
        diagnostic: "diagnostic",
        phase: "runtime" as const,
        rollback: "unconfirmed" as const,
      },
    } satisfies InitialSetupRecoveryRecordV1;
    delete record.success;
    __testSeedInitialSetupRecoveryRecord(record);
    fixture.storage.setItem(`keymaster.bucket.${entry.bucketId}.candidate`, btoa("candidate"));
    __testSetLocalStorageBridgeOverride(fixture.bridge);

    const response = await __testDispatchStorageControl({
      type: "initial-setup-cleanup",
      transactionId: record.transactionId,
      password: "recovery-password",
    });
    expect(response.operationResult).toEqual({ status: "cleanup-confirmed" });
    expect(fixture.events.indexOf("catalog-rollback")).toBeGreaterThanOrEqual(0);
    expect(fixture.events.indexOf("delete")).toBeGreaterThan(fixture.events.indexOf("catalog-rollback"));
    expect(fixture.getCatalog()).toEqual({ format: "keymaster.storage.catalog", version: 2, buckets: [] });
    expect(fixture.storage.length).toBe(0);
  });

  it("S3 恢复清理拒绝未匹配物理目标，不触碰候选对象", async () => {
    const transactionId = "initial-setup-recovery-s3-fingerprint-001";
    const fixture = makeInitialSetupWorkerBridge();
    __testSeedInitialSetupRecoveryRecord({
      format: "keymaster.storage.initial-setup-recovery",
      version: 1,
      transactionId,
      bucketId: "recovery-s3-fingerprint-001",
      catalogEntryFingerprint: "b".repeat(64),
      configRevision: 1,
      snapshotRevision: 0,
      backend: "s3",
      connectionFingerprint: "a".repeat(64),
      phase: "rollback",
      catalog: "empty",
      runtimeInstalled: false,
      cleanup: "unconfirmed",
      status: "failed",
      error: {
        title: "初始化失败",
        summary: "需要清理候选数据",
        action: "重试清理",
        code: "storage_provider_error",
        incidentId: "s3-fingerprint-incident",
        transactionId,
        diagnostic: "diagnostic",
        phase: "rollback",
        rollback: "unconfirmed",
      },
      updatedAt: Date.now(),
    });
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    const response = await __testDispatchStorageControl({
      type: "initial-setup-cleanup",
      transactionId,
      connection: {
        kind: "s3",
        endpoint: "https://objects.example.test",
        region: "us-east-1",
        bucket: "different-bucket",
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
    });
    expect(response.operationResult).toMatchObject({ status: "cleanup-required", error: { code: "storage_conflict" } });
    expect(fixture.events).not.toContain("delete");
  });

});

// ============================================================
// Backup Import Tests (生产执行路径)
// ============================================================

const TEST_PRIV_2 = "0000000000000000000000000000000000000000000000000000000000000002";
const TEST_PRIV_3 = "0000000000000000000000000000000000000000000000000000000000000003";

describe("Session Coordinator backup import", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("cross-vault import succeeds with different passwords", async () => {
    const sourceResult = await __testCreateVault("source-pw", { label: "source-key" });
    const backup = await __testExportKeyBackup(sourceResult.publicKeyHex!);

    // A second Vault must be a fresh persistent store, rather than merely a
    // reset Worker session over the source Vault's platform K-V records.
    await __testDeleteVault();
    __testResetState();
    await __testCreateVault("target-pw", { label: "target-key" });
    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(imported.publicKeyHex).toBe(sourceResult.publicKeyHex);

    const targetMeta = await __testGetVaultAuthMetadata();
    const targetRecord = await __testGetVaultKeyIndex(imported.publicKeyHex);
    expect(targetMeta).toBeDefined();
    expect(targetRecord).toBeDefined();
    await __testLock();
    const unlocked = await __testUnlock("target-pw", imported.publicKeyHex);
    expect(unlocked.ack.status).toBe("accepted");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
  }, 15_000);

  it("rejects wrong source password without writing any key", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(backup, "wrong-source-pw", "target-pw")).rejects.toThrow(/record authentication failed/);
    expect(await __testListVaultKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("locked");
  });

  it("rejects wrong target password without writing any key", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(backup, "source-pw", "wrong-target-pw")).rejects.toThrow(/Invalid password/);
    expect(await __testListVaultKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("locked");
  });

  it("rejects backup with mismatched public key and material", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    const parsed = JSON.parse(backup) as Record<string, unknown>;
    const tamperedPublicKeyHex = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true));
    parsed.publicKeyHex = tamperedPublicKeyHex;
    const tamperedBackup = JSON.stringify(parsed);

    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    await expect(__testImportKeyBackup(tamperedBackup, "source-pw", "target-pw")).rejects.toThrow();
    expect(await __testListVaultKeys()).toHaveLength(0);
  });

  it("rejects duplicate key import with Key already exists", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");
    const first = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    const original = await __testGetVaultKeyIndex(first.publicKeyHex);

    await expect(__testImportKeyBackup(backup, "source-pw", "target-pw")).rejects.toThrow("Key already exists");
    expect(await __testListVaultKeys()).toHaveLength(1);
    expect(await __testGetVaultKeyIndex(first.publicKeyHex)).toEqual(original);
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
  });

  it("imports the first key into a locked empty Vault and activates it after unlock", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();
    await __testCreateEmptyVault("target-pw");

    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(await __testListVaultKeys()).toHaveLength(1);
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();

    const unlocked = await __testUnlock("target-pw");
    expect(unlocked.ack.status).toBe("accepted");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
  }, 15_000);

  it("activates the first key in an unlocked Vault and broadcasts it to every tab", async () => {
    const source = await __testCreateVault("source-pw");
    const backup = await __testExportKeyBackup(source.publicKeyHex!);
    await __testDeleteVault();
    __testResetState();

    const a = attachTestPort("import-a");
    const b = attachTestPort("import-b");
    a.send({ kind: "subscribe", clientId: "import-a", requestId: "subscribe-a", topics: ["session.state"] });
    b.send({ kind: "subscribe", clientId: "import-b", requestId: "subscribe-b", topics: ["session.state"] });
    await flush();
    a.messages.length = 0;
    b.messages.length = 0;

    const placeholder = await __testCreateVault("target-pw", { label: "placeholder" });
    // Model an unlocked empty Vault without forging session crypto state: remove
    // the only persisted key while retaining the real unlocked target session.
    await __testClearVaultHold("target-pw");
    expect(await __testListVaultKeys()).toHaveLength(0);
    expect(__testGetVaultStatus()).toBe("unlocked");

    const imported = await __testImportKeyBackup(backup, "source-pw", "target-pw");
    expect(__testGetActivePublicKeyHex()).toBe(imported.publicKeyHex);
    for (const port of [a, b]) {
      expect(port.messages).toContainEqual(expect.objectContaining({
        type: "session.state.changed",
        activePublicKeyHex: imported.publicKeyHex,
      }));
    }
  }, 15_000);
});

describe("Session Coordinator locked deletion and cold export", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("recovers a legacy empty Vault to the uninitialized state", async () => {
    await __testCreateEmptyVault("pw");
    const result = await __testUnlock("pw");
    expect(result.ack.status).toBe("accepted");
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    expect(await __testGetVaultAuthMetadata()).toBeUndefined();
  });

  it("classifies a legacy empty Vault as uninitialized after a worker restart", async () => {
    await __testCreateEmptyVault("pw");
    await __testRestartWorker();
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(await __testGetVaultAuthMetadata()).toBeUndefined();
  });

  it("cold-exports the encrypted Hold record while locked", async () => {
    const key = await __testCreateVault("pw");
    await __testLock();
    const backup = await __testExportCurrentKeyBackup();
    expect(Object.keys(JSON.parse(backup)).sort()).toEqual(["address", "capabilities", "createdAt", "format", "key", "keyDerivation", "keyFormat", "label", "network", "publicKeyHex", "version"]);
    expect(JSON.parse(backup)).toMatchObject({ format: "keymaster.storage.catalog-key-backup", version: 1 });
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    expect(key.publicKeyHex).toBeDefined();
  });

  it("new and hex-imported records keep private material out of the public index", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    for (const key of [first, second]) {
      const index = await __testGetVaultKeyIndex(key.publicKeyHex!);
      expect(index).toBeDefined();
      expect(index).not.toHaveProperty("cipher");
      expect(index).not.toHaveProperty("privateKey");
    }
  }, 15_000);

  it("rolls back active bytes and selected state when active metadata persistence fails", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    __testFailNextCoordinatorSnapshotPersist();
    await expect(__testSetActive(first.publicKeyHex!)).rejects.toThrow("injected coordinator snapshot persist failure");
    expect(__testGetActivePublicKeyHex()).toBe(second.publicKeyHex);
    expect(__testGetSnapshot().selectedPublicKeyHex).toBe(second.publicKeyHex);
  });

  it("deletes selected material while locked and repairs selection to the remaining key", async () => {
    const first = await __testCreateVault("pw", { label: "first" });
    const second = await __testImportPrivateKey("pw", { label: "second", material: { hex: TEST_PRIV_2 }, format: "hex", capabilities: ["p2pkh"] });
    await __testLock();
    await __testDeleteKeyMaterial(second.publicKeyHex, "pw");
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    expect(snapshot.activePublicKeyHex).toBeUndefined();
    expect(snapshot.selectedPublicKeyHex).toBe(first.publicKeyHex);
  });

  it("releases a Delete claim when bucket authentication fails before Hold publication", async () => {
    const key = await __testCreateVault("pw", { label: "delete-auth" });
    await __testLock();

    await expect(__testDeleteKeyMaterial(key.publicKeyHex!, "wrong-password")).rejects.toThrow("Invalid password");
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
    expect(await __testListVaultKeys()).toEqual([
      expect.objectContaining({ publicKeyHex: key.publicKeyHex }),
    ]);
  });

  it("recovers a prepared deletion after Hold commit and Journal failure across worker restart", async () => {
    const key = await __testCreateVault("pw", { label: "crash-delete" });
    await __testLock();
    __testFailKeyLifecycleJournalAfterHold();

    await expect(__testDeleteKeyMaterial(key.publicKeyHex!, "pw"))
      .rejects.toThrow("injected key lifecycle Journal persist failure");
    expect(await __testListKeyLifecycleJournals()).toEqual([
      expect.objectContaining({ publicKeyHex: key.publicKeyHex, phase: "prepared" }),
    ]);
    expect(await __testListVaultKeys()).toHaveLength(0);

    // __testRestartWorker follows the production order: Journal recovery runs
    // before an empty public index can make the Vault look uninitialized.
    await __testRestartWorker();
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
    expect(await __testListVaultKeys()).toHaveLength(0);
    expect(await __testGetVaultAuthMetadata()).toBeUndefined();
    expect(__testGetVaultStatus()).toBe("uninitialized");
  }, 15_000);

  it("keeps initial auth metadata and fails closed when new Key rollback is unconfirmed", async () => {
    __testFailNextOwnerStorageActivation();
    __testFailNextHoldRollbackCas();

    await expect(__testCreateVault("pw", { label: "rollback-unconfirmed" }))
      .rejects.toThrow(/rollback-unconfirmed/);

    // The new encrypted Key may still be present in Hold/index.  Keeping the
    // verifier is what makes the degraded state recoverable instead of
    // destroying the only authentication route.
    expect(await __testGetVaultAuthMetadata()).toBeDefined();
    expect(await __testListVaultKeys()).toHaveLength(1);
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
  }, 15_000);

  it("recovers an orphaned new-Key owner namespace after Hold rollback and worker restart", async () => {
    const first = await __testCreateVault("pw", { label: "existing" });
    __testMaterializeNextOwnerStorageActivation();
    __testFailAfterOwnerStorageActivation();
    __testFailNextOwnerStorageDeletion();

    await expect(__testImportPrivateKey("pw", {
      label: "rollback-owner-cleanup",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    })).rejects.toThrow(/rollback-unconfirmed/);

    const orphan = (await __testListKeyLifecycleJournals()).find((journal) => journal.publicKeyHex !== first.publicKeyHex);
    expect(orphan).toEqual(expect.objectContaining({ operation: "add", phase: "hold-committed" }));
    expect(__testOwnerStorageNamespaceExists(orphan!.publicKeyHex)).toBe(true);
    expect(await __testListVaultKeys()).toHaveLength(1);

    await __testRestartWorker();

    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
    expect(__testOwnerStorageNamespaceExists(orphan!.publicKeyHex)).toBe(false);
    expect(await __testListVaultKeys()).toEqual([expect.objectContaining({ publicKeyHex: first.publicKeyHex })]);
  }, 15_000);

  it("finalizes the last material deletion exactly once to uninitialized", async () => {
    const key = await __testCreateVault("pw");
    await __testLock();
    await __testDeleteKeyMaterial(key.publicKeyHex!, "pw");
    // 删除事务本身已完成最后一把 Key 的 Vault meta 清理，状态直接收敛
    // 到 uninitialized；旧的显式 finalize 入口仍保持幂等。
    expect(__testGetVaultStatus()).toBe("uninitialized");
    await __testFinalizeEmptyVaultAfterLastKeyDeletion();
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(await __testGetVaultAuthMetadata()).toBeUndefined();
    expect(await __testListVaultKeys()).toHaveLength(0);
  });

});

describe("Catalog Hold lifecycle CAS", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testReleaseCatalogLocalBinding();
    await __testDeleteVault();
    __testResetState();
  });

  it("rejects an add based on a stale Hold snapshot instead of overwriting the concurrent key", async () => {
    const password = "catalog-cas-password";
    const current = await makeEncryptedLocalCatalogEntry("catalog-cas-current", "CAS 当前桶", password);
    const target = await makeEncryptedLocalCatalogEntry("catalog-cas-target", "CAS 目标桶", password);
    const fixture = makeCatalogBridgeFixture(current, target);
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    await __testInstallCatalogLocalBinding(current);
    await __testCreateEmptyVault(password);

    const barrier = __testBlockNextCatalogHoldPublish();
    const staleAdd = __testImportPrivateKey(password, {
      label: "stale-add",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await barrier.entered;

    const concurrent = await __testImportPrivateKey(password, {
      label: "concurrent-add",
      material: { hex: TEST_PRIV_3 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    barrier.release();

    await expect(staleAdd).rejects.toMatchObject({ code: "storage_conflict" });
    expect(await __testListVaultKeys()).toEqual([
      expect.objectContaining({ publicKeyHex: concurrent.publicKeyHex, label: "concurrent-add" }),
    ]);
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
  }, 20_000);

  it("rejects a first empty-Hold publish when another creator wins the absent-Head CAS", async () => {
    const password = "catalog-absent-cas-password";
    const current = await makeEncryptedLocalCatalogEntry("catalog-absent-cas-current", "CAS 首次桶", password);
    const target = await makeEncryptedLocalCatalogEntry("catalog-absent-cas-target", "CAS 首次目标桶", password);
    const fixture = makeCatalogBridgeFixture(current, target);
    __testSetLocalStorageBridgeOverride(fixture.bridge);
    await __testInstallCatalogLocalBinding(current);

    const barrier = __testBlockNextCatalogHoldPublish();
    const staleCreator = __testCreateVault(password, { label: "stale-first-key" });
    await barrier.entered;

    const winner = await __testCreateVault(password, { label: "winner-first-key" });
    barrier.release();

    await expect(staleCreator).rejects.toMatchObject({ code: "storage_conflict" });
    expect(await __testListVaultKeys()).toEqual([
      expect.objectContaining({ publicKeyHex: winner.publicKeyHex, label: "winner-first-key" }),
    ]);
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
  }, 20_000);

  it("does not let a failed Hold rollback overwrite a newer concurrent Head", async () => {
    const first = await __testCreateVault("pw", { label: "existing" });
    __testMaterializeNextOwnerStorageActivation();
    __testFailAfterOwnerStorageActivation();
    const rollbackBarrier = __testBlockNextCatalogHoldRollback();
    const failedAdd = __testImportPrivateKey("pw", {
      label: "rollback-race",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await rollbackBarrier.entered;

    const concurrent = await __testImportPrivateKey("pw", {
      label: "concurrent-after-publish",
      material: { hex: TEST_PRIV_3 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    rollbackBarrier.release();

    await expect(failedAdd).rejects.toThrow(/rollback-unconfirmed/);
    expect(await __testListVaultKeys()).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicKeyHex: first.publicKeyHex, label: "existing" }),
      expect.objectContaining({ publicKeyHex: concurrent.publicKeyHex, label: "concurrent-after-publish" }),
    ]));
    expect(await __testListKeyLifecycleJournals()).toEqual([
      expect.objectContaining({ operation: "add", phase: "hold-committed" }),
    ]);
  }, 20_000);

  it("blocks same-key Delete while Add has committed Hold but not Owner activation", async () => {
    const first = await __testCreateVault("pw", { label: "existing" });
    __testMaterializeNextOwnerStorageActivation();
    const owner = bytesToHex(secp256k1.getPublicKey(hexToBytes(TEST_PRIV_2), true));
    const ownerBarrier = __testBlockNextKeyLifecycleOwnerSideEffect();
    const adding = __testImportPrivateKey("pw", {
      label: "lifecycle-add",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await ownerBarrier.entered;

    const deleting = __testDeleteKeyMaterial(owner, "pw");
    await expect(deleting).rejects.toMatchObject({ code: "storage_conflict" });
    ownerBarrier.release();

    await expect(adding).resolves.toEqual(expect.objectContaining({ publicKeyHex: owner }));
    expect(await __testListVaultKeys()).toEqual(expect.arrayContaining([
      expect.objectContaining({ publicKeyHex: first.publicKeyHex }),
      expect.objectContaining({ publicKeyHex: owner, label: "lifecycle-add" }),
    ]));
    expect(__testOwnerStorageNamespaceExists(owner)).toBe(true);
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
  }, 20_000);

  it("blocks same-key Add while Delete has committed Hold but not Owner deletion", async () => {
    await __testCreateVault("pw", { label: "existing" });
    __testMaterializeNextOwnerStorageActivation();
    const target = await __testImportPrivateKey("pw", {
      label: "lifecycle-delete",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    const owner = target.publicKeyHex;
    expect(__testOwnerStorageNamespaceExists(owner)).toBe(true);

    const ownerBarrier = __testBlockNextKeyLifecycleOwnerSideEffect();
    const deleting = __testDeleteKeyMaterial(owner, "pw");
    await ownerBarrier.entered;

    const readding = __testImportPrivateKey("pw", {
      label: "lifecycle-readd",
      material: { hex: TEST_PRIV_2 },
      format: "hex",
      capabilities: ["p2pkh"],
    });
    await expect(readding).rejects.toMatchObject({ code: "storage_conflict" });
    ownerBarrier.release();

    await expect(deleting).resolves.toBeUndefined();
    expect(await __testListVaultKeys()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ publicKeyHex: owner }),
    ]));
    expect(__testOwnerStorageNamespaceExists(owner)).toBe(false);
    expect(await __testListKeyLifecycleJournals()).toHaveLength(0);
  }, 20_000);
});

describe("Coordinator K-V GC registry enumeration", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  it("reopens a bucket namespace from central declarations after its handle is closed", async () => {
    const orphanPath = await __testSeedCoordinatorKeyValueGarbage("bucket");
    expect(__testCoordinatorKeyValueObjectExists(orphanPath)).toBe(true);

    await __testCollectCoordinatorKeyValueGarbage();

    expect(__testCoordinatorKeyValueObjectExists(orphanPath)).toBe(false);
  });

  it("reopens the current Owner built-in namespace from central declarations after its handle is closed", async () => {
    await __testCreateVault("pw", { label: "gc-owner" });
    const orphanPath = await __testSeedCoordinatorKeyValueGarbage("owner");
    expect(__testCoordinatorKeyValueObjectExists(orphanPath)).toBe(true);

    await __testCollectCoordinatorKeyValueGarbage();

    expect(__testCoordinatorKeyValueObjectExists(orphanPath)).toBe(false);
  });
});

// 预生成 PeerId 向量（由 @libp2p/peer-id 派生，避免 apps/web 引入 libp2p 依赖）。
const SUPPLIER_PEER_IDS = new Map<string, string>([
  ["02352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5", "16Uiu2HAky1EH6J1p6jLjseMf5AtAMn3GLwYbcYaK7dH9T1F9XF56"],
  ["03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc", "16Uiu2HAmH771Jxhe2diA2zAtPYNqfABsk5aaJ51cp99LhadN6waK"]
]);

function SUPPLIER_PEER_ID_FOR(publicKeyHex: string): string {
  const peerId = SUPPLIER_PEER_IDS.get(publicKeyHex);
  if (!peerId) throw new Error(`missing precomputed peer id for ${publicKeyHex}`);
  return peerId;
}

describe("Window P2P executor lease 与受限 signer（施工单 001 §3.1–3.2）", () => {
  beforeEach(async () => {
    await __testDeleteVault();
    __testResetState();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testDeleteVault();
    __testResetState();
  });

  async function unlockForSpike(): Promise<{ epoch: string; owner: string }> {
    const created = await __testCreateVault("spike-pw", { label: "executor-key" });
    expect(created.publicKeyHex).toBeTruthy();
    const owner = created.publicKeyHex!;
    const unlockedResponse = await __testUnlock("spike-pw", owner);
    expect(["accepted", "ok", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return { epoch: __testGetSnapshot().sessionEpoch, owner };
  }

  function noiseStaticPublicKey(fill = 7): ArrayBuffer {
    return new Uint8Array(32).fill(fill).buffer;
  }

  it("A04: two tabs competing for the same epoch yields exactly one lease", async () => {
    const { owner } = await unlockForSpike();
    const first = await __testAcquireExecutorLease(owner, "port-a");
    expect(first.ack.status).toBe("ok");
    const second = await __testAcquireExecutorLease(owner, "port-b");
    expect(second.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    // 同 port 幂等续租返回同一 leaseId。
    const again = await __testAcquireExecutorLease(owner, "port-a");
    expect((again.operationResult as { leaseId: string }).leaseId)
      .toBe((first.operationResult as { leaseId: string }).leaseId);
  });

  it("A06: charges inbound SSP Wire against the Worker bridge and releases it", () => {
    __testResetState();
    const result = __testWindowP2pInboundBridgePressure({ attempts: 64, wireBytes: 1024 * 1024 });
    // 64 次 1MiB 尝试不能突破 32MiB Worker bridge 上限；被拒绝的
    // reservation 不能进入 handler，已接受的项全部释放后计数归零。
    expect(result.accepted).toBe(32);
    expect(result.rejected).toBe(32);
    expect(result.peakBytes).toBe(32 * 1024 * 1024);
    expect(result.peakItems).toBe(32);
    expect(result.releasedBytes).toBe(0);
    expect(result.releasedItems).toBe(0);

    const itemLimited = __testWindowP2pInboundBridgePressure({ attempts: 300, wireBytes: 1 });
    expect(itemLimited.accepted).toBe(256);
    expect(itemLimited.rejected).toBe(44);
    expect(itemLimited.peakItems).toBe(256);
    expect(itemLimited.releasedItems).toBe(0);
  });

  it("A06: reserves the maximum SSP response before admitting small requests", async () => {
    __testResetState();
    const result = await __testWindowP2pResponseBridgePressure({ attempts: 256, requestBytes: 1 });
    // 每项至少占用 1 byte request + 1MiB response；256 个小请求只能
    // 排队，实际在途字节始终不超过 32MiB。
    expect(result.accepted).toBe(31);
    expect(result.queued).toBe(225);
    expect(result.peakBytes).toBe(31 * (1 + 1024 * 1024));
    expect(result.peakBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(result.peakItems).toBe(256);
    expect(result.releasedBytes).toBe(0);
    expect(result.releasedItems).toBe(0);
  });

  it("A05: stale lease id / wrong port signer requests are rejected", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    // 伪造 port。
    const forgedPort = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-forged");
    expect(forgedPort.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });

    // 正确 port 成功并返回签名。
    const good = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(good.ack.status).toBe("ok");
    expect((good.operationResult as { signatureDer: ArrayBuffer }).signatureDer.byteLength).toBeGreaterThan(0);

    // 显式释放后旧 leaseId 重放被拒（A05）。
    await __testReleaseExecutorLease(lease.leaseId, "port-a");
    const replay = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(replay.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("A03: typed signer inputs and Peer Record invariants are enforced by the worker", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };
    const shortNoiseKey = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: new Uint8Array(31).buffer }, "port-a");
    expect(shortNoiseKey.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });

    const peerId = peerIdFromPublicKeyBytes(hexToBytes(owner)).toString();
    const nonEmptyAddresses = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: ["/ip4/127.0.0.1/tcp/1"], sequence: "0" }, "port-a");
    expect(nonEmptyAddresses.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const wrongPeerId = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId: "16Uiu2HAmH4VY9jMZ2fG4N7aQZ6uHh5mS5jQxZ3Yy1h1nH7qVY6r", addresses: [], sequence: "0" }, "port-a");
    expect(wrongPeerId.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const valid = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "7" }, "port-a");
    expect(valid.ack.status).toBe("ok");
    const decreasing = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "6" }, "port-a");
    expect(decreasing.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const overflow = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "18446744073709551616" }, "port-a");
    expect(overflow.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("A06: lock invalidates the lease; queued signer requests fail after re-unlock", async () => {
    const { epoch } = await unlockForSpike();
    const owner = __testGetSnapshot().activePublicKeyHex!;
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    await __testLock();
    const duringLock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(duringLock.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    void epoch;

    await __testUnlock("spike-pw");
    const afterReunlock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    // lock 清空了 lease：旧 leaseId 在新会话中不可复活。
    expect(afterReunlock.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("B11: importing a key into an unlocked Vault revokes the old Window P2P lease immediately", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const oldLease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    const imported = await __testImportPrivateKey("spike-pw", {
      label: "switched-owner",
      material: { hex: "2".padStart(64, "0") },
      format: "hex",
      capabilities: ["p2pkh"],
      source: "test",
    });
    expect(imported.publicKeyHex).not.toBe(owner);
    expect(__testGetSnapshot().activePublicKeyHex).toBe(imported.publicKeyHex);

    const replay = await __testExecutorSignNoise({
      leaseId: oldLease.leaseId,
      expectedSessionEpoch: oldLease.sessionEpoch,
      noiseStaticPublicKey: noiseStaticPublicKey(),
    }, "port-a");
    expect(replay.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const replacement = await __testAcquireExecutorLease(imported.publicKeyHex, "port-a");
    expect(replacement.ack.status).toBe("ok");
  });
});

describe("Sat 入站 handler 资源闭环（施工单 2026-09-02/002）", () => {
  beforeEach(() => {
    __testResetState();
  });

  afterEach(() => {
    __testSetSatInboundResponseDispatcher(undefined);
    __testResetState();
  });

  it("C01: never-settling handler 被取消后保留 slot，直到 Promise settle", async () => {
    let settle!: () => void;
    const completion = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([1]));
    });
    const task = __testStartSatInboundHandler({ handler: async () => completion });
    expect(task.accepted).toBe(true);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 0, bridgeItems: 1 });

    expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    expect(task.signal?.aborted).toBe(true);
    // 取消只释放 Wire 额度，不能伪造 Promise 已经结束。
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 1, bridgeBytes: 0, bridgeItems: 0 });

    settle();
    await task.completion;
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C02: canceled handler 的迟到成功不会回写 ActionResult", async () => {
    const writer = vi.fn(async () => undefined);
    __testSetSatInboundResponseDispatcher(writer);
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([2]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    settle();
    await task.completion;
    expect(writer).not.toHaveBeenCalled();
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 0, bridgeBytes: 0, bridgeItems: 0 });
  });

  it("C03: lease revoke 会 abort 所有仍在等待的入站任务", async () => {
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([3]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    __testRevokeWindowP2pExecutorLease();
    expect(task.signal?.aborted).toBe(true);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 1, bridgeBytes: 0, bridgeItems: 0 });

    settle();
    await task.completion;
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C04: Supplier generation 变化后丢弃迟到成功", async () => {
    const writer = vi.fn(async () => undefined);
    __testSetSatInboundResponseDispatcher(writer);
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([4]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    expect(__testChangeSatInboundGeneration(task.connectionId, 2)).toBe(true);
    settle();
    await task.completion;
    expect(writer).not.toHaveBeenCalled();
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C05: 64 个 active handler 后第 65 个 fail closed，取消后仍要等 settle 才回收", async () => {
    const releases: Array<() => void> = [];
    const tasks: Array<ReturnType<typeof __testStartSatInboundHandler>> = [];
    for (let index = 0; index < 65; index += 1) {
      let release!: () => void;
      const response = new Promise<Uint8Array>((resolve) => {
        release = () => resolve(new Uint8Array([index & 0xff]));
      });
      releases.push(release);
      tasks.push(__testStartSatInboundHandler({
        eventId: `c05-event-${index}`,
        connectionId: `c05-connection-${index}`,
        handler: async () => response,
      }));
    }
    expect(tasks.filter((task) => task.accepted)).toHaveLength(64);
    expect(tasks[64]?.accepted).toBe(false);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 64, maxActive: 64, bridgeItems: 64 });

    for (const task of tasks.slice(0, 64)) {
      expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    }
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 64, canceled: 64, bridgeBytes: 0, bridgeItems: 0 });

    for (const release of releases) release();
    await Promise.all(tasks.slice(0, 64).map((task) => task.completion));
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });
});

describe("Session Coordinator MSFile RPC lane", () => {
  const identity = {
    version: 1 as const,
    publisherPublicKeyHex: "03" + "ab".repeat(32),
    appId: "player.example",
    appName: "Player",
    identityDigestHex: "aa".repeat(32)
  };
  const ownerPublicKeyHex = validPublisherKey(9);

  beforeEach(async () => {
    await __testDeleteVault();
    await __testClearCentralNamespace("MSFile");
    __testResetState();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testDeleteVault();
    await __testClearCentralNamespace("MSFile");
    __testResetState();
  });

  async function unlockVault(): Promise<string> {
    const created = await __testCreateVault("vault-pw", { label: "msfile-key" });
    expect(created.publicKeyHex).toBeTruthy();
    // createVaultWithInitialKey 可能直接进入 unlocked（already-unlocked 亦视为就绪）。
    const unlockedResponse = await __testUnlock("vault-pw", created.publicKeyHex);
    expect(["ok", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return __testGetSnapshot().sessionEpoch;
  }

  it("rejects all data/control/grant traffic while the Vault is locked（审查修复）", async () => {
    // 全新状态：未创建 / 未解锁。
    __testResetState();
    const lockedControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(lockedControl.ack).toMatchObject({ status: "locked" });
    const lockedData = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(lockedData.ack).toMatchObject({ status: "locked" });
    const lockedGrant = await __testDispatchMsfileGrant({
      connectSessionId: "s", transportOrigin: "https://app.example", ownerPublicKeyHex, appIdentity: identity
    }, "port-a");
    expect(lockedGrant.ack).toMatchObject({ status: "locked" });

    // session.abort 是纯清理：锁定态仍返回 ok 且不重建 runtime。
    const abortWhileLocked = await __testDispatchMsfileSessionAbort("s", __testGetSnapshot().sessionEpoch, "port-a");
    expect(abortWhileLocked.ack).toMatchObject({ status: "ok" });

    // 解锁后同一控制面请求成功。
    const epoch = await unlockVault();
    const okControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(okControl.ack.status).toBe("ok");
    void epoch;
  });

  it("enforces the session epoch fence on the msfile lane（审查修复）", async () => {
    // 记录解锁前的 epoch；创建 Vault 会推进 epoch。
    __testResetState();
    const epochBefore = __testGetSnapshot().sessionEpoch;
    await unlockVault();
    const stale = await __testDispatchMsfileControlWithEpoch({ type: "settings.get" }, epochBefore);
    // 携带旧 epoch 的 control 必须被判 stale，而不是进入执行。
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 当前 epoch 正常放行。
    const fresh = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(fresh.ack.status).toBe("ok");
  });

  it("routes control-plane settings through the coordinator", async () => {
    await unlockVault();
    const saved = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" } });
    expect(saved.ack.status).toBe("ok");
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect(snapshot.operationResult).toMatchObject({
      globalSettings: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" }
    });
  });

  it("waits on full global slots and rotates clients fairly", async () => {
    await unlockVault();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const active = { value: 0 };
    __testSetMsfileReadConcurrencySettings({
      mediaBlockReadConcurrency: 1,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 1,
      globalStatConcurrency: 1,
    });
    __testSetMsfileRuntimeOverride({
      stat: vi.fn(async ({ seedHashHex }: { seedHashHex: string }) => {
        active.value += 1;
        started.push(seedHashHex);
        try {
          await new Promise<void>((resolve) => releases.set(seedHashHex, resolve));
          return { seedHashHex, suppliers: [] };
        } finally {
          active.value -= 1;
        }
      }),
      describeState: () => ({
        status: "ready",
        supplierGeneration: 0,
        globalSettings: null,
        mediaBlockReadConcurrency: 1,
        globalSeedReadConcurrency: 1,
        globalBlockReadConcurrency: 1,
        globalStatConcurrency: 1,
        pendingApprovals: [],
      }),
    } as never);

    const firstHash = "aa".repeat(32);
    const playerQueuedHash = "bb".repeat(32);
    const appQueuedHash = "cc".repeat(32);
    const first = __testDispatchMsfileData({ type: "stat", seedHashHex: firstHash }, "player");
    await vi.waitFor(() => expect(started).toEqual([firstHash]));
    const playerQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: playerQueuedHash }, "player");
    const appQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: appQueuedHash }, "connect-app");
    await Promise.resolve();
    expect(active.value).toBe(1);
    expect(started).toEqual([firstHash]);

    releases.get(firstHash)!();
    await first;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash]));
    expect(active.value).toBe(1);
    releases.get(appQueuedHash)!();
    await appQueued;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash, playerQueuedHash]));
    releases.get(playerQueuedHash)!();
    await playerQueued;
  });

  it("rejects non-canonical amounts with a validation error", async () => {
    await unlockVault();
    const bad = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "01", blockMaxPriceSatoshis: "5" } });
    expect(bad.ack.status).toBe("error");
  });

  it("serializes control mutations so identical generations cannot both commit（审查修复）", async () => {
    await unlockVault();
    const supplierA = validPublisherKey(21);
    const supplierB = validPublisherKey(22);
    // 两个端口携带相同 expectedGeneration=0 并发 upsert：
    // 串行化后第二个任务内的世代检查必须失败，而不是双双通过。
    const [first, second] = await Promise.all([
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "a", supplierPublicKeyHex: supplierA, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierA)}`], enabled: true }, expectedGeneration: 0 }),
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "b", supplierPublicKeyHex: supplierB, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierB)}`], enabled: true }, expectedGeneration: 0 })
    ]);
    const outcomes = [first.ack.status, second.ack.status].sort();
    expect(outcomes).toEqual(["ok", "validation-error"]);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect((snapshot.operationResult as { suppliers: unknown[] }).suppliers).toHaveLength(1);
  });

  it("rejects mutations queued before a lock/unlock cycle with stale-epoch and leaves the DB untouched（审查修复）", async () => {
    const epochAtEnqueue = await unlockVault();
    // 用可悬挂的 stub runtime 阻塞串行尾，构造真实排队窗口。
    let releaseHead!: (value?: unknown) => void;
    const headGate = new Promise<unknown>((resolve) => { releaseHead = resolve; });
    __testSetMsfileRuntimeOverride({
      updateGlobalPriceSettings: () => headGate,
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] })
    } as never);

    // A：占据串行尾（挂起）。
    const headPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "1", blockMaxPriceSatoshis: "1" } });
    // B：以**当时有效**的 epoch 入队——排在 A 之后。
    const queuedPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "2", blockMaxPriceSatoshis: "2" } });

    // B 尚未开始执行：先等一拍确保它已入队。
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 排队期间 lock → unlock：epoch 推进两次。
    await __testLock();
    const relocked = await __testUnlock("vault-pw");
    expect(["accepted", "ok", "already-unlocked"]).toContain(relocked.ack.status);

    // 释放 A；随后 B 才真正开始执行。
    releaseHead();
    const headResult = await headPromise;
    // A 的提交跨越了 lock/unlock 栅栏：即使写入发生也不得报告为成功。
    expect(headResult.ack).toMatchObject({ status: "stale-epoch" });

    const queuedResult = await queuedPromise;
    // B 携带入队时的 epoch，执行时已是新会话 → 任务开始时即被拒。
    expect(queuedResult.ack).toMatchObject({ status: "stale-epoch" });
    void epochAtEnqueue;

    // DB 未被 B 修改：重建真实 runtime 后设置仍为空。
    __testSetMsfileRuntimeOverride(undefined);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("keeps mutation results stale-epoch when lock lands mid-queue（审查修复）", async () => {
    await unlockVault();
    // 以不存在的旧 epoch 发起 mutation：入口栅栏直接拦截，
    // 等价于“排队期间发生 lock/key switch”的最终形态。
    const stale = await __testDispatchMsfileControlWithEpoch(
      { type: "settings.global.update", input: { seedMaxPriceSatoshis: "9", blockMaxPriceSatoshis: "9" } },
      "epoch-that-no-longer-exists"
    );
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 未写入：设置保持为空。
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("rejects grants whose session lookup spans a lock/unlock cycle（审查修复）", async () => {
    await unlockVault();
    const epochAtEnqueue = __testGetSnapshot().sessionEpoch;
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);

    const pendingGrant = __testDispatchMsfileGrant({
      connectSessionId: "session-gated",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-a", epochAtEnqueue);

    await new Promise((resolve) => setTimeout(resolve, 10));
    // resolver 挂起期间 lock → unlock：epoch 推进。
    await __testLock();
    await __testUnlock("vault-pw");

    releaseResolver({ sessionId: "session-gated", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingGrant;
    expect(result.ack).toMatchObject({ status: "stale-epoch" });
  });

  it("never reaches the service when an existing grant spans a lock/unlock during session lookup（第五轮审查修复）", async () => {
    const epoch = await unlockVault();
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 用 spy stub 替换 runtime：任何 service 调用都会被记录。
    const readSeedSpy = vi.fn(async () => { throw new Error("must not be called"); });
    __testSetMsfileRuntimeOverride({
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] }),
      connect: { stat: vi.fn(), readSeed: readSeedSpy, readBlock: vi.fn() }
    } as never);

    // 让 authoritative session 查询悬挂，期间 lock → unlock。
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);
    const pendingRead = __testDispatchMsfileData({ type: "read-seed", grantId, supplierPublicKeyHex: identity.publisherPublicKeyHex, seedHashHex: "ab".repeat(32) }, "port-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testLock();
    await __testUnlock("vault-pw");

    // 释放后：grant 已随 lock 清空 → 拒绝且 service 从未被调用。
    releaseResolver({ sessionId: "session-msfile", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingRead;
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
    expect(readSeedSpy).not.toHaveBeenCalled();
    void epoch;
  });

  it("refuses to bind a grant when the session owner is not the active runtime owner（审查修复）", async () => {
    await unlockVault();
    const otherOwner = validPublisherKey(31);
    __testSetStorageSessionResolver(async () => ({
      sessionId: "session-owner-mismatch",
      origin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity,
      revokedAt: null
    }));
    const result = await __testDispatchMsfileGrant({
      connectSessionId: "session-owner-mismatch",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity
    }, "port-a");
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });

  it("grants connect data access only for authoritative sessions and fails forged grants", async () => {
    await unlockVault();
    // 审查修复后 grant 要求 session owner === active runtime owner。
    const activeOwner = __testGetSnapshot().activePublicKeyHex!;
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: activeOwner, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: activeOwner,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 同 session 的伪造 origin grant 必须被拒。
    const forged = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://evil.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-b");
    expect(forged.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });

    // Stat 不受金额设置阻断：无启用供应商时返回空聚合（不是错误）。
    const trustedStat = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedStat.ack.status).toBe("ok");
    expect((trustedStat.operationResult as { suppliers: unknown[] }).suppliers).toEqual([]);

    // Read fail closed（三道闸）：全局设置未保存 → msfile_not_configured。
    const unconfigured = await __testDispatchMsfileData({ type: "read-seed", supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(unconfigured.ack).toMatchObject({ status: "error", code: "msfile_not_configured" });

    // 设置已保存但 Gate 0 前无 transport → 未配置供应商先失败。
    await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" } });
    const trustedRead = await __testDispatchMsfileData({ type: "read-seed", supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedRead.ack).toMatchObject({ status: "error", code: "msfile_supplier_not_found" });

    // 其他端口的 grant 不能使用。
    const stolen = await __testDispatchMsfileData({ type: "read-seed", grantId, supplierPublicKeyHex: "02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-b");
    expect(stolen.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });
});
