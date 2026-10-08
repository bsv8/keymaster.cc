// MSFile 跨插件内容能力实现。
//
// 这一层只做三件事：把「本地优先 + 完整性验证 + 统一落盘」包装成别的插件可以
// 使用的窄接口；把同 hash 的并发请求合并成一个任务；把删除/损坏变成可订阅的
// 失效事件。
//
// 明确不做的事：
//   - 不返回 OwnerFileStore、私有路径或供应商私钥；
//   - 不让调用方凭 metadata 或任务成功标志绕过内容验证；
//   - 不在远程渠道缺失时伪造「已获取」。
//
// 来源选择、价格策略、网络并发、失败重试与落盘全部由 MSFile 自己拥有；远程
// 获取复用既有 supplier/BitFS 通道，不在本文件里建立第二套传输。

import type {
  MsFileContentEnsureInput,
  MsFileContentFailureCode,
  MsFileContentImportInput,
  MsFileContentService,
  MsFileContentState,
  MsFileContentStatus,
  MsFilePublicationReachability,
  MsFileService,
  MsFileVerifiedContent,
} from "@keymaster/contracts";
import { MSFILE_MAX_CONTENT_BYTES, isValidMsFileContentSeedHash } from "@keymaster/contracts";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";

import { readMsFileSeed, storeMsFileSeed, type MsFileSeedSource } from "./storage/msfileSeedStore.js";

/** 远程获取通道；由 MSFile 装配阶段注入，缺失时如实报告「无可用渠道」。 */
export interface MsFileRemoteContentFetcher {
  /** 当前可用的来源路由标识。 */
  listSourceIds(): readonly string[];
  /** 把缺失内容取回本地并完成落盘；返回 true 表示已落盘。 */
  fetch(input: { seedHashHex: string; allowPurchase: boolean; signal?: AbortSignal }): Promise<boolean>;
}

export interface MsFileContentServiceDeps {
  store: BorrowedOwnerFileStore;
  /** 已有 MSFile 服务，用于复用全局价格与并发策略的当前快照。 */
  service?: Pick<MsFileService, "getBitfsBuyerSettings" | "getSettingsSnapshot">;
  remote?: MsFileRemoteContentFetcher;
  /** 上限；缺省用 MSFILE_MAX_CONTENT_BYTES。防止资源耗尽。 */
  maxContentBytes?: number;
  now?(): number;
}

interface ContentEntry {
  readonly seedHashHex: string;
  state: MsFileContentState;
  failureCode?: MsFileContentFailureCode;
  verifiedBytes?: string;
  fileName?: string;
  mediaType?: string;
  /** 同 hash 的共享飞行中任务；引用计数保证取消一个消费者不影响其他消费者。 */
  flight?: { promise: Promise<MsFileContentStatus>; controller: AbortController; consumers: number };
}

