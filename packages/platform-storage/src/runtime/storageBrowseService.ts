import type { StorageBrowseWallet } from "./storageBrowsePrivate.js";
// Worker 侧只读存储浏览服务。
//
// 这是浏览能力的唯一实现：它在 Coordinator 信任的进程里读 WalletStore，只做
// 元数据列举和受限预览，没有任何写路径。它与 StorageRuntimeController 分离，
// 因为浏览不经过 Connect grant，也不接受 App 命名空间——它看的是整个钱包。
//
// 三条不变式：
//   1. 列举只读元数据，永不读字节；预览才读字节，且由 Worker 强制 1 MiB 上限。
//   2. 每个会话绑定钱包世代、会话世代、Worker 运行世代和发起端口；任一变化立即失效。
//   3. 游标绑定目录和会话，跨目录、跨会话或过期重放一律失败。

import type { StorageErrorCode } from "@keymaster/contracts";
import type { StorageBrowseEntry, StorageBrowsePage, StorageBrowsePreview, StorageBrowseSession } from "./storageBrowseTypes.js";
import { STORAGE_BROWSE_CURSOR_TTL_MS, STORAGE_BROWSE_DEFAULT_LIMIT, STORAGE_BROWSE_MAX_CURSORS_PER_SESSION, STORAGE_BROWSE_MAX_LIMIT, STORAGE_BROWSE_PREVIEW_CONCURRENCY, STORAGE_BROWSE_PREVIEW_MAX_BYTES } from "./storageBrowseTypes.js";
import type { WalletObjectMeta } from "../local/indexedDbWalletStore.js";
import {
  BrowsePathError,
  directoryScanPrefix,
  normalizeBrowseDirectory,
  normalizeBrowseObjectPath,
} from "./storageBrowsePaths.js";
import { detectBrowsePreview } from "./storageBrowsePreview.js";
import { StorageRuntimeError } from "./storageError.js";

export interface StorageBrowseServiceOptions {
  /** 读取钱包；由 Worker 注入真实 WalletStore。 */
  wallet: StorageBrowseWallet;
  /** 当前钱包身份世代；重置后必须变化。 */
  walletGeneration(): string;
  /** 当前会话世代；锁定或改密后必须变化。 */
  sessionEpoch(): string;
  /** Worker 运行世代；Worker 重启后必须变化。 */
  runGeneration(): string;
  /**
   * 解析某个端口当前的浏览授权；返回 undefined 表示该端口不是受信任的浏览运行单元。
   *
   * 授权只能由 Coordinator 在它自己已验证的 peer 上下文里产生，并按端口绑定。
   * 这里刻意不接受「调用方说自己是谁」：浏览服务不读请求里的任何身份字段，只认这份
   * 由 Worker 注入的查表结果。端口撤销、世代推进或钱包锁定后查表返回 undefined，
   * 已发放的会话因此在下一次调用时立即失效。
   */
  trustedAuthorization(clientId: string, authorizationId: unknown): StorageBrowseAuthorization | undefined;
  /** 当前是否已解锁；锁定后不能发放或继续使用会话。 */
  isUnlocked(): boolean;
  /** 可注入时钟；游标 TTL。 */
  now?: () => number;
  /** 生成不透明 id；测试可注入确定性实现。 */
  generateId?: () => string;
  /** 只读 I/O 租约；与既有 Coordinator 读取路径共用同一把闸。 */
  withReadLease?: <T>(task: () => Promise<T>) => Promise<T>;
}

/** Coordinator 为某个端口签发的浏览授权；由 Worker 侧生成，页面与调用方都碰不到。 */
export interface StorageBrowseAuthorization {
  /** 受信任的平台浏览运行单元 id；由 Coordinator 常量给出。 */
  unitId: string;
  /** 授权绑定的端口/peer 身份。 */
  clientId: string;
  /** 授权绑定的钱包身份世代。 */
  walletGeneration: string;
  /** 授权绑定的会话世代。 */
  sessionEpoch: string;
  /** 授权绑定的 Worker 运行世代。 */
  runGeneration: string;
}

