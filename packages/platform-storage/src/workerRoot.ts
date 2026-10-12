import {
  type NetworkIdentity, type StorageRuntimeController, type StorageRuntimeControllerStatus,
  type CoordinatorStorageStateEvent, type CoordinatorAuthorityRecovery, type WalletColdStartSnapshot,
  deriveThirdPartyStorageModuleId,
} from "@keymaster/contracts";
import type { WalletStore } from "@keymaster/contracts/storage-internal";
import {
  createPlatformRootStore, createStorageRuntimeController, createWalletStoreActivity,
  StorageRuntimeError, type StoragePrivateRootStore,
} from "./coordinator/index.js";
import { removeRetiredPluginIntent } from "./assembly.js";

export interface StorageWorkerRootPorts {
  session(): { walletGeneration: string; sessionEpoch: string; runGeneration: string; vaultStatus: string; activePublicKeyHex?: string };
  wallet: { store(): WalletStore | undefined; identity(): Promise<NetworkIdentity>; label(): Promise<string | undefined>; coldStart(): WalletColdStartSnapshot | undefined; lifecycleReady(): boolean };
  artifacts(root: StoragePrivateRootStore): Promise<{ commit(): void; dispose(): void }>;
  io<T>(execute: () => Promise<T>): Promise<T>;
  lifecycle: { ready(): void; stop(): void; reconcile(): void; maintenance(): void };
  abortSession(sessionId: string): void;
  revokeRequests(): void;
  invalidateClients(): void;
  recover(peerId?: string): Promise<boolean>;
  assertAuthority(): Promise<void>;
  recovery(): CoordinatorAuthorityRecovery | undefined;
  publish(event: CoordinatorStorageStateEvent): void;
}

