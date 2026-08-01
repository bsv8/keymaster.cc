// apps/web/src/keymasterSessionCoordinator.worker.ts
// Keymaster Session Coordinator SharedWorker
//
// 设计缘由（施工单 002）：
//   - 所有 Keymaster 主页面 tab 共享同一个 SharedWorker 中的 Vault 会话
//   - 私钥只在 Worker 内存中，永不离开
//   - 删除所有多 tab 竞争机制（leader 选举、BroadcastChannel 等）
//   - sessionEpoch 是每个异步操作的世代栅栏
//
// 关键约束：
//   - 不得 import React、页面 shell 或 plugin manifest
//   - 只暴露 onconnect / MessagePort 协议
//   - Worker 重启后必为 locked，禁止恢复为 unlocked

import type {
  SessionEpoch,
  CoordinatorVaultStatus,
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorTopicEvent,
  CoordinatorBootstrapSnapshot,
  CoordinatorTopic,
  CoordinatorCommandAck,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorBackgroundSyncSettings,
  CoordinatorTaskSnapshot,
  CoordinatorVaultOperation,
  CoordinatorSubscribeTopicsResult,
  AssetDataInvalidationEvent,
  SessionStateEvent,
} from "@keymaster/contracts";
import { vaultDb, type VaultMetaRecord, type VaultKeyRecord, deriveKey, verifyVerifier, hexToBytes as cryptoHexToBytes, base64ToBytes, bytesToHex, decryptBytesWithAad, vaultKeyAad, deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, sealAppMessageLocalBytes, openAppMessageLocalBytes, encryptVerifier, buildVaultMeta, encryptVaultKeyMaterial, resolveVaultPasswordKey, decryptVaultKeyMaterialForMigration, encryptBytes, decryptBytes, buildKeyBackupEnvelope, passwordBackupView, encryptMaterialWithPasskey, decryptMaterialWithPasskey, toPasskeySummary } from "@keymaster/plugin-vault/coordinator";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import { createMessageBus } from "@keymaster/runtime/messageBus";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService } from "@keymaster/plugin-woc/coordinator";
import { createP2pkhCoordinatorTasks, openP2pkhDb, createP2pkhDb } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import type { KeyspaceService, VaultService, WocService } from "@keymaster/contracts";

// Vault DB 操作（Worker 内可直接访问 IndexedDB）
async function getVaultMeta(): Promise<VaultMetaRecord | undefined> {
  return vaultDb.getMeta();
}

async function getActiveKey(): Promise<VaultKeyRecord | undefined> {
  const activePublicKeyHex = coordinatorMeta.activePublicKeyHex;
  if (activePublicKeyHex) return vaultDb.getKey(activePublicKeyHex);
  const keys = await vaultDb.listKeys();
  return keys[0];
}

// 密码验证逻辑（简化版，实际需要导入 crypto 模块）
async function verifyPassword(password: string, meta: VaultMetaRecord): Promise<boolean> {
  const salt = decodePersisted(meta.saltB64);
  const key = await deriveKey(password, salt);
  return verifyVerifier(key, {
    salt: decodePersisted(meta.verifierSaltB64),
    iv: decodePersisted(meta.verifierIvB64),
    ciphertext: decodePersisted(meta.verifierCipherB64),
    version: meta.cryptoVersion
  });
}

async function decryptPrivateKey(passwordKey: CryptoKey, record: VaultKeyRecord): Promise<Uint8Array> {
  const bytes = await decryptBytesWithAad(passwordKey, {
    salt: decodePersisted(record.cipherSaltB64), iv: decodePersisted(record.cipherIvB64), ciphertext: decodePersisted(record.cipherB64)
  }, record.cipherVersion === "v2" ? vaultKeyAad(record.publicKeyHex) : undefined);
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { hex: string };
  const privateKey = cryptoHexToBytes(parsed.hex);
  verifySessionKeyPair({ publicKeyHex: record.publicKeyHex, privateKeyBytes: privateKey });
  return privateKey;
}

function decodePersisted(value: string): Uint8Array {
  try { return cryptoHexToBytes(value); } catch { return base64ToBytes(value); }
}

interface CoordinatorMetaRecord { id: "singleton"; activePublicKeyHex?: string; generation: number; scheduleSettings?: CoordinatorBackgroundSyncSettings; }
const coordinatorMeta: CoordinatorMetaRecord = { id: "singleton", generation: 0, scheduleSettings: { assetHoldingsIntervalMs: 900_000 } };
async function loadCoordinatorMeta(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.open("keymaster.session-coordinator", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("meta", { keyPath: "id" });
    req.onsuccess = () => { const db = req.result; const get = db.transaction("meta", "readonly").objectStore("meta").get("singleton"); get.onsuccess = () => { Object.assign(coordinatorMeta, get.result ?? {}); if (coordinatorMeta.scheduleSettings) coordinatorState.scheduleSettings = coordinatorMeta.scheduleSettings; resolve(); }; get.onerror = () => resolve(); };
    req.onerror = () => resolve();
  });
}
async function persistCoordinatorMeta(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.open("keymaster.session-coordinator", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta", { keyPath: "id" });
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(coordinatorMeta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    };
    req.onerror = () => resolve();
  });
}
const persistActiveMeta = persistCoordinatorMeta;
function publishSessionState(cause: SessionStateEvent["cause"]): void {
  publishTopicEvent("session.state", {
    type: "session.state.changed",
    cause,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
  });
}

// ============================================================
// 1. Coordinator State
// ============================================================

interface CoordinatorState {
  sessionEpoch: SessionEpoch;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  activePrivateKeyBytes?: Uint8Array;
  passwordKey?: CryptoKey;
  keyspaceGeneration: number;
  taskRuntimes: Map<string, TaskRuntime>;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockDeadline?: number;
  lastActivityAt: number;
}

interface TaskRuntime {
  id: string;
  pluginId: string;
  state: "idle" | "queued" | "running" | "blocked";
  controller?: AbortController;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: string;
  timer?: ReturnType<typeof setTimeout>;
  keyScope?: { publicKeyHex: string; label?: string } | (() => { publicKeyHex: string; label?: string } | undefined);
  intervalMs?: number;
  run?: (context: { signal: AbortSignal; reason: string; reportProgress(progress: unknown): void; assertSessionFresh(): void }) => Promise<void>;
  startedEpoch?: SessionEpoch;
  startedGeneration?: number;
  startedPublicKeyHex?: string;
  completion?: Promise<void>;
}

interface ConnectedPort {
  port: MessagePort;
  clientId: string;
  subscriptions: Set<CoordinatorTopic>;
  lastSeenAt: number;
}

// ============================================================
// 2. Worker Global State
// ============================================================

const coordinatorState: CoordinatorState = {
  sessionEpoch: generateEpoch(),
  vaultStatus: "booting",
  keyspaceGeneration: 0,
  taskRuntimes: new Map(),
  scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
  lastActivityAt: Date.now(),
};