/**
 * Worker 内部的浏览面。
 *
 * clientId 一律由 Coordinator 从端口上下文补齐，不接受调用方自报：它是会话的
 * 归属端口，也是断连时精确作废会话的依据。打开会话需要的授权 id 同样由 Coordinator
 * 注入，请求体里不存在身份字段。
 */
export interface StorageBrowseRuntime {
  openSession(clientId: string, input: { authorizationId: string }): Promise<StorageBrowseSession>;
  list(clientId: string, input: { browseSessionId: string; prefix: string; cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<StorageBrowsePage>;
  preview(clientId: string, input: { browseSessionId: string; path: string; ifRevision?: string }, options?: { signal?: AbortSignal }): Promise<StorageBrowsePreview>;
  closeSession(clientId: string, browseSessionId: string): Promise<void>;
  /** 作废某端口的全部会话；端口断开时调用。 */
  revokeClient(clientId: string): void;
  /** 作废全部会话；锁定、改密、重置和 Worker 重启时调用。 */
  revokeAll(): void;
}

interface BrowseSessionRecord {
  browseSessionId: string;
  clientId: string;
  /** 发放时使用的授权 id；每次调用都要重新向 Coordinator 查一次这张授权。 */
  authorizationId: string;
  /** 发放时核验过的授权内容；用于发现「同一张授权被换发」。 */
  authorization: StorageBrowseAuthorization;
  walletGeneration: string;
  sessionEpoch: string;
  runGeneration: string;
  cursors: Map<string, BrowseCursorRecord>;
  /** 在途预览的取消器；会话关闭时全部中止。 */
  inFlight: Set<AbortController>;
}

interface BrowseCursorRecord {
  prefix: string;
  after: string | undefined;
  limit: number;
  expiresAt: number;
}

/**
 * 有界并发闸：快速切换时不堆积大对象读取。
 *
 * `admit` 是排队后的入场复核：等待期间会话可能已被撤销、授权可能已重签，因此真正
 * 开始读取之前要再核对一次，否则「已经放弃的请求」会在闸门打开后照常读完整对象。
 */
class ReadGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, admit?: () => void): Promise<T> {
    if (this.active >= this.limit) {
      // 唤醒时名额直接交接，不能先释放再争抢，否则新请求会与排队项超额并行。
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      // 入场复核失败也必须交还名额并唤醒下一请求，否则取消的排队项会堵住队列。
      admit?.();
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

function defaultGenerateId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  // 非安全上下文没有 randomUUID。浏览会话 id 只需在同一 Worker 运行内不可预测：
  // 跨进程重放会被 runGeneration 直接挡住。
  const bytes = new Uint8Array(16);
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") cryptoRef.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fail(code: StorageErrorCode, message: string): never {
  throw new StorageRuntimeError(code, message);
}

/** WalletStore 的 revision 是单调数字；wire 上用字符串，避免页面把它当算术量。 */
function browseEntry(meta: WalletObjectMeta): StorageBrowseEntry {
  return {
    path: meta.path,
    size: meta.size,
    lastModified: meta.lastModified,
    revision: String(meta.revision),
    ...(meta.contentType === undefined ? {} : { contentType: meta.contentType }),
  };
}

export function createStorageBrowseService(options: StorageBrowseServiceOptions): StorageBrowseRuntime {
  const clock = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? defaultGenerateId;
  const sessions = new Map<string, BrowseSessionRecord>();
  const previewGate = new ReadGate(STORAGE_BROWSE_PREVIEW_CONCURRENCY);

  const withLease = <T,>(task: () => Promise<T>): Promise<T> => (options.withReadLease ? options.withReadLease(task) : task());

  function dropSession(record: BrowseSessionRecord): void {
    sessions.delete(record.browseSessionId);
    for (const controller of record.inFlight) controller.abort();
    record.inFlight.clear();
    record.cursors.clear();
  }

  function assertClientId(clientId: string): string {
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 256) {
      fail("storage_forbidden", "Browse caller context is invalid");
    }
    return clientId;
  }