/** 平台根、健康状态和控制器属于 Storage；候选根准备成功前不可见。 */
export function createStorageWorkerRoot(ports: StorageWorkerRootPorts) {
  let root: StoragePrivateRootStore | undefined;
  let token: object | undefined;
  let ready = false;
  let failed = false;
  let controller: StorageRuntimeController | undefined;
  let recovering: Promise<void> | undefined;
  let revision = 0;
  let lastState: CoordinatorStorageStateEvent | undefined;
  let stateTail = Promise.resolve();
  let testRuntime: StorageRuntimeController | undefined;
  let testFailure = false;
  const activity = createWalletStoreActivity(() => {
    if (!lastState) return;
    lastState = { ...lastState, storageRevision: ++revision, activity: activity.snapshot() };
    ports.publish(lastState);
  });
  function status(): StorageRuntimeControllerStatus {
    if (failed) return "degraded";
    const cold = ports.wallet.coldStart()?.state;
    if (cold === "corrupt" || cold === "unsupported") return cold;
    if (ports.session().vaultStatus === "unlocked") return "ready";
    return cold === "ready" ? "locked" : "uninitialized";
  }
  function emit() {
    stateTail = stateTail.then(async () => {
      const cold = status();
      const currentStatus = ["corrupt", "unsupported", "degraded"].includes(cold) ? cold : controller?.status() ?? cold;
      const summary = await controller?.summary().catch(() => null) ?? null;
      const session = ports.session();
      const recovery = ports.recovery();
      lastState = {
        topic: "storage.state", type: "storage.state.changed", storageRevision: ++revision,
        activity: activity.snapshot(), sessionEpoch: session.sessionEpoch, status: currentStatus,
        ...(session.walletGeneration ? { walletGeneration: session.walletGeneration } : {}),
        ...(recovery ? { authorityRecovery: recovery } : {}), summary,
      };
      ports.publish(lastState);
    }, () => undefined);
  }
  async function install() {
    const store = ports.wallet.store();
    if (!store) throw new StorageRuntimeError("storage_unavailable", "Wallet storage is not available");
    await ports.io(() => removeRetiredPluginIntent(store));
    const identity = await ports.wallet.identity();
    const candidateToken = {};
    const candidate = createPlatformRootStore({
      identity, store,
      generations: () => ports.session(), isCurrent: binding => token !== undefined && binding.walletGeneration === ports.session().walletGeneration,
    });
    const artifacts = await ports.artifacts(candidate);
    const previousRoot = root;
    const previousToken = token;
    try {
      root = candidate; token = candidateToken;
      artifacts.commit();
      ready = true;
      ports.lifecycle.maintenance();
    } catch (error) {
      if (token === candidateToken) { root = previousRoot; token = previousToken; }
      artifacts.dispose();
      throw error;
    }
  }
  function assertAvailable() {
    if (!ready) throw new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable");
  }
  function startupError(error: unknown): never {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    failed = code !== "storage_wallet_corrupt" && code !== "storage_wallet_unsupported" && code !== "storage_unavailable";
    emit();
    if (typeof code === "string" && code.startsWith("storage_")) throw error;
    throw new StorageRuntimeError("storage_unavailable", error instanceof Error ? error.message : "Storage startup failed");
  }
  async function ensure(): Promise<StorageRuntimeController> {
    if (controller) return controller;
    if (testRuntime) {
      controller = testRuntime; ready = true;
      ports.lifecycle.ready(); ports.lifecycle.reconcile();
      return controller;
    }
    if (testFailure) { failed = true; emit(); throw new StorageRuntimeError("storage_unavailable", "storage_unavailable"); }
    if (!ports.wallet.lifecycleReady() || !root) startupError(new Error("Wallet storage root is unavailable"));
    const boundRoot = root!;
    let candidate: StorageRuntimeController;
    try {
      candidate = await createStorageRuntimeController({
        summary: async () => {
          const session = ports.session();
          return {
            ...(session.activePublicKeyHex ? { publicKeyHex: session.activePublicKeyHex } : {}),
            ...(session.walletGeneration ? { label: await ports.wallet.label(), walletGeneration: session.walletGeneration } : {}),
          };
        },
        openAppFileStore: async context => boundRoot.openModuleFileStore({
          declaration: { moduleId: deriveThirdPartyStorageModuleId(context.appIdentity.publisherPublicKeyHex, context.appIdentity.appId), purposeId: "", authority: "third-party-app", model: "files", schemaVersion: 1 },
          appStorageName: context.appStorageName, verifiedAppIdentity: { publisherPublicKeyHex: context.appIdentity.publisherPublicKeyHex, appId: context.appIdentity.appId },
        }),
        abortSession: async id => ports.abortSession(id),
        persistence: async () => await ports.wallet.store()?.persistence() ?? { persisted: false },
        status,
      });
    } catch (error) { startupError(error); }
    // Root 可以在异步创建期间被重置，候选控制器不能绑定到下一代。
    if (root !== boundRoot) { (candidate! as StorageRuntimeController & { dispose?(): void }).dispose?.(); throw new StorageRuntimeError("storage_unavailable", "Storage binding became stale"); }
    controller = candidate!; ready = true; failed = false;
    ports.lifecycle.ready(); ports.lifecycle.reconcile(); ports.lifecycle.maintenance();
    controller.subscribe(emit); emit();
    return controller;
  }
  async function recover(peerId?: string) {
    if (recovering) return recovering;
    const pending = (async () => {
      if (!root) throw new StorageRuntimeError("storage_unavailable", "Wallet storage root is unavailable");
      ports.invalidateClients(); ready = true;
      await ports.assertAuthority();
      if (!await ports.recover(peerId)) return;
      failed = false; emit();
    })();
    recovering = pending;
    try { await pending; } catch (error) { failed = true; emit(); throw error; }
    finally { if (recovering === pending) recovering = undefined; }
  }
  async function release() {
    ports.revokeRequests();
    (controller as StorageRuntimeController & { dispose?(): void } | undefined)?.dispose?.();
    controller = undefined; ready = false;
    ports.lifecycle.stop(); ports.lifecycle.reconcile();
  }
  function failure(error: unknown) {
    if (!ready) return;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code !== "storage_unavailable" && code !== "storage_wallet_corrupt") return;
    if (code === "storage_unavailable" && /cancel|abort|closed|stale|fenced|binding|owner storage requests did not drain|key\/session transition/i.test(message)) return;
    console.warn("[storage] business I/O failed", { code, message: "Wallet storage operation failed" });
  }
  function isFailure(error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && code.startsWith("storage_") || code === "upgrade.authority_claim_failed"
      || Boolean(error && typeof error === "object" && "recoveryRequired" in error && error.recoveryRequired) || failed;
  }
  return {
    install, ensure, recover, release, assertAvailable, failure, isFailure, status, emit, activity,
    get root() { return root; }, set root(value) { root = value; },
    get token() { return token; }, set token(value) { token = value; },
    get ready() { return ready; }, set ready(value) { ready = value; },
    get failed() { return failed; }, set failed(value) { failed = value; },
    get controller() { return controller; }, set controller(value) { controller = value; },
    get lastState() { return lastState; }, set lastState(value) { lastState = value; },
    get revision() { return revision; }, set revision(value) { revision = value; },
    get stateTail() { return stateTail; }, set stateTail(value) { stateTail = value; },
    get testRuntime() { return testRuntime; }, set testRuntime(value) { testRuntime = value; },
    get testFailure() { return testFailure; }, set testFailure(value) { testFailure = value; },
  };
}