const connectedPorts = new Map<string, ConnectedPort>();
const PASSKEY_ADD_INTENT_TTL_MS = 120_000;
const passkeyAddIntents = new Map<string, {
  publicKeyHex: string;
  sessionEpoch: SessionEpoch;
  label: string;
  expiresAt: number;
}>();
function prunePasskeyAddIntents(now = Date.now()): void {
  for (const [intentId, intent] of passkeyAddIntents) {
    if (intent.expiresAt <= now) passkeyAddIntents.delete(intentId);
  }
  while (passkeyAddIntents.size >= 32) {
    const oldestIntentId = passkeyAddIntents.keys().next().value as string | undefined;
    if (!oldestIntentId) break;
    passkeyAddIntents.delete(oldestIntentId);
  }
}
let sessionRevision = 0;
let backgroundSnapshotRevision = 0;
let assetDataRevision = 0;
function resolveKeyScope(runtime: TaskRuntime): { publicKeyHex: string; label?: string } | undefined { return typeof runtime.keyScope === "function" ? runtime.keyScope() : runtime.keyScope; }
function scheduleRuntime(runtime: TaskRuntime): void { if (!runtime.intervalMs) return; if (runtime.timer) clearTimeout(runtime.timer); runtime.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString(); runtime.timer = setTimeout(() => { runtime.timer = undefined; void executeTask(runtime.id, "interval"); }, runtime.intervalMs); }
function assertTaskFresh(taskId: string): void {
  const runtime = coordinatorState.taskRuntimes.get(taskId);
  if (!runtime || runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    throw new Error("stale task session epoch");
  }
}

/**
 * 统一进入 unlocked 状态。
 * 设计缘由：unlock、创建首把 key、导入首把 key 共用状态写入、任务恢复、快照广播和自动锁定启动。
 */
async function enterUnlockedState(
  passwordKey: CryptoKey,
  activePublicKeyHex: string,
  activePrivateKeyBytes: Uint8Array,
  cause: SessionStateEvent["cause"]
): Promise<void> {
  // 更新状态
  coordinatorState.vaultStatus = "unlocked";
  coordinatorState.sessionEpoch = generateEpoch();
  passkeyAddIntents.clear();
  coordinatorState.activePublicKeyHex = activePublicKeyHex;
  coordinatorState.passwordKey = passwordKey;
  coordinatorState.activePrivateKeyBytes = activePrivateKeyBytes;
  coordinatorMeta.activePublicKeyHex = activePublicKeyHex;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();

  // 恢复所有 blocked 任务为 idle 并重新调度
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.state === "blocked" && runtime.blockedReason === "Vault is locked") {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      scheduleRuntime(runtime);
    }
  }

  publishSessionState(cause);

  // 广播任务快照
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 启动自动锁定计时器
  resetAutoLockTimer();
}

function createWorkerKeyspace(): KeyspaceService {
  const active = () => ({ activePublicKeyHex: coordinatorState.activePublicKeyHex });
  const storageName = (key: string, pluginId: string, storageId: string) => `keymaster.key.${key}.plugin.${pluginId}.${storageId}`;
  return {
    listKeys: async () => (await vaultDb.listKeys()).map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt })),
    getKey: async (publicKeyHex) => { const key = await vaultDb.getKey(publicKeyHex); return key ? { publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt } : undefined; },
    active,
    setActive: async (publicKeyHex) => { await executeVaultOperation({ type: "setActive", publicKeyHex }); },
    requireActiveKey: () => { if (!coordinatorState.activePublicKeyHex) throw new Error("No active key"); return { publicKeyHex: coordinatorState.activePublicKeyHex, label: "", capabilities: ["p2pkh"], createdAt: "" }; },
    onActiveKeyChanged: () => () => undefined,
    openKeyStorage: async (input) => { const name = storageName(input.publicKeyHex, input.pluginId, input.storageId); const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(name, input.version); req.onupgradeneeded = () => input.upgrade(req.result, req.transaction?.db.version ?? 0, input.version); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); return { db, name, close: () => db.close() }; },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async (input) => { await executeVaultOperation({ type: "deleteKey", ...input }); },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}

