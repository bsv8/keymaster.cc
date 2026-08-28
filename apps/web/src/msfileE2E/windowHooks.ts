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
  ProtocolStorageDb,
  SessionCoordinatorClient,
} from "@keymaster/contracts";
import {
  MSFILE_SERVICE_CAPABILITY,
  SESSION_COORDINATOR_CLIENT_CAPABILITY,
} from "@keymaster/contracts";
import { openProtocolStorageDb, verifyAppIdentityProof } from "@keymaster/plugin-protocol";
import type { PluginHost } from "@keymaster/runtime";

const E2E_VAULT_PASSWORD = "msfile-production-e2e-password";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function ensureUnlocked(coordinator: SessionCoordinatorClient): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }> {
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (service.status() === "ready") return;
    await delay(25);
  }
  throw new Error(`MSFile service did not become ready; status=${service.status()}`);
}

export interface MsFileProductionE2EHooks {
  bootstrap(): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }>;
  configure(supplier: MsFileSupplierConfig): Promise<void>;
  status(): string;
  probe(supplierPublicKeyHex: string): ReturnType<MsFileService["probeSupplier"]>;
  stat(seedHashHex: string): ReturnType<MsFileService["stat"]>;
  readSeed(supplierPublicKeyHex: string, seedHashHex: string): ReturnType<typeof summarizeRead>;
  readBlock(supplierPublicKeyHex: string, blockHashHex: string): ReturnType<typeof summarizeRead>;
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
  const coordinator = host.capabilities.get<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
  const service = host.capabilities.get<MsFileService>(MSFILE_SERVICE_CAPABILITY);
  if (!coordinator || !service) throw new Error("MSFile E2E requires enabled Coordinator and MSFile capabilities");
  let protocolDb: ProtocolStorageDb | undefined;

  const hooks: MsFileProductionE2EHooks = {
    bootstrap: () => ensureUnlocked(coordinator),
    async configure(supplier) {
      await ensureUnlocked(coordinator);
      await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: "0", blockMaxPriceSatoshis: "0" });
      await service.upsertSupplier(supplier);
      await waitUntilReady(service);
    },
    status: () => service.status(),
    probe: (supplierPublicKeyHex) => service.probeSupplier(supplierPublicKeyHex),
    stat: (seedHashHex) => service.stat({ seedHashHex }),
    readSeed: async (supplierPublicKeyHex, seedHashHex) => summarizeRead(await service.readSeed({ supplierPublicKeyHex, seedHashHex })),
    readBlock: async (supplierPublicKeyHex, blockHashHex) => summarizeRead(await service.readBlock({ supplierPublicKeyHex, blockHashHex })),
    readSeeds: async (supplierPublicKeyHex, seedHashHexes) => Promise.all(seedHashHexes.map(async (seedHashHex) => summarizeRead(await service.readSeed({ supplierPublicKeyHex, seedHashHex })))),
    readBlocks: async (supplierPublicKeyHex, blockHashHexes) => Promise.all(blockHashHexes.map(async (blockHashHex) => summarizeRead(await service.readBlock({ supplierPublicKeyHex, blockHashHex })))),
    async seedConnectSession(input) {
      const { ownerPublicKeyHex } = await ensureUnlocked(coordinator);
      const appIdentity = verifyAppIdentityProof(input.proof);
      protocolDb ??= await openProtocolStorageDb();
      const now = Date.now();
      await protocolDb.putConnectSession({
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
    appAuthorizations: () => service.listAppAuthorizations(),
    async switchToGeneratedKey() {
      const previousPublicKeyHex = (await ensureUnlocked(coordinator)).ownerPublicKeyHex;
      const generated = await coordinator.vaultOperation({
        type: "generateKey",
        password: E2E_VAULT_PASSWORD,
        label: "MSFile production E2E switched key",
        capabilities: ["p2pkh"],
      });
      if (generated.status !== "ok") throw new Error(`MSFile E2E key switch failed: ${generated.status}`);
      const value = generated.value as { publicKeyHex?: unknown };
      if (typeof value.publicKeyHex !== "string") throw new Error("MSFile E2E key switch returned no public key");
      const current = await ensureUnlocked(coordinator);
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
