// KMP-001 / KMP-002：仅由 VITE_MSFILE_E2E=1 的隔离构建加载。
//
// 这里验证真实浏览器链，不提供 fake transport：Window 页面使用生产
// Coordinator Client，Coordinator 使用 SharedWorker 和独立 MessagePort
// 暴露 owner-storage / crypto 服务。普通产品构建不会把本模块放进模块图。

import type { PluginHost } from "@keymaster/runtime";
import {
  COORDINATOR_CRYPTO_SERVICE,
  COORDINATOR_OWNER_STORAGE_SERVICE,
  COORDINATOR_SERVICE_CONTRACT_VERSION,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  systemStorageDeclarationForPurpose,
  VAULT_COORDINATOR_CONTROL_CAPABILITY,
} from "@keymaster/contracts";
import type { VaultCoordinatorControl } from "@keymaster/contracts";
import type { RuntimeHandle, RuntimeStatusSnapshot } from "webloom-framework";
import { createStorageBindingAuthority } from "@keymaster/platform-storage/coordinator";
import { createSessionCryptoEngine } from "@keymaster/plugin-vault";
import {
  __testArmCoordinatorBridgeBarrier,
  getCoordinatorClient,
} from "../keymasterSessionCoordinatorClient.js";

const E2E_VAULT_PASSWORD = "lifecycle-production-e2e-password";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RuntimeService = RuntimeStatusSnapshot["services"][number];

function serviceSummary(runtime: RuntimeHandle | undefined): Array<{
  capabilityId: string;
  serviceInstanceId: string;
  status: string;
  hasServerGrant: boolean;
}> {
  const state = runtime?.state();
  return state?.services.map((service: RuntimeService) => ({
    capabilityId: service.capabilityId,
    serviceInstanceId: service.serviceInstanceId,
    status: state.state === "ready" ? "ready" : state.state,
    // E2E 只报告授权是否存在，不把不透明 grant 值暴露到页面调试对象。
    hasServerGrant: typeof service.grantId === "string" && service.grantId.length > 0,
  })) ?? [];
}

async function ensureUnlocked(
  coordinator: VaultCoordinatorControl,
  client: ReturnType<typeof getCoordinatorClient>,
  diagnostics?: { storageSelection?: unknown },
): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }> {
  let lastSnapshot: { vaultStatus: string; sessionEpoch: string; activePublicKeyHex?: string } | undefined;
  let lastStorageRecovery: string | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = coordinator.getBootstrapSnapshot();
    lastSnapshot = {
      vaultStatus: snapshot.vaultStatus,
      sessionEpoch: snapshot.sessionEpoch,
      ...(snapshot.activePublicKeyHex ? { activePublicKeyHex: snapshot.activePublicKeyHex } : {}),
    };
    if (snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex) {
      return { ownerPublicKeyHex: snapshot.activePublicKeyHex, sessionEpoch: snapshot.sessionEpoch };
    }
    if (snapshot.vaultStatus === "uninitialized") {
      const result = await coordinator.vaultOperation({
        type: "createVaultWithInitialKey",
        password: E2E_VAULT_PASSWORD,
        label: "Lifecycle production E2E",
        capabilities: ["p2pkh"],
      });
      if (result.status !== "ok") throw new Error(`Lifecycle E2E Vault creation failed: ${result.status}`);
    } else if (snapshot.vaultStatus === "locked") {
      const result = await coordinator.unlock(E2E_VAULT_PASSWORD);
      if (result.status !== "accepted" && result.status !== "already-unlocked") {
        throw new Error(`Lifecycle E2E Vault unlock failed: ${result.status}`);
      }
    } else if (snapshot.vaultStatus === "booting") {
      // 首次 hello 可能在 onboarding 状态结束后已经完成了初始化 Promise，
      // 但没有消费新的 Storage ready 事件；retry 会走正式恢复编排，不在
      // E2E 中直接修改 Coordinator 内部状态。
      const result = await client.storageControl({ type: "retry" });
      lastStorageRecovery = result.status === "ok" ? String(result.value) : result.status;
      if (result.status !== "ok") throw new Error(`Lifecycle E2E Storage recovery failed: ${result.status}`);
    }
    await delay(25);
  }
  throw new Error(`Lifecycle E2E Vault did not become unlocked: ${JSON.stringify({ lastSnapshot, lastStorageRecovery, storageSelection: diagnostics?.storageSelection })}`);
}