  /**
   * 解析并核对当前授权。
   *
   * 授权由 Coordinator 在它自己的 peer 上下文里签发；这里的任务是把它与「本次调用
   * 的端口」和「当前三种世代」一起核对。任何一项不成立都返回 undefined，调用方
   * 因此拿不到「原因」之外的任何信息，也不能靠换一个端口复用别人的授权。
   */
  function resolveAuthorization(clientId: string, authorizationId: unknown): StorageBrowseAuthorization | undefined {
    if (typeof authorizationId !== "string" || authorizationId.length === 0 || authorizationId.length > 256) return undefined;
    const authorization = options.trustedAuthorization(assertClientId(clientId), authorizationId);
    if (!authorization || authorization.clientId !== clientId || authorization.unitId.length === 0) return undefined;
    if (authorization.walletGeneration !== options.walletGeneration()
      || authorization.sessionEpoch !== options.sessionEpoch()
      || authorization.runGeneration !== options.runGeneration()) return undefined;
    return authorization;
  }

  /** 授权是否仍然指向同一份记录；端口撤销或授权重签后旧会话必须立即作废。 */
  function sameAuthorization(left: StorageBrowseAuthorization, right: StorageBrowseAuthorization): boolean {
    return left.unitId === right.unitId
      && left.clientId === right.clientId
      && left.walletGeneration === right.walletGeneration
      && left.sessionEpoch === right.sessionEpoch
      && left.runGeneration === right.runGeneration;
  }

  /**
   * 取出仍然有效的会话。
   *
   * 不存在、属于别的端口、授权已被撤销或世代不符一律返回同一个错误：区分它们
   * 等于告诉调用方某个句柄曾经存在过。
   */
  function requireSession(clientId: string, browseSessionId: unknown): BrowseSessionRecord {
    if (typeof browseSessionId !== "string" || browseSessionId.length === 0 || browseSessionId.length > 256) {
      fail("storage_invalid_path", "Browse session id is invalid");
    }
    const record = sessions.get(browseSessionId);
    if (!record || record.clientId !== assertClientId(clientId)) {
      fail("storage_unavailable", "Browse session is not available");
    }
    const authorization = resolveAuthorization(record.clientId, record.authorizationId);
    if (!options.isUnlocked()
      || !authorization
      || !sameAuthorization(authorization, record.authorization)
      || record.walletGeneration !== options.walletGeneration()
      || record.sessionEpoch !== options.sessionEpoch()
      || record.runGeneration !== options.runGeneration()) {
      dropSession(record);
      fail("storage_unavailable", "Browse session is not available");
    }
    return record;
  }

  /**
   * 读取之后的第二道栅栏。
   *
   * `requireSession` 只能在 await 之前检查，而授权撤销、端口断开、会话关闭、锁定与
   * 世代推进全都发生在读取期间：底层 WalletStore 可能忽略 AbortSignal，在被撤销
   * 之后才成功返回。因此 await 之后必须重新核对会话与授权，撤销之后才到达的字节
   * 一个都不返回。
   */
  function assertSessionLive(record: BrowseSessionRecord, signal?: AbortSignal): void {
    if (signal?.aborted) fail("storage_unavailable", "Browse request was cancelled");
    if (sessions.get(record.browseSessionId) !== record) fail("storage_unavailable", "Browse session is not available");
    requireSession(record.clientId, record.browseSessionId);
  }

  /**
   * 把「读取期间的撤销/取消」翻译成调用方能行动的结论。
   *
   * 底层读取在这两种情况下多半会抛出自己的原始错误（IndexedDB 的 AbortError 等）。
   * 那类错误对页面没有意义：它需要知道的是「句柄没了，重新开会话」，否则会把这个
   * 文件显示成一次内容读取失败。真正的业务错误（例如对象不存在、版本冲突）原样透出。
   */
  function normalizeRevoked(error: unknown, record: BrowseSessionRecord, signal?: AbortSignal): never {
    if (signal?.aborted) fail("storage_unavailable", "Browse request was cancelled");
    if (sessions.get(record.browseSessionId) !== record || !options.isUnlocked()) {
      fail("storage_unavailable", "Browse session is not available");
    }
    throw error;
  }

