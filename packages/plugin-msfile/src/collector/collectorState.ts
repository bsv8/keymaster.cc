// 采集持久化状态：确认态、待提交队列、发送中批次、介绍与配置。
// 单文档 `collector/state.json` 经 owner 文件句柄读写，写操作串行化。
// 与 seed meta、Catalog 映射分开存放，不混入可重建的派生数据。

import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import type { CollectorConfirmedEntry, CollectorInflight } from "./collectorQueue.js";
import type { CollectorRecord } from "./collectorCodec.js";

/** 持久化文档版本号。 */
const COLLECTOR_STATE_VERSION = 1;

/** 持久化路径（msfiles 根下，不在 meta/ 前缀内，不影响列表）。 */
const COLLECTOR_STATE_PATH = "collector/state.json";

/** 采集配置。 */
export interface CollectorPersistedConfig {
  /** 采集服务地址，空表示未配置。 */
  endpoint: string;
  /** 启用开关。 */
  enabled: boolean;
}

/** 采集持久化文档。 */
export interface CollectorDoc {
  version: number;
  config: CollectorPersistedConfig;
  /** 各 Hash 的介绍（旧记录缺省空字符串）。 */
  descriptions: Record<string, string>;
  /** 已确认状态。 */
  confirmed: Record<string, CollectorConfirmedEntry>;
  /** 待提交队列。 */
  pending: Record<string, CollectorRecord>;
  /** 发送中批次，重启后恢复。 */
  inflight: CollectorInflight | null;
  meta: {
    /** 最近尝试提交的毫秒时间戳（ hourly 触发基准）。 */
    lastAttemptAt: number;
    /** 最近成功的毫秒时间戳。 */
    lastSuccessAt: number | null;
    /** 最近失败原因。 */
    lastError: string | null;
  };
}

/** 空文档。 */
export function emptyCollectorDoc(): CollectorDoc {
  return {
    version: COLLECTOR_STATE_VERSION,
    config: { endpoint: "", enabled: false },
    descriptions: {},
    confirmed: {},
    pending: {},
    inflight: null,
    meta: { lastAttemptAt: 0, lastSuccessAt: null, lastError: null },
  };
}

function sanitizeDoc(value: unknown): CollectorDoc {
  const doc = emptyCollectorDoc();
  if (typeof value !== "object" || value === null) return doc;
  const record = value as Record<string, unknown>;
  if (record.version !== COLLECTOR_STATE_VERSION) return doc;
  if (typeof record.config === "object" && record.config !== null) {
    const config = record.config as Record<string, unknown>;
    if (typeof config.endpoint === "string") doc.config.endpoint = config.endpoint;
    if (typeof config.enabled === "boolean") doc.config.enabled = config.enabled;
  }
  for (const key of ["descriptions", "confirmed", "pending"] as const) {
    if (typeof record[key] === "object" && record[key] !== null) {
      if (key === "descriptions") doc.descriptions = record[key] as Record<string, string>;
      if (key === "confirmed") doc.confirmed = record[key] as Record<string, CollectorConfirmedEntry>;
      if (key === "pending") doc.pending = record[key] as Record<string, CollectorRecord>;
    }
  }
  if (typeof record.inflight === "object" && record.inflight !== null) {
    const inflight = record.inflight as Record<string, unknown>;
    if (typeof inflight.gzipBase64 === "string" && typeof inflight.signatureHex === "string"
      && typeof inflight.pubkeyHex === "string" && typeof inflight.records === "object" && inflight.records !== null) {
      doc.inflight = {
        gzipBase64: inflight.gzipBase64,
        signatureHex: inflight.signatureHex,
        pubkeyHex: inflight.pubkeyHex,
        records: inflight.records as Record<string, CollectorRecord>,
        trigger: typeof inflight.trigger === "string" ? inflight.trigger : "recovered",
      };
    }
  }
  if (typeof record.meta === "object" && record.meta !== null) {
    const meta = record.meta as Record<string, unknown>;
    if (typeof meta.lastAttemptAt === "number") doc.meta.lastAttemptAt = meta.lastAttemptAt;
    if (typeof meta.lastSuccessAt === "number" || meta.lastSuccessAt === null) doc.meta.lastSuccessAt = meta.lastSuccessAt as number | null;
    if (typeof meta.lastError === "string" || meta.lastError === null) doc.meta.lastError = meta.lastError as string | null;
  }
  return doc;
}

/** 采集状态存储：读改写串行，调用方无需加锁。 */
export class CollectorStore {
  #tail: Promise<CollectorDoc>;

  constructor(private readonly store: BorrowedModuleFileStore) {
    this.#tail = this.#load();
  }

  async #load(): Promise<CollectorDoc> {
    try {
      const object = await this.store.get(COLLECTOR_STATE_PATH);
      if (!object) return emptyCollectorDoc();
      return sanitizeDoc(JSON.parse(new TextDecoder().decode(object.bytes)));
    } catch {
      return emptyCollectorDoc();
    }
  }

  /** 原子读改写：mutate 内同步修改文档，保存后返回其返回值。 */
  update<T>(mutate: (doc: CollectorDoc) => T): Promise<T> {
    const run = this.#tail.then(async (doc) => {
      const result = mutate(doc);
      await this.store.put(COLLECTOR_STATE_PATH, new TextEncoder().encode(JSON.stringify(doc)));
      return { result, doc };
    });
    // 失败不阻塞后续写入（回退到磁盘状态），但调用方仍能拿到本次错误。
    this.#tail = run.then(
      ({ doc }) => doc,
      () => this.#load(),
    );
    return run.then(({ result }) => result);
  }

  /** 只读快照（浅拷贝顶层，调用方不得直接修改后保存）。 */
  snapshot(): Promise<CollectorDoc> {
    return this.#tail.then((doc) => JSON.parse(JSON.stringify(doc)) as CollectorDoc);
  }
}