async function registerCoordinatorTasks(): Promise<void> {
  const keyspace = createWorkerKeyspace();
  const messageBus = createMessageBus();
  const woc = createWocService({ messageBus });
  const emitDataChanged = (providerId: string, kinds: AssetDataInvalidationEvent["kinds"]) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId, publicKeyHex: coordinatorState.activePublicKeyHex ?? "", kinds });
  const p2pkh = createP2pkhCoordinatorTasks({ keyspace, woc, messageBus, assertSessionFresh: (kind) => assertTaskFresh(kind === "recent" ? "p2pkh.recent-sync" : "p2pkh.history-backfill") });
  // 使用恢复后的配置，而非固定值
  const assetHoldingsIntervalMs = coordinatorState.scheduleSettings.assetHoldingsIntervalMs;
  coordinatorState.taskRuntimes.set("p2pkh.recent-sync", { id: "p2pkh.recent-sync", pluginId: "p2pkh", state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => { const result = await p2pkh.recent(signal); assertSessionFresh(); if (result.committed && !result.cancelled) emitDataChanged("p2pkh", ["resource", "utxo", "history"]); } });
  coordinatorState.taskRuntimes.set("p2pkh.history-backfill", { id: "p2pkh.history-backfill", pluginId: "p2pkh", state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => { const result = await p2pkh.backfill(signal); assertSessionFresh(); if (result.committed && !result.cancelled) emitDataChanged("p2pkh", ["history"]); } });
  const p2pkhProvider = {
    listResources: async (assetId: "bsv" | "bsvtest") => {
      if (!coordinatorState.activePublicKeyHex) return [];
      const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: coordinatorState.activePublicKeyHex }));
      return (await db.listResourcesByKey()).filter((resource) => assetId === (resource.network === "main" ? "bsv" : "bsvtest"));
    },
    listUtxos: async (filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }) => {
      const ownerPublicKeyHex = filter?.ownerPublicKeyHex ?? coordinatorState.activePublicKeyHex;
      if (!ownerPublicKeyHex) return [];
      const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: ownerPublicKeyHex }));
      const utxos = await db.listUtxos();
      return utxos.filter((utxo) => {
        if (filter?.assetId && filter.assetId !== (utxo.network === "main" ? "bsv" : "bsvtest")) return false;
        return true;
      });
    },
    getGlobalSettings: () => ({ includeTestnet: false })
  };
  const vault = { status: () => coordinatorState.vaultStatus, } as VaultService;
  const bsv21Task = createBsv21CoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const stasTask = createStasCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const oneSatTask = createOrdinalsCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  coordinatorState.taskRuntimes.set(bsv21Task.id, { id: bsv21Task.id, pluginId: bsv21Task.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  coordinatorState.taskRuntimes.set(stasTask.id, { id: stasTask.id, pluginId: stasTask.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  coordinatorState.taskRuntimes.set(oneSatTask.id, { id: oneSatTask.id, pluginId: oneSatTask.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  for (const runtime of coordinatorState.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
}

// ============================================================
// 3. Utility Functions
// ============================================================

function generateEpoch(): SessionEpoch {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================
// 4. Port Management
// ============================================================

function handlePortConnect(event: MessageEvent): void {
  const port = event.ports[0];
  if (!port) return;

  const clientId = generateClientId();
  const connectedPort: ConnectedPort = {
    port,
    clientId,
    subscriptions: new Set(),
    lastSeenAt: Date.now(),
  };

  connectedPorts.set(clientId, connectedPort);

  port.onmessage = (msgEvent: MessageEvent<CoordinatorClientRequest>) => {
    handleClientMessage(clientId, msgEvent.data);
  };

  port.onmessageerror = () => {
    handlePortDisconnect(clientId);
  };

  port.start();

  // 发送初始状态
  sendToPort(port, {
    requestId: "hello",
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
  });
}

function handlePortDisconnect(clientId: string): void {
  connectedPorts.delete(clientId);
  // 最后一个 port 断开时，Worker 生命周期结束即内存消失
  // 不主动锁定，等待浏览器回收或重启
}

// ============================================================
// 5. Message Handling
// ============================================================

async function handleClientMessage(
  clientId: string,
  request: CoordinatorClientRequest
): Promise<void> {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;

  connectedPort.lastSeenAt = Date.now();

  if (request.kind === "hello") {
    handleHello(clientId, request);
    return;
  }

  if (request.kind === "subscribe") {
    handleSubscribe(clientId, request);
    return;
  }

  if (request.kind === "activity") {
    handleActivity(clientId);
    return;
  }

  // lock 是收敛型的安全操作：即使发起页面持有旧 epoch，也必须能够锁定
  // 当前全局会话。其余命令仍由 epoch 栅栏拒绝，避免旧页面操作新会话。
  if (request.kind !== "lock" && "expectedSessionEpoch" in request && request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    sendToPort(connectedPort.port, { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } });
    return;
  }

  const response = await processRequest(request);
  sendToPort(connectedPort.port, response);
}

function handleHello(
  clientId: string,
  request: { kind: "hello"; clientId: string; requestId: string }
): void {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;

  connectedPort.clientId = request.clientId;

  // 发送完整快照
  sendToPort(connectedPort.port, {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: buildSnapshot()
  });
}

function handleSubscribe(
  clientId: string,
  request: { kind: "subscribe"; topics: CoordinatorTopic[]; requestId: string }
): void {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;

  connectedPort.subscriptions.clear();
  for (const topic of request.topics) {
    connectedPort.subscriptions.add(topic);
  }

  const baselines = request.topics.flatMap((topic) => {
    if (topic === "asset.data-changed") return [];
    const baselineRevision = topic === "session.state" ? sessionRevision : backgroundSnapshotRevision;
    const snapshot = topic === "session.state"
      ? { topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null, keyspaceGeneration: coordinatorState.keyspaceGeneration }
        : { topic, type: "background.snapshot.changed" as const, backgroundSnapshotRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots(), scheduleSettings: coordinatorState.scheduleSettings };
    return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot }];
  });

  sendToPort(connectedPort.port, {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: { topics: request.topics, baselines } satisfies CoordinatorSubscribeTopicsResult,
  });
}

function handleActivity(clientId: string): void {
  coordinatorState.lastActivityAt = Date.now();
  resetAutoLockTimer();
}

// ============================================================
// 6. Request Processing
// ============================================================

async function processRequest(
  request: CoordinatorClientRequest
): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();

  if (request.kind !== "lock" && "expectedSessionEpoch" in request) {
    if (
      request.expectedSessionEpoch !== coordinatorState.sessionEpoch &&
      request.expectedSessionEpoch !== "boot" &&
      request.expectedSessionEpoch !== "locked"
    ) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "stale-epoch" },
      };
    }
  }

  try {
    switch (request.kind) {
      case "unlock":
        return await handleUnlock(requestId, request);
      case "lock":
        return await handleLock(requestId, request);
      case "activate-key":
        return await handleActivateKey(requestId, request);
      case "vault.operation":
        return await handleVaultOperation(requestId, request);
      case "crypto":
        return await handleCrypto(requestId, request);
      case "background.run-now":
        return await handleBackgroundRunNow(requestId, request);
      case "background.trigger":
        return await handleBackgroundTrigger(requestId, request);
      case "background.cancel":
        return await handleBackgroundCancel(requestId, request);
      case "background.cancel-by-key":
        return await handleBackgroundCancelByKey(requestId, request);
      case "background.settings.update":
        return await handleBackgroundSettingsUpdate(requestId, request);
      default:
        return {
          requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "validation-error", message: "Unknown request kind" },
        };
    }
  } catch (err) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ============================================================
// 7. Vault Operations
// ============================================================

async function handleUnlock(
  requestId: string,
  request: { kind: "unlock"; password: string; publicKeyHex?: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus === "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "already-unlocked" },
    };
  }

  if (coordinatorState.vaultStatus === "booting" || coordinatorState.vaultStatus === "fatal") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "not-ready" },
    };
  }

  if (coordinatorState.vaultStatus === "uninitialized") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: "Vault not initialized" },
    };
  }

  try {
    // 1. 从 DB 读取 vault_meta
    const meta = await getVaultMeta();
    if (!meta) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Vault not initialized" },
      };
    }

    // 2. 验证密码
    const passwordKey = await deriveKey(request.password, decodePersisted(meta.saltB64));
    const passwordValid = await verifyVerifier(passwordKey, { salt: decodePersisted(meta.verifierSaltB64), iv: decodePersisted(meta.verifierIvB64), ciphertext: decodePersisted(meta.verifierCipherB64), version: meta.cryptoVersion });
    if (!passwordValid) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Invalid password" },
      };
    }

    // 3. 获取 active key
    const activeKey = request.publicKeyHex ? await vaultDb.getKey(request.publicKeyHex) : await getActiveKey();
    if (!activeKey) throw new Error("No active key");
    const privateKey = await decryptPrivateKey(passwordKey, activeKey);

    // 4. 统一进入 unlocked 状态
    await enterUnlockedState(passwordKey, activeKey.publicKeyHex, privateKey, "unlock");

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  } catch (err) {
    // unlock 失败，回到 locked
    coordinatorState.vaultStatus = "locked";
    coordinatorState.activePublicKeyHex = undefined;
    coordinatorState.activePrivateKeyBytes = undefined;
    coordinatorState.passwordKey = undefined;

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function handleVaultOperation(requestId: string, request: { kind: "vault.operation"; operation: CoordinatorVaultOperation }): Promise<CoordinatorResponse> {
  try {
    const result = await executeVaultOperation(request.operation);
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  } catch (err) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err) } };
  }
}