async function waitForReadyRuntime(client: ReturnType<typeof getCoordinatorClient>): Promise<RuntimeHandle> {
  const observations: Array<{ state?: string; services: Array<{ capabilityId: string; version: string; grant: boolean }>; optional: { owner: boolean; crypto: boolean } }> = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const runtime = client.getRuntimeHandle();
    const state = runtime?.state();
    const services = state?.services ?? [];
    const ownerOptional = Boolean(runtime?.optionalCapability(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY));
    const cryptoOptional = Boolean(runtime?.optionalCapability(COORDINATOR_CRYPTO_RPC_CAPABILITY));
    observations.push({
      state: state?.state,
      services: services.map((service) => ({ capabilityId: service.capabilityId, version: service.contractVersion, grant: typeof service.grantId === "string" })),
      optional: { owner: ownerOptional, crypto: cryptoOptional },
    });
    if (observations.length > 8) observations.shift();
    const ownerStorageReady = services.some((service) =>
      service.capabilityId === COORDINATOR_OWNER_STORAGE_SERVICE
      && service.contractVersion === COORDINATOR_SERVICE_CONTRACT_VERSION
      && typeof service.grantId === "string"
    );
    const cryptoReady = services.some((service) =>
      service.capabilityId === COORDINATOR_CRYPTO_SERVICE
      && service.contractVersion === COORDINATOR_SERVICE_CONTRACT_VERSION
      && typeof service.grantId === "string"
    );
    if (runtime && state?.state === "ready" && ownerStorageReady && cryptoReady
      && ownerOptional
      && cryptoOptional) return runtime;
    await delay(25);
  }
  throw new Error(`Lifecycle E2E Coordinator Runtime did not expose ready services: ${JSON.stringify(observations)}`);
}

async function waitForStorageReady(client: ReturnType<typeof getCoordinatorClient>): Promise<void> {
  const observations: Array<{ status: unknown; vault?: string; runtime?: string; error?: string }> = [];
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await client.storageControl({ type: "status" });
    const snapshot = client.getBootstrapSnapshot();
    observations.push({
      status: status.status === "ok" ? status.value : status.status,
      vault: snapshot.vaultStatus,
      runtime: client.getRuntimeHandle()?.state().state,
      ...(status.status !== "ok" && "message" in status ? { error: status.message } : {}),
    });
    if (observations.length > 8) observations.shift();
    if (status.status === "ok" && status.value === "ready") return;
    // Storage 首次选择和 Coordinator 初始化是两个异步阶段；不能只看
    // Vault snapshot 已变成 uninitialized 就提前发起 createVault。
    await client.storageControl({ type: "retry" });
    await delay(25);
  }
  throw new Error(`Lifecycle E2E Storage did not become ready: ${JSON.stringify(observations)}`);
}

