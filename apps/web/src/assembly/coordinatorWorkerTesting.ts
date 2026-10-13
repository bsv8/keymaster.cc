import type { WocService } from "@keymaster/contracts";
import type { VaultWalletState } from "@keymaster/contracts";
import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { createP2pkhWorkerTaskDefinitions } from "@keymaster/plugin-p2pkh/coordinator";
import { type ContactsPresenceChannel } from "@keymaster/contracts";
import { createWocService } from "@keymaster/plugin-woc/coordinator";
import { createMessageBus } from "webloom-framework";
import { createP2pkhWorkerAssetReader } from "@keymaster/plugin-p2pkh/coordinator";
import type { VaultService } from "@keymaster/contracts";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createWocBsv21Service } from "@keymaster/plugin-woc/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createWocStasService } from "@keymaster/plugin-woc/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import { createWoc1SatOrdinalsService } from "@keymaster/plugin-woc/coordinator";
import { BACKGROUND_TRIGGER_REASON } from "@keymaster/contracts";
import "../keymasterSessionCoordinator.worker.js";
import { coordinatorTestingPorts } from "../assembly/coordinatorWorker.js";
import { type NetworkIdentity, networkIdentityStorageRoot } from "@keymaster/contracts";
import { FORUM_WORKER_LANE_ID, FORUM_WORKER_MAX_FRAME_BYTES, FORUM_WORKER_ROUNDTRIP_KIND } from "@keymaster/contracts";
import { privateProtocol, privateBodyForPublish, validatePrivateProtocolCaller } from "@keymaster/plugin-sat-subscription/coordinator";
import { signPrivateMessageForFixture } from "@keymaster/plugin-vault/coordinator";
import type { SessionEpoch, CoordinatorVaultStatus, CoordinatorResponse, CoordinatorBootstrapSnapshot, CoordinatorBackgroundSyncSettings, CoordinatorSubscribeTopicsResult, VaultSealedSecret, P2pkhProviderConfig, P2pkhTransactionBroadcastProvider, MsFileReadConcurrencySettings, CoordinatorChannelOperation, SatWindowLaneOperation, SatWindowLaneSspRequestEvent, CoordinatorRpcResponse, CoordinatorSessionOpenRequest, CoordinatorSessionCloseRequest, CoordinatorSessionBinding } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS, AUTO_LOCK_DEFAULT_TIMEOUT_MS } from "@keymaster/contracts";
import { buildWalletStorageRoot } from "@keymaster/contracts";
import { MSFILE_READ_CONCURRENCY_RECOMMENDED, normalizeMsFileReadConcurrencySettings, SAT_SUBSCRIPTION_RESOURCE_LIMITS } from "@keymaster/contracts";
import { type HandlerCallContext, type PeerController } from "webloom-framework";
import { COORDINATOR_WORKER_UNIT_CATALOG, getCoordinatorWorkerUnitForTask } from "../coordinator/workerUnitCatalog.js";
import { type P2pkhService } from "@keymaster/plugin-p2pkh/coordinator";
import { openP2pkhStateRepository, createP2pkhStateRepository } from "@keymaster/plugin-p2pkh/coordinator";
import type { WocQueueSnapshot, BsvNetwork, ChainHeightSnapshot } from "@keymaster/contracts";
import type { WalletColdStartSnapshot } from "@keymaster/contracts";
import { WALLET_KEYHOLD_PATH, WALLET_META_PATH } from "@keymaster/contracts";
import type { StorageRuntimeController, CoordinatorStorageControl, CoordinatorStorageStateEvent, CoordinatorMsFileControl, CoordinatorMsFileData, WocUtxoResponse } from "@keymaster/contracts";
import { STORAGE_DATA_CONCURRENCY, STORAGE_DATA_MAX_QUEUE } from "@keymaster/platform-storage/coordinator";
import { WALLET_LIST_MAX_LIMIT } from "@keymaster/platform-storage/coordinator";
import { storeMsFileSeed, type BitfsSellerProtocolPort, type BitfsSellerStreamTransport, type MsFileServiceImpl } from "@keymaster/plugin-msfile/coordinator";
import { buildWindowP2pConcurrencyConfig } from "@keymaster/plugin-msfile/executor-transport";
import type { WindowP2pExecutorOperation } from "@keymaster/contracts/window-p2p";
import { newMessageID } from "bsv8-channel-protocol";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";
import type { ChannelSeenMessageKind, CoordinatorPeerHandoffNotifier, BitfsNetwork, CoordinatorClientRequest, CoordinatorSettingsSnapshot } from "../assembly/coordinatorWorker.js";
const coordinatorPorts = coordinatorTestingPorts();
async function __testCollectCoordinatorKeyValueGarbage(): Promise<void> { await coordinatorPorts.storageKeyValueMaintenance.collectNow(); }

async function __testSeedCoordinatorKeyValueGarbage(): Promise<string> {
  const store = coordinatorPorts.vaultWalletWorker.walletStore;
  if (!store || !coordinatorPorts.storageWorkerRoot.root) throw new Error("Test Coordinator garbage storage is not ready");
  const declaration = CENTRAL_STORAGE_DECLARATIONS.bsvPrice;
  const handle = await coordinatorPorts.storageWorkerRoot.root.openPlatformStore({ declaration });
  const valuePrefix = `${networkIdentityStorageRoot(coordinatorPorts.storageWorkerRoot.root.identity)}${buildWalletStorageRoot({
    authority: declaration.authority,
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
  })}.keymaster/values/`;
  const listValueIds = async (): Promise<Set<string>> => {
    const valueIds = new Set<string>();
    let cursor: string | undefined;
    for (; ;) {
      const page = await store.list({ prefix: valuePrefix, ...(cursor === undefined ? {} : { cursor }), limit: WALLET_LIST_MAX_LIMIT });
      for (const object of page.objects) valueIds.add(object.path);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return valueIds;
  };
  const before = await listValueIds();
  try {
    const key = `gc-orphan-${crypto.randomUUID()}`;
    await handle.put(key, { source: "coordinator-gc-test" }, { partition: "gc-test" });
    // value object 的文件名是内容哈希，不是业务 key：靠 put 前后差集才能拿到
    // 那个被 delete 变成孤儿的真实路径。
    const created = [...(await listValueIds())].filter((path) => !before.has(path));
    if (created.length !== 1) throw new Error(`Test Coordinator garbage expected one new value object, saw ${created.length}`);
    await handle.delete(key, { partition: "gc-test" });
    return created[0]!;
  } finally {
    // The next collection must discover this namespace through declarations,
    // not through a resident handle retained in the Coordinator registry.
    handle.close();
  }
}

function __testBuildChannelPublicMessageTimes(now: () => number = Date.now): { issuedAtMs: number; expiresAtMs: number } {
  return coordinatorPorts.channelWorkerRuntime.channelPublicMessageTimes(now);
}

function __testBuildChannelSeenMessageKey(
  kind: ChannelSeenMessageKind,
  ...parts: readonly string[]
): string {
  return coordinatorPorts.channelWorkerRuntime.channelSeenMessageKey(kind, ...parts);
}

function __testFailNextP2pkhSettingWrite(): void {
  coordinatorPorts.testFailNextP2pkhSettingWrite = true;
}

function __testCoordinatorRuntimePlugin(pluginId: string) {
  const plugin = coordinatorPorts.coordinatorRuntimePlugins.find(plugin => plugin.manifest.id === pluginId);
  if (!plugin) throw new Error(`Worker plugin not found: ${pluginId}`);
  return plugin;
}

function __testEncodeChannelPrivateBody(
  protocol: string,
  content: import("@keymaster/contracts").JSONValue
): import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"] {
  return privateBodyForPublish(protocol, content);
}

function __testValidateChannelPrivateProtocol(
  caller: Extract<CoordinatorChannelOperation, { type: "private-publish" }>['caller'],
  protocol: string
): void {
  validatePrivateProtocolCaller(caller, privateProtocol(protocol));
}

function __testSignChannelPrivateMessage(input: {
  recipientPublicKeyHex: string;
  protocol: string;
  content: import("@keymaster/contracts").JSONValue;
  messageId?: string;
  nowMs: number;
  privateKeyHex: string;
}): import("bsv8-channel-protocol/inbox").SignedPrivateMessage {
  const protocol = privateProtocol(input.protocol);
  return signPrivateMessageForFixture({
    recipientPublicKeyHex: input.recipientPublicKeyHex,
    protocol,
    body: privateBodyForPublish(protocol, input.content),
    messageId: input.messageId ?? newMessageID(),
    nowMs: input.nowMs,
    privateKeyHex: input.privateKeyHex
  });
}

function __testGetSnapshot(): CoordinatorBootstrapSnapshot {
  return coordinatorPorts.buildSnapshot();
}

function __testGetMsfileSellerLifecycle(): {
  /** 自动锁截止时间；卖方启用时必须为空。 */
  autoLockDeadline?: number;
  /** 当前是否存在卖方索引。 */
  indexActive: boolean;
  /** 当前是否存在卖方匹配运行单元。 */
  runtimeActive: boolean;
} {
  return {
    ...(coordinatorPorts.coordinatorState.autoLockDeadline === undefined ? {} : { autoLockDeadline: coordinatorPorts.coordinatorState.autoLockDeadline }),
    indexActive: coordinatorPorts.msfileBitfsRuntime.msfileSellerIndex !== undefined,
    runtimeActive: coordinatorPorts.msfileBitfsRuntime.msfileSellerRuntime !== undefined,
  };
}

function __testSetMsfileSellerBridge(
  bridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined,
): void {
  coordinatorPorts.msfileBitfsRuntime.testMsfileSellerBridge = bridge;
}

async function __testDispatchMsfileSellerHashRequest(
  request: import("bsv8-channel-protocol/hash-request").VerifiedHashRequest,
): Promise<void> {
  await coordinatorPorts.handleMsfileSellerHashRequest(request);
}

function __testMsfileSellerSessionCount(): number {
  return coordinatorPorts.msfileBitfsRuntime.msfileSellerSessionManager?.activeCount() ?? 0;
}

async function __testMsfileStoreSeed(input: {
  /** 文件名。 */
  name: string;
  /** 媒体类型。 */
  mediaType: string;
  /** 文件字节。 */
  bytes: Uint8Array;
}): Promise<{ seedHashHex: string }> {
  const bytes = input.bytes.slice();
  const result = await storeMsFileSeed({
    store: coordinatorPorts.createWorkerModuleFileStore("msfile", ""),
    source: {
      name: input.name,
      mediaType: input.mediaType,
      size: BigInt(bytes.byteLength),
      async *stream() { yield bytes; },
      async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length); },
    },
  });
  return { seedHashHex: result.entry.seedHashHex };
}

async function __testMsfileOwnerStorageWrite(path: string, bytes: Uint8Array): Promise<void> {
  await coordinatorPorts.createWorkerModuleFileStore("msfile", "").put(path, bytes);
}

async function __testMsfileOwnerStorageDelete(path: string): Promise<void> {
  await coordinatorPorts.createWorkerModuleFileStore("msfile", "").delete(path);
}

function __testSetCoordinatorPeerHandoffNotifier(notifier: CoordinatorPeerHandoffNotifier | undefined): void {
  coordinatorPorts.testCoordinatorPeerHandoffNotifier = notifier;
}