async function executeVaultOperation(operation: CoordinatorVaultOperation): Promise<unknown> {
  switch (operation.type) {
    case "listKeys": return (await vaultDb.listKeys()).map(({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }) => ({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }));
    case "getKey": { const key = await vaultDb.getKey(operation.publicKeyHex); if (!key) return undefined; const { cipherSaltB64: _s, cipherIvB64: _i, cipherB64: _c, passkeyProtections: _p, ...publicKey } = key; return publicKey; }
    case "verifyPassword": { const meta = await getVaultMeta(); if (!meta) throw new Error("Vault not initialized"); if (!(await verifyPassword(operation.password, meta))) throw new Error("Invalid password"); return true; }
    case "setActive": {
      if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.passwordKey) throw new Error("Vault is locked");
      const key = await vaultDb.getKey(operation.publicKeyHex); if (!key) throw new Error("Key not found");
      if (coordinatorState.activePublicKeyHex && coordinatorState.activePublicKeyHex !== operation.publicKeyHex) {
        await cancelTaskRuntimesByKey(coordinatorState.activePublicKeyHex);
      }
      const bytes = await decryptPrivateKey(coordinatorState.passwordKey, key); coordinatorState.activePrivateKeyBytes?.fill(0); coordinatorState.activePrivateKeyBytes = bytes; coordinatorState.activePublicKeyHex = key.publicKeyHex; coordinatorState.keyspaceGeneration++; coordinatorState.sessionEpoch = generateEpoch(); passkeyAddIntents.clear(); coordinatorMeta.activePublicKeyHex = key.publicKeyHex; coordinatorMeta.generation = coordinatorState.keyspaceGeneration; await persistActiveMeta(); publishSessionState("activate-key"); return true;
    }
    case "deleteKeyMaterial": await cancelTaskRuntimesByKey(operation.publicKeyHex); await vaultDb.deleteKey(operation.publicKeyHex); if (coordinatorState.activePublicKeyHex === operation.publicKeyHex) await performGlobalLock("key-deleted"); return true;
    case "deleteKey": { const meta = await getVaultMeta(); if (!meta || !(await verifyPassword(operation.password, meta))) throw new Error("Invalid password"); await cancelTaskRuntimesByKey(operation.publicKeyHex); await vaultDb.deleteKey(operation.publicKeyHex); if (coordinatorState.activePublicKeyHex === operation.publicKeyHex) await performGlobalLock("key-deleted"); return true; }
    case "createVault": return await createVaultRpc(operation.password);
    case "createVaultWithInitialKey": return await createVaultRpc(operation.password, { label: operation.label, capabilities: operation.capabilities });
    case "createVaultWithImportedKey": return await createVaultRpc(operation.vaultPassword, operation.key);
    case "generateKey": return await addKeyRpc(operation.password, { label: operation.label, capabilities: operation.capabilities, material: { hex: generatePrivateKeyHex() }, format: "generated", source: "vault-generated" });
    case "importPrivateKey": return await addKeyRpc(operation.password, operation);
    case "exportCurrentKeyBackup": {
      const key = await requireCurrentKeyRecord();
      const { sourceVaultMeta, keyRecord } = await vaultDb.readKeyBackupRecord(key.publicKeyHex);
      return (await import("@keymaster/plugin-vault/coordinator")).encodeKeyBackup(buildKeyBackupEnvelope(sourceVaultMeta, keyRecord));
    }
    case "listCurrentKeyPasskeys": {
      const key = await requireCurrentKeyRecord();
      return (key.passkeyProtections ?? []).map(toPasskeySummary);
    }
    case "listPasskeysForKey": {
      const key = await vaultDb.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      return (key.passkeyProtections ?? []).map(toPasskeySummary);
    }
    case "getPasskeyChallenge": {
      const { protection } = await findKeyByPasskeyId(operation.passkeyId);
      return {
        credentialIdB64: protection.credentialIdB64,
        prfSaltB64: protection.prfSaltB64,
        rpId: protection.rpId,
        transports: protection.transports
      };
    }
    case "prepareAddPasskeyToCurrentKey": {
      const key = await requireCurrentKeyRecord();
      const label = operation.label.trim();
      if (!label) throw new Error("Passkey name is required");
      if ((key.passkeyProtections ?? []).some((item) => item.label === label)) {
        throw new Error("Passkey name already exists for this key");
      }
      prunePasskeyAddIntents();
      const intentId = crypto.randomUUID();
      passkeyAddIntents.set(intentId, {
        publicKeyHex: key.publicKeyHex,
        sessionEpoch: coordinatorState.sessionEpoch,
        label,
        expiresAt: Date.now() + PASSKEY_ADD_INTENT_TTL_MS
      });
      return { intentId, publicKeyHex: key.publicKeyHex };
    }
    case "addPasskeyToCurrentKey": {
      const intent = passkeyAddIntents.get(operation.intentId);
      passkeyAddIntents.delete(operation.intentId);
      if (!intent || intent.expiresAt < Date.now()) throw new Error("Passkey setup expired; try again");
      const key = await requireCurrentKeyRecord();
      if (intent.sessionEpoch !== coordinatorState.sessionEpoch || intent.publicKeyHex !== key.publicKeyHex) {
        throw new Error("Current key changed during passkey setup");
      }
      const allKeys = await vaultDb.listKeys();
      if (allKeys.some((record) => (record.passkeyProtections ?? []).some((item) => item.id === operation.credentialIdB64))) {
        throw new Error("Passkey already exists in this Vault");
      }
      const prfOutput = cryptoHexToBytes(operation.prfOutputHex);
      const material = { hex: bytesToHex(coordinatorState.activePrivateKeyBytes!) };
      let encrypted: Awaited<ReturnType<typeof encryptMaterialWithPasskey>>;
      try {
        encrypted = await encryptMaterialWithPasskey({
          prfOutput,
          publicKeyHex: key.publicKeyHex,
          credentialIdB64: operation.credentialIdB64,
          material
        });
      } finally {
        prfOutput.fill(0);
      }
      const protection = {
        id: operation.credentialIdB64,
        label: intent.label,
        credentialIdB64: operation.credentialIdB64,
        prfSaltB64: operation.prfSaltB64,
        rpId: operation.rpId,
        createdAt: new Date().toISOString(),
        transports: operation.transports,
        ...encrypted
      };
      await vaultDb.putKey({
        ...key,
        passkeyProtections: [...(key.passkeyProtections ?? []), protection]
      });
      return toPasskeySummary(protection);
    }
    case "removePasskeyFromCurrentKey": {
      const key = await requireCurrentKeyRecord();
      const next = (key.passkeyProtections ?? []).filter((item) => item.id !== operation.passkeyId);
      if (next.length === (key.passkeyProtections ?? []).length) throw new Error("Passkey protection not found");
      await vaultDb.putKey({ ...key, passkeyProtections: next });
      return true;
    }
    case "activateKeyWithPasskey": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      const { key, protection } = await findKeyByPasskeyId(operation.passkeyId);
      const prfOutput = cryptoHexToBytes(operation.prfOutputHex);
      let material: Awaited<ReturnType<typeof decryptMaterialWithPasskey>>;
      try {
        material = await decryptMaterialWithPasskey({
          prfOutput,
          publicKeyHex: key.publicKeyHex,
          protection
        });
      } finally {
        prfOutput.fill(0);
      }
      const privateKey = cryptoHexToBytes(material.hex);
      verifySessionKeyPair({ publicKeyHex: key.publicKeyHex, privateKeyBytes: privateKey });
      if (coordinatorState.activePublicKeyHex && coordinatorState.activePublicKeyHex !== key.publicKeyHex) {
        await cancelTaskRuntimesByKey(coordinatorState.activePublicKeyHex);
      }
      coordinatorState.activePrivateKeyBytes?.fill(0);
      coordinatorState.activePrivateKeyBytes = privateKey;
      coordinatorState.activePublicKeyHex = key.publicKeyHex;
      coordinatorState.keyspaceGeneration++;
      coordinatorState.sessionEpoch = generateEpoch();
      passkeyAddIntents.clear();
      coordinatorMeta.activePublicKeyHex = key.publicKeyHex;
      coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
      await persistActiveMeta();
      publishSessionState("activate-key");
      return true;
    }
    case "changePassword": return await changePasswordRpc(operation.oldPassword, operation.newPassword);
    case "finalizeEmptyVaultAfterLastKeyDeletion": if ((await vaultDb.listKeys()).length === 0) { await vaultDb.deleteMeta(); await performGlobalLock("empty-vault"); } return true;
    case "recoverEmptyVaultToUninitialized": await vaultDb.deleteMeta(); await performGlobalLock("recover-empty"); return true;
    case "exportKeyBackup": {
      const key = await vaultDb.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      const meta = await getVaultMeta();
      if (!meta) throw new Error("Vault not initialized");
      const { encodeKeyBackup } = await import("@keymaster/plugin-vault/coordinator");
      return encodeKeyBackup(buildKeyBackupEnvelope(meta, key));
    }
    case "importKeyBackup": {
      const currentMeta = await getVaultMeta();
      if (!currentMeta) throw new Error("Vault not initialized");
      const { decodeKeyBackup, resolveVaultPasswordKey: resolveKey, decryptVaultKeyMaterialForMigration: decryptMigrate, encryptVaultKeyMaterial: encryptMaterial } = await import("@keymaster/plugin-vault/coordinator");
      // 解码备份
      const backup = passwordBackupView(decodeKeyBackup(operation.backup));
      // 用备份里的 source meta 验证 source password
      const sourceKey = await resolveKey(operation.sourcePassword, backup.sourceVaultMeta);
      // 用当前 vault meta 验证 target password
      const targetKey = await resolveKey(operation.targetPassword, currentMeta);
      // 验证 backup key 的 public key 与解密后的 material 一致
      const material = await decryptMigrate(sourceKey.key, backup.keyRecord, sourceKey.encoding);
      const { bytesToHex: toHex, hexToBytes: fromHex } = await import("@keymaster/plugin-vault/coordinator");
      const { secp256k1 } = await import("@noble/curves/secp256k1.js");
      const derivedPub = toHex(secp256k1.getPublicKey(fromHex(material.hex), true));
      if (derivedPub !== backup.keyRecord.publicKeyHex) {
        throw new Error("Backup key public key mismatch");
      }
      // 检查重复 key
      const existingKey = await vaultDb.getKey(backup.keyRecord.publicKeyHex);
      if (existingKey) {
        throw new Error("Key already exists");
      }
      // 重加密并落库
      const encrypted = await encryptMaterial(targetKey.key, backup.keyRecord.publicKeyHex, material);
      const record: VaultKeyRecord = { ...backup.keyRecord, ...encrypted };
      await vaultDb.putKey(record);
      // 仅当 Vault 已 unlocked 且是第一个 key 时，设置为 active
      if (coordinatorState.vaultStatus === "unlocked") {
        const keys = await vaultDb.listKeys();
        if (keys.length === 1) {
          await executeVaultOperation({ type: "setActive", publicKeyHex: record.publicKeyHex });
        }
      }
      return { publicKeyHex: record.publicKeyHex, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
    }
    default: throw new Error(`Unsupported vault operation: ${(operation as { type: string }).type}`);
  }
}