export interface LifecycleProductionE2EHooks {
  /** 创建 / 解锁临时 Vault，并等待真实服务目录 ready。 */
  bootstrap(): Promise<{
    ownerPublicKeyHex: string;
    sessionEpoch: string;
    /** 当前 Coordinator 构建身份；正式部署验收必须是 immutable buildId。 */
    buildId: string;
    bridgeState: string;
    services: ReturnType<typeof serviceSummary>;
  }>;
  /** 通过生产 storage binding authority 完成一次 owner K-V 往返。 */
  ownerStorageRoundTrip(): Promise<{
    key: string;
    value: unknown;
    bridgeState: string;
    serviceInstanceId: string;
    ownerPeerId: string;
    ownerHandoffRevision: number;
    /** 提交态 WebLoom 是否提供了 owner peer 的脱敏投影。 */
    ownerPeerObservable: boolean;
    /** 提交态 WebLoom 是否把远端 endpoint binding 公开给 Runtime 状态。 */
    ownerBindingObservable: boolean;
    ownerBindingMatchesRuntime: boolean;
  }>;
  /** 通过真实独立服务桥调用 Coordinator crypto 最终边界。 */
  deriveAddress(): Promise<{
    address: string;
    ownerPublicKeyHex: string;
    serviceInstanceId: string;
  }>;
  /** 锁屏撤销旧代理，解锁后必须产生新的 service 实例。 */
  lockRevokesOldProxy(): Promise<{
    lockStatus: string;
    unlockStatus: string;
    oldProxyErrorCode: string;
    oldServiceInstanceId: string;
    newServiceInstanceId: string;
    oldProxyRejected: boolean;
  }>;
  /** 在 Chromium 中真实启动 Dedicated Worker 的 Session Crypto 路径。 */
  dedicatedWorkerRoundTrip(): Promise<{
    address: string;
    signatureLength: number;
    revoked: boolean;
  }>;
  /** 关闭当前 tab 的 Runtime，并返回旧 proxy 的真实拒绝结果。 */
  disconnectRuntime(): Promise<{
    oldServiceInstanceId: string;
    oldProxyErrorCode: string;
    connectedAfterDisconnect: boolean;
    connectionState: string;
    /** 当前提交态 WebLoom 是否暴露了 0.5.0 的 bounded drain API。 */
    closeDrainSupported: boolean;
    closeDrainCompleted: boolean;
    closeDrainTimedOut: boolean;
    closeDrainPendingExecutions: number;
    wasStorageIoOwner: boolean;
    ownerPeerId: string;
    ownerHandoffRevision: number;
    /** 提交态 WebLoom 是否提供了 owner peer 的脱敏投影。 */
    ownerPeerObservable: boolean;
    /** 提交态 WebLoom 是否把远端 endpoint binding 公开给 Runtime 状态。 */
    ownerBindingObservable: boolean;
  }>;
  /** 让 session.open 的反向 bridge 结果在 endpoint 撤权后迟到。 */
  lateSessionResultAfterReconnect(): Promise<{
    barrierStarted: boolean;
    pendingBeforeClose: number;
    reconnectAttemptSettled: boolean;
    lateResultCleanupCompleted: boolean;
    connectedAfterLateResult: boolean;
    connectionStateAfterLateResult: string;
  }>;
  /** 脱敏地报告页面启动阶段的运行单元/业务投影状态，仅供隔离 E2E。 */
  diagnostics(): unknown;
}

declare global {
  interface Window {
    __lifecycleProductionE2E?: LifecycleProductionE2EHooks;
  }
}

