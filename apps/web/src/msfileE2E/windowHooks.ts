// 施工单 002/003：仅由 VITE_MSFILE_E2E=1 的测试构建加载。
//
// 本模块不提供 fake transport。它只把真实 PluginHost capability 暴露给
// Playwright，用于驱动 Coordinator -> Window executor -> 正式 Go supplier。
// 普通生产构建不会包含入口，避免把 session fixture 能力暴露给用户页面。

import type {
  AppIdentityProofV1,
  MsFileAppIdentityKey,
  MsFileReadResult,
  MsFileService,
  MsFileSupplierConfig,
  ProtocolStorageRepository,
  VaultCoordinatorControl,
} from "@keymaster/contracts";
import {
  VAULT_COORDINATOR_CONTROL_CAPABILITY,
  MSFILE_SERVICE_CAPABILITY,
  PROTOCOL_STORAGE_REPOSITORY_CAPABILITY,
} from "@keymaster/contracts";
import { verifyAppIdentityProof } from "@keymaster/plugin-protocol";
import type { PluginHost } from "@keymaster/runtime";
import { getCoordinatorClient } from "../keymasterSessionCoordinatorClient.js";
import {
  configureMsFileMediaServiceWorker,
  ensureMsFileMediaServiceWorker,
} from "@keymaster/msfile-media/browser";

const E2E_VAULT_PASSWORD = "msfile-production-e2e-password";
const E2E_MISMATCH_SERVICE_WORKER = "/e2e-mismatch-sw.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function delaySupplierResult<T>(pending: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
  if (milliseconds <= 0) return pending;
  // 让真实 service.readBlock 先发起到 Go supplier 的请求，再延迟向 RangeSource
  // 交付结果；seek/cancel 时传入的 AbortSignal 仍会先取消真实请求。
  void pending.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("E2E supplier read aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      pending.then(resolve, reject);
    }, milliseconds);
  });
}

function bytesOf(result: MsFileReadResult): Uint8Array {
  return new Uint8Array(result.content.bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function summarizeRead(result: MsFileReadResult): Promise<{
  contentHashHex: string;
  byteLength: number;
  sha256Hex: string;
}> {
  const bytes = bytesOf(result);
  return {
    contentHashHex: result.contentHashHex,
    byteLength: bytes.byteLength,
    sha256Hex: await sha256Hex(bytes),
  };
}

async function ensureStorageReady(client: ReturnType<typeof getCoordinatorClient>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await client.storageControl({ type: "status" });
    if (status.status === "ok" && status.value === "ready") return;
    if (status.status !== "ok") {
      throw new Error(`MSFile E2E Storage status failed: ${"message" in status ? status.message : status.status}`);
    }
    if (status.status === "ok" && status.value === "unselected") {
      const selected = await client.storageControl({ type: "initial-setup", plan: {
        transactionId: `msfile-e2e-${crypto.randomUUID()}`,
        bucketLabel: "MSFile E2E Local",
        backend: "local",
        connection: { kind: "local" },
        bucketPassword: E2E_VAULT_PASSWORD,
        firstKey: { kind: "generate", label: "MSFile E2E", capabilities: ["p2pkh"] },
      } });
      if (selected.status !== "ok") throw new Error(`MSFile E2E Local setup failed: ${selected.status}`);
    } else if (status.status === "ok" && status.value === "authentication") {
      const unlocked = await client.storageControl({ type: "unlock-bucket", password: E2E_VAULT_PASSWORD });
      if (unlocked.status !== "ok") throw new Error(`MSFile E2E Local unlock failed: ${unlocked.status}`);
    } else {
      await client.storageControl({ type: "retry" });
    }
    await delay(25);
  }
  throw new Error("MSFile E2E Storage did not become ready");
}

async function ensureUnlocked(
  coordinator: VaultCoordinatorControl,
  client: ReturnType<typeof getCoordinatorClient>,
): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }> {
  await ensureStorageReady(client);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = coordinator.getBootstrapSnapshot();
    if (snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex) {
      return { ownerPublicKeyHex: snapshot.activePublicKeyHex, sessionEpoch: snapshot.sessionEpoch };
    }
    if (snapshot.vaultStatus === "uninitialized") {
      const created = await coordinator.vaultOperation({
        type: "createVaultWithInitialKey",
        password: E2E_VAULT_PASSWORD,
        label: "MSFile production E2E",
        capabilities: ["p2pkh"],
      });
      if (created.status === "ok") continue;
    } else if (snapshot.vaultStatus === "locked") {
      await coordinator.unlock(E2E_VAULT_PASSWORD);
    }
    await delay(20);
  }
  throw new Error("MSFile E2E Vault did not become unlocked");
}

