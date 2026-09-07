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
  SYSTEM_STORAGE_DECLARATIONS,
  VAULT_COORDINATOR_CONTROL_CAPABILITY,
} from "@keymaster/contracts";
import type { VaultCoordinatorControl } from "@keymaster/contracts";
import type { RemoteServiceBridge } from "webloom-framework";
import { createStorageBindingAuthority, requestOpfsPersistence, writeStorageBootstrap } from "@keymaster/platform-storage/coordinator";
import { createSessionCryptoEngine } from "@keymaster/plugin-vault";
import { getCoordinatorClient } from "../keymasterSessionCoordinatorClient.js";

const E2E_VAULT_PASSWORD = "lifecycle-production-e2e-password";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serviceSummary(bridge: RemoteServiceBridge | undefined): Array<{
  capabilityId: string;
  providerInstanceId: string;
  status: string;
  hasServerGrant: boolean;
}> {
  return bridge?.services().map((service) => ({
    capabilityId: service.capabilityId,
    providerInstanceId: service.providerInstanceId,
    status: service.status,
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

async function waitForReadyBridge(client: ReturnType<typeof getCoordinatorClient>): Promise<RemoteServiceBridge> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const bridge = client.getServiceBridge();
    const services = bridge?.services() ?? [];
    const ownerStorageReady = services.some((service) =>
      service.capabilityId === COORDINATOR_OWNER_STORAGE_SERVICE
      && service.contractVersion === COORDINATOR_SERVICE_CONTRACT_VERSION
      && service.status === "ready"
      && typeof service.grantId === "string"
    );
    const cryptoReady = services.some((service) =>
      service.capabilityId === COORDINATOR_CRYPTO_SERVICE
      && service.contractVersion === COORDINATOR_SERVICE_CONTRACT_VERSION
      && service.status === "ready"
      && typeof service.grantId === "string"
    );
    if (bridge?.state === "ready" && ownerStorageReady && cryptoReady) return bridge;
    await delay(25);
  }
  throw new Error("Lifecycle E2E service bridge did not become ready");
}

async function waitForStorageReady(client: ReturnType<typeof getCoordinatorClient>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await client.storageControl({ type: "status" });
    if (status.status === "ok" && status.value === "ready") return;
    // Storage 首次选择和 Coordinator 初始化是两个异步阶段；不能只看
    // Vault snapshot 已变成 uninitialized 就提前发起 createVault。
    await client.storageControl({ type: "retry" });
    await delay(25);
  }
  throw new Error("Lifecycle E2E Storage did not become ready");
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
    providerInstanceId: string;
  }>;
  /** 通过真实独立服务桥调用 Coordinator crypto 最终边界。 */
  deriveAddress(): Promise<{
    address: string;
    ownerPublicKeyHex: string;
    providerInstanceId: string;
  }>;
  /** 锁屏撤销旧代理，解锁后必须产生新的 provider 实例。 */
  lockRevokesOldProxy(): Promise<{
    lockStatus: string;
    unlockStatus: string;
    oldProxyErrorCode: string;
    oldProviderInstanceId: string;
    newProviderInstanceId: string;
    oldProxyRejected: boolean;
  }>;
  /** 在 Chromium 中真实启动 Dedicated Worker 的 Session Crypto 路径。 */
  dedicatedWorkerRoundTrip(): Promise<{
    address: string;
    signatureLength: number;
    revoked: boolean;
  }>;
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
    ? host.capabilities.get<VaultCoordinatorControl>(VAULT_COORDINATOR_CONTROL_CAPABILITY)
    : client as unknown as VaultCoordinatorControl;

  const bootstrap = async () => {
    const storageStatus = await client.storageControl({ type: "status" });
    if (storageStatus.status !== "ok" || storageStatus.value !== "ready") {
      await requestOpfsPersistence();
      const selected = await client.storageControl({ type: "select-opfs" });
      diagnostics.storageSelection = selected.status === "ok" ? selected.value : selected.status;
      if (selected.status !== "ok") throw new Error(`Lifecycle E2E OPFS selection failed: ${selected.status}`);
      // 与 StorageRpcProxy.selectOpfs 的生产行为一致：Worker 选择成功后，
      // 页面还要留下下次 hello 可读取的首帧后端选择。否则页面导航时
      // SharedWorker 可能因没有活动端口退出，新 Worker 会回到 onboarding。
      writeStorageBootstrap({ selectedBackend: "opfs", selectedProfileId: "opfs" });
    }
    await waitForStorageReady(client);
    const owner = await ensureUnlocked(coordinator, client, diagnostics);
    const bridge = await waitForReadyBridge(client);
    return {
      ...owner,
      buildId: client.getBootstrapSnapshot().buildId ?? "",
      bridgeState: bridge.state,
      services: serviceSummary(bridge),
    };
  };

  const ownerStorageRoundTrip = async () => {
    await bootstrap();
    const declaration = SYSTEM_STORAGE_DECLARATIONS.p2pkh;
    if (!declaration) throw new Error("Lifecycle E2E p2pkh storage declaration is missing");
    const authority = createStorageBindingAuthority(client, {
      serviceBridge: () => client.getServiceBridge(),
      requireServiceBridge: true,
    });
    const store = await authority.openOwnerAppStore({ pluginId: "p2pkh", declaration });
    const key = `lifecycle-e2e-${Date.now().toString(36)}`;
    const value = { source: "browser-shared-worker-message-port", ok: true };
    try {
      await store.put(key, value);
      const entry = await store.get<typeof value>(key);
      if (!entry) throw new Error("Lifecycle E2E owner K-V round trip returned no value");
      const bridge = await waitForReadyBridge(client);
      return {
        key,
        value: entry.value,
        bridgeState: bridge.state,
        providerInstanceId: bridge.services().find((service) => service.capabilityId === COORDINATOR_OWNER_STORAGE_SERVICE)?.providerInstanceId ?? "",
      };
    } finally {
      store.close();
    }
  };

  const deriveAddress = async () => {
    const owner = await bootstrap();
    const bridge = await waitForReadyBridge(client);
    const proxy = bridge.requireProxy({
      capabilityId: COORDINATOR_CRYPTO_SERVICE,
      contractVersion: COORDINATOR_SERVICE_CONTRACT_VERSION,
      execution: "coordinator-worker",
    });
    const result = await proxy.call<{ type: "deriveP2pkhAddress"; network: "main" }, { type: "deriveP2pkhAddress"; address: string }>(
      { type: "deriveP2pkhAddress", network: "main" },
      { operationId: "lifecycle-e2e:derive-address" },
    );
    return {
      address: result.address,
      ownerPublicKeyHex: owner.ownerPublicKeyHex,
      providerInstanceId: proxy.reference.providerInstanceId,
    };
  };

  const lockRevokesOldProxy = async () => {
    await bootstrap();
    const bridge = await waitForReadyBridge(client);
    const oldProxy = bridge.requireProxy({
      capabilityId: COORDINATOR_CRYPTO_SERVICE,
      contractVersion: COORDINATOR_SERVICE_CONTRACT_VERSION,
      execution: "coordinator-worker",
    });
    const oldProviderInstanceId = oldProxy.reference.providerInstanceId;
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
    const nextBridge = await waitForReadyBridge(client);
    const newProviderInstanceId = nextBridge.services().find((service) => service.capabilityId === COORDINATOR_CRYPTO_SERVICE)?.providerInstanceId ?? "";
    return {
      lockStatus: lockResult.status,
      unlockStatus: unlockResult.status,
      oldProxyErrorCode,
      oldProviderInstanceId,
      newProviderInstanceId,
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

  window.__lifecycleProductionE2E = {
    bootstrap,
    ownerStorageRoundTrip,
    deriveAddress,
    lockRevokesOldProxy,
    dedicatedWorkerRoundTrip,
  };
  window.addEventListener("pagehide", () => {
    delete window.__lifecycleProductionE2E;
  }, { once: true });
}