export function installLifecycleProductionE2EHooks(host: PluginHost): void {
  const client = getCoordinatorClient();
  const diagnostics: { storageSelection?: unknown } = {};
  // 首次浏览器上下文可能还没有选择 Storage；此时正式 Host 按设计只装配
  // Storage onboarding，Vault capability 尚不存在。测试钩子不能把这个
  // 可恢复阶段改成 fatal，直接复用同一 Coordinator client 的窄 Vault 面。
  const coordinator = host.capabilities.has(VAULT_COORDINATOR_CONTROL_CAPABILITY)
    ? host.capabilities.get(VAULT_COORDINATOR_CONTROL_CAPABILITY)
    : client;

  const bootstrap = async () => {
    const storageStatus = await client.storageControl({ type: "status" });
    if (storageStatus.status === "ok" && storageStatus.value === "authentication") {
      const unlocked = await client.storageControl({ type: "unlock-bucket", password: E2E_VAULT_PASSWORD });
      diagnostics.storageSelection = unlocked.status === "ok" ? unlocked.value : unlocked.status;
      if (unlocked.status !== "ok") throw new Error(`Lifecycle E2E Local unlock failed: ${unlocked.status}`);
    } else if (storageStatus.status !== "ok" || storageStatus.value !== "ready") {
      const selected = await client.storageControl({ type: "initial-setup", plan: {
        transactionId: `lifecycle-e2e-${crypto.randomUUID()}`,
        bucketLabel: "Lifecycle E2E Local",
        backend: "local",
        connection: { kind: "local" },
        firstKey: { kind: "generate", label: "Lifecycle E2E", capabilities: ["p2pkh"], password: E2E_VAULT_PASSWORD },
      } });
      diagnostics.storageSelection = selected.status === "ok" ? selected.value : selected.status;
      if (selected.status !== "ok") throw new Error(`Lifecycle E2E Local setup failed: ${selected.status}`);
    }
    await waitForStorageReady(client);
    const owner = await ensureUnlocked(coordinator, client, diagnostics);
    const runtime = await waitForReadyRuntime(client);
    return {
      ...owner,
      buildId: client.getBootstrapSnapshot().buildId ?? "",
      bridgeState: runtime.state().state,
      services: serviceSummary(runtime),
    };
  };

  const ownerStorageRoundTrip = async () => {
    await bootstrap();
    // session.open 的真实响应携带当前 owner peer 投影；重读一次让
    // survivor 在其它 tab 完成 handoff 后也观察到最新 revision。
    await client.refreshStorageBootstrap();
    // P2PKH 同时有 owner K-V 状态和 owner 文件根；不能用会拒绝
    // 多声明模块的单一声明解析器。这里要打开的是 round-trip 使用的
    // owner K-V 状态，因此必须显式选择 purpose=state。
    const declaration = systemStorageDeclarationForPurpose("p2pkh", "state");
    if (!declaration) throw new Error("Lifecycle E2E p2pkh storage declaration is missing");
    const authority = createStorageBindingAuthority(client, {
    });
    const store = await authority.openOwnerAppStore({ pluginId: "p2pkh", declaration });
    const key = `lifecycle-e2e-${Date.now().toString(36)}`;
    const value = { source: "browser-shared-worker-message-port", ok: true };
    try {
      await store.put(key, value);
      const entry = await store.get<typeof value>(key);
      if (!entry) throw new Error("Lifecycle E2E owner K-V round trip returned no value");
      const runtime = await waitForReadyRuntime(client);
      const ownerPeer = client.getBootstrapSnapshot().storageIoOwnerPeer;
      const runtimeBinding = (runtime.state() as RuntimeStatusSnapshot & {
        binding?: { runtimeInstanceId: string; connectionId: string };
      }).binding;
      return {
        key,
        value: entry.value,
        bridgeState: runtime.state().state,
        serviceInstanceId: runtime.state().services.find((service) => service.capabilityId === COORDINATOR_OWNER_STORAGE_SERVICE)?.serviceInstanceId ?? "",
        ownerPeerId: ownerPeer?.peerId ?? "",
        ownerHandoffRevision: ownerPeer?.handoffRevision ?? 0,
        ownerPeerObservable: Boolean(ownerPeer),
        ownerBindingObservable: Boolean(runtimeBinding),
        ownerBindingMatchesRuntime: Boolean(ownerPeer && runtimeBinding
          && ownerPeer.binding.runtimeInstanceId === runtimeBinding.runtimeInstanceId
          && ownerPeer.binding.connectionId === runtimeBinding.connectionId),
      };
    } finally {
      store.close();
    }
  };

  const deriveAddress = async () => {
    const owner = await bootstrap();
    const runtime = await waitForReadyRuntime(client);
    const result = await runtime.capability(COORDINATOR_CRYPTO_RPC_CAPABILITY).call(
      { type: "deriveP2pkhAddress", network: "main" },
      { operationId: "lifecycle-e2e:derive-address" },
    );
    if (result.type !== "deriveP2pkhAddress") throw new Error("Coordinator crypto returned an unexpected result");
    return {
      address: result.address,
      ownerPublicKeyHex: owner.ownerPublicKeyHex,
      serviceInstanceId: runtime.state().services.find((service) => service.capabilityId === COORDINATOR_CRYPTO_SERVICE)?.serviceInstanceId ?? "",
    };
  };

  const lockRevokesOldProxy = async () => {
    await bootstrap();
    const runtime = await waitForReadyRuntime(client);
    const oldProxy = runtime.capability(COORDINATOR_CRYPTO_RPC_CAPABILITY);
    const oldServiceInstanceId = runtime.state().services.find((service) => service.capabilityId === COORDINATOR_CRYPTO_SERVICE)?.serviceInstanceId ?? "";
    const lockResult = await coordinator.lock();
    let oldProxyErrorCode = "none";
    try {
      await oldProxy.call({ type: "deriveP2pkhAddress", network: "main" }, { operationId: "lifecycle-e2e:old-after-lock" });
    } catch (error) {
      oldProxyErrorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown";
    }
    const unlockResult = await coordinator.unlock(E2E_VAULT_PASSWORD);
    const nextRuntime = await waitForReadyRuntime(client);
    const newServiceInstanceId = nextRuntime.state().services.find((service) => service.capabilityId === COORDINATOR_CRYPTO_SERVICE)?.serviceInstanceId ?? "";
    return {
      lockStatus: lockResult.status,
      unlockStatus: unlockResult.status,
      oldProxyErrorCode,
      oldServiceInstanceId,
      newServiceInstanceId,
      oldProxyRejected: oldProxyErrorCode !== "none",
    };
  };

  const dedicatedWorkerRoundTrip = async () => {
    // 这是 E2E 专用的临时密钥，不接触 Coordinator/Vault 私钥；它只验证
    // appView 的 Dedicated Worker 构建、消息往返和 dispose 后撤权。
    const privateKeyBytes = new Uint8Array(32);
    privateKeyBytes[31] = 1;
    const publicKeyHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const engine = await createSessionCryptoEngine({
      sessionId: `lifecycle-dedicated-worker-${Date.now().toString(36)}`,
      publicKeyHex,
      privateKeyBytes,
      label: "Lifecycle Dedicated Worker",
      capabilities: ["p2pkh"],
      createdAt: new Date().toISOString(),
    }, {
      mode: "appview",
      workerFactory: () => new Worker(new URL("../sessionCryptoDedicatedWorker.ts", import.meta.url), { type: "module" }),
    });
    const digest = new Uint8Array(32);
    digest.fill(7);
    const [address, signature] = await Promise.all([
      engine.deriveP2pkhAddress({ publicKeyHex, network: "main" }),
      engine.signDigest({ publicKeyHex, digest: digest.buffer, format: "der" }),
    ]);
    engine.dispose("lifecycle-e2e-revoke");
    let revoked = false;
    try {
      engine.getIdentity();
    } catch {
      revoked = true;
    }
    await delay(75);
    return { address: address.address, signatureLength: signature.signature.byteLength, revoked };
  };

  const disconnectRuntime = async () => {
    await bootstrap();
    const runtime = client.getRuntimeHandle();
    if (!runtime) throw new Error("Lifecycle E2E Runtime is unavailable before disconnect");
    const oldServiceInstanceId = runtime.state().services.find((service) => service.capabilityId === COORDINATOR_CRYPTO_SERVICE)?.serviceInstanceId ?? "";
    const oldProxy = runtime.capability(COORDINATOR_CRYPTO_RPC_CAPABILITY);
    const ownerPeer = client.getBootstrapSnapshot().storageIoOwnerPeer;
    const runtimeBinding = (runtime.state() as RuntimeStatusSnapshot & {
      binding?: { runtimeInstanceId: string; connectionId: string };
    }).binding;
    const wasStorageIoOwner = Boolean(ownerPeer && runtimeBinding
      && ownerPeer.binding.runtimeInstanceId === runtimeBinding.runtimeInstanceId
      && ownerPeer.binding.connectionId === runtimeBinding.connectionId);
    // 真实 Runtime close handshake：等待两端 execution slots 的 bounded
    // drain 完成后再断开页面，给 Worker 一个确定的 owner-handoff barrier。
    // 提交态和本地验收都消费 WebLoom 0.5.0；仍保留运行时能力探测，
    // 让缺 API 时由严格 spec 明确失败，而不是伪造 drain 结果。
    // 先取消 Coordinator topic stream，结束 Worker 端 async iterator；再由
    // client 观察 WebLoom 0.5.0 的 bounded close ack。缺少 drain API 或真实
    // ack 超时都会由严格 E2E 断言失败，不能把 fallback 当成成功。
    const closeDrainSupported = typeof runtime.drain === "function"
      && typeof client.drainRuntime === "function";
    const closeDrain = closeDrainSupported
      ? await client.drainRuntime(2_000).catch(() => ({
        drained: false,
        timedOut: true,
        pendingExecutions: (() => {
          const inspection = runtime.inspect();
          return inspection && typeof inspection === "object" && "pendingCallCount" in inspection
            && typeof inspection.pendingCallCount === "number"
            ? inspection.pendingCallCount
            : 0;
        })(),
      }))
      : undefined;
    client.disconnect();
    let oldProxyErrorCode = "none";
    try {
      await oldProxy.call({ type: "deriveP2pkhAddress", network: "main" }, { operationId: "lifecycle-e2e:old-after-disconnect" });
    } catch (error) {
      oldProxyErrorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown";
    }
    return {
      oldServiceInstanceId,
      oldProxyErrorCode,
      connectedAfterDisconnect: client.getIsConnected(),
      connectionState: client.getConnectionState(),
      closeDrainSupported,
      closeDrainCompleted: closeDrain?.drained ?? false,
      closeDrainTimedOut: closeDrain?.timedOut ?? false,
      closeDrainPendingExecutions: closeDrain?.pendingExecutions ?? 0,
      wasStorageIoOwner,
      ownerPeerId: ownerPeer?.peerId ?? "",
      ownerHandoffRevision: ownerPeer?.handoffRevision ?? 0,
      ownerPeerObservable: Boolean(ownerPeer),
      ownerBindingObservable: Boolean(runtimeBinding),
    };
  };

  const lateSessionResultAfterReconnect = async () => {
    await bootstrap();
    const barrier = __testArmCoordinatorBridgeBarrier();
    let barrierStarted = false;
    let barrierReleased = false;
    let reconnectAttemptSettled = false;
    let lateResultCleanupCompleted = false;
    let pendingBeforeClose = 0;
    const releaseBarrier = (): void => {
      if (barrierReleased) return;
      barrierReleased = true;
      barrier.release();
    };
    try {
      // disconnect() 先撤销旧物理 peer；随后新 connect() 的 session.open
      // 会走真实 Window reverse capability，并在 barrier 上停住。
      client.disconnect();
      const reconnectAttempt = client.connect().then(
        () => { reconnectAttemptSettled = true; },
        () => { reconnectAttemptSettled = true; },
      );
      await barrier.started;
      barrierStarted = true;
      const runtimeInspection = client.getRuntimeHandle()?.inspect();
      pendingBeforeClose = runtimeInspection && typeof runtimeInspection === "object" && "pendingCallCount" in runtimeInspection
        && typeof runtimeInspection.pendingCallCount === "number"
        ? runtimeInspection.pendingCallCount
        : 0;
      // 新 session.open 仍在 Worker 端等待这条反向结果；立即关闭物理
      // Runtime，使其结果只能作为 late result 到达并被 binding fence 丢弃。
      client.disconnect();
      releaseBarrier();
      await reconnectAttempt;
      // completed 位于真实 Window bridge handler 的 finally；它确认迟到
      // response 已经完成页面侧清理，而不是只观察 connect() 提前因
      // attempt 失效而返回。
      await barrier.completed;
      lateResultCleanupCompleted = true;
    } finally {
      // 失败时也不能把页面测试挂在永远未释放的 bridge barrier 上。
      releaseBarrier();
    }
    return {
      barrierStarted,
      pendingBeforeClose,
      reconnectAttemptSettled,
      lateResultCleanupCompleted,
      connectedAfterLateResult: client.getIsConnected(),
      connectionStateAfterLateResult: client.getConnectionState(),
    };
  };

  const runtimeDiagnostics = () => ({
    connectionState: client.getConnectionState(),
    connected: client.getIsConnected(),
    bootstrap: client.getBootstrapSnapshot(),
    plugins: host.installed().map((pluginId) => {
      const state = host.state(pluginId);
      return { id: pluginId, kind: state.kind, desiredEnabled: state.desiredEnabled, blockedBy: state.blockedBy };
    }),
    homeIds: host.home._ids(),
    homeProjectionIds: host.business.listHomeProjections().map((projection) => projection.id),
    capabilityIds: host.capabilities.registrations().map((entry) => `${entry.capability.kind}:${entry.capability.id}@${entry.capability.version}`),
    bsvPriceState: host.state("bsv-price"),
  });

  window.__lifecycleProductionE2E = {
    bootstrap,
    ownerStorageRoundTrip,
    deriveAddress,
    lockRevokesOldProxy,
    dedicatedWorkerRoundTrip,
    disconnectRuntime,
    lateSessionResultAfterReconnect,
    diagnostics: runtimeDiagnostics,
  };
  window.addEventListener("pagehide", () => {
    delete window.__lifecycleProductionE2E;
  }, { once: true });
}