export function createMsFileContentService(deps: MsFileContentServiceDeps): MsFileContentService {
  const entries = new Map<string, ContentEntry>();
  const listeners = new Map<string, Set<(status: MsFileContentStatus) => void>>();
  const maxContentBytes = deps.maxContentBytes ?? MSFILE_MAX_CONTENT_BYTES;

  const publish = (entry: ContentEntry): void => {
    const snapshot = toStatus(entry);
    for (const listener of listeners.get(entry.seedHashHex) ?? []) {
      try {
        listener(snapshot);
      } catch {
        // 订阅者的异常不能影响内容状态本身。
      }
    }
  };

  const entryFor = (seedHashHex: string): ContentEntry => {
    let entry = entries.get(seedHashHex);
    if (entry === undefined) {
      entry = { seedHashHex, state: "absent" };
      entries.set(seedHashHex, entry);
    }
    return entry;
  };

  /** 本地完整命中：只读本地，永不走远程。 */
  const readLocalVerified = async (
    seedHashHex: string,
    signal: AbortSignal | undefined,
  ): Promise<MsFileVerifiedContent | undefined> => {
    let assembled: Awaited<ReturnType<typeof readMsFileSeed>>;
    try {
      assembled = await readMsFileSeed({ store: deps.store, seedHashHex, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      // 损坏或不完整都落到验证失败，而不是当作不存在。
      return undefined;
    }
    const byteLength = assembled.parts.reduce((total, part) => total + part.byteLength, 0);
    if (byteLength > maxContentBytes) {
      throw new MsFileContentTooLargeError(byteLength, maxContentBytes);
    }
    // 组装后的总长度必须与 meta 声明的原始大小一致，否则不是完整内容。
    if (byteLength !== Number(assembled.meta.fileSizeBytes)) {
      throw new MsFileContentIntegrityError(`组装长度 ${byteLength} 与 fileSizeBytes ${assembled.meta.fileSizeBytes} 不一致`);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of assembled.parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return {
      seedHashHex,
      bytes,
      byteLength: byteLength.toString(),
      mediaType: assembled.meta.mediaType,
      fileName: assembled.meta.fileName,
    };
  };

  const markVerified = (entry: ContentEntry, content: MsFileVerifiedContent): void => {
    entry.state = "verified";
    entry.failureCode = undefined;
    entry.verifiedBytes = content.byteLength;
    entry.fileName = content.fileName;
    entry.mediaType = content.mediaType;
    publish(entry);
  };

  const ensureLocalFirst = async (seedHashHex: string, signal?: AbortSignal): Promise<MsFileContentStatus> => {
    const entry = entryFor(seedHashHex);
    try {
      const local = await readLocalVerified(seedHashHex, signal);
      if (local !== undefined) {
        markVerified(entry, local);
        return toStatus(entry);
      }
    } catch (error) {
      if (isCancellation(error, signal)) throw error;
      const code = error instanceof MsFileContentTooLargeError ? "too-large" : "integrity-error";
      entry.state = "verification-failed";
      entry.failureCode = code;
      entry.verifiedBytes = undefined;
      publish(entry);
      return toStatus(entry);
    }
    entry.state = "absent";
    entry.verifiedBytes = undefined;
    entry.failureCode = undefined;
    return toStatus(entry);
  };

  /** 同 hash 的共享飞行中任务。 */
  const sharedFlight = (seedHashHex: string, allowPurchase: boolean): { promise: Promise<MsFileContentStatus>; controller: AbortController } => {
    const entry = entryFor(seedHashHex);
    const existing = entry.flight;
    if (existing !== undefined) {
      existing.consumers += 1;
      return { promise: existing.promise, controller: existing.controller };
    }
    const controller = new AbortController();
    const record = { promise: Promise.resolve() as unknown as Promise<MsFileContentStatus>, controller, consumers: 1 };
    record.promise = (async (): Promise<MsFileContentStatus> => {
      entry.state = "fetching";
      entry.failureCode = undefined;
      publish(entry);
      try {
        const localFirst = await ensureLocalFirst(seedHashHex, controller.signal);
        if (localFirst.state === "verified") return localFirst;
        const remote = deps.remote;
        if (remote === undefined || remote.listSourceIds().length === 0) {
          // 渠道缺失必须如实报告，不能把「本地没有」说成「已获取」。
          entry.state = "unreachable";
          entry.failureCode = "no-available-channel";
          publish(entry);
          return toStatus(entry);
        }
        const fetched = await remote.fetch({ seedHashHex, allowPurchase, signal: controller.signal });
        if (!fetched) {
          entry.state = "unreachable";
          entry.failureCode = "source-unreachable";
          publish(entry);
          return toStatus(entry);
        }
        const content = await readLocalVerified(seedHashHex, controller.signal);
        if (content === undefined) {
          entry.state = "verification-failed";
          entry.failureCode = "integrity-error";
          publish(entry);
          return toStatus(entry);
        }
        markVerified(entry, content);
        return toStatus(entry);
      } catch (error) {
        if (isCancellation(error, controller.signal)) {
          entry.state = "absent";
          entry.failureCode = "cancelled";
          publish(entry);
          return toStatus(entry);
        }
        entry.state = "verification-failed";
        entry.failureCode = mapFailure(error);
        publish(entry);
        return toStatus(entry);
      } finally {
        entry.flight = undefined;
      }
    })();
    entry.flight = record;
    return { promise: record.promise, controller };
  };

  /** 让一个消费者在自己的中止信号上立刻离开，而不动共享任务。 */
  const raceConsumer = async (
    promise: Promise<MsFileContentStatus>,
    signal: AbortSignal | undefined,
    cancelled: () => MsFileContentStatus,
  ): Promise<MsFileContentStatus> => {
    if (signal === undefined) return promise;
    if (signal.aborted) return cancelled();
    return Promise.race([
      promise,
      new Promise<MsFileContentStatus>((resolve) => {
        signal.addEventListener("abort", () => resolve(cancelled()), { once: true });
      }),
    ]);
  };

  return {
    async ensureContent(input: MsFileContentEnsureInput): Promise<MsFileContentStatus> {
      if (!isValidMsFileContentSeedHash(input.seedHashHex)) {
        return { seedHashHex: String(input.seedHashHex), state: "verification-failed", failureCode: "integrity-error", localCopy: false };
      }
      if (input.allowPurchase !== true) {
        // 列表浏览不得自动购买正文：没有明确授权就只查本地。
        return ensureLocalFirst(input.seedHashHex, input.signal);
      }
      // 授权路径直接进入共享任务：飞行中任务内部先做本地优先检查。
      // 先查本地再登记任务会让并发调用各自通过本地检查，从而产生两个任务。
      const { promise, controller } = sharedFlight(input.seedHashHex, true);
      try {
        // 取消只让**本消费者**立刻返回，不能去中止共享控制器：那会连带杀死
        // 其他消费者仍然需要的任务。共享任务在最后一个消费者离开时才中止。
        return await raceConsumer(promise, input.signal, () =>
          toStatus({ ...entryFor(input.seedHashHex), state: "absent", failureCode: "cancelled", verifiedBytes: undefined }),
        );
      } finally {
        releaseConsumer(input.seedHashHex);
      }
      // 局部常量仅用于让上面的中止路径可以读到共享记录。
      void controller;
    },

    async openVerifiedContent(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<MsFileVerifiedContent | undefined> {
      if (!isValidMsFileContentSeedHash(seedHashHex)) return undefined;
      const entry = entryFor(seedHashHex);
      // 每次读取都重新验证：内容可能已被用户删除或损坏，
      // 进程内的「已验证」标记不能替代本次读盘核对。
      const local = await readLocalVerified(seedHashHex, options?.signal);
      if (local === undefined) {
        // 内容被删除或已损坏：投影必须失效，不能继续呈现过时可用标记。
        if (entry.state !== "fetching") {
          entry.state = entry.state === "absent" ? "absent" : "verification-failed";
          if (entry.state === "verification-failed") entry.failureCode = "integrity-error";
          entry.verifiedBytes = undefined;
          publish(entry);
        }
        return undefined;
      }
      markVerified(entry, local);
      return local;
    },

    async importContent(input: MsFileContentImportInput): Promise<{ seedHashHex: string; byteLength: string }> {
      if (input.bytes.byteLength === 0) throw new TypeError("内容不能为空");
      if (input.bytes.byteLength > maxContentBytes) {
        throw new MsFileContentTooLargeError(input.bytes.byteLength, maxContentBytes);
      }
      const source = bytesSeedSource(input);
      const result = await storeMsFileSeed({ store: deps.store, source });
      const entry = entryFor(result.meta.seedHashHex);
      const verifiedBytes = result.meta.fileSizeBytes;
      entry.state = "verified";
      entry.verifiedBytes = verifiedBytes;
      entry.fileName = result.meta.fileName;
      entry.mediaType = result.meta.mediaType;
      entry.failureCode = undefined;
      publish(entry);
      return { seedHashHex: result.meta.seedHashHex, byteLength: verifiedBytes };
    },

    async getContentStatus(seedHashHex: string): Promise<MsFileContentStatus> {
      if (!isValidMsFileContentSeedHash(seedHashHex)) {
        return { seedHashHex: String(seedHashHex), state: "verification-failed", failureCode: "integrity-error", localCopy: false };
      }
      return ensureLocalFirst(seedHashHex);
    },

    subscribeContent(seedHashHex: string, listener: (status: MsFileContentStatus) => void): () => void {
      if (!isValidMsFileContentSeedHash(seedHashHex)) return () => undefined;
      let group = listeners.get(seedHashHex);
      if (group === undefined) {
        group = new Set();
        listeners.set(seedHashHex, group);
      }
      group.add(listener);
      return () => {
        group?.delete(listener);
        if (group?.size === 0) listeners.delete(seedHashHex);
      };
    },

    async publicationReachability(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<MsFilePublicationReachability> {
      const local = await ensureLocalFirst(seedHashHex, options?.signal);
      const sourceIds = deps.remote?.listSourceIds() ?? [];
      if (local.state === "verified" && sourceIds.length > 0) {
        return { seedHashHex, published: true, sourceIds, detail: "本地已保存且存在可用供应渠道" };
      }
      if (local.state === "verified") {
        // 本地已存不等于读者可取得。
        return {
          seedHashHex,
          published: false,
          sourceIds: [],
          detail: "内容只保存在本地，没有读者可用的供应渠道；发布渠道尚未实现",
        };
      }
      return { seedHashHex, published: false, sourceIds, detail: "内容尚未完整保存" };
    },
  };

  /** 取消一个消费者只减少引用计数；最后一个消费者离开时才中止任务。 */
  function releaseConsumer(seedHashHex: string): void {
    const entry = entries.get(seedHashHex);
    const flight = entry?.flight;
    if (entry === undefined || flight === undefined) return;
    flight.consumers -= 1;
    if (flight.consumers <= 0) {
      flight.controller.abort();
      entry.flight = undefined;
    }
  }
}

function toStatus(entry: ContentEntry): MsFileContentStatus {
  return {
    seedHashHex: entry.seedHashHex,
    state: entry.state,
    localCopy: entry.state === "verified",
    ...(entry.verifiedBytes === undefined ? {} : { verifiedBytes: entry.verifiedBytes }),
    ...(entry.failureCode === undefined ? {} : { failureCode: entry.failureCode }),
    ...(entry.fileName === undefined ? {} : { fileName: entry.fileName }),
    ...(entry.mediaType === undefined ? {} : { mediaType: entry.mediaType }),
  };
}

/** 内存字节实现的上传源；块路径与校验仍由 storeMsFileSeed 决定。 */
function bytesSeedSource(input: MsFileContentImportInput): MsFileSeedSource {
  const bytes = input.bytes;
  return {
    name: input.fileName,
    mediaType: input.mediaType,
    size: BigInt(bytes.byteLength),
    async *stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
      if (options?.signal?.aborted === true) throw options.signal.reason;
      yield bytes;
    },
    async read(offset: bigint, length: number, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
      if (options?.signal?.aborted === true) throw options.signal.reason;
      const start = Number(offset);
      return bytes.subarray(start, start + length);
    },
  };
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

function mapFailure(error: unknown): MsFileContentFailureCode {
  if (error instanceof MsFileContentTooLargeError) return "too-large";
  if (error instanceof MsFileContentIntegrityError) return "integrity-error";
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code === "price_limit_exceeded" || code === "msfile_price_limit_exceeded") return "price-limit-exceeded";
    if (code === "msfile_content_not_found" || code === "missing-block" || code === "missing-seed") return "content-not-found";
    if (code === "msfile_integrity_error" || code === "integrity") return "integrity-error";
    if (code === "msfile_unavailable" || code === "msfile_not_configured") return "no-available-channel";
    if (code === "cancelled") return "cancelled";
  }
  return "storage-error";
}

export class MsFileContentTooLargeError extends Error {
  readonly code = "too-large";
  readonly byteLength: number;
  readonly limitBytes: number;

  constructor(byteLength: number, limitBytes: number) {
    super(`内容 ${byteLength} 字节超过上限 ${limitBytes} 字节`);
    this.name = "MsFileContentTooLargeError";
    this.byteLength = byteLength;
    this.limitBytes = limitBytes;
  }
}

export class MsFileContentIntegrityError extends Error {
  readonly code = "integrity-error";

  constructor(message: string) {
    super(message);
    this.name = "MsFileContentIntegrityError";
  }
}