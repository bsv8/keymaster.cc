// Storage Worker 的私有浏览端点。框架 private handler 完成消费实例/连接授权后，
// 这里继续负责页面会话、钱包世代、分页句柄以及取消，不处理 Connect grant。
import type { CoordinatorResponse } from "@keymaster/contracts";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";
import { createStorageBrowseService, type StorageBrowseAuthorization, type StorageBrowseRuntime } from "../runtime/storageBrowseService.js";
import { StorageRuntimeError } from "../runtime/storageError.js";
import type { StorageBrowsePrivateCommand } from "./storageBrowsePrivateCapability.js";

interface BrowseGenerations { walletGeneration: string; sessionEpoch: string; runGeneration: string }
export interface StorageBrowseCoordinatorOptions {
  root: () => { store: StoragePrivateRootStore; token: object } | undefined;
  generations: () => BrowseGenerations;
  isUnlocked: () => boolean;
  /** 从已提交的真实页面 peer 会话读取，不接受请求中的自报身份。 */
  isPeerOpen: (peerId: string) => boolean;
  isPeerRevoked: (peerId: string) => boolean;
  withReadLease: <T>(task: () => Promise<T>) => Promise<T>;
}
interface Authorization extends BrowseGenerations { peerId: string; unitId: string }

export class StorageBrowseCoordinator {
  private readonly authorizations = new Map<string, Authorization>();
  private runtime?: StorageBrowseRuntime;
  private rootToken?: object;
  private bindingGeneration = 0;
  private opening?: { token: object; promise: Promise<StorageBrowseRuntime> };
  constructor(private readonly options: StorageBrowseCoordinatorOptions) {}

  revokeClient(peerId: string): void {
    for (const [id, record] of this.authorizations) if (record.peerId === peerId) this.authorizations.delete(id);
    this.runtime?.revokeClient(peerId);
  }
  revokeAll(): void {
    this.bindingGeneration += 1;
    this.opening = undefined;
    this.authorizations.clear(); this.runtime?.revokeAll();
  }
  dropBinding(): void { this.revokeAll(); this.runtime = undefined; this.rootToken = undefined; }
  /** 仅供可信装配的测试诊断，不返回授权材料或浏览内容。 */
  hasClientAuthorization(peerId: string): boolean {
    return [...this.authorizations.values()].some(record => record.peerId === peerId);
  }
  private issue(peerId: string): string | undefined {
    if (this.options.isPeerRevoked(peerId) || !this.options.isPeerOpen(peerId)) return undefined;
    if (!this.options.isUnlocked() || !this.options.root()) throw new StorageRuntimeError("storage_unavailable", "Storage browse requires a ready storage root");
    this.revokeClient(peerId);
    const id = crypto.randomUUID();
    this.authorizations.set(id, { peerId, unitId: "storage.window", ...this.options.generations() });
    return id;
  }
  private resolve(peerId: string, id: unknown): StorageBrowseAuthorization | undefined {
    if (typeof id !== "string") return undefined;
    const record = this.authorizations.get(id);
    return record?.peerId === peerId ? { clientId: peerId, ...record } : undefined;
  }
  private async ensureRuntime(): Promise<StorageBrowseRuntime> {
    const root = this.options.root();
    if (!root) throw new StorageRuntimeError("storage_unavailable", "Storage browse requires a ready storage root");
    if (this.runtime && this.rootToken === root.token) return this.runtime;
    if (this.opening?.token === root.token) return this.opening.promise;
    this.runtime?.revokeAll();
    const generation = this.bindingGeneration;
    const promise = (async () => {
      const wallet = await root.store.openBrowseStore();
      if (generation !== this.bindingGeneration || this.options.root()?.token !== root.token) {
        throw new StorageRuntimeError("storage_unavailable", "Storage browse root was replaced while opening");
      }
      const runtime = createStorageBrowseService({ wallet,
        walletGeneration: () => this.options.generations().walletGeneration,
        sessionEpoch: () => this.options.generations().sessionEpoch,
        runGeneration: () => this.options.generations().runGeneration,
        trustedAuthorization: (peerId, id) => this.resolve(peerId, id),
        isUnlocked: this.options.isUnlocked, withReadLease: this.options.withReadLease,
      });
      this.runtime = runtime; this.rootToken = root.token;
      return runtime;
    })();
    const opening = { token: root.token, promise };
    this.opening = opening;
    try { return await promise; }
    finally { if (this.opening === opening) this.opening = undefined; }
  }

  async execute(request: StorageBrowsePrivateCommand, peerId: string, signal?: AbortSignal): Promise<CoordinatorResponse> {
    const envelope = () => ({ requestId: request.requestId, sessionEpoch: this.options.generations().sessionEpoch });
    const cancelled = (): CoordinatorResponse => ({ ...envelope(), ack: { status: "error", code: "storage_unavailable", message: "Storage browse request was cancelled" } });
    if (signal?.aborted || this.options.isPeerRevoked(peerId)) return cancelled();
    if (!this.options.isUnlocked()) return { ...envelope(), ack: { status: "error", code: "storage_unavailable", message: "Storage browse requires unlocked vault" } };
    if (request.kind === "storage.browse.open") {
      const authorizationId = this.issue(peerId);
      if (authorizationId === undefined) return { ...envelope(), ack: { status: "error", code: "storage_forbidden", message: "Storage browse caller has no committed page session" } };
      const runtime = await this.ensureRuntime();
      const session = await runtime.openSession(peerId, { authorizationId });
      if (signal?.aborted || this.options.isPeerRevoked(peerId)) {
        await runtime.closeSession(peerId, session.browseSessionId);
        this.authorizations.delete(authorizationId);
        return cancelled();
      }
      return { ...envelope(), ack: { status: "ok" }, operationResult: session };
    }
    const runtime = await this.ensureRuntime();
    if (request.kind === "storage.browse.close") {
      await runtime.closeSession(peerId, request.browseSessionId);
      return { ...envelope(), ack: { status: "ok" } };
    }
    const options = signal ? { signal } : undefined;
    const value = request.data.type === "browse.list"
      ? await runtime.list(peerId, request.data, options)
      : await runtime.preview(peerId, request.data, options);
    if (signal?.aborted || this.options.isPeerRevoked(peerId)) return cancelled();
    return { ...envelope(), ack: { status: "ok" }, operationResult: value };
  }
}