  function resolveLimit(limit: unknown): number {
    if (limit === undefined) return STORAGE_BROWSE_DEFAULT_LIMIT;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > STORAGE_BROWSE_MAX_LIMIT) {
      fail("storage_limit_exceeded", "Browse page size is invalid");
    }
    return limit;
  }

  function resolveDirectory(prefix: unknown): string {
    if (prefix === undefined) return "";
    if (typeof prefix !== "string") return fail("storage_invalid_path", "Browse directory is invalid");
    try {
      return normalizeBrowseDirectory(prefix);
    } catch (error) {
      if (error instanceof BrowsePathError) return fail("storage_invalid_path", "Browse directory is invalid");
      throw error;
    }
  }

  function resolveObjectPath(path: unknown): string {
    if (typeof path !== "string") return fail("storage_invalid_path", "Browse object path is invalid");
    try {
      return normalizeBrowseObjectPath(path);
    } catch (error) {
      if (error instanceof BrowsePathError) return fail("storage_invalid_path", "Browse object path is invalid");
      throw error;
    }
  }

  function pruneExpiredCursors(record: BrowseSessionRecord): void {
    const at = clock();
    for (const [id, cursor] of [...record.cursors]) {
      if (cursor.expiresAt <= at) record.cursors.delete(id);
    }
  }

  return {
    revokeClient(clientId: string): void {
      for (const record of [...sessions.values()]) {
        if (record.clientId === clientId) dropSession(record);
      }
    },

    revokeAll(): void {
      for (const record of [...sessions.values()]) dropSession(record);
    },

    async openSession(clientId: string, input: { authorizationId: string }): Promise<StorageBrowseSession> {
      const caller = assertClientId(clientId);
      if (!options.isUnlocked()) fail("storage_unavailable", "Wallet is locked");
      // 授权只来自 Coordinator 已验证的端口上下文：这里按 id 查它自己签发的那一份，
      // 请求体里不存在任何「调用方自报身份」的字段可比对。
      const authorization = resolveAuthorization(caller, input?.authorizationId);
      if (!authorization) fail("storage_forbidden", "Caller is not a trusted storage browse unit");
      const record: BrowseSessionRecord = {
        browseSessionId: generateId(),
        clientId: caller,
        authorizationId: input.authorizationId,
        authorization,
        walletGeneration: options.walletGeneration(),
        sessionEpoch: options.sessionEpoch(),
        runGeneration: options.runGeneration(),
        cursors: new Map(),
        inFlight: new Set(),
      };
      sessions.set(record.browseSessionId, record);
      return {
        browseSessionId: record.browseSessionId,
        walletGeneration: record.walletGeneration,
        sessionEpoch: record.sessionEpoch,
        runGeneration: record.runGeneration,
      };
    },

    async list(clientId: string, input: { browseSessionId: string; prefix: string; cursor?: string; limit?: number }, options2?: { signal?: AbortSignal }): Promise<StorageBrowsePage> {
      const record = requireSession(clientId, input.browseSessionId);
      const directory = resolveDirectory(input.prefix);
      const limit = resolveLimit(input.limit);
      pruneExpiredCursors(record);

      let after: string | undefined;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > 256) {
          fail("storage_conflict", "Browse cursor is invalid");
        }
        const cursor = record.cursors.get(input.cursor);
        // 游标绑定目录：换一个目录继续加载就是越界，必须失败而不是从别处接着读。
        if (!cursor || cursor.prefix !== directory) fail("storage_conflict", "Browse cursor does not match this directory");
        after = cursor.after;
      }