async function requireCurrentKeyRecord(): Promise<VaultKeyRecord> {
  if (
    coordinatorState.vaultStatus !== "unlocked" ||
    !coordinatorState.activePublicKeyHex ||
    !coordinatorState.activePrivateKeyBytes
  ) {
    throw new Error("No active private key");
  }
  const key = await vaultDb.getKey(coordinatorState.activePublicKeyHex);
  if (!key) throw new Error("Active key not found");
  verifySessionKeyPair({
    publicKeyHex: key.publicKeyHex,
    privateKeyBytes: coordinatorState.activePrivateKeyBytes
  });
  return key;
}

async function findKeyByPasskeyId(passkeyId: string): Promise<{
  key: VaultKeyRecord;
  protection: NonNullable<VaultKeyRecord["passkeyProtections"]>[number];
}> {
  const matches = (await vaultDb.listKeys()).flatMap((key) => {
    const protection = key.passkeyProtections?.find((item) => item.id === passkeyId);
    return protection ? [{ key, protection }] : [];
  });
  if (matches.length === 0) throw new Error("Passkey protection not found");
  if (matches.length > 1) throw new Error("Passkey protection id is not unique");
  return matches[0]!;
}

function generatePrivateKeyHex(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return bytesToHex(bytes); }
async function createVaultRpc(password: string, key?: { label?: string; capabilities?: string[]; material?: { hex: string; wif?: string }; format?: string; source?: string }): Promise<unknown> {
  if (await getVaultMeta()) throw new Error("Vault already exists");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = key?.material ?? { hex: generatePrivateKeyHex() };
  const passwordKey = await deriveKey(password, salt);
  const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(passwordKey);
  const meta = (await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt, verifier });
  await vaultDb.putMeta(meta);
  if (key) {
    // 有 key 时调用 addKeyRpc，它会设置 unlocked 状态
    return addKeyRpc(password, { ...key, material: keyMaterial, label: key.label ?? "Key", capabilities: key.capabilities ?? ["p2pkh"], format: key.format ?? "imported", source: key.source }, key.format === "imported" ? "import-initial-key" : "create-initial-key");
  }
  // 空 Vault 创建后保持 locked 状态，清空内存中的 passwordKey
  coordinatorState.passwordKey = undefined;
  passkeyAddIntents.clear();
  coordinatorState.vaultStatus = "locked";
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorMeta.activePublicKeyHex = undefined;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();
  // 广播 locked 状态
  publishSessionState("create-vault");
  return true;
}
async function addKeyRpc(password: string, input: { label: string; capabilities?: string[]; material: { hex: string; wif?: string }; format: string; source?: string }, initialCause: Extract<SessionStateEvent["cause"], "create-initial-key" | "import-initial-key"> = "create-initial-key"): Promise<unknown> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error("Vault not initialized");
  const passwordKey = coordinatorState.passwordKey ?? await (async () => {
    const k = await deriveKey(password, decodePersisted(meta.saltB64));
    if (!(await verifyVerifier(k, { salt: decodePersisted(meta.verifierSaltB64), iv: decodePersisted(meta.verifierIvB64), ciphertext: decodePersisted(meta.verifierCipherB64) }))) throw new Error("Invalid password");
    return k;
  })();
  const priv = cryptoHexToBytes(input.material.hex);
  const pub = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(priv, true));
  const encrypted = await (await import("@keymaster/plugin-vault/coordinator")).encryptVaultKeyMaterial(passwordKey, pub, input.material);
  const record = { publicKeyHex: pub, label: input.label, address: deriveP2pkhAddress(pub, "main"), network: "main" as const, format: input.format, capabilities: input.capabilities ?? ["p2pkh"], createdAt: new Date().toISOString(), source: input.source, ...encrypted };
  await vaultDb.putKey(record);
  const wasUnlocked = coordinatorState.vaultStatus === "unlocked";
  if (wasUnlocked && coordinatorState.activePublicKeyHex && coordinatorState.activePublicKeyHex !== pub) {
    await cancelTaskRuntimesByKey(coordinatorState.activePublicKeyHex);
  }
  coordinatorState.activePrivateKeyBytes?.fill(0);
  // keyspaceGeneration 递增
  coordinatorState.keyspaceGeneration++;
  // 统一进入 unlocked 状态
  await enterUnlockedState(passwordKey, pub, priv, wasUnlocked ? "activate-key" : initialCause);
  return { publicKeyHex: pub, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
}
async function changePasswordRpc(oldPassword: string, newPassword: string): Promise<boolean> { const meta = await getVaultMeta(); if (!meta) throw new Error("Vault not initialized"); const oldKey = await (await import("@keymaster/plugin-vault/coordinator")).resolveVaultPasswordKey(oldPassword, meta); const newSalt = crypto.getRandomValues(new Uint8Array(16)); const newKey = await deriveKey(newPassword, newSalt); const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(newKey); const records = await vaultDb.listKeys(); const migrated = []; for (const record of records) { const material = await (await import("@keymaster/plugin-vault/coordinator")).decryptVaultKeyMaterialForMigration(oldKey.key, record); migrated.push({ ...record, ...(await (await import("@keymaster/plugin-vault/coordinator")).encryptVaultKeyMaterial(newKey, record.publicKeyHex, material)) }); } await vaultDb.putMetaAndKeys((await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt: newSalt, verifier }), migrated); await performGlobalLock("password-change"); return true; }