async function __testFenceCoordinatorAuthority(): Promise<void> {
  await coordinatorPorts.ensureCoordinatorAuthorityClaim();
  if (!coordinatorPorts.coordinatorAuthorityRecord) throw new Error("Coordinator authority is unavailable");
  coordinatorPorts.coordinatorAuthorityRecord = {
    ...coordinatorPorts.coordinatorAuthorityRecord,
    authorityInstanceId: "coordinator:external-test-fence",
    handoverGeneration: coordinatorPorts.coordinatorAuthorityRecord.handoverGeneration + 1,
  };
}

async function __testHoldCoordinatorFinalIoLease(): Promise<() => Promise<void>> {
  await coordinatorPorts.ensureCoordinatorUpgradeSession();
  const lease = await coordinatorPorts.acquireCoordinatorFinalIoLease("write");
  return lease.release;
}

async function __testGetCoordinatorUpgradePartition(): Promise<{ revision: number; entryCount: number }> {
  // Coordinator upgrade/lease state is V1 memory-only. The old coordinator
  // K-V partition intentionally has no backing head, commits, or values.
  return { revision: 0, entryCount: 0 };
}

function __testResetState(): void {
  coordinatorPorts.walletLockBarrier.reset(); coordinatorPorts.lockRevocationPending = false; coordinatorPorts.globalLockRunning = undefined; coordinatorPorts.walletRevocationCleanup = undefined; coordinatorPorts.satWorkerLifecycle.resetRetry();
  coordinatorPorts.vaultWorkerKeys.activeKeyBackend = undefined;
  void coordinatorPorts.vaultWorkerKeys.hardwareConnections.close();
  coordinatorPorts.testDomainUnitReadiness = true;
  coordinatorPorts.stopCoordinatorKeyValueMaintenance();
  coordinatorPorts.storageKeyValueMaintenance.clear();
  coordinatorPorts.storageWorkerRequests.storageBrowseCoordinator.revokeAll();
  coordinatorPorts.storageWorkerRequests.storageBrowseCoordinator.dropBinding();
  // Drop domain-owned resources before resetting the compatibility table. The
  // real WebLoom Host must then observe the booting/locked state and tear down
  // its old owner scopes before the next test unlocks a new owner.
  coordinatorPorts.releaseMsfileRuntime("test-reset");
  coordinatorPorts.testMsfileRuntimeOverride = undefined;
  coordinatorPorts.coordinatorWorkerUnitRegistry.reset();
  if (coordinatorPorts.storageWorkerRoot.controller) {
    const storageUnit = coordinatorPorts.coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorPorts.coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  }
  // 测试夹具模拟 Worker 重启：旧意图控制器和 authority 不能继续冒充新实例。
  coordinatorPorts.closeCoordinatorUpgradeSession("Coordinator test Worker reset");
  const previousAuthorityLock = coordinatorPorts.coordinatorAuthorityLock;
  coordinatorPorts.coordinatorAuthorityLock = undefined;
  void previousAuthorityLock?.release().catch((error) => {
    console.warn("[coordinator] test authority lock release failed", error instanceof Error ? error.message : String(error));
  });
  coordinatorPorts.coordinatorAuthorityInstanceId = coordinatorPorts.makeCoordinatorAuthorityInstanceId();
  coordinatorPorts.coordinatorAuthorityRecord = undefined;
  coordinatorPorts.coordinatorAuthorityRecovery = undefined;
  coordinatorPorts.coordinatorAuthorityRecoveryOperationNames = [];
  coordinatorPorts.coordinatorHandoverGeneration = 0;
  // reset API 保持同步以兼容既有测试；真正的最终 I/O 会等待这条 claim
  // 完成，因此不会在新内存权威建立前执行业务操作。
  void coordinatorPorts.scheduleCoordinatorAuthorityClaim().catch((error) => {
    console.warn("[coordinator] test authority claim failed", error instanceof Error ? error.message : String(error));
  });
  // 测试夹具也模拟一次 Root 重装；旧句柄不能跨“重启”复用同一个令牌。
  coordinatorPorts.storageWorkerRoot.token = {};
  coordinatorPorts.storageWorkerRoot.failed = false;
  // releaseSatRuntime 会同步摘除旧 owner 的全局句柄，并把本地退出任务放入
  // satRuntimeRelease；下一次测试创建 runtime 时会等待该 Promise。
  void coordinatorPorts.releaseSatRuntime("test").catch(() => undefined);
  coordinatorPorts.testPersistCoordinatorSnapshotFailure = false;
  coordinatorPorts.testCoordinatorSnapshotMetrics.clear();
  coordinatorPorts.testFailNextP2pkhSettingWrite = false;
  // 链高度是进程级公共状态：reset 必须清回「尚无可信读数」，
  // 否则上个用例的高度会泄漏进下一个用例的 baseline 断言。
  coordinatorPorts.testChainHeightProvider = undefined;
  coordinatorPorts.wocWorkerRuntime.resetHeight();
  coordinatorPorts.chainHeightRevision = 0;
  coordinatorPorts.cancelSmartSyncIdleTimer();
  coordinatorPorts.backgroundWorkerRuntime.resetDebounce();
  for (const runtime of coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.values()) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  coordinatorPorts.coordinatorState.sessionEpoch = coordinatorPorts.generateEpoch();
  coordinatorPorts.coordinatorState.vaultStatus = "booting";
  coordinatorPorts.coordinatorState.activePublicKeyHex = undefined;
  coordinatorPorts.vaultWorkerKeys.dropActivePrivateKey();
  coordinatorPorts.testHarnessActivationSecret = undefined;
  coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.clear();
  coordinatorPorts.coordinatorState.autoLockDeadline = undefined;
  coordinatorPorts.vaultAutoLock.pause();
  coordinatorPorts.coordinatorState.lastActivityAt = Date.now();
  for (const state of coordinatorPorts.coordinatorPeers.values()) {
    if (state.topicStream) coordinatorPorts.closeCoordinatorTopicStreamQueue(state.topicStream);
  }
  coordinatorPorts.coordinatorPeers.clear();
  coordinatorPorts.storageIoOwner = undefined;
  coordinatorPorts.coordinatorSessionCommitOrder = 0;
  coordinatorPorts.coordinatorStorageIoHandoffRevision = 0;
  coordinatorPorts.testCoordinatorPeerHandoffNotifier = undefined;
  coordinatorPorts.coordinatorOpeningSession = undefined;
  coordinatorPorts.coordinatorSessionOpenTail = Promise.resolve();
  coordinatorPorts.revokedCoordinatorPeerIds.clear();
  coordinatorPorts.coordinatorTestEventSinks.clear();
  for (const pending of coordinatorPorts.channelWorkerRuntime.channelRequests.values()) pending.controller.abort();
  coordinatorPorts.channelWorkerRuntime.channelRequests.clear();
  coordinatorPorts.channelWorkerRuntime.channelCallersByClient.clear();
  coordinatorPorts.storageWorkerRequests.storageRequests.clear();
  coordinatorPorts.storageWorkerRequests.storageGrants.clear();
  coordinatorPorts.storageWorkerRequests.ownerStorageGrants.clear();
  coordinatorPorts.storageWorkerRequests.platformStorageGrants.clear();
  coordinatorPorts.workerStorageClients.invalidateAll();
  coordinatorPorts.storageWorkerRequests.storagePortCounts.clear();
  coordinatorPorts.storageWorkerRequests.storageDataQueue.resetForTests();
  coordinatorPorts.msfileWorkerRequests.msfileRequests.clear();
  coordinatorPorts.msfileWorkerRequests.msfileGrants.clear();
  coordinatorPorts.msfileWorkerRequests.msfileDataQueue.resetForTests();
  coordinatorPorts.windowP2pWorkerRuntime.rejectWindowP2pExecutorBridgePending(coordinatorPorts.windowP2pWorkerRuntime.windowP2pError("ERR_WORKER_RESTARTED", "Window P2P Coordinator runtime restarted"));
  // 测试接缝模拟整个 Worker 被销毁；真实 Worker 重启不会保留旧 Promise。
  coordinatorPorts.windowP2pWorkerRuntime.activeSatInboundHandlers.clear();
  coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.reset(new Error("Worker fixture restarted"));
  coordinatorPorts.msfileWorkerProjection.msfileReadConcurrencySettings = { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigVersion = 0;
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigSignature = JSON.stringify(coordinatorPorts.msfileWorkerProjection.msfileReadConcurrencySettings);
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(coordinatorPorts.msfileWorkerProjection.msfileReadConcurrencySettings, coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigVersion);
  coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorConfigSync?.reject(coordinatorPorts.windowP2pWorkerRuntime.windowP2pError("ERR_WORKER_RESTARTED", "Window P2P Coordinator runtime restarted"));
  coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorConfigSync = undefined;
  coordinatorPorts.msfileWorkerLifecycle.revoke();
  coordinatorPorts.msfileWorkerProjection.lastMsFileState = undefined;
  coordinatorPorts.satIncomingHandlers.clear();
  coordinatorPorts.channelWorkerRuntime.channelProtocolRelations.clear();
  coordinatorPorts.msfileBitfsRuntime.clearBuyerState();
  coordinatorPorts.channelRevision = 0;
  coordinatorPorts.contactsWorkerRuntime.reset();
  // 后台任务注册会重建 P2PKH 供应商注册表；重置时一并丢弃旧句柄，
  // 否则后续 ensureTestP2pkhProviders 会因为“注册表还在”而跳过重建，
  // 让 taskRuntimes 保持为空。
  coordinatorPorts.p2pkhWorkerRuntime.reset();
  coordinatorPorts.p2pkhWocService = undefined;
  coordinatorPorts.contactsPresenceRevision = 0;
  coordinatorPorts.contactsPresenceProjection.reset();
  coordinatorPorts.channelWorkerRuntime.channelPublicSubscribers.clear();
  coordinatorPorts.channelWorkerRuntime.channelPrivateSubscribers.clear();
  coordinatorPorts.channelWorkerRuntime.channelSubscriptionStatusSubscribers.clear();
  coordinatorPorts.channelWorkerRuntime.channelSubscriptionMuxStatusOff?.();
  coordinatorPorts.channelWorkerRuntime.channelSubscriptionMuxStatusOff = undefined;
  coordinatorPorts.windowP2pWorkerRuntime.testSatInboundResponseDispatcher = undefined;
  coordinatorPorts.satRevision = 0;
  coordinatorPorts.lastSatState = undefined;
  coordinatorPorts.msfileBitfsRuntime.resetControlQueue();
  coordinatorPorts.windowP2pWorkerRuntime.clearWindowP2pExecutorLeaseLocked();
  coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorIdentityTail = Promise.resolve();
  coordinatorPorts.msfileBitfsRuntime.resetControlQueue();
  coordinatorPorts.storageWorkerRoot.stateTail = Promise.resolve();
  coordinatorPorts.storageWorkerRequests.storageMutationTail = Promise.resolve();
  coordinatorPorts.storageWorkerRoot.controller = coordinatorPorts.storageWorkerRoot.testRuntime;
  coordinatorPorts.coordinatorRequestTail = Promise.resolve();
  coordinatorPorts.testP2pkhBroadcastProvider = undefined;
  coordinatorPorts.p2pkhWorkerRuntime.snapshots()?.clearAll();
  coordinatorPorts.workerWalletState.publish();
}

function __testSetVaultStatus(status: CoordinatorVaultStatus, activePublicKeyHex?: string): void {
  coordinatorPorts.coordinatorState.vaultStatus = status;
  coordinatorPorts.coordinatorState.activePublicKeyHex = activePublicKeyHex;
  coordinatorPorts.workerWalletState.publish();
}

function __testSetP2pkhBroadcastProvider(provider: P2pkhTransactionBroadcastProvider | undefined): void {
  coordinatorPorts.testP2pkhBroadcastProvider = provider;
}

function __testSetP2pkhUnspentAllProvider(provider: ((network: "main" | "test", address: string) => Promise<WocUtxoResponse[]>) | undefined): void {
  coordinatorPorts.testP2pkhUnspentAllProvider = provider;
}

function __testSetSatBroadcastRetryOverrides(input: { maxAttempts?: number; deadlineMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } | undefined): void {
  coordinatorPorts.testSatBroadcastRetryOverrides = input;
}

function __testSetChainHeightProvider(provider: ((network: BsvNetwork) => Promise<number>) | undefined): void {
  coordinatorPorts.testChainHeightProvider = provider;
}

function __testGetChainHeight(): ChainHeightSnapshot {
  return coordinatorPorts.wocWorkerRuntime.snapshot();
}

function __testResetChainHeight(): void {
  coordinatorPorts.wocWorkerRuntime.resetHeight();
  coordinatorPorts.chainHeightRevision = 0;
}

function __testReadBitfsBlockHeight(network: BitfsNetwork): Promise<number> {
  return coordinatorPorts.readCoordinatorBitfsBlockHeight(network);
}

async function __testRegisterRealCoordinatorTasks(): Promise<void> {
  coordinatorPorts.activateCoordinatorRootWorkerUnits();
  await coordinatorPorts.registerCoordinatorTasks();
}

async function __testEnsureSatP2pkhService(): Promise<P2pkhService> {
  await ensureTestP2pkhProviders();
  return coordinatorPorts.ensureSatP2pkhService();
}

async function __testEnsureSatRuntime(): Promise<void> {
  await coordinatorPorts.ensureSatRuntime();
}

async function __testReleaseSatRuntime(): Promise<void> {
  await coordinatorPorts.releaseSatRuntime("test");
}

async function __testAwaitMsfileSellerDependencyResume(): Promise<void> {
  await coordinatorPorts.msfileBitfsRuntime.msfileSellerDependencyResume?.catch(() => undefined);
  coordinatorPorts.msfileBitfsRuntime.msfileSellerDependencyResume = undefined;
}

function __testFailNextCoordinatorSnapshotPersist(): void {
  coordinatorPorts.testPersistCoordinatorSnapshotFailure = true;
}

async function ensureTestP2pkhProviders(): Promise<void> {
  if (!coordinatorPorts.p2pkhWorkerRuntime.registry()) await coordinatorPorts.registerCoordinatorTasks();
}

async function __testP2pkhProviderConfigUpdate(providerId: string, config: P2pkhProviderConfig): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  return coordinatorPorts.handleP2pkhProviderConfigUpdate(`test-p2pkh-config-${Date.now()}`, {
    kind: "p2pkh.provider-config.update",
    clientId: "test",
    requestId: `test-p2pkh-config-${Date.now()}`,
    providerId,
    config,
    expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch
  });
}