      const prefix = directoryScanPrefix(directory);
      let page: Awaited<ReturnType<StorageBrowseWallet["list"]>>;
      try {
        page = await withLease(() => options.wallet.list({
          ...(prefix === undefined ? {} : { prefix }),
          ...(after === undefined ? {} : { cursor: after }),
          limit,
          ...(options2?.signal === undefined ? {} : { signal: options2.signal }),
        }));
        // 元数据同样不能穿过撤销：读取期间锁定的会话不得把这一页交出去。
        assertSessionLive(record, options2?.signal);
      } catch (error) {
        normalizeRevoked(error, record, options2?.signal);
      }
      let nextCursor: string | undefined;
      if (page.nextCursor !== undefined) {
        if (record.cursors.size >= STORAGE_BROWSE_MAX_CURSORS_PER_SESSION) {
          // 游标是运行态句柄：超量时淘汰最旧的，而不是让已经开始的浏览失败。
          const oldest = [...record.cursors.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
          if (oldest) record.cursors.delete(oldest[0]);
        }
        nextCursor = generateId();
        record.cursors.set(nextCursor, {
          prefix: directory,
          after: page.nextCursor,
          limit,
          expiresAt: clock() + STORAGE_BROWSE_CURSOR_TTL_MS,
        });
      }

      // 只回元数据。目录由页面从路径前缀折叠得出，Worker 不生成虚构节点。
      const entries = page.objects.map(browseEntry);
      return { entries, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },

    async preview(clientId: string, input: { browseSessionId: string; path: string; ifRevision?: string }, options2?: { signal?: AbortSignal }): Promise<StorageBrowsePreview> {
      const record = requireSession(clientId, input.browseSessionId);
      const path = resolveObjectPath(input.path);
      if (input.ifRevision !== undefined && (typeof input.ifRevision !== "string" || !/^[0-9]+$/u.test(input.ifRevision))) {
        fail("storage_invalid_path", "Browse expected revision is invalid");
      }

      const controller = new AbortController();
      record.inFlight.add(controller);
      const external = options2?.signal;
      const onExternalAbort = (): void => controller.abort();
      // 已经取消的信号不会再触发 abort 事件；漏掉这一支就会让快速切换后
      // 那个被放弃的文件仍然被完整读一遍。
      if (external?.aborted) controller.abort();
      else external?.addEventListener("abort", onExternalAbort, { once: true });

      try {
        return await previewGate.run(() => withLease(async () => {
          // 排队期间可能已经撤销；入场复核拦下这种「本来就不该开始」的读取。
          assertSessionLive(record, controller.signal);
          const object = await options.wallet.get(path, { signal: controller.signal });
          // 读取之后必须再核一次：授权撤销、端口断开与世代推进都发生在这个 await
          // 期间，而底层读取可能忽略 AbortSignal 才成功返回。
          assertSessionLive(record, controller.signal);
          if (!object) fail("storage_not_found", "Object no longer exists");
          const revision = String(object.revision);
          // 版本不符时一个字节都不返回：静默展示另一个版本比报错更糟。
          if (input.ifRevision !== undefined && input.ifRevision !== revision) {
            fail("storage_conflict", "Object changed since it was listed");
          }
          const totalSize = object.size;
          // WalletStore.getRange 先读完整对象再切片，因此上限必须由这里裁剪后返回，
          // 页面拿不到、也绕不过 1 MiB。
          const returned = object.bytes.byteLength > STORAGE_BROWSE_PREVIEW_MAX_BYTES
            ? object.bytes.slice(0, STORAGE_BROWSE_PREVIEW_MAX_BYTES)
            : object.bytes;
          const truncated = returned.byteLength < totalSize;
          const detection = detectBrowsePreview({
            path,
            ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
            bytes: returned,
            truncated,
          });
          return {
            path,
            format: detection.format,
            bytes: returned,
            totalSize,
            returnedSize: returned.byteLength,
            truncated,
            revision,
            lastModified: object.lastModified,
            ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
            ...(detection.kvPayload === undefined ? {} : { kvPayload: detection.kvPayload }),
            ...(detection.kvError === undefined ? {} : { kvError: detection.kvError }),
          } satisfies StorageBrowsePreview;
        }), () => assertSessionLive(record, controller.signal));
      } catch (error) {
        normalizeRevoked(error, record, controller.signal);
      } finally {
        record.inFlight.delete(controller);
        external?.removeEventListener("abort", onExternalAbort);
      }
    },

    async closeSession(clientId: string, browseSessionId: string): Promise<void> {
      const record = sessions.get(browseSessionId);
      // 关闭只释放自己的会话；别人的句柄对调用方不存在，猜中也是空操作。
      if (record && record.clientId === clientId) dropSession(record);
    },
  };
}