async function handleLock(
  requestId: string,
  request: { kind: "lock"; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  await performGlobalLock("manual");
  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

async function performGlobalLock(reason: string): Promise<void> {
  // abort 所有 session-bound task，并在清空运行句柄前保留 completion，确保
  // handler 已经退出；否则迟到的 DB commit 可能越过锁定栅栏。
  const completions: Promise<void>[] = [];
  for (const [, runtime] of coordinatorState.taskRuntimes) {
    runtime.controller?.abort();
    if (runtime.completion) completions.push(runtime.completion);
    if (runtime.timer) {
      clearTimeout(runtime.timer);
    }
    // 锁定时将任务标记为 blocked，而非 idle，让 UI 显示"等待解锁"
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    runtime.timer = undefined;
  }
  await Promise.allSettled(completions);
  for (const runtime of coordinatorState.taskRuntimes.values()) runtime.controller = undefined;

  // 覆盖私钥 buffer
  if (coordinatorState.activePrivateKeyBytes) {
    coordinatorState.activePrivateKeyBytes.fill(0);
  }

  // 撤销 capability、清空 active key
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorState.activePrivateKeyBytes = undefined;
  coordinatorState.passwordKey = undefined;
  passkeyAddIntents.clear();

  // 递增 epoch
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = reason === "recover-empty" ? "uninitialized" : "locked";

  coordinatorState.keyspaceGeneration++;
  coordinatorMeta.activePublicKeyHex = undefined;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();
  publishSessionState(reason === "key-deleted" || reason === "empty-vault" ? "delete-active-key" : reason === "recover-empty" ? "recover-empty-vault" : "lock");

  // 广播任务快照，让 UI 立即显示 blocked 状态
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 清除自动锁定 timer
  if (coordinatorState.autoLockDeadline) {
    coordinatorState.autoLockDeadline = undefined;
  }
}

async function handleActivateKey(
  requestId: string,
  request: { kind: "activate-key"; password: string; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  try {
    const meta = await getVaultMeta();
    if (!meta || !(await verifyPassword(request.password, meta))) throw new Error("Invalid password");
    const key = await vaultDb.getKey(request.publicKeyHex);
    if (!key || !coordinatorState.passwordKey) throw new Error("Key not found");
    if (coordinatorState.activePublicKeyHex && coordinatorState.activePublicKeyHex !== request.publicKeyHex) {
      await cancelTaskRuntimesByKey(coordinatorState.activePublicKeyHex);
    }
    const privateKey = await decryptPrivateKey(coordinatorState.passwordKey, key);
    coordinatorState.activePrivateKeyBytes?.fill(0);
    coordinatorState.activePrivateKeyBytes = privateKey;
    coordinatorState.activePublicKeyHex = request.publicKeyHex;
    coordinatorState.keyspaceGeneration++;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorMeta.activePublicKeyHex = request.publicKeyHex;
    coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
    await persistCoordinatorMeta();

    publishSessionState("activate-key");

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  } catch (err) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ============================================================
// 8. Crypto Operations
// ============================================================

async function handleCrypto(
  requestId: string,
  request: { kind: "crypto"; operation: CoordinatorCryptoOperation; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  if (!coordinatorState.activePrivateKeyBytes) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.noActiveKey", fallback: "No active key" } },
    };
  }

  try {
    const result = await executeCryptoOperation(
      request.operation,
      coordinatorState.activePrivateKeyBytes
    );

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      cryptoResult: result,
    };
  } catch (err) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function executeCryptoOperation(
  operation: CoordinatorCryptoOperation,
  privateKeyBytes: Uint8Array
): Promise<CoordinatorCryptoResult> {
  switch (operation.type) {
    case "signDigest": {
      const sig = await signEcdsaDigest({
        privateKeyBytes,
        digest: cryptoHexToBytes(operation.digestHex),
        format: operation.format
      });
      return { type: "signDigest", signatureHex: bytesToHex(sig), format: operation.format };
    }
    case "deriveP2pkhAddress": return { type: "deriveP2pkhAddress", address: deriveP2pkhAddress(coordinatorState.activePublicKeyHex!, operation.network) };
    case "sealSendInput": { const i = operation.input; const sealed = sealAppMessageLocalBytes({ senderPrivateKeyBytes: privateKeyBytes, senderPublicKeyBytes: cryptoHexToBytes(coordinatorState.activePublicKeyHex!), recipientPublicKeyBytes: cryptoHexToBytes(i.recipient.recipientPublicKeyHex), senderEndpoint: i.sender.senderOrigin ? { kind: "origin", id: i.sender.senderOrigin } : { kind: "plugin", id: i.sender.senderAppId ?? "" }, recipientEndpoint: i.recipient.recipientOrigin ? { kind: "origin", id: i.recipient.recipientOrigin } : { kind: "plugin", id: i.recipient.recipientAppId ?? "" }, contentType: i.contentType, body: i.body, clientMessageId: i.clientMessageId, createdAtMs: i.createdAtMs }); return { type: "sealSendInput", envelope: sealed.envelope, signature: sealed.signatureBytes }; }
    case "openSealed": { const r = operation.record as { envelope: { envelopeBytes: ArrayBuffer; signatureBytes: ArrayBuffer }; recipientPublicKeyHex: string }; const opened = openAppMessageLocalBytes({ signed: { envelopeBytes: new Uint8Array(r.envelope.envelopeBytes), signatureBytes: new Uint8Array(r.envelope.signatureBytes) }, recipientPrivateKeyBytes: privateKeyBytes, recipientPublicKeyBytes: cryptoHexToBytes(r.recipientPublicKeyHex) }); return { type: "openSealed", plaintext: new TextEncoder().encode(JSON.stringify(opened)) }; }
    case "encryptVaultKeyMaterial": { if (!coordinatorState.passwordKey) throw new Error("Password key unavailable"); const blob = await (await import("@keymaster/plugin-vault/coordinator")).encryptBytes(coordinatorState.passwordKey, operation.plaintext); return { type: "encryptVaultKeyMaterial", ciphertext: new TextEncoder().encode(JSON.stringify({ salt: bytesToHex(blob.salt), iv: bytesToHex(blob.iv), ciphertext: bytesToHex(blob.ciphertext) })) }; }
    case "decryptVaultKeyMaterial": { if (!coordinatorState.passwordKey) throw new Error("Password key unavailable"); const r = JSON.parse(new TextDecoder().decode(operation.ciphertext)) as { salt: string; iv: string; ciphertext: string }; const plain = await (await import("@keymaster/plugin-vault/coordinator")).decryptBytes(coordinatorState.passwordKey, { salt: cryptoHexToBytes(r.salt), iv: cryptoHexToBytes(r.iv), ciphertext: cryptoHexToBytes(r.ciphertext) }); return { type: "decryptVaultKeyMaterial", plaintext: plain }; }
    default: throw new Error("Unsupported coordinator crypto operation");
  }
}

// ============================================================
// 9. Background Operations
// ============================================================

async function handleBackgroundRunNow(
  requestId: string,
  request: { kind: "background.run-now"; taskId: string; expectedSessionEpoch: SessionEpoch },
  reason = "manual"
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  const runtime = coordinatorState.taskRuntimes.get(request.taskId);
  if (!runtime) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
    };
  }

  if (runtime.state === "running") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "already-running" },
    };
  }

  if (runtime.state === "blocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.task", fallback: runtime.blockedReason ?? "Task blocked" } },
    };
  }

  void executeTask(request.taskId, reason);
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