async function waitUntilReady(service: MsFileService): Promise<void> {
  let configurationRead = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (service.status() === "ready") return;
    // 新页面可能先拿到 Worker 的 unconfigured baseline；MSFile runtime
    // 是按需启动的，配置读取本身会触发真实 Coordinator 恢复并刷新代理。
    if (!configurationRead || service.status() === "unconfigured") {
      configurationRead = true;
      try {
        const snapshot = await service.getSettingsSnapshot();
        if (snapshot.globalSettings === null && snapshot.suppliers.length === 0) {
          throw new Error("MSFile service is not configured");
        }
      } catch (error) {
        if (service.status() === "unavailable") {
          await delay(25);
          continue;
        }
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error(`MSFile service did not become ready; status=${service.status()}`);
}

export interface MsFileProductionE2EHooks {
  /** `waitForReady` 仅用于需要立即发起数据面的浏览器验收页。 */
  bootstrap(waitForReady?: boolean): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }>;
  configure(supplier: MsFileSupplierConfig): Promise<void>;
  status(): string;
  probe(supplierPublicKeyHex: string): ReturnType<MsFileService["probeSupplier"]>;
  stat(seedHashHex: string): ReturnType<MsFileService["stat"]>;
  readSeed(supplierPublicKeyHex: string, seedHashHex: string): ReturnType<typeof summarizeRead>;
  readBlock(supplierPublicKeyHex: string, blockHashHex: string): ReturnType<typeof summarizeRead>;
  /** 仅 E2E 使用：控制真实 Read 结果交付延迟，验证 seek/cancel 时的在途请求。 */
  setReadDelay(milliseconds: number): void;
  /** 仅 E2E 使用：安装返回未知协议版本的 SW，验证页面安全终止。 */
  installProtocolMismatchServiceWorker(): Promise<{ errorCode: string; controllerScriptUrl: string }>;
  readSeeds(supplierPublicKeyHex: string, seedHashHexes: string[]): Promise<Awaited<ReturnType<typeof summarizeRead>>[]>;
  readBlocks(supplierPublicKeyHex: string, blockHashHexes: string[]): Promise<Awaited<ReturnType<typeof summarizeRead>>[]>;
  seedConnectSession(input: { sessionId: string; origin: string; proof: AppIdentityProofV1 }): Promise<{ ownerPublicKeyHex: string; appKey: MsFileAppIdentityKey }>;
  appAuthorizations(): ReturnType<MsFileService["listAppAuthorizations"]>;
  switchToGeneratedKey(): Promise<{ previousPublicKeyHex: string; activePublicKeyHex: string }>;
  lock(): Promise<string>;
  unlock(): Promise<string>;
}

declare global {
  interface Window {
    __msfileProductionE2E?: MsFileProductionE2EHooks;
  }
}

export function installMsFileProductionE2EHooks(host: PluginHost): void {
  const client = getCoordinatorClient();
  // 首个页面返回 host 时，Vault/MSFile 可能仍在 storage-onboarding 或
  // owner-apps-ready 异步门禁中。安装测试钩子不能把这个正常竞态升级成
  // fatal；先保留 Coordinator 窄面，真正调用时再取得已装配的 service。
  const coordinator = host.capabilities.has(VAULT_COORDINATOR_CONTROL_CAPABILITY)
    ? host.capabilities.get(VAULT_COORDINATOR_CONTROL_CAPABILITY)
    : client;
  let service: MsFileService | undefined;
  let protocolRepository: ProtocolStorageRepository | undefined;
  let readBlockDelayMs = 0;
  let readBlockPatched = false;
  const getService = (): MsFileService => {
    if (!service) {
      if (!host.capabilities.has(MSFILE_SERVICE_CAPABILITY)) {
        throw new Error("MSFile E2E service is not ready; bootstrap must finish owner-apps-ready");
      }
      service = host.capabilities.get(MSFILE_SERVICE_CAPABILITY);
    }
    if (!readBlockPatched) {
      const readBlock = service.readBlock.bind(service);
      service.readBlock = (input) => delaySupplierResult(readBlock(input), input.signal, readBlockDelayMs);
      readBlockPatched = true;
    }
    return service;
  };

  async function waitForService(): Promise<MsFileService> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (host.capabilities.has(MSFILE_SERVICE_CAPABILITY)) return getService();
      await delay(25);
    }
    throw new Error("MSFile E2E service did not become available after Vault unlock");
  }

  const hooks: MsFileProductionE2EHooks = {
    async bootstrap(waitForReady = false) {
      const owner = await ensureUnlocked(coordinator, client);
      const msfile = await waitForService();
      // 首次启动允许保持 unconfigured；已有配置的业务页可显式要求
      // Window executor 就绪，避免页面代理先以 unavailable 首帧进入操作。
      if (waitForReady) await waitUntilReady(msfile);
      return owner;
    },
    async configure(supplier) {
      await ensureUnlocked(coordinator, client);
      const msfile = await waitForService();
      await msfile.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "0", blockMaxPriceSatoshis: "0" });
      await msfile.upsertSupplier(supplier);
      await waitUntilReady(msfile);
    },
    status: () => getService().status(),
    probe: (supplierPublicKeyHex) => getService().probeSupplier(supplierPublicKeyHex),
    stat: (seedHashHex) => getService().stat({ seedHashHex }),
    readSeed: async (supplierPublicKeyHex, seedHashHex) => summarizeRead(await getService().readSeed({ supplierPublicKeyHex, seedHashHex })),
    readBlock: async (supplierPublicKeyHex, blockHashHex) => summarizeRead(await getService().readBlock({ supplierPublicKeyHex, blockHashHex })),
    setReadDelay(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 30_000) {
        throw new Error("MSFile E2E read delay must be an integer in 0..30000");
      }
      readBlockDelayMs = milliseconds;
    },
    async installProtocolMismatchServiceWorker() {
      configureMsFileMediaServiceWorker({
        scriptUrl: E2E_MISMATCH_SERVICE_WORKER,
        scope: "/",
        timeoutMs: 5000,
      });
      let errorCode = "none";
      try {
        await ensureMsFileMediaServiceWorker();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
          errorCode = error.code;
        } else {
          errorCode = "unknown";
        }
      }
      return {
        errorCode,
        controllerScriptUrl: navigator.serviceWorker.controller?.scriptURL ?? "",
      };
    },
    readSeeds: async (supplierPublicKeyHex, seedHashHexes) => Promise.all(seedHashHexes.map(async (seedHashHex) => summarizeRead(await getService().readSeed({ supplierPublicKeyHex, seedHashHex })))),
    readBlocks: async (supplierPublicKeyHex, blockHashHexes) => Promise.all(blockHashHexes.map(async (blockHashHex) => summarizeRead(await getService().readBlock({ supplierPublicKeyHex, blockHashHex })))),
    async seedConnectSession(input) {
      const { ownerPublicKeyHex } = await ensureUnlocked(coordinator, client);
      const appIdentity = verifyAppIdentityProof(input.proof);
      protocolRepository ??= await host.capabilities.get(PROTOCOL_STORAGE_REPOSITORY_CAPABILITY);
      const now = Date.now();
      await protocolRepository.putConnectSession({
        sessionId: input.sessionId,
        origin: input.origin,
        ownerPublicKeyHex,
        ownerLabel: "MSFile production E2E",
        claimsSnapshot: {},
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
        appIdentity,
      });
      return {
        ownerPublicKeyHex,
        appKey: {
          ownerPublicKeyHex,
          publisherPublicKeyHex: appIdentity.publisherPublicKeyHex,
          appId: appIdentity.appId,
        },
      };
    },
    appAuthorizations: () => getService().listAppAuthorizations(),
    async switchToGeneratedKey() {
      const previousPublicKeyHex = (await ensureUnlocked(coordinator, client)).ownerPublicKeyHex;
      const generated = await coordinator.vaultOperation({
        type: "generateKey",
        password: E2E_VAULT_PASSWORD,
        label: "MSFile production E2E switched key",
        capabilities: ["p2pkh"],
      });
      if (generated.status !== "ok") throw new Error(`MSFile E2E key switch failed: ${generated.status}`);
      const value = generated.value as { publicKeyHex?: unknown };
      if (typeof value.publicKeyHex !== "string") throw new Error("MSFile E2E key switch returned no public key");
      const current = await ensureUnlocked(coordinator, client);
      if (current.ownerPublicKeyHex !== value.publicKeyHex) throw new Error("MSFile E2E generated key did not become active");
      return { previousPublicKeyHex, activePublicKeyHex: current.ownerPublicKeyHex };
    },
    async lock() {
      return (await coordinator.lock()).status;
    },
    async unlock() {
      return (await coordinator.unlock(E2E_VAULT_PASSWORD)).status;
    },
  };

  window.__msfileProductionE2E = hooks;
  window.addEventListener("pagehide", () => {
    delete window.__msfileProductionE2E;
  }, { once: true });
}
