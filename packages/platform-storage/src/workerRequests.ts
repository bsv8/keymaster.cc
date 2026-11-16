import { defineWorkerRequestRoute } from "@keymaster/contracts";
import {
  type CoordinatorClientRequest as PublicCoordinatorClientRequest, type CoordinatorResponse, type SessionEpoch,
  type StorageRuntimeController, SYSTEM_STORAGE_DECLARATIONS, CENTRAL_STORAGE_DECLARATIONS,
} from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData, StorageOwnerGrant } from "@keymaster/contracts/storage-internal";
import { createStorageGrantAuthority, createStorageDataQueue, createStorageDataExecutor, type StoragePrivateRootStore } from "./coordinator/index.js";
import { StorageBrowseCoordinator, type StorageBrowsePrivateCommand } from "./assembly.js";
type CoordinatorClientRequest = PublicCoordinatorClientRequest | StorageBrowsePrivateCommand;
export interface CoordinatorStorageBinding {
  /** 钱包身份世代；重置或重新初始化后改变。 */
  walletGeneration: string;
  /** 会话世代；锁定、解锁、改密后改变。 */
  sessionEpoch: SessionEpoch;
  /** Worker 运行世代；每次 Worker 启动生成。 */
  runGeneration: string;
  /** 平台 Root 的对象身份；换绑时改变，必须保持引用相等。 */
  platformRootToken: object;
}
export interface StorageWorkerRequestPorts {
  session(): { sessionEpoch: string; walletGeneration: string; runGeneration: string; vaultStatus: string; activePublicKeyHex?: string };
  root(): StoragePrivateRootStore | undefined;
  token(): object | undefined;
  ready(): boolean;
  assertAvailable(): void;
  unavailable(message: string): Error;
  ensureRuntime(peerId?: string): Promise<StorageRuntimeController>;
  failure(error: unknown): void;
  admission: { open(peerId: string): boolean; revoked(peerId: string): boolean; response(requestId: string): CoordinatorResponse };
  io: { run<T>(operation: "read" | "write", signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>, options: { auditOperation: "storage.browse" | "storage.owner.data"; durableLease?: boolean; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean; allowLocalBindingDiscard?: boolean }): Promise<T> };
  clearSecrets(request: { kind: string }): void;
  errorResponse(requestId: string, error: unknown): CoordinatorResponse;
  control(request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>, signal?: AbortSignal, peerId?: string): Promise<CoordinatorResponse>;
}