async function handleBackgroundTrigger(requestId: string, request: { kind: "background.trigger"; taskId: string; reason: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
  return handleBackgroundRunNow(requestId, { kind: "background.run-now", taskId: request.taskId, expectedSessionEpoch: request.expectedSessionEpoch }, request.reason);
}

async function handleBackgroundCancelByKey(requestId: string, request: { kind: "background.cancel-by-key"; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
  const cancelled = await cancelTaskRuntimesByKey(request.publicKeyHex);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: cancelled ? { status: "accepted" } : { status: "ok" } };
}

async function cancelTaskRuntimesByKey(publicKeyHex: string): Promise<boolean> {
  let cancelled = false;
  const completions: Promise<void>[] = [];
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (resolveKeyScope(runtime)?.publicKeyHex !== publicKeyHex) continue;
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.state = "idle";
    if (runtime.completion) completions.push(runtime.completion);
    cancelled = true;
  }
  await Promise.allSettled(completions);
  return cancelled;
}

async function handleBackgroundCancel(
  requestId: string,
  request: { kind: "background.cancel"; taskId: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  const runtime = coordinatorState.taskRuntimes.get(request.taskId);
  if (!runtime) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
    };
  }

  if (runtime.state === "running" && runtime.controller) {
    runtime.controller.abort();
    const completion = runtime.completion;
    runtime.state = "idle";
    if (completion) await completion;
    runtime.controller = undefined;

    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  }

  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
  };
}

async function handleBackgroundSettingsUpdate(
  requestId: string,
  request: { kind: "background.settings.update"; settings: CoordinatorBackgroundSyncSettings; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  const interval = request.settings.assetHoldingsIntervalMs;
  if (!Number.isFinite(interval) || interval < 1_000 || interval > 7 * 24 * 60 * 60 * 1000) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid schedule interval" } };
  }
  coordinatorState.scheduleSettings = request.settings;
  coordinatorMeta.scheduleSettings = request.settings;
  await persistCoordinatorMeta();
  for (const runtime of coordinatorState.taskRuntimes.values()) { runtime.intervalMs = request.settings.assetHoldingsIntervalMs; scheduleRuntime(runtime); }

  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

// ============================================================
// 10. Task Execution
// ============================================================

async function executeTask(taskId: string, reason: string): Promise<void> {
  const runtime = coordinatorState.taskRuntimes.get(taskId);
  if (!runtime) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    scheduleRuntime(runtime);
    return;
  }

  const controller = new AbortController();
  runtime.controller = controller;
  runtime.startedEpoch = coordinatorState.sessionEpoch;
  runtime.startedGeneration = coordinatorState.keyspaceGeneration;
  runtime.startedPublicKeyHex = coordinatorState.activePublicKeyHex;
  runtime.state = "running";
  runtime.lastStartedAt = new Date().toISOString();
  runtime.lastAttemptAt = runtime.lastStartedAt;

  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  const execution = (async () => {
   try {
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task epoch");
    if (!runtime.run) throw new Error(`Task ${taskId} has no Coordinator handler`);
    await runtime.run({ signal: controller.signal, reason, reportProgress: () => undefined, assertSessionFresh: () => assertTaskFresh(taskId) });
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task result");
    runtime.state = "idle";
    runtime.lastCompletedAt = new Date().toISOString();
    runtime.error = undefined;
   } catch (err) {
    if (controller.signal.aborted) {
      runtime.state = "idle";
      runtime.error = "Cancelled";
    } else {
      runtime.state = "idle";
      runtime.error = err instanceof Error ? err.message : String(err);
    }
   } finally {
    runtime.controller = undefined;

    // 若当前 Vault 已锁定或 epoch 已变化，保留 blocked，不得把任务重写为 idle
    if (coordinatorState.vaultStatus !== "unlocked" ||
        runtime.startedEpoch !== coordinatorState.sessionEpoch ||
        runtime.startedGeneration !== coordinatorState.keyspaceGeneration ||
        runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
    } else if (!controller.signal.aborted) {
      // 仅当任务所属 session 仍有效且未 abort 时才恢复 idle/排程
      scheduleRuntime(runtime);
    }

    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });
   }
  })();
  runtime.completion = execution;
  await execution;
  runtime.completion = undefined;
}

// ============================================================
// 11. Snapshot & Broadcasting
// ============================================================

function buildSnapshot(): CoordinatorBootstrapSnapshot {
  return {
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
    taskSnapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings,
  };
}

function getTaskSnapshots(): CoordinatorTaskSnapshot[] {
  const snapshots: CoordinatorTaskSnapshot[] = [];

  for (const [taskId, runtime] of coordinatorState.taskRuntimes) {
    snapshots.push({
      id: taskId,
      pluginId: runtime.pluginId,
      label: taskId,
      state: runtime.state,
      lastStartedAt: runtime.lastStartedAt,
      lastCompletedAt: runtime.lastCompletedAt,
      lastAttemptAt: runtime.lastAttemptAt,
      nextRunAt: runtime.nextRunAt,
      error: runtime.error,
      blockedReason: runtime.blockedReason ? { key: "background.blocked.task", fallback: runtime.blockedReason } : undefined,
      keyScope: resolveKeyScope(runtime),
    });
  }

  return snapshots;
}

function publishTopicEvent(topic: CoordinatorTopic, event: any): void {
  const normalized = {
    ...event,
    topic,
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : { assetDataRevision: ++assetDataRevision }),
    sessionEpoch: coordinatorState.sessionEpoch,
    ...(topic === "background.snapshot" ? { scheduleSettings: coordinatorState.scheduleSettings } : {})
  } as CoordinatorTopicEvent;
  for (const [, connectedPort] of connectedPorts) {
    if (connectedPort.subscriptions.has(topic)) {
      sendToPort(connectedPort.port, normalized);
    }
  }
}

function sendToPort(port: MessagePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口可能已关闭
  }
}

// ============================================================
// 12. Auto-lock Timer
// ============================================================

function resetAutoLockTimer(): void {
  const AUTO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  coordinatorState.autoLockDeadline = Date.now() + AUTO_LOCK_TIMEOUT_MS;

  setTimeout(() => {
    if (
      coordinatorState.autoLockDeadline &&
      Date.now() >= coordinatorState.autoLockDeadline &&
      coordinatorState.vaultStatus === "unlocked"
    ) {
      void performGlobalLock("auto-lock-timeout");
    }
  }, AUTO_LOCK_TIMEOUT_MS);
}

// ============================================================
// 13. Worker Entry Point
// ============================================================

const workerScope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null;
};

workerScope.onconnect = handlePortConnect;