async function __testP2pkhProviderConfigGet(providerId: string): Promise<P2pkhProviderConfig> {
  await ensureTestP2pkhProviders();
  const response = await coordinatorPorts.handleP2pkhProviderConfigGet(`test-p2pkh-config-get-${Date.now()}`, {
    kind: "p2pkh.provider-config.get",
    clientId: "test",
    requestId: `test-p2pkh-config-get-${Date.now()}`,
    providerId,
    expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch
  });
  return response.operationResult && typeof response.operationResult === "object" && !Array.isArray(response.operationResult)
    ? response.operationResult as P2pkhProviderConfig
    : {};
}

async function __testSeedP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submission: unknown; claims?: unknown[] }): Promise<void> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await coordinatorPorts.satWorkerLifecycle.waitReleased();
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")));
  await repository.prepareLocalSubmission({ submission: input.submission as never, claims: (input.claims ?? []) as never });
}

async function __testFinishP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submissionId: string; localState: "local-confirmed" | "isolated" }): Promise<void> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await coordinatorPorts.satWorkerLifecycle.waitReleased();
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")));
  await repository.finishLocalSubmission({ submissionId: input.submissionId, localState: input.localState });
}

async function __testSetP2pkhChainResolution(input: { ownerPublicKeyHex: string; submissionId: string; chainResolution: "unresolved" | "chain-confirmed" }): Promise<void> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await coordinatorPorts.satWorkerLifecycle.waitReleased();
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")));
  const row = (await repository.listLocalTransactions()).find((candidate) => candidate.id === input.submissionId);
  if (!row) throw new Error(`P2PKH submission not found: ${input.submissionId}`);
  const next = { ...row, chainResolution: input.chainResolution, ...(input.chainResolution === "chain-confirmed" ? { confirmedHistoryId: `${row.resourceId}:${row.txid}` } : { confirmedHistoryId: undefined }) };
  await repository.replaceLocalTransaction(next);
}

async function __testListP2pkhLocalTransactions(ownerPublicKeyHex: string): Promise<unknown[]> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await coordinatorPorts.satWorkerLifecycle.waitReleased();
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")));
  return repository.listLocalTransactions();
}

async function __testListP2pkhLocalInputClaims(ownerPublicKeyHex: string): Promise<unknown[]> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await coordinatorPorts.satWorkerLifecycle.waitReleased();
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")));
  return repository.listLocalInputClaims();
}

async function __testP2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: import("@keymaster/contracts").P2pkhBroadcastSubmission; expectedSessionEpoch?: SessionEpoch }): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  return coordinatorPorts.handleP2pkhBroadcast(`test-p2pkh-broadcast-${Date.now()}`, {
    kind: "p2pkh.broadcast",
    clientId: "test",
    requestId: `test-p2pkh-broadcast-${Date.now()}`,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    network: input.network,
    submissionId: input.submissionId,
    ...(input.submission === undefined ? {} : { submission: input.submission }),
    expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorPorts.coordinatorState.sessionEpoch
  });
}

function __testGetConnectedPortCount(): number {
  return coordinatorPorts.coordinatorTestEventSinks.size;
}

function __testSetStorageSessionResolver(resolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined): void {
  coordinatorPorts.testStorageSessionResolver = resolver;
}

function __testSetStorageRuntime(runtime: Partial<StorageRuntimeController> | undefined): void {
  const previousUnit = coordinatorPorts.coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
  coordinatorPorts.storageWorkerRoot.testRuntime = runtime as StorageRuntimeController | undefined;
  coordinatorPorts.storageWorkerRoot.controller = coordinatorPorts.storageWorkerRoot.testRuntime;
  if (runtime) {
    const unit = coordinatorPorts.coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorPorts.coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
    coordinatorPorts.storageWorkerRoot.ready = true;
    coordinatorPorts.storageWorkerRoot.failed = false;
  }
  if (!runtime && previousUnit) coordinatorPorts.stopCoordinatorWorkerUnit(previousUnit.unitId, previousUnit.instanceId);
}

function __testSetStorageStartupFailure(enabled: boolean): void {
  coordinatorPorts.storageWorkerRoot.testFailure = enabled;
  coordinatorPorts.storageWorkerRoot.failed = enabled;
  if (enabled) {
    coordinatorPorts.emitStorageState();
  } else {
    coordinatorPorts.storageWorkerRoot.failed = false;
  }
  if (enabled) coordinatorPorts.storageWorkerRoot.controller = undefined;
}

async function __testReleaseStorageRuntime(): Promise<void> {
  await coordinatorPorts.releaseStorageRuntime("test-lock");
}