/** Storage 授权、绑定排空、请求队列与数据分发均由 Storage 运行时拥有。 */
export function createStorageWorkerRequests(ports: StorageWorkerRequestPorts) {
  const storageBrowseCoordinator = new StorageBrowseCoordinator({
    root: () => { const store = ports.root(); const token = ports.token(); return store && token && ports.ready() ? { store, token } : undefined; },
    generations: () => ({
      walletGeneration: ports.session().walletGeneration,
      sessionEpoch: ports.session().sessionEpoch, runGeneration: ports.session().runGeneration
    }),
    isUnlocked: () => ports.session().vaultStatus === "unlocked",
    isPeerOpen: ports.admission.open,
    isPeerRevoked: peerId => ports.admission.revoked(peerId),
    withReadLease: task => ports.io.run("read", undefined, task, { auditOperation: "storage.browse" }),
  });

  const storageRequests = new Map<string, { controller: AbortController; clientId: string; walletPublicKeyHex?: string }>();

  const storageRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;

  const storagePortCounts = new Map<string, number>();

  const storageGrantAuthority = createStorageGrantAuthority({
    session: () => ({ sessionEpoch: ports.session().sessionEpoch, walletGeneration: ports.session().walletGeneration, runGeneration: ports.session().runGeneration, unlocked: ports.session().vaultStatus === "unlocked", rootAvailable: ports.root() !== undefined }),
  });


  const ownerStorageGrants = storageGrantAuthority.owners;



  const resolveOwnerStorageGrant = storageGrantAuthority.resolveOwner;


  let storageMutationTail: Promise<void> = Promise.resolve();

  const STORAGE_DATA_MAX_PER_PORT = 16;

  const storageDataQueue = createStorageDataQueue();

  const withStorageDataSlot = storageDataQueue.run;

  const storageBindingRequests = new Set<Promise<void>>();

  let pendingStorageBindingDrain: Promise<void> | undefined;

  const STORAGE_BINDING_DRAIN_TIMEOUT_MS = 5_000;

  function currentCoordinatorStorageBinding(): CoordinatorStorageBinding | undefined {
    if (!ports.token()) return undefined;
    return {
      walletGeneration: ports.session().walletGeneration,
      sessionEpoch: ports.session().sessionEpoch,
      runGeneration: ports.session().runGeneration,
      platformRootToken: ports.token()!,
    };
  }

  function storageBindingsEqual(left: CoordinatorStorageBinding, right: CoordinatorStorageBinding): boolean {
    return left.walletGeneration === right.walletGeneration
      && left.sessionEpoch === right.sessionEpoch
      && left.runGeneration === right.runGeneration
      && left.platformRootToken === right.platformRootToken;
  }

  function assertStorageBindingLive(binding: CoordinatorStorageBinding): void {
    const current = currentCoordinatorStorageBinding();
    if (!current || !storageBindingsEqual(current, binding)) {
      throw ports.unavailable("Storage binding became stale");
    }
  }

  function beginStorageBindingRequest(): () => void {
    let resolveRelease!: () => void;
    const pending = new Promise<void>((resolve) => { resolveRelease = resolve; });
    storageBindingRequests.add(pending);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      storageBindingRequests.delete(pending);
      resolveRelease();
    };
  }

  async function drainStorageBindingRequests(): Promise<void> {
    if (storageBindingRequests.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = await Promise.race([
        Promise.allSettled([...storageBindingRequests]).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), STORAGE_BINDING_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (!drained) {
        // 超时不能继续清库：忽略 AbortSignal 的迟到写入仍可能在清空之后
        // 落到新钱包里，因此必须保留绑定世代已经推进的事实。
        throw ports.unavailable("Storage requests did not drain before the binding timeout");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function rememberStorageBindingDrain(promise: Promise<void>): void {
    const existing = pendingStorageBindingDrain;
    if (existing === promise) return;
    pendingStorageBindingDrain = promise;
    // 锁定路径不能因为迟到请求而产生未处理 rejection；真正的错误由下一次
    // 解锁再次 await 并重新 drain 时返回。
    void promise.then(
      () => undefined,
      () => undefined
    );
  }

  async function waitForPendingStorageBindingDrain(): Promise<void> {
    const pending = pendingStorageBindingDrain;
    if (!pending) return;
    try {
      await pending;
    } catch {
      // 初次锁定的 drain 可能已经超时，但请求随后才自然结束；解锁时重新
      // 观察当前集合，不能把旧的 rejected Promise 当成永久结论。
      await drainStorageBindingRequests();
    }
    if (pendingStorageBindingDrain === pending) pendingStorageBindingDrain = undefined;
  }

  function beginStorageBindingRequestForTest(): () => void {
    return beginStorageBindingRequest();
  }

  function revokeStorageSessionGrants(): void {
    ownerStorageGrants.clear();
    storageRequests.clear();
  }

  function reserveStoragePortSlot(clientId: string): boolean {
    const count = storagePortCounts.get(clientId) ?? 0;
    if (count >= STORAGE_DATA_MAX_PER_PORT) return false;
    storagePortCounts.set(clientId, count + 1);
    return true;
  }

  function releaseStoragePortSlot(clientId: string): void {
    const next = Math.max(0, (storagePortCounts.get(clientId) ?? 1) - 1);
    if (next) storagePortCounts.set(clientId, next); else storagePortCounts.delete(clientId);
  }

  const { executeOwnerStorageDataUnsafe } = createStorageDataExecutor({
    root: () => ports.root(),
    rootToken: () => ports.token(),
    sessionEpoch: () => ports.session().sessionEpoch,
    assertStorageDataAvailable: ports.assertAvailable,
    storageUnavailableError: ports.unavailable,
    resolveOwnerStorageGrant,
    beginStorageBindingRequest,
    currentCoordinatorStorageBinding,
    assertStorageBindingLive,
  });

  async function executeOwnerStorageData(
    data: CoordinatorOwnerStorageData,
    actualClientId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const operation = data.type === "owner.get" || data.type === "owner.list" ? "read" : "write";
    return ports.io.run(operation, signal, (leaseSignal) => executeOwnerStorageDataUnsafe(data, actualClientId, leaseSignal), {
      auditOperation: "storage.owner.data",
      // owner K-V 的读取没有不可逆副作用；写入仍登记当前 Worker 的内存
      // lease，保证本次运行不会越过未知的本地写入。
      durableLease: operation === "write",
    });
  }

  function revokeStorageSessionRequests(walletPublicKeyHex: string): void {
    for (const [requestId, pending] of storageRequests) {
      if (pending.walletPublicKeyHex === walletPublicKeyHex) { pending.controller.abort(); storageRequests.delete(requestId); }
    }
  }

  async function abortStorageSession(walletPublicKeyHex: string, peerId: string): Promise<void> {
    revokeStorageSessionRequests(walletPublicKeyHex);
    const service = await ports.ensureRuntime(peerId);
    await service.abortSession(walletPublicKeyHex);
  }

  async function executeStorageRequest(request: Extract<CoordinatorClientRequest, { kind: "storage.control" | "storage.cancel" | "storage.session.abort" | "storage.browse.open" | "storage.browse.data" | "storage.browse.close" | "storage.owner.bind" | "storage.owner.data" | "storage.clear.root" }>, actualClientId: string, requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
    if (request.kind === "storage.browse.open" || request.kind === "storage.browse.data" || request.kind === "storage.browse.close") {
      return storageBrowseCoordinator.execute(request, actualClientId, requestSignal);
    }
    if (request.kind === "storage.cancel") {
      const target = storageRequests.get(storageRequestKey(actualClientId, request.targetRequestId));
      if (target?.clientId === actualClientId) target.controller.abort();
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
    }
    if (request.kind === "storage.session.abort") {
      await abortStorageSession(request.walletPublicKeyHex, actualClientId);
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" } };
    }
    if (request.kind === "storage.owner.bind") {
      const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId]?.find((candidate) => candidate.authority === "built-in-module" && candidate.purposeId === request.declaration.purposeId);
      if (!expected || expected.moduleId !== request.pluginId || expected.authority !== "built-in-module"
        || (expected.model !== "kv" && expected.model !== "files")
        || request.declaration.moduleId !== expected.moduleId
        || request.declaration.purposeId !== expected.purposeId
        || request.declaration.authority !== expected.authority
        || request.declaration.model !== expected.model
        || request.declaration.schemaVersion !== expected.schemaVersion) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Owner storage declaration is not authorized", code: "storage_forbidden" } };
      }
      if (ports.session().vaultStatus !== "unlocked" || !ports.session().activePublicKeyHex || !ports.root()) return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Owner storage requires an unlocked wallet", code: "storage_unavailable" } };
      if (ports.admission.revoked(actualClientId)) return ports.admission.response(request.requestId);
      const grant: StorageOwnerGrant & { clientId: string } = {
        ...ports.root()!.identity,
        storageGrantId: `owner-${crypto.randomUUID()}`,
        walletGeneration: ports.session().walletGeneration,
        runGeneration: ports.session().runGeneration,
        moduleId: expected.moduleId,
        purposeId: expected.purposeId,
        authority: expected.authority,
        model: expected.model,
        schemaVersion: expected.schemaVersion,
        sessionEpoch: ports.session().sessionEpoch,
        clientId: actualClientId,
      };
      ownerStorageGrants.set(grant.storageGrantId, grant);
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: grant };
    }
    if (request.kind === "storage.clear.root") {
      // 只清空一个已绑定根：中央声明目录里登记过的 namespace，或某个已验证 App
      // 自己的 apps/<app-name>/ 目录。调用方不能自报未登记的坐标，也不能用
      // 别人的 name 清理其它 App 的数据。
      if (ports.admission.revoked(actualClientId)) return ports.admission.response(request.requestId);
      if (!ports.root()) {
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Storage root is unavailable", code: "storage_unavailable" } };
      }
      const declaration = request.input.declaration;
      if (declaration.authority === "third-party-app") {
        if (request.input.appStorageName === undefined) {
          return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Clearing an app root requires its registered appStorageName", code: "storage_forbidden" } };
        }
        if (declaration.model !== "files" || declaration.purposeId !== "") {
          return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Third-party app storage declaration is invalid", code: "storage_forbidden" } };
        }
      } else {
        const expected = Object.values(CENTRAL_STORAGE_DECLARATIONS).find((candidate) => candidate.moduleId === declaration.moduleId
          && candidate.purposeId === declaration.purposeId
          && candidate.authority === declaration.authority
          && candidate.model === declaration.model
          && candidate.schemaVersion === declaration.schemaVersion);
        if (!expected) {
          return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: "Storage declaration is not authorized", code: "storage_forbidden" } };
        }
      }
      const controller = new AbortController();
      const requestKey = storageRequestKey(actualClientId, request.requestId);
      storageRequests.set(requestKey, { controller, clientId: actualClientId });
      try {
        await ports.io.run("write", controller.signal, async (signal) => {
          if (signal.aborted) throw ports.unavailable("Storage root clearing was cancelled");
          const root = ports.root();
          if (!root) throw ports.unavailable("Platform storage has not been bootstrapped");
          await root.clearStorageRoot(request.input);
        }, { auditOperation: "storage.owner.data" });
      } catch (error) {
        ports.failure(error);
        throw error;
      } finally {
        if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
      }
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "ok" }, operationResult: true };
    }
    if (request.kind === "storage.owner.data") {
      if (ports.admission.revoked(actualClientId)) return ports.admission.response(request.requestId);
      const controller = new AbortController();
      const requestKey = storageRequestKey(actualClientId, request.requestId);
      storageRequests.set(requestKey, { controller, clientId: actualClientId });
      let value: unknown;
      try {
        value = await withStorageDataSlot(actualClientId, () => executeOwnerStorageData(request.data, actualClientId, controller.signal), controller.signal);
      } catch (error) {
        ports.failure(error);
        throw error;
      } finally {
        if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
      }
      return {
        requestId: request.requestId,
        sessionEpoch: ports.session().sessionEpoch,
        ack: { status: "ok" },
        // owner.delete is void; owner.get may legitimately return undefined.
        ...(request.data.type === "owner.delete" ? {} : { operationResult: value }),
      };
    }

    const controller = new AbortController();
    const requestKey = storageRequestKey(actualClientId, request.requestId);
    if (ports.admission.revoked(actualClientId)) return ports.admission.response(request.requestId);
    storageRequests.set(requestKey, { controller, clientId: actualClientId });
    try {
      const run = storageMutationTail.then(() => ports.control(request, controller.signal, actualClientId), () => ports.control(request, controller.signal, actualClientId));
      storageMutationTail = run.then(() => undefined, () => undefined);
      return await run;
    } finally {
      if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
    }
  }

  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: `storage.${string}` }>>({
    kinds: ["storage.control", "storage.cancel", "storage.session.abort", "storage.browse.open", "storage.browse.data", "storage.browse.close", "storage.clear.root", "storage.owner.bind", "storage.owner.data"],
    policy: request => ({
      scheduling: "parallel", validateEpoch: false,
      cleanupOnly: request.kind === "storage.cancel" || request.kind === "storage.session.abort",
      activatesWallet: request.kind === "storage.control" && ["unlock", "initialize", "reset-wallet", "change-key-password"].includes(request.control.type)
    }),
    execute: (request, call) => executeStorageRequest(request, call.peerId, call.signal).catch(error => { ports.failure(error); return ports.errorResponse(call.requestId, error); }).finally(() => ports.clearSecrets(request)),
  });
  return {
    route,
    storageBrowseCoordinator,
    storageRequests,
    storageRequestKey,
    storagePortCounts,
    storageGrantAuthority,
    ownerStorageGrants,
    resolveOwnerStorageGrant,
    get storageMutationTail() { return storageMutationTail; }, set storageMutationTail(value: typeof storageMutationTail) { storageMutationTail = value; },
    STORAGE_DATA_MAX_PER_PORT,
    storageDataQueue,
    withStorageDataSlot,
    storageBindingRequests,
    get pendingStorageBindingDrain() { return pendingStorageBindingDrain; }, set pendingStorageBindingDrain(value: typeof pendingStorageBindingDrain) { pendingStorageBindingDrain = value; },
    STORAGE_BINDING_DRAIN_TIMEOUT_MS,
    currentCoordinatorStorageBinding,
    storageBindingsEqual,
    assertStorageBindingLive,
    beginStorageBindingRequest,
    drainStorageBindingRequests,
    rememberStorageBindingDrain,
    waitForPendingStorageBindingDrain,
    beginStorageBindingRequestForTest,
    revokeStorageSessionGrants,
    reserveStoragePortSlot,
    releaseStoragePortSlot,
    executeOwnerStorageDataUnsafe,
    executeOwnerStorageData,
    revokeStorageSessionRequests,
    abortStorageSession,
    executeStorageRequest,
  };
}