// Worker 启动时从 DB 读取仅公开的 Vault metadata
// 状态为 uninitialized 或 locked；绝不读取/解密私钥直到 unlock RPC
async function initializeCoordinator(): Promise<void> {
  try {
    await loadCoordinatorMeta();
    const meta = await getVaultMeta();
    if (meta) {
      coordinatorState.vaultStatus = "locked";
      coordinatorState.activePublicKeyHex = undefined;
      coordinatorState.keyspaceGeneration = coordinatorMeta.generation;
    } else {
      coordinatorState.vaultStatus = "uninitialized";
    }
    await registerCoordinatorTasks();
    // 启动时如果 vault 是 locked 状态，将所有任务标记为 blocked
    if (coordinatorState.vaultStatus === "locked") {
      for (const runtime of coordinatorState.taskRuntimes.values()) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      }
    }
  } catch {
    coordinatorState.vaultStatus = "fatal";
  } finally {
    // hello 可能先于异步 IndexedDB 初始化抵达。无论初始化成功或失败，
    // 都必须广播最终状态，否则首个页面会永久停留在 booting。
    publishSessionState("bootstrap");
  }
}

void initializeCoordinator();

// ============================================================
// 14. Test Exports
// ============================================================

export function __testGetSnapshot(): CoordinatorBootstrapSnapshot {
  return buildSnapshot();
}

export function __testResetState(): void {
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = "booting";
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorState.activePrivateKeyBytes = undefined;
  coordinatorState.passwordKey = undefined;
  coordinatorState.keyspaceGeneration = 0;
  coordinatorState.taskRuntimes.clear();
  coordinatorState.autoLockDeadline = undefined;
  coordinatorState.lastActivityAt = Date.now();
  connectedPorts.clear();
  passkeyAddIntents.clear();
}

export function __testSetVaultStatus(status: CoordinatorVaultStatus, activePublicKeyHex?: string): void {
  coordinatorState.vaultStatus = status;
  coordinatorState.activePublicKeyHex = activePublicKeyHex;
}

export function __testGetConnectedPortCount(): number {
  return connectedPorts.size;
}

export function __testRegisterTask(input: {
  id: string;
  publicKeyHex: string;
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  coordinatorState.taskRuntimes.set(input.id, {
    id: input.id,
    pluginId: "test",
    state: "idle",
    keyScope: { publicKeyHex: input.publicKeyHex },
    run: input.run
  });
}

export async function __testRunTask(taskId: string): Promise<void> {
  await executeTask(taskId, "test");
}

export async function __testCancelByKey(publicKeyHex: string): Promise<boolean> {
  return cancelTaskRuntimesByKey(publicKeyHex);
}

export function __testInvalidateSession(): void {
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.keyspaceGeneration++;
}

export async function __testBackgroundRunNow(taskId: string): Promise<CoordinatorResponse> {
  return handleBackgroundRunNow(`test-${Date.now()}`, { kind: "background.run-now", taskId, expectedSessionEpoch: coordinatorState.sessionEpoch });
}

export async function __testUpdateScheduleSettings(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorResponse> {
  return handleBackgroundSettingsUpdate(`test-${Date.now()}`, { kind: "background.settings.update", settings, expectedSessionEpoch: coordinatorState.sessionEpoch });
}

export async function __testRestartWorker(): Promise<void> {
  __testResetState();
  await loadCoordinatorMeta();
  coordinatorState.vaultStatus = (await getVaultMeta()) ? "locked" : "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorState.activePrivateKeyBytes = undefined;
  coordinatorState.passwordKey = undefined;
}

// ============================================================
// 15. Backup Import Test Helpers
// ============================================================

/** 删除 Vault（清理 IndexedDB）。 */
export async function __testDeleteVault(): Promise<void> {
  try {
    // 删除所有 keys
    const keys = await vaultDb.listKeys();
    for (const key of keys) {
      await vaultDb.deleteKey(key.publicKeyHex);
    }
    // 删除 meta
    await vaultDb.deleteMeta();
  } catch {
    // 忽略错误（可能数据库不存在）
  }
  // 重置内存状态
  coordinatorState.vaultStatus = "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorState.activePrivateKeyBytes = undefined;
  coordinatorState.passwordKey = undefined;
  coordinatorState.keyspaceGeneration = 0;
}

/** 创建 Vault（空或带初始 key）。 */
export async function __testCreateVault(password: string, options?: { label?: string; capabilities?: string[] }): Promise<{ publicKeyHex?: string }> {
  const result = await executeVaultOperation({ type: "createVaultWithInitialKey", password, label: options?.label ?? "Key", capabilities: options?.capabilities ?? ["p2pkh"] });
  return result as { publicKeyHex?: string };
}

/** 创建没有 key 的 locked Vault。 */
export async function __testCreateEmptyVault(password: string): Promise<void> {
  await executeVaultOperation({ type: "createVault", password });
}

/** 导入私钥。 */
export async function __testImportPrivateKey(password: string, input: { label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string }): Promise<{ publicKeyHex: string }> {
  const result = await executeVaultOperation({ type: "importPrivateKey", password, ...input });
  return result as { publicKeyHex: string };
}

/** 导出备份。 */
export async function __testExportKeyBackup(publicKeyHex: string): Promise<string> {
  const result = await executeVaultOperation({ type: "exportKeyBackup", publicKeyHex });
  return result as string;
}

/** 导入备份。 */
export async function __testImportKeyBackup(backup: string, sourcePassword: string, targetPassword: string): Promise<{ publicKeyHex: string }> {
  const result = await executeVaultOperation({ type: "importKeyBackup", backup, sourcePassword, targetPassword });
  return result as { publicKeyHex: string };
}

export async function __testAddPasskeyToCurrentKey(input: {
  label: string;
  credentialIdB64: string;
  prfSaltB64: string;
  prfOutputHex: string;
  rpId: string;
}): Promise<unknown> {
  const prepared = await executeVaultOperation({
    type: "prepareAddPasskeyToCurrentKey",
    label: input.label
  }) as { intentId: string };
  return executeVaultOperation({
    type: "addPasskeyToCurrentKey",
    intentId: prepared.intentId,
    credentialIdB64: input.credentialIdB64,
    prfSaltB64: input.prfSaltB64,
    prfOutputHex: input.prfOutputHex,
    rpId: input.rpId
  });
}

export async function __testRemovePasskeyFromCurrentKey(input: {
  passkeyId: string;
}): Promise<void> {
  await executeVaultOperation({ type: "removePasskeyFromCurrentKey", ...input });
}

export async function __testActivateKeyWithPasskey(input: {
  passkeyId: string;
  prfOutputHex: string;
}): Promise<void> {
  await executeVaultOperation({ type: "activateKeyWithPasskey", ...input });
}

/** 解锁 Vault。 */
export async function __testUnlock(password: string, publicKeyHex?: string): Promise<CoordinatorResponse> {
  return processRequest({ kind: "unlock", password, publicKeyHex, requestId: `test-unlock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
}

/** 锁定 Vault。 */
export async function __testLock(): Promise<CoordinatorResponse> {
  return processRequest({ kind: "lock", requestId: `test-lock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
}

/** 获取 Vault 状态。 */
export function __testGetVaultStatus(): CoordinatorVaultStatus {
  return coordinatorState.vaultStatus;
}

/** 获取 active key。 */
export function __testGetActivePublicKeyHex(): string | undefined {
  return coordinatorState.activePublicKeyHex;
}