async function __testStorageMutationBarrierProbe(): Promise<{ blockedBeforeRelease: boolean; completedAfterRelease: boolean }> {
  let release!: () => void;
  const previous = coordinatorPorts.storageWorkerRequests.storageMutationTail;
  coordinatorPorts.storageWorkerRequests.storageMutationTail = coordinatorPorts.storageWorkerRequests.storageMutationTail.then(() => new Promise<void>((resolve) => { release = resolve; }));
  await previous;
  let completed = false;
  const run = coordinatorPorts.storageWorkerRequests.executeStorageRequest({ kind: "storage.control", clientId: "test", requestId: crypto.randomUUID(), control: { type: "status" }, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, "test").then(() => { completed = true; });
  await Promise.resolve();
  const blockedBeforeRelease = !completed;
  release();
  await run;
  coordinatorPorts.storageWorkerRequests.storageMutationTail = Promise.resolve();
  return { blockedBeforeRelease, completedAfterRelease: completed };
}

async function __testDispatchStorageGrant(connectSessionId: string, actualPortId: string, requestClientId = actualPortId): Promise<CoordinatorResponse> {
  return coordinatorPorts.storageWorkerRequests.executeStorageRequest({ kind: "storage.grant", clientId: requestClientId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, actualPortId);
}

async function __testResolveStorageGrant(grantId: string, actualPortId: string): Promise<import("@keymaster/contracts").OwnerAppStorageGrant> {
  return (await coordinatorPorts.storageWorkerRequests.resolveStorageGrant(grantId, actualPortId)).context;
}

function __testSetMsfileRuntimeOverride(runtime: Partial<MsFileServiceImpl> | undefined): void {
  coordinatorPorts.testMsfileRuntimeOverride = runtime as MsFileServiceImpl | undefined;
}

function __testSetMsfileReadConcurrencySettings(settings: MsFileReadConcurrencySettings): void {
  const normalized = normalizeMsFileReadConcurrencySettings(settings);
  if (!normalized) throw new Error("invalid MSFile read concurrency settings");
  coordinatorPorts.msfileWorkerProjection.msfileReadConcurrencySettings = normalized;
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigSignature = JSON.stringify(normalized);
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigVersion += 1;
  coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(normalized, coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConfigVersion);
  void coordinatorPorts.windowP2pWorkerRuntime.syncWindowP2pExecutorConfig().catch(() => undefined);
  coordinatorPorts.msfileWorkerRequests.pumpMsfileDataWaiters();
}

async function __testDispatchMsfileControl(control: CoordinatorMsFileControl): Promise<CoordinatorResponse> {
  return coordinatorPorts.msfileWorkerRequests.executeMsfileRequest({ kind: "msfile.control", clientId: "port-msfile", requestId: crypto.randomUUID(), control, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, "port-msfile");
}

async function __testDispatchMsfileGrant(
  input: { connectSessionId: string; transportOrigin: string; ownerPublicKeyHex: string; appIdentity: import("@keymaster/contracts").AppIdentitySnapshot },
  actualPortId = "port-msfile",
  expectedSessionEpoch: SessionEpoch = coordinatorPorts.coordinatorState.sessionEpoch
): Promise<CoordinatorResponse> {
  return coordinatorPorts.msfileWorkerRequests.executeMsfileRequest({ kind: "msfile.grant", clientId: actualPortId, requestId: crypto.randomUUID(), context: { connectSessionId: input.connectSessionId, transportOrigin: input.transportOrigin, ownerPublicKeyHex: input.ownerPublicKeyHex, appIdentity: input.appIdentity }, expectedSessionEpoch }, actualPortId);
}

async function __testDispatchMsfileData(data: CoordinatorMsFileData, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return coordinatorPorts.msfileWorkerRequests.executeMsfileRequest({ kind: "msfile.data", clientId: actualPortId, requestId: crypto.randomUUID(), data, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, actualPortId);
}

async function __testDispatchMsfileSessionAbort(connectSessionId: string, expectedSessionEpoch: SessionEpoch, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return coordinatorPorts.msfileWorkerRequests.executeMsfileRequest({ kind: "msfile.session.abort", clientId: actualPortId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch }, actualPortId);
}

async function __testDispatchMsfileControlWithEpoch(control: CoordinatorMsFileControl, expectedSessionEpoch: SessionEpoch, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return coordinatorPorts.msfileWorkerRequests.executeMsfileRequest({ kind: "msfile.control", clientId: actualPortId, requestId: crypto.randomUUID(), control, expectedSessionEpoch }, actualPortId);
}

async function __testAcquireExecutorLease(ownerPublicKeyHex: string, clientId = "port-exec", expectedSessionEpoch: SessionEpoch = coordinatorPorts.coordinatorState.sessionEpoch): Promise<CoordinatorResponse> {
  return coordinatorPorts.processRequest({ kind: "window-p2p.executor.acquire", clientId, requestId: crypto.randomUUID(), ownerPublicKeyHex, expectedSessionEpoch }, clientId);
}

function __testWindowP2pInboundBridgePressure(input: { attempts?: number; wireBytes?: number } = {}): {
  attempts: number;
  accepted: number;
  rejected: number;
  peakBytes: number;
  peakItems: number;
  releasedBytes: number;
  releasedItems: number;
} {
  const attempts = input.attempts ?? 64;
  const wireBytes = input.wireBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(wireBytes) || wireBytes < 1) {
    throw new RangeError("bridge pressure input must be positive safe integers");
  }
  const lease = coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorLease ?? {
    leaseId: "test-window-p2p-bridge-lease",
    sessionEpoch: "test-window-p2p-bridge-epoch",
    activePublicKeyHex: "02" + "11".repeat(32),
    clientId: "test-window-p2p-bridge",
    ownerPublicKeyHex: "02" + "11".repeat(32),
    acquiredAt: Date.now(),
    transportReady: true,
    transportConfigVersion: coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConcurrencyConfig.version,
  } satisfies import("@keymaster/plugin-window-p2p/worker").WindowP2pExecutorLeaseState;
  const acceptedEventIds: string[] = [];
  let accepted = 0;
  for (let index = 0; index < attempts; index += 1) {
    const eventId = `test-window-p2p-bridge-event-${index}`;
    const event = {
      type: "ssp.request" as const,
      eventId,
      wire: new Uint8Array(wireBytes),
      supplierId: "test-supplier",
      connectionId: "test-connection",
      ownerSessionEpoch: lease.sessionEpoch,
      supplierGeneration: 1,
    } satisfies SatWindowLaneSspRequestEvent;
    if (coordinatorPorts.windowP2pWorkerRuntime.reserveWindowP2pExecutorInboundEvent(event, lease)) {
      accepted += 1;
      acceptedEventIds.push(eventId);
    }
  }
  const peakBytes = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().bytes;
  const peakItems = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().items;
  for (const eventId of acceptedEventIds) {
    coordinatorPorts.windowP2pWorkerRuntime.releaseWindowP2pExecutorInboundEvent({ connectionId: "test-connection", eventId }, lease.leaseId);
  }
  return {
    attempts,
    accepted,
    rejected: attempts - accepted,
    peakBytes,
    peakItems,
    releasedBytes: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().bytes,
    releasedItems: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().items,
  };
}

async function __testWindowP2pResponseBridgePressure(input: { attempts?: number; requestBytes?: number } = {}): Promise<{
  attempts: number;
  requestBytes: number;
  accepted: number;
  queued: number;
  peakBytes: number;
  peakItems: number;
  releasedBytes: number;
  releasedItems: number;
}> {
  const attempts = input.attempts ?? 256;
  const requestBytes = input.requestBytes ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(requestBytes) || requestBytes < 1 || requestBytes > MAX_WIRE_BYTES) {
    throw new RangeError("response bridge pressure input must be positive safe integers");
  }
  const operation = {
    type: "lane" as const,
    laneId: coordinatorPorts.SAT_WINDOW_LANE_ID,
    operation: {
      type: "requestSsp" as const,
      supplierId: "test-supplier",
      connectionId: "test-connection",
      ownerSessionEpoch: "test-epoch",
      supplierGeneration: 1,
      wire: new Uint8Array(requestBytes),
    },
  } satisfies WindowP2pExecutorOperation;
  const reservedBytes = coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorBridgeBytesForOperation(operation);
  const controllers = Array.from({ length: attempts }, () => new AbortController());
  const reservations = controllers.map((controller) => coordinatorPorts.windowP2pWorkerRuntime.reserveWindowP2pExecutorBridgeBytes(reservedBytes, controller.signal).then(() => undefined, () => undefined));
  await Promise.resolve();
  const accepted = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().items;
  const queued = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().queued;
  const peakBytes = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().bytes;
  const peakItems = accepted + queued;
  // 取消尚未准入的 waiter，再释放已经准入的操作，避免测试 helper 留下
  // 全局 bridge 状态或未处理 rejection 影响后续测试。
  for (const controller of controllers) controller.abort();
  for (let index = 0; index < accepted; index += 1) coordinatorPorts.windowP2pWorkerRuntime.releaseWindowP2pExecutorBridgeBytes(reservedBytes);
  await Promise.all(reservations);
  return {
    attempts,
    requestBytes,
    accepted,
    queued,
    peakBytes,
    peakItems,
    releasedBytes: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().bytes,
    releasedItems: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().items,
  };
}

async function __testForumRoundtripBridgePressure(input: { attempts?: number; requestBytes?: number } = {}): Promise<{
  attempts: number;
  requestBytes: number;
  reservedBytesPerOperation: number;
  accepted: number;
  queued: number;
  peakBytes: number;
  peakItems: number;
  releasedBytes: number;
  releasedItems: number;
}> {
  const attempts = input.attempts ?? 64;
  const requestBytes = input.requestBytes ?? 1024;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(requestBytes) || requestBytes < 1 || requestBytes > FORUM_WORKER_MAX_FRAME_BYTES) {
    throw new RangeError("forum bridge pressure input must be positive safe integers within the frame limit");
  }
  const operation = {
    type: "lane" as const,
    laneId: FORUM_WORKER_LANE_ID,
    operation: {
      kind: FORUM_WORKER_ROUNDTRIP_KIND,
      address: "/ip4/127.0.0.1/tcp/8080/p2p/12D3KooW",
      forumPublicKeyHex: "02" + "11".repeat(32),
      // hex 在 bridge 上是 UTF-16：请求字节数翻倍进入预算。
      requestBytesHex: "00".repeat(requestBytes),
    },
  } satisfies WindowP2pExecutorOperation;
  const reservedBytes = coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorBridgeBytesForOperation(operation);
  const controllers = Array.from({ length: attempts }, () => new AbortController());
  const reservations = controllers.map((controller) => coordinatorPorts.windowP2pWorkerRuntime.reserveWindowP2pExecutorBridgeBytes(reservedBytes, controller.signal).then(() => undefined, () => undefined));
  await Promise.resolve();
  const snapshot = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot();
  const accepted = snapshot.items;
  const queued = snapshot.queued;
  const peakBytes = snapshot.bytes;
  const peakItems = accepted + queued;
  for (const controller of controllers) controller.abort();
  for (let index = 0; index < accepted; index += 1) coordinatorPorts.windowP2pWorkerRuntime.releaseWindowP2pExecutorBridgeBytes(reservedBytes);
  await Promise.all(reservations);
  const after = coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot();
  return {
    attempts,
    requestBytes,
    reservedBytesPerOperation: reservedBytes,
    accepted,
    queued,
    peakBytes,
    peakItems,
    releasedBytes: after.bytes,
    releasedItems: after.items,
  };
}

function __testStartSatInboundHandler(input: {
  leaseId?: string;
  eventId?: string;
  connectionId?: string;
  supplierId?: string;
  ownerSessionEpoch?: string;
  supplierGeneration?: number;
  wireBytes?: number;
  makeCurrent?: boolean;
  handler?: (wire: Uint8Array) => Promise<Uint8Array>;
} = {}): {
  accepted: boolean;
  leaseId: string;
  eventId: string;
  connectionId: string;
  signal?: AbortSignal;
  completion?: Promise<void>;
} {
  const leaseId = input.leaseId ?? `test-sat-inbound-lease-${crypto.randomUUID()}`;
  const eventId = input.eventId ?? `test-sat-inbound-event-${crypto.randomUUID()}`;
  const connectionId = input.connectionId ?? `test-sat-inbound-connection-${crypto.randomUUID()}`;
  const supplierId = input.supplierId ?? "test-sat-supplier";
  const ownerSessionEpoch = input.ownerSessionEpoch ?? "test-sat-inbound-epoch";
  const supplierGeneration = input.supplierGeneration ?? 1;
  const wireBytes = input.wireBytes ?? 1;
  if (!Number.isSafeInteger(supplierGeneration) || supplierGeneration < 1
    || !Number.isSafeInteger(wireBytes) || wireBytes < 1 || wireBytes > SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes) {
    throw new RangeError("invalid Sat inbound handler test input");
  }
  const lease = {
    leaseId,
    sessionEpoch: ownerSessionEpoch,
    activePublicKeyHex: "02" + "11".repeat(32),
    clientId: "test-sat-inbound",
    ownerPublicKeyHex: "02" + "11".repeat(32),
    acquiredAt: Date.now(),
    transportReady: true,
    transportConfigVersion: coordinatorPorts.msfileWorkerProjection.windowP2pExecutorConcurrencyConfig.version,
  } satisfies import("@keymaster/plugin-window-p2p/worker").WindowP2pExecutorLeaseState;
  const event: SatWindowLaneSspRequestEvent = {
    type: "ssp.request",
    eventId,
    supplierId,
    connectionId,
    ownerSessionEpoch,
    supplierGeneration,
    wire: new Uint8Array(wireBytes),
  };
  if (!coordinatorPorts.windowP2pWorkerRuntime.reserveWindowP2pExecutorInboundEvent(event, lease)) {
    return { accepted: false, leaseId, eventId, connectionId };
  }
  const task = coordinatorPorts.windowP2pWorkerRuntime.beginSatInboundHandler(event, lease);
  if (!task) {
    coordinatorPorts.windowP2pWorkerRuntime.releaseWindowP2pExecutorInboundEvent(event, lease.leaseId);
    return { accepted: false, leaseId, eventId, connectionId };
  }
  const registration = {
    supplierId,
    ownerSessionEpoch,
    supplierGeneration,
    handler: input.handler ?? (() => new Promise<Uint8Array>(() => undefined)),
  };
  coordinatorPorts.satIncomingHandlers.set(connectionId, registration);
  if (input.makeCurrent) {
    coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorLease = lease;
    coordinatorPorts.coordinatorState.sessionEpoch = ownerSessionEpoch;
    coordinatorPorts.coordinatorState.vaultStatus = "unlocked";
    coordinatorPorts.coordinatorState.activePublicKeyHex = lease.activePublicKeyHex;
  }
  const completion = coordinatorPorts.windowP2pWorkerRuntime.handleSatWindowEvent(event, lease, task).finally(() => {
    if (coordinatorPorts.satIncomingHandlers.get(connectionId) === registration) coordinatorPorts.satIncomingHandlers.delete(connectionId);
  });
  return { accepted: true, leaseId, eventId, connectionId, signal: task.controller.signal, completion };
}

function __testCancelSatInboundHandler(input: { leaseId: string; eventId: string; connectionId: string }): boolean {
  const task = coordinatorPorts.windowP2pWorkerRuntime.activeSatInboundHandlers.get(`${input.leaseId}\u0000${input.connectionId}\u0000${input.eventId}`);
  if (!task) return false;
  coordinatorPorts.windowP2pWorkerRuntime.cancelSatInboundHandler(task, "test cancellation");
  return true;
}

function __testRevokeWindowP2pExecutorLease(): void {
  coordinatorPorts.windowP2pWorkerRuntime.clearWindowP2pExecutorLeaseLocked();
}

function __testChangeSatInboundGeneration(connectionId: string, supplierGeneration: number): boolean {
  const current = coordinatorPorts.satIncomingHandlers.get(connectionId);
  if (!current) return false;
  coordinatorPorts.satIncomingHandlers.set(connectionId, { ...current, supplierGeneration });
  return true;
}

function __testSatInboundHandlerSnapshot(): {
  active: number;
  canceled: number;
  bridgeBytes: number;
  bridgeItems: number;
  maxActive: number;
} {
  return {
    active: coordinatorPorts.windowP2pWorkerRuntime.activeSatInboundHandlers.size,
    canceled: [...coordinatorPorts.windowP2pWorkerRuntime.activeSatInboundHandlers.values()].filter((task) => task.canceled).length,
    bridgeBytes: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().bytes,
    bridgeItems: coordinatorPorts.windowP2pWorkerRuntime.windowP2pBridgeBudget.snapshot().items,
    maxActive: SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxActiveWorkerInboundHandlers,
  };
}

function __testSetSatInboundResponseDispatcher(dispatcher: ((operation: SatWindowLaneOperation, signal: AbortSignal) => Promise<unknown>) | undefined): void {
  coordinatorPorts.windowP2pWorkerRuntime.testSatInboundResponseDispatcher = dispatcher;
}

function __testPublishSatState(event: import("@keymaster/contracts").CoordinatorSatEvent): void {
  coordinatorPorts.emitSatState(event);
}

async function __testReleaseExecutorLease(leaseId: string, clientId = "port-exec"): Promise<CoordinatorResponse> {
  return coordinatorPorts.processRequest({ kind: "window-p2p.executor.release", clientId, requestId: crypto.randomUUID(), leaseId }, clientId);
}

async function __testExecutorSignNoise(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; noiseStaticPublicKey: ArrayBuffer }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "window-p2p.executor.identity.sign-noise" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorPorts.coordinatorState.sessionEpoch, noiseStaticPublicKey: input.noiseStaticPublicKey };
  return coordinatorPorts.windowP2pWorkerRuntime.executeWindowP2pExecutorRequest(request, clientId);
}

async function __testExecutorSignPeerRecord(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; peerId: string; addresses: string[]; sequence: string }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "window-p2p.executor.identity.sign-peer-record" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorPorts.coordinatorState.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
  return coordinatorPorts.windowP2pWorkerRuntime.executeWindowP2pExecutorRequest(request, clientId);
}

async function __testReleaseMsfileRuntime(): Promise<void> {
  coordinatorPorts.releaseMsfileRuntime("test");
  coordinatorPorts.testMsfileRuntimeOverride = undefined;
  await coordinatorPorts.releaseSatRuntime("test");
}

async function __testDispatchStorageData(input: { grantId: string; actualPortId: string; requestClientId?: string; connectSessionId?: string }): Promise<CoordinatorResponse> {
  const requestId = crypto.randomUUID();
  return coordinatorPorts.storageWorkerRequests.executeStorageRequest({ kind: "storage.data", clientId: input.requestClientId ?? input.actualPortId, requestId, data: { type: "list", grantId: input.grantId, input: {} }, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, input.actualPortId);
}

async function __testDispatchStorageControl(control: CoordinatorStorageControl): Promise<CoordinatorResponse> {
  const request = { kind: "storage.control" as const, clientId: "test", requestId: crypto.randomUUID(), control, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch };
  try {
    return await coordinatorPorts.storageWorkerRequests.executeStorageRequest(request, "test");
  } finally {
    // 测试 seam 直接进入 executeStorageRequest，不经过生产
    // processRequestCore 的 finally；这里仍模拟 RPC 返回前的秘密清零。
    coordinatorPorts.storageWorkerControl.clearSecrets(request);
  }
}

async function __testDispatchStorageBrowseOpen(actualPortId: string): Promise<CoordinatorResponse> {
  const request = { kind: "storage.browse.open" as const, clientId: actualPortId, requestId: crypto.randomUUID(), expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch };
  try {
    return await coordinatorPorts.storageWorkerRequests.executeStorageRequest(request, actualPortId);
  } finally {
    coordinatorPorts.storageWorkerControl.clearSecrets(request);
  }
}

function __testHasStorageBrowseAuthorization(peerId: string): boolean {
  return coordinatorPorts.storageWorkerRequests.storageBrowseCoordinator.hasClientAuthorization(peerId);
}

function __testSeedStorageRequest(requestId: string, actualPortId: string, connectSessionId?: string): AbortSignal {
  const controller = new AbortController();
  coordinatorPorts.storageWorkerRequests.storageRequests.set(coordinatorPorts.storageWorkerRequests.storageRequestKey(actualPortId, requestId), { controller, clientId: actualPortId, connectSessionId });
  return controller.signal;
}

async function __testDispatchStorageCancel(targetRequestId: string, actualPortId: string): Promise<CoordinatorResponse> {
  return coordinatorPorts.storageWorkerRequests.executeStorageRequest({ kind: "storage.cancel", clientId: actualPortId, requestId: crypto.randomUUID(), targetRequestId }, actualPortId);
}

async function __testDispatchStorageAbort(connectSessionId: string, actualPortId: string): Promise<CoordinatorResponse> {
  return coordinatorPorts.storageWorkerRequests.executeStorageRequest({ kind: "storage.session.abort", clientId: actualPortId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch }, actualPortId);
}

function __testStorageQueueAdmission(portId: string): { firstPortAccepted: number; firstPortRejected: boolean; secondPortAccepted: boolean; remaining: Record<string, number> } {
  let firstPortAccepted = 0;
  while (coordinatorPorts.storageWorkerRequests.reserveStoragePortSlot(portId)) firstPortAccepted++;
  const firstPortRejected = !coordinatorPorts.storageWorkerRequests.reserveStoragePortSlot(portId);
  const secondPortAccepted = coordinatorPorts.storageWorkerRequests.reserveStoragePortSlot(`${portId}-other`);
  for (let i = 0; i < firstPortAccepted; i++) coordinatorPorts.storageWorkerRequests.releaseStoragePortSlot(portId);
  if (secondPortAccepted) coordinatorPorts.storageWorkerRequests.releaseStoragePortSlot(`${portId}-other`);
  return { firstPortAccepted, firstPortRejected, secondPortAccepted, remaining: Object.fromEntries(coordinatorPorts.storageWorkerRequests.storagePortCounts) };
}

async function __testPublishStorageState(): Promise<void> {
  coordinatorPorts.emitStorageState();
  await coordinatorPorts.storageWorkerRoot.stateTail;
}

async function __testStorageFairDispatch(): Promise<string[]> {
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  const run = (portId: string, label: string) => coordinatorPorts.storageWorkerRequests.withStorageDataSlot(portId, () => new Promise<void>((resolve) => { order.push(label); releases.set(label, resolve); }));
  const active = [run("port-a", "a1"), run("port-a", "a2"), run("port-a", "a3")];
  const queuedA = run("port-a", "a4");
  const queuedB = run("port-b", "b1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.get("a1")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.get("b1")?.(); releases.get("a2")?.(); releases.get("a3")?.(); releases.get("a4")?.();
  await Promise.all([...active, queuedA, queuedB]);
  return order;
}

function __testStorageTransfer(bytes: ArrayBuffer): { inputDetachedByteLength: number; detachedByteLength: number; receivedByteLength: number; transferCount: number } {
  const inputClone = structuredClone({ data: { content: { bytes } } }, { transfer: [bytes] });
  const inputDetachedByteLength = bytes.byteLength;
  let receivedByteLength = -1;
  let transferCount = 0;
  const port = {
    postMessage(message: unknown, transfer: ArrayBuffer[] = []) {
      transferCount = transfer.length;
      const cloned = structuredClone(message, { transfer });
      receivedByteLength = ((cloned as { operationResult?: { content?: { bytes?: ArrayBuffer } } }).operationResult?.content?.bytes)?.byteLength ?? -1;
    }
  } as unknown as MessagePort;
  const responseBytes = (inputClone.data as { content: { bytes: ArrayBuffer } }).content.bytes;
  try { port.postMessage({ operationResult: { content: { bytes: responseBytes } } }, [responseBytes]); } catch { /* the test fake records post failures */ }
  return { inputDetachedByteLength, detachedByteLength: responseBytes.byteLength, receivedByteLength, transferCount };
}

function __testAttachPort(clientId: string, postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void): void {
  coordinatorPorts.revokedCoordinatorPeerIds.delete(clientId);
  coordinatorPorts.coordinatorTestEventSinks.set(clientId, { postMessage, topics: new Set() });
}

function __testInstallCoordinatorBridgePeer(
  peer: Pick<PeerController, "peerId" | "scope">,
  binding: CoordinatorSessionBinding,
): void {
  coordinatorPorts.configureCoordinatorPeer(peer as PeerController);
  const state = coordinatorPorts.coordinatorPeerState(peer.peerId);
  if (!state) throw new Error("Coordinator test peer was not registered");
  state.sessionGeneration = binding.peerGeneration;
  state.status = "open";
  state.sessionOpen = true;
  state.sessionBinding = { ...binding };
  state.openCommitOrder = ++coordinatorPorts.coordinatorSessionCommitOrder;
  coordinatorPorts.storageIoOwner = {
    ...binding,
    peerId: peer.peerId,
    commitOrder: ++coordinatorPorts.coordinatorStorageIoHandoffRevision,
  };
}

async function __testHandleCoordinatorSessionRpc(
  peer: Pick<PeerController, "peerId" | "scope" | "capability" | "exposeGroup">,
  request: CoordinatorSessionOpenRequest | CoordinatorSessionCloseRequest,
  signal: AbortSignal = new AbortController().signal,
  options: { waitForDrain?: boolean } = {},
): Promise<CoordinatorRpcResponse> {
  const existing = coordinatorPorts.coordinatorPeerState(peer.peerId);
  if (!existing) coordinatorPorts.configureCoordinatorPeer(peer as PeerController);
  else if (existing.peer !== peer) throw new Error("Coordinator test peer instance was replaced");
  // 避免测试接缝触发真实外部初始化；handler 仍会执行 recovery-list
  // bridge 与完整 session.open 提交。调用完成后恢复原始 single-flight。
  const previousInitialization = coordinatorPorts.coordinatorInitialization;
  if (request.kind === "session.open") coordinatorPorts.coordinatorInitialization = Promise.resolve();
  try {
    const response = await coordinatorPorts.handleCoordinatorRpc(request, {
      signal,
      deadlineAt: Date.now() + 60_000,
      operationId: `test-session-${peer.peerId}-${Date.now()}`,
      reference: {} as HandlerCallContext["reference"],
      origin: "remote",
      peer: { peerId: peer.peerId } as HandlerCallContext["peer"],
    });
    if (request.kind === "session.close" && options.waitForDrain) {
      await coordinatorPorts.coordinatorPeerState(peer.peerId)?.drainPromise;
    }
    return response;
  } finally {
    if (request.kind === "session.open") coordinatorPorts.coordinatorInitialization = previousInitialization;
  }
}

async function __testAwaitCoordinatorPeerDrain(peerId: string): Promise<void> {
  await coordinatorPorts.coordinatorPeerState(peerId)?.drainPromise;
}

async function __testCloseCoordinatorBridgePeer(
  peerId: string,
  binding: CoordinatorSessionBinding,
): Promise<void> {
  const state = coordinatorPorts.coordinatorPeerState(peerId);
  if (!state) return;
  coordinatorPorts.coordinatorSessionClosed(peerId, binding);
  await state.drainPromise;
}

function __testHoldCoordinatorFifo(): () => void {
  const previous = coordinatorPorts.coordinatorRequestTail;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  coordinatorPorts.coordinatorRequestTail = previous.then(() => held);
  return release;
}

async function __testDispatchStorageMessage(clientId: string, request: CoordinatorClientRequest): Promise<void> {
  const sink = coordinatorPorts.coordinatorTestEventSinks.get(clientId);
  if (!sink) return;
  if (request.kind === "subscribe") {
    sink.topics.clear();
    for (const topic of request.topics) sink.topics.add(topic);
    const baselines = await coordinatorPorts.buildTopicBaselines({ topics: request.topics });
    sink.postMessage({
      requestId: request.requestId,
      sessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: { topics: request.topics, baselines } satisfies CoordinatorSubscribeTopicsResult,
    });
    return;
  }
  if (request.kind === "activity") {
    coordinatorPorts.handleActivity();
    return;
  }
  if (request.kind === "disconnect") {
    void coordinatorPorts.vaultWorkerKeys.hardwareConnections.closePeer(clientId);
    coordinatorPorts.revokedCoordinatorPeerIds.add(clientId);
    for (const pending of coordinatorPorts.storageWorkerRequests.storageRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of coordinatorPorts.channelWorkerRuntime.channelRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of coordinatorPorts.msfileWorkerRequests.msfileRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of coordinatorPorts.windowP2pWorkerRuntime.windowP2pExecutorIdentityRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const [grantId, grant] of coordinatorPorts.storageWorkerRequests.storageGrants) if (grant.clientId === clientId) coordinatorPorts.storageWorkerRequests.storageGrants.delete(grantId);
    for (const [grantId, grant] of coordinatorPorts.storageWorkerRequests.ownerStorageGrants) if (grant.clientId === clientId) coordinatorPorts.storageWorkerRequests.ownerStorageGrants.delete(grantId);
    // 浏览句柄绑定端口：断开即作废，不能留给重连后的页面继续用。
    coordinatorPorts.storageWorkerRequests.storageBrowseCoordinator.revokeClient(clientId);
    for (const [grantId, grant] of coordinatorPorts.storageWorkerRequests.platformStorageGrants) if (grant.clientId === clientId) coordinatorPorts.storageWorkerRequests.platformStorageGrants.delete(grantId);
    for (const [grantId, grant] of coordinatorPorts.msfileWorkerRequests.msfileGrants) if (grant.clientId === clientId) coordinatorPorts.msfileWorkerRequests.msfileGrants.delete(grantId);
    coordinatorPorts.coordinatorTestEventSinks.delete(clientId);
    return;
  }
  const response = await coordinatorPorts.processRequest(request, clientId);
  sink.postMessage(response);
}

function __testStorageQueueSnapshot(): { globalActive: number; queued: number; perPort: Record<string, number> } {
  return { globalActive: coordinatorPorts.storageWorkerRequests.storageDataQueue.snapshot().active, queued: coordinatorPorts.storageWorkerRequests.storageDataQueue.snapshot().queued, perPort: Object.fromEntries(coordinatorPorts.storageWorkerRequests.storagePortCounts) };
}

async function __testStorageSlotErrorCodes(): Promise<{ queueFull: string; queuedAbort: string; activeAbort: string }> {
  __testResetState();
  const releases: Array<() => void> = [];
  const active = [0, 1, 2].map(() => coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-test", () => new Promise<void>((resolve) => releases.push(resolve))));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queuedController = new AbortController();
  const queued = coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-test", async () => undefined, queuedController.signal).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  queuedController.abort();
  const waiting = Array.from({ length: STORAGE_DATA_MAX_QUEUE }, () => coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-test", async () => undefined));
  const queueFull = await coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-test", async () => undefined).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  const queuedAbort = await queued;
  releases.forEach((release) => release());
  await Promise.all([...active, ...waiting]);
  const activeController = new AbortController();
  let releaseActive!: () => void;
  const running = coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-active", () => new Promise<void>((resolve) => { releaseActive = resolve; }), activeController.signal).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeController.abort();
  const activeAbort = await running;
  releaseActive?.();
  return { queueFull, queuedAbort, activeAbort };
}

async function __testStorageCancelKeepsPhysicalSlots(): Promise<{
  activeAfterCancel: number;
  queuedAfterCancel: number;
  fifthStartedAfterCancel: boolean;
  activeDuringFifth: number;
  fifthStartedAfterPhysicalRelease: boolean;
  finalActive: number;
}> {
  __testResetState();
  const controllers = Array.from({ length: STORAGE_DATA_CONCURRENCY }, () => new AbortController());
  const releases: Array<() => void> = [];
  const canceledRpc = controllers.map((controller, index) => coordinatorPorts.storageWorkerRequests.withStorageDataSlot(
    `slot-cancel-${index}`,
    () => new Promise<void>((resolve) => { releases.push(resolve); }),
    controller.signal
  ).catch(() => undefined));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controllers.forEach((controller) => controller.abort());
  await Promise.all(canceledRpc);

  let fifthStarted = false;
  let releaseFifth!: () => void;
  const fifth = coordinatorPorts.storageWorkerRequests.withStorageDataSlot("slot-cancel-fifth", () => new Promise<void>((resolve) => {
    fifthStarted = true;
    releaseFifth = resolve;
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterCancel = __testStorageQueueSnapshot();
  releases.forEach((release) => release());
  for (let i = 0; i < 3 && !fifthStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const afterPhysicalRelease = __testStorageQueueSnapshot();
  releaseFifth();
  await fifth;
  return {
    activeAfterCancel: afterCancel.globalActive,
    queuedAfterCancel: afterCancel.queued,
    fifthStartedAfterCancel: fifthStarted && afterCancel.globalActive < STORAGE_DATA_CONCURRENCY,
    activeDuringFifth: afterPhysicalRelease.globalActive,
    fifthStartedAfterPhysicalRelease: fifthStarted,
    finalActive: __testStorageQueueSnapshot().globalActive
  };
}

function __testReadyWorkerUnit(unitId: string): void {
  const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find(candidate => candidate.unitId === unitId);
  const unit = descriptor?.scopeKind === "root" || descriptor?.scopeKind === "storage"
    ? coordinatorPorts.coordinatorWorkerUnitRegistry.activate(unitId)
    : coordinatorPorts.activateCoordinatorOwnerWorkerUnit(unitId);
  coordinatorPorts.coordinatorWorkerUnitRegistry.ready(unitId, unit.instanceId);
}

function __testRegisterTask(input: {
  id: string;
  /** 测试任务所属产品；已登记的真实任务省略时从 Worker 单元目录推导。 */
  pluginId?: string;
  /** 测试任务所属运行单元；省略时按产品生成 coordinator-worker 单元。 */
  unitId?: string;
  publicKeyHex: string;
  bsvNetwork: "main" | "test";
  keyScope?: NetworkIdentity | (() => NetworkIdentity | undefined);
  /** 同步策略；省略时为 fixed（不读取同步管理设置、不参与智能调度）。 */
  syncPolicy?: "managed" | "smart" | "fixed";
  intervalMs?: number;
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  const pluginId = input.pluginId ?? getCoordinatorWorkerUnitForTask(input.id)?.productId ?? "test";
  coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.set(input.id, coordinatorPorts.createCoordinatorTaskRuntime({
    id: input.id,
    pluginId,
    unitId: input.unitId,
    allowUncataloguedForTest: true,
    syncPolicy: input.syncPolicy,
    intervalMs: input.intervalMs,
    keyScope: input.keyScope ?? { bsvNetwork: input.bsvNetwork, publicKeyHex: input.publicKeyHex },
    run: input.run
  }));
}

async function __testRunTask(taskId: string): Promise<void> {
  await coordinatorPorts.executeTask(taskId, "test");
}

async function __testCancelByKey(identity: NetworkIdentity): Promise<boolean> {
  return coordinatorPorts.cancelTaskRuntimesByKey(identity);
}

function __testInvalidateSession(): void {
  coordinatorPorts.coordinatorState.sessionEpoch = coordinatorPorts.generateEpoch();
  coordinatorPorts.workerWalletState.publish();
}

function __testAdvanceWalletGeneration(): void {
  coordinatorPorts.coordinatorState.walletGeneration = `test-wallet-generation-${crypto.randomUUID()}`;
  coordinatorPorts.workerWalletState.publish();
}

async function __testBackgroundRunNow(taskId: string): Promise<CoordinatorResponse> {
  return coordinatorPorts.handleBackgroundRunNow(`test-${Date.now()}`, { kind: "background.run-now", taskId, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch });
}

async function __testUpdateScheduleSettings(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorResponse> {
  return coordinatorPorts.handleBackgroundSettingsUpdate(`test-${Date.now()}`, { kind: "background.settings.update", settings, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch });
}

async function __testUpdateAutolockSettings(settings: { timeoutMs: number }): Promise<CoordinatorResponse> {
  return coordinatorPorts.handleAutolockSettingsUpdate(`test-${Date.now()}`, { kind: "autolock.settings.update", settings, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch });
}

function __testGetAutolockTimeoutMs(): number {
  return coordinatorPorts.coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS;
}

function __testSetSmartSyncDebounceMs(ms: number): void {
  coordinatorPorts.backgroundWorkerRuntime.setDebounce(ms);
}

function __testNotifyWocQueueChange(snapshot: WocQueueSnapshot): void {
  coordinatorPorts.onWocQueueChanged(snapshot);
}

function __testSmartSyncState(): { pending: boolean; debounceMs: number } {
  return coordinatorPorts.backgroundWorkerRuntime.smartState();
}

function __testTriggerImmediateSync(reason = "unlock"): void {
  coordinatorPorts.triggerImmediateSync(reason);
}

async function __testReloadCoordinatorMeta(): Promise<void> {
  await coordinatorPorts.loadCoordinatorMeta();
}

async function __testSeedCoordinatorSettingsSnapshot(settings: unknown): Promise<void> {
  await coordinatorPorts.persistCoordinatorSettings(structuredClone(settings) as CoordinatorSettingsSnapshot);
}

function __testCoordinatorSnapshotMetrics(): Record<"settings", { revision: number; writes: number }> {
  return {
    settings: coordinatorPorts.snapshotWriteMetrics("coordinator.settings.persist"),
  };
}

async function __testRestartWorker(): Promise<void> {
  __testResetState();
  await coordinatorPorts.ensureCoordinatorAuthorityClaim();
  // reset 只清内存里的 Root 指针，没有关闭上一代快照句柄；直接读取会撞上
  // isCurrent 栅栏。重启语义要求旧句柄全部作废并从本地真值重新安装。
  coordinatorPorts.discardCurrentPlatformStorageBinding();
  if (coordinatorPorts.vaultWalletWorker.walletStore) {
    const coldStart = await coordinatorPorts.vaultWalletWorker.walletLifecycle?.coldStart();
    if (coldStart?.state === "ready") await coordinatorPorts.installPlatformStorage();
  }
  await coordinatorPorts.loadCoordinatorMeta();
  // 冷启动状态只由 meta 与固定 KeyHold 决定：ready = locked,uninitialized =
  // 还没有 Key；corrupt/unsupported 不得静默变成空钱包。
  const coldStart = await coordinatorPorts.vaultWalletWorker.walletLifecycle?.coldStart();
  coordinatorPorts.coordinatorState.vaultStatus = coldStart?.state === "ready"
    ? "locked"
    : coldStart?.state === "uninitialized" ? "uninitialized" : "fatal";
  coordinatorPorts.coordinatorState.activePublicKeyHex = undefined;
  coordinatorPorts.vaultWorkerKeys.dropActivePrivateKey();
}

async function __testClearCentralNamespace(moduleId: string): Promise<void> {
  if (!coordinatorPorts.storageWorkerRoot.root) throw new Error("Test platform storage is not ready");
  const normalizedModuleId = moduleId.toLowerCase();
  const declarations = Object.values(CENTRAL_STORAGE_DECLARATIONS).filter(
    (candidate) => candidate.moduleId === normalizedModuleId,
  );
  if (declarations.length === 0) throw new Error(`Unknown central module: ${moduleId}`);
  for (const declaration of declarations) {
    if (declaration.model !== "kv") continue;
    const store = await coordinatorPorts.storageWorkerRoot.root.openPlatformStore({ declaration });
    for (const partition of ["default", "settings", "suppliers", "policies", "usages"]) {
      for (; ;) {
        const page = await store.list({ partition, limit: 1000 });
        if (page.entries.length === 0) break;
        await store.commit({
          partition,
          ifRevision: page.revision,
          operations: page.entries.map((entry) => ({ type: "delete" as const, key: entry.key }))
        });
      }
    }
  }
}

async function __testSealLocalSecret(scope: string, plaintext: string): Promise<VaultSealedSecret> {
  const bytes = new TextEncoder().encode(plaintext);
  return await coordinatorPorts.vaultWorkerOperations.executeVaultOperation({ type: "sealLocalSecret", scope, plaintext: bytes }) as VaultSealedSecret;
}

async function __testOwnerStoragePut(path: string, bytes: Uint8Array): Promise<void> {
  const store = coordinatorPorts.createWorkerModuleFileStore("p2pkh", "");
  await store.put(path, bytes);
}

async function __testUnlock(password: string): Promise<CoordinatorResponse> {
  const response = await coordinatorPorts.processRequest({ kind: "unlock", password, requestId: `test-unlock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch });
  if (response.ack.status === "accepted" || response.ack.status === "already-unlocked") coordinatorPorts.testHarnessActivationSecret = password;
  return response;
}

function __testUnlockAtLifecycle(password: string): Promise<import("@keymaster/contracts").WalletUnlockResult> {
  return coordinatorPorts.vaultWalletWorker.requireWalletLifecycle().unlock(password);
}

async function __testChangePassword(oldPassword: string, newPassword: string): Promise<unknown> {
  return coordinatorPorts.vaultWorkerOperations.executeVaultOperation({ type: "changePassword", oldPassword, newPassword });
}

async function __testLock(cleanup?: Extract<CoordinatorClientRequest, { kind: "lock" }>["cleanup"], peerId = "test"): Promise<CoordinatorResponse> {
  const response = await coordinatorPorts.processRequest({ kind: "lock", requestId: `test-lock-${Date.now()}`, clientId: peerId, expectedSessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch, cleanup });
  if (!cleanup) await coordinatorPorts.globalLockRunning;
  return response;
}

function __testGetVaultStatus(): CoordinatorVaultStatus {
  return coordinatorPorts.coordinatorState.vaultStatus;
}

function __testGetActivePublicKeyHex(): string | undefined {
  return coordinatorPorts.coordinatorState.activePublicKeyHex;
}

async function __testBootstrapWalletStorage(): Promise<WalletColdStartSnapshot> {
  await coordinatorPorts.ensureCoordinatorAuthorityClaim();
  await coordinatorPorts.vaultWalletWorker.bootstrapWalletStorage();
  const coldStart = coordinatorPorts.vaultWalletWorker.storageColdStartState ?? await coordinatorPorts.vaultWalletWorker.walletLifecycle?.coldStart();
  coordinatorPorts.coordinatorState.walletGeneration = coldStart?.state === "ready"
    ? coldStart.meta?.walletGeneration ?? ""
    : "";
  if (coldStart?.state === "ready") {
    // 已解锁的会话不能被幂等 bootstrap 顺带锁掉：调用方按需重复 bootstrap
    // 是正常用法（例如先冷启动、再导入第二把 Key 观察拒绝路径），被拒绝的
    // 请求不得留下「会话已撤销」的副作用。这里只在没有活动身份时回到锁定
    // 投影，保持与生产冷启动一致的 fail closed 默认值。
    if (coordinatorPorts.coordinatorState.vaultStatus !== "unlocked") {
      coordinatorPorts.coordinatorState.vaultStatus = "locked";
      coordinatorPorts.coordinatorState.activePublicKeyHex = undefined;
    }
    await coordinatorPorts.ensureStorageRuntime();
    await coordinatorPorts.ensureCoordinatorTasksRegistered();
    for (const runtime of coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.values()) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
    }
  } else if (coldStart?.state === "uninitialized") {
    coordinatorPorts.coordinatorState.walletGeneration = "";
    coordinatorPorts.coordinatorState.vaultStatus = "uninitialized";
  }
  coordinatorPorts.storageWorkerRoot.failed = false;
  coordinatorPorts.emitStorageState();
  return coldStart ?? { state: "uninitialized" };
}

async function __testColdStart(): Promise<WalletColdStartSnapshot> {
  return await (coordinatorPorts.vaultWalletWorker.walletLifecycle ?? coordinatorPorts.vaultWalletWorker.requireWalletLifecycle()).coldStart();
}

async function __testColdBootCoordinator(): Promise<CoordinatorStorageStateEvent | undefined> {
  __testResetState();
  coordinatorPorts.discardCurrentPlatformStorageBinding();
  await coordinatorPorts.initializeCoordinator();
  await coordinatorPorts.storageWorkerRoot.stateTail;
  return coordinatorPorts.storageWorkerRoot.lastState;
}

async function __testResetWalletStore(): Promise<void> {
  __testResetState();
  const store = coordinatorPorts.vaultWalletWorker.walletStore;
  if (store) await store.resetWallet().catch(() => undefined);
  coordinatorPorts.discardCurrentPlatformStorageBinding();
  coordinatorPorts.vaultWalletWorker.walletStore = undefined;
  coordinatorPorts.vaultWalletWorker.walletKeys = undefined;
  coordinatorPorts.vaultWalletWorker.walletLifecycle = undefined;
  coordinatorPorts.vaultWalletWorker.storageColdStartState = undefined;
  coordinatorPorts.coordinatorState.walletGeneration = "";
  coordinatorPorts.coordinatorState.vaultStatus = "uninitialized";
  coordinatorPorts.coordinatorState.activePublicKeyHex = undefined;
}

async function __testSeedWalletLocalRecords(input: {
  /** meta 原文；省略表示不改动 `.keymaster/meta`。 */
  meta?: string;
  /** `key.json` 原文；省略表示不改动固定 KeyHold 路径。 */
  keyHold?: string;
  /** 删除固定 KeyHold 路径，构造「缺少唯一 KeyHold」。 */
  deleteKeyHold?: boolean;
}): Promise<void> {
  const store = coordinatorPorts.vaultWalletWorker.walletStore;
  if (!store) throw new Error("Test wallet store is not ready");
  if (input.meta !== undefined) {
    await store.put(WALLET_META_PATH, new TextEncoder().encode(input.meta));
  }
  if (input.keyHold !== undefined) {
    await store.put(WALLET_KEYHOLD_PATH, new TextEncoder().encode(input.keyHold));
  }
  if (input.deleteKeyHold) await store.delete(WALLET_KEYHOLD_PATH).catch(() => undefined);
}

async function __testListWalletObjectPaths(): Promise<string[]> {
  const store = coordinatorPorts.vaultWalletWorker.walletStore;
  if (!store) throw new Error("Test wallet store is not ready");
  const paths: string[] = [];
  let cursor: string | undefined;
  for (; ;) {
    const page = await store.list({ limit: WALLET_LIST_MAX_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
    paths.push(...page.objects.map((object) => object.path));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return paths.sort();
}
export { __testCollectCoordinatorKeyValueGarbage, __testSeedCoordinatorKeyValueGarbage, __testBuildChannelPublicMessageTimes, __testBuildChannelSeenMessageKey, __testFailNextP2pkhSettingWrite, __testCoordinatorRuntimePlugin, __testEncodeChannelPrivateBody, __testValidateChannelPrivateProtocol, __testSignChannelPrivateMessage, __testGetSnapshot, __testGetMsfileSellerLifecycle, __testSetMsfileSellerBridge, __testDispatchMsfileSellerHashRequest, __testMsfileSellerSessionCount, __testMsfileStoreSeed, __testMsfileOwnerStorageWrite, __testMsfileOwnerStorageDelete, __testSetCoordinatorPeerHandoffNotifier, __testFenceCoordinatorAuthority, __testHoldCoordinatorFinalIoLease, __testGetCoordinatorUpgradePartition, __testResetState, __testSetVaultStatus, __testSetP2pkhBroadcastProvider, __testSetP2pkhUnspentAllProvider, __testSetSatBroadcastRetryOverrides, __testSetChainHeightProvider, __testGetChainHeight, __testResetChainHeight, __testReadBitfsBlockHeight, __testRegisterRealCoordinatorTasks, __testEnsureSatP2pkhService, __testEnsureSatRuntime, __testReleaseSatRuntime, __testAwaitMsfileSellerDependencyResume, __testFailNextCoordinatorSnapshotPersist, __testP2pkhProviderConfigUpdate, __testP2pkhProviderConfigGet, __testSeedP2pkhLocalSubmission, __testFinishP2pkhLocalSubmission, __testSetP2pkhChainResolution, __testListP2pkhLocalTransactions, __testListP2pkhLocalInputClaims, __testP2pkhBroadcast, __testGetConnectedPortCount, __testSetStorageSessionResolver, __testSetStorageRuntime, __testSetStorageStartupFailure, __testReleaseStorageRuntime, __testStorageMutationBarrierProbe, __testDispatchStorageGrant, __testResolveStorageGrant, __testSetMsfileRuntimeOverride, __testSetMsfileReadConcurrencySettings, __testDispatchMsfileControl, __testDispatchMsfileGrant, __testDispatchMsfileData, __testDispatchMsfileSessionAbort, __testDispatchMsfileControlWithEpoch, __testAcquireExecutorLease, __testWindowP2pInboundBridgePressure, __testWindowP2pResponseBridgePressure, __testForumRoundtripBridgePressure, __testStartSatInboundHandler, __testCancelSatInboundHandler, __testRevokeWindowP2pExecutorLease, __testChangeSatInboundGeneration, __testSatInboundHandlerSnapshot, __testSetSatInboundResponseDispatcher, __testPublishSatState, __testReleaseExecutorLease, __testExecutorSignNoise, __testExecutorSignPeerRecord, __testReleaseMsfileRuntime, __testDispatchStorageData, __testDispatchStorageControl, __testDispatchStorageBrowseOpen, __testHasStorageBrowseAuthorization, __testSeedStorageRequest, __testDispatchStorageCancel, __testDispatchStorageAbort, __testStorageQueueAdmission, __testPublishStorageState, __testStorageFairDispatch, __testStorageTransfer, __testAttachPort, __testInstallCoordinatorBridgePeer, __testHandleCoordinatorSessionRpc, __testAwaitCoordinatorPeerDrain, __testCloseCoordinatorBridgePeer, __testHoldCoordinatorFifo, __testDispatchStorageMessage, __testStorageQueueSnapshot, __testStorageSlotErrorCodes, __testStorageCancelKeepsPhysicalSlots, __testReadyWorkerUnit, __testRegisterTask, __testRunTask, __testCancelByKey, __testInvalidateSession, __testAdvanceWalletGeneration, __testBackgroundRunNow, __testUpdateScheduleSettings, __testUpdateAutolockSettings, __testGetAutolockTimeoutMs, __testSetSmartSyncDebounceMs, __testNotifyWocQueueChange, __testSmartSyncState, __testTriggerImmediateSync, __testReloadCoordinatorMeta, __testSeedCoordinatorSettingsSnapshot, __testCoordinatorSnapshotMetrics, __testRestartWorker, __testClearCentralNamespace, __testSealLocalSecret, __testOwnerStoragePut, __testUnlock, __testUnlockAtLifecycle, __testChangePassword, __testLock, __testGetVaultStatus, __testGetActivePublicKeyHex, __testBootstrapWalletStorage, __testColdStart, __testColdBootCoordinator, __testResetWalletStore, __testSeedWalletLocalRecords, __testListWalletObjectPaths };
export const createMsfileBitfsBuyerTask = coordinatorPorts.createMsfileBitfsBuyerTask;
export const prepareMsfileBitfsFundingSplit = coordinatorPorts.prepareMsfileBitfsFundingSplit;
export const recoverMsfileBitfsFundingSplit = coordinatorPorts.recoverMsfileBitfsFundingSplit;

function createCoordinatorChainHeightTask(woc: WocService) {
  return coordinatorPorts.wocWorkerRuntime.heightTask(coordinatorPorts.bitfsNetwork,
    (network, signal) => coordinatorPorts.testChainHeightProvider ? coordinatorPorts.testChainHeightProvider(network) : woc.getChainHeight(network, { priority: "background", signal }));
}

async function installP2pkhCoordinatorTasks(walletState: VaultWalletState, woc: WocService, assertActive: () => void = () => { }, storage: BorrowedModuleFileStore = coordinatorPorts.createWorkerModuleFileStore("p2pkh", "")): Promise<() => void> {
  const epoch = coordinatorPorts.coordinatorState.sessionEpoch;
  for (const id of ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"]) {
    await coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.get(id)?.completion?.catch(() => undefined);
  }
  assertActive();
  if (coordinatorPorts.coordinatorState.sessionEpoch !== epoch) throw new Error("P2PKH task installation became stale");
  const definitions = createP2pkhWorkerTaskDefinitions({
    walletState, woc, storage,
    isNetworkEnabled: network => network === coordinatorPorts.vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork,
    loadSettings: coordinatorPorts.loadP2pkhSettingForOwner,
    refreshUtxos: signal => coordinatorPorts.refreshP2pkhUtxoSnapshots(signal, storage, assertActive),
    emitDataChanged: (kinds, utxoSeqs) => coordinatorPorts.publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: coordinatorPorts.coordinatorState.activePublicKeyHex ?? "", kinds, ...(utxoSeqs === undefined ? {} : { utxoSeqs }) }),
  });
  for (const definition of definitions) {
    coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.set(definition.id, coordinatorPorts.createCoordinatorTaskRuntime({
      id: definition.id, pluginId: definition.pluginId, unitId: definition.unitId,
      syncPolicy: definition.syncPolicy,
      ...(definition.syncPolicy === "managed" ? { intervalMs: coordinatorPorts.managedIntervalFor(definition.id) } : {}),
      keyScope: definition.keyScope,
      run: async context => { await definition.run({ ...context, reportProgress: () => undefined }); },
    }));
  }
  const tasks = ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"].map(id => coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.get(id)!);
  for (const task of tasks) coordinatorPorts.scheduleRuntime(task);
  return () => {
    for (const task of tasks) {
      task.controller?.abort();
      if (task.timer) clearTimeout(task.timer);
      const remove = () => { if (coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.get(task.id) === task) coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.delete(task.id); };
      if (task.completion) void task.completion.then(remove, remove);
      else remove();
    }
  };
}

async function installCoordinatorDomainTask(task: import("@keymaster/contracts").BackgroundTaskDefinition & { unitId: string; syncPolicy?: "managed" | "smart" | "fixed" }, pluginId: string, assertActive: () => void): Promise<() => Promise<void>> {
  if (task.pluginId !== pluginId) throw new Error("Task owner does not match plugin");
  return (await coordinatorPorts.backgroundWorkerRuntime.register(task, assertActive)).dispose;
}

async function installContactsCoordinatorService(walletState: VaultWalletState, storage: BorrowedModuleFileStore, vault: { status(): string }, assertActive: () => void, ownCleanup: (cleanup: () => void) => void = () => { }, channel: ContactsPresenceChannel = coordinatorPorts.channelWorkerRuntime.createCoordinatorChannelRuntime()): Promise<() => Promise<void>> {
  const instance = await coordinatorPorts.contactsWorkerRuntime.install({ walletState, storage, channel, messageBus: coordinatorDomainMessageBus, assertActive, ownCleanup });
  return instance.dispose;
}

function initializeCoordinatorWocService(): ReturnType<typeof createWocService> {
  if (!coordinatorDomainMessageBus) throw new Error("Worker message bus is unavailable");
  const service = coordinatorPorts.wocWorkerRuntime.createService(coordinatorDomainMessageBus);
  service.onQueueChange(coordinatorPorts.onWocQueueChanged);
  coordinatorPorts.p2pkhWocService = service;
  return service;
}

async function registerCoordinatorDomainFixtures(): Promise<void> {
  const walletState = coordinatorPorts.createWorkerWalletState();
  const messageBus = createMessageBus();
  coordinatorDomainMessageBus = messageBus;
  if (coordinatorPorts.testDomainUnitReadiness) await installContactsCoordinatorService(walletState, coordinatorPorts.createWorkerModuleFileStore("contacts", "address-book"), { status: () => coordinatorPorts.coordinatorState.vaultStatus }, () => { });
  const woc = coordinatorPorts.testDomainUnitReadiness ? initializeCoordinatorWocService() : undefined;
  if (woc) coordinatorPorts.initializeCoordinatorP2pkhProviders(woc, woc);
  if (coordinatorPorts.testDomainUnitReadiness && woc) await installCoordinatorDomainTask(createCoordinatorChainHeightTask(woc), "woc", () => { });
  if (coordinatorPorts.testDomainUnitReadiness && woc) await installP2pkhCoordinatorTasks(walletState, woc);
  const p2pkhProvider = createP2pkhWorkerAssetReader({ walletState, storage: coordinatorPorts.createWorkerModuleFileStore("p2pkh", ""), snapshots: () => coordinatorPorts.p2pkhWorkerRuntime.snapshots(), bsvNetwork: () => coordinatorPorts.vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork });
  const vault = { status: () => coordinatorPorts.coordinatorState.vaultStatus, } as VaultService;
  if (coordinatorPorts.testDomainUnitReadiness && woc) {
    const bsv21Task = createBsv21CoordinatorTask({ walletState, stateStore: coordinatorPorts.createWorkerKeyValueStore("token-bsv21", "token-state"), p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => coordinatorPorts.publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
    const stasTask = createStasCoordinatorTask({ walletState, stateStore: coordinatorPorts.createWorkerKeyValueStore("token-stas", "token-state"), p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => coordinatorPorts.publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
    const oneSatTask = createOrdinalsCoordinatorTask({ walletState, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => coordinatorPorts.publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
    coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.set(bsv21Task.id, coordinatorPorts.createCoordinatorTaskRuntime({ id: bsv21Task.id, pluginId: "token-bsv21", unitId: bsv21Task.unitId, syncPolicy: "managed", intervalMs: coordinatorPorts.managedIntervalFor(bsv21Task.id), keyScope: () => coordinatorPorts.coordinatorState.activePublicKeyHex ? coordinatorPorts.vaultWorkerKeys.requireCoordinatorNetworkIdentity() : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
    coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.set(stasTask.id, coordinatorPorts.createCoordinatorTaskRuntime({ id: stasTask.id, pluginId: "token-stas", unitId: stasTask.unitId, syncPolicy: "managed", intervalMs: coordinatorPorts.managedIntervalFor(stasTask.id), keyScope: () => coordinatorPorts.coordinatorState.activePublicKeyHex ? coordinatorPorts.vaultWorkerKeys.requireCoordinatorNetworkIdentity() : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
    coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.set(oneSatTask.id, coordinatorPorts.createCoordinatorTaskRuntime({ id: oneSatTask.id, pluginId: "collectible-1satordinals", unitId: oneSatTask.unitId, syncPolicy: "managed", intervalMs: coordinatorPorts.managedIntervalFor(oneSatTask.id), keyScope: () => coordinatorPorts.coordinatorState.activePublicKeyHex ? coordinatorPorts.vaultWorkerKeys.requireCoordinatorNetworkIdentity() : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  }
  coordinatorPorts.bindCoordinatorTaskUnitsToOwner();
  for (const runtime of coordinatorPorts.backgroundWorkerRuntime.taskRuntimes.values()) coordinatorPorts.scheduleRuntime(runtime);
  coordinatorPorts.publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorPorts.coordinatorState.sessionEpoch, snapshots: coordinatorPorts.getTaskSnapshots() });
  // 任务在「已解锁」状态下补齐注册（首次接入存储等）时，第一时间同步一次。
  coordinatorPorts.triggerImmediateSync(BACKGROUND_TRIGGER_REASON.INIT);
}
coordinatorPorts.domainFixtureInstaller = registerCoordinatorDomainFixtures;

let coordinatorDomainMessageBus: ReturnType<typeof createMessageBus> | undefined;
