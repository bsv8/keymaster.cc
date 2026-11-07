// 采集服务：队列、触发、签名、提交、重试的编排。
// 调度与签名由 Worker 侧驱动；锁定后停止新签名，解锁后恢复。
// dev 保留诊断日志，生产不输出诊断内容、不记录秘密。

import type { ActiveKeyCrypto, BorrowedModuleFileStore, MsFileCollectorStatus } from "@keymaster/contracts";
import {
  COLLECTOR_HEADERS,
  COLLECTOR_SIG_VERSION,
  collectorBase64Decode,
  collectorBase64Encode,
  collectorCanonicalJson,
  collectorDigestInput,
  collectorHex,
  collectorSubmissionUrl,
  defaultCollectorGzip,
  defaultCollectorSha256,
  type CollectorGzip,
  type CollectorRecord,
  type CollectorSha256,
} from "./collectorCodec.js";
import {
  COLLECTOR_EARLY_TRIGGER_COUNT,
  COLLECTOR_HOURLY_MS,
  collectorConfirm,
  collectorShouldTrigger,
  collectorUpsert,
  type CollectorInflight,
} from "./collectorQueue.js";
import { CollectorStore } from "./collectorState.js";

/** 生产缺省退避：基线 30s、因子 2、上限 1h。 */
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 3_600_000;

/** 签名能力：Vault 受限摘要签名（der）。 */
export interface CollectorSigner {
  /** 当前压缩公钥 hex。 */
  pubkeyHex: string;
  /** 对 32 字节摘要签名，返回 low-S DER。 */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

export interface CollectorServiceDeps {
  /** owner 文件句柄（msfiles 根）。 */
  files: BorrowedModuleFileStore;
  /** 当前 owner 的 Vault 签名能力；锁定后拒绝。 */
  crypto: () => Promise<ActiveKeyCrypto>;
  /** 当前会话是否仍有效（epoch 一致且已解锁），失效即自停。 */
  isAlive: () => boolean;
  now?: () => number;
  gzip?: CollectorGzip;
  sha256?: CollectorSha256;
  fetchFn?: typeof fetch;
  /** 存活检查间隔，缺省 60s。 */
  tickMs?: number;
  /** 退避基线，缺省生产值；测试可注入小值。 */
  retryBaseMs?: number;
  /** dev 诊断开关，生产保持关闭。 */
  diagnostics?: boolean;
}

/** 采集服务：同一时刻只发送一个批次，失败复用原 gzip 与签名。 */
export class CollectorService {
  readonly #store: CollectorStore;
  readonly #deps: CollectorServiceDeps;
  #started = false;
  #stopped = false;
  #hourlyTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryDelayMs = RETRY_BASE_MS;
  #sending = false;

  constructor(deps: CollectorServiceDeps) {
    this.#deps = deps;
    this.#store = new CollectorStore(deps.files);
  }

  nowMs(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #log(event: string, detail?: unknown): void {
    if (!this.#deps.diagnostics) return;
    console.debug(`[msfile-collector] ${event}`, detail ?? "");
  }

  /** 启动调度：恢复未完成批次，开始每小时检查。 */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#log("service.start");
    void this.#recover().then(() => this.#armHourly());
  }

  /** 停止调度与重试，不再发起新签名。锁定/撤销后调用。 */
  stop(): void {
    this.#stopped = true;
    if (this.#hourlyTimer !== undefined) clearTimeout(this.#hourlyTimer);
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#hourlyTimer = undefined;
    this.#retryTimer = undefined;
    this.#log("service.stop");
  }

  async #recover(): Promise<void> {
    if (!this.#alive()) return;
    const doc = await this.#store.snapshot();
    if (doc.inflight && doc.config.enabled && doc.config.endpoint !== "") {
      this.#log("recover.inflight");
      await this.#sendInflight();
    }
  }

  #alive(): boolean {
    if (this.#stopped) return false;
    try {
      return this.#deps.isAlive();
    } catch {
      return false;
    }
  }

  #armHourly(): void {
    if (this.#stopped) return;
    const tickMs = this.#deps.tickMs ?? 60_000;
    this.#hourlyTimer = setTimeout(() => {
      this.#hourlyTimer = undefined;
      if (!this.#alive()) {
        this.stop();
        return;
      }
      void this.#tickHourly().finally(() => this.#armHourly());
    }, tickMs);
    this.#hourlyTimer.unref?.();
  }

  async #tickHourly(): Promise<void> {
    const ready = await this.#store.update((doc) => {
      if (!doc.config.enabled || doc.config.endpoint === "" || doc.inflight) return false;
      if (Object.keys(doc.pending).length === 0) return false;
      return this.nowMs() - doc.meta.lastAttemptAt >= COLLECTOR_HOURLY_MS;
    });
    if (ready) await this.#submit("hourly");
  }

  /** 自有导入文件完整入库后通知（购买/下载路径不调用）。 */
  async notifyStored(input: { seedHashHex: string; fileName: string; mediaType: string; fileSizeBytes: string }): Promise<void> {
    const result = await this.#store.update((doc) => {
      const record: CollectorRecord = { ...input, description: doc.descriptions[input.seedHashHex] ?? "" };
      return collectorUpsert(doc.confirmed, doc.pending, record);
    });
    if (result === "noop") return;
    this.#log("notify.stored", { seed: input.seedHashHex });
    await this.#maybeEarly();
  }

  /** 介绍编辑成功后更新队列；无记录可附着时只保存介绍。 */
  async setDescription(seedHashHex: string, description: string): Promise<void> {
    const queued = await this.#store.update((doc) => {
      doc.descriptions[seedHashHex] = description;
      const queuedRecord = doc.pending[seedHashHex];
      if (queuedRecord) {
        const known = doc.confirmed[seedHashHex];
        if (queuedRecord.description === description && known?.description === description) return false;
        doc.pending[seedHashHex] = { ...queuedRecord, description };
        return true;
      }
      const known = doc.confirmed[seedHashHex];
      if (!known || known.description === description) return false;
      doc.pending[seedHashHex] = { ...known, description };
      return true;
    });
    if (queued) {
      this.#log("description.set", { seed: seedHashHex });
      await this.#maybeEarly();
    }
  }

  async getConfig(): Promise<{ endpoint: string; enabled: boolean }> {
    const doc = await this.#store.snapshot();
    return { ...doc.config };
  }

  async updateConfig(input: { endpoint?: string; enabled?: boolean }): Promise<{ endpoint: string; enabled: boolean }> {
    const config = await this.#store.update((doc) => {
      if (input.endpoint !== undefined) doc.config.endpoint = input.endpoint;
      if (input.enabled !== undefined) doc.config.enabled = input.enabled;
      return { ...doc.config };
    });
    this.#log("config.update", { enabled: config.enabled });
    if (config.enabled && config.endpoint !== "") await this.#maybeEarly();
    return config;
  }

  async getStatus(): Promise<MsFileCollectorStatus> {
    const doc = await this.#store.snapshot();
    return {
      enabled: doc.config.enabled,
      endpoint: doc.config.endpoint,
      pendingCount: Object.keys(doc.pending).length,
      inflight: doc.inflight !== null,
      lastSuccessAt: doc.meta.lastSuccessAt,
      lastError: doc.meta.lastError,
    };
  }

  async #maybeEarly(): Promise<void> {
    if (!this.#alive()) return;
    const trigger = await this.#store.snapshot().then((doc) => {
      if (!doc.config.enabled || doc.config.endpoint === "" || doc.inflight) return null;
      return collectorShouldTrigger(Object.keys(doc.pending).length, this.nowMs(), doc.meta.lastAttemptAt) === "early" ? "early" : null;
    });
    if (trigger) await this.#submit(trigger);
  }

  /** 测试与管理入口：忽略计时器立即尝试。 */
  async flush(): Promise<boolean> {
    if (!this.#alive()) return false;
    const ready = await this.#store.snapshot().then((doc) => {
      if (!doc.config.enabled || doc.config.endpoint === "" || doc.inflight) return false;
      return Object.keys(doc.pending).length > 0;
    });
    if (!ready) return false;
    await this.#submit("manual");
    return true;
  }

  async #submit(trigger: string): Promise<void> {
    if (this.#sending || !this.#alive()) return;
    const prepared = await this.#store.update((doc) => {
      if (!doc.config.enabled || doc.config.endpoint === "" || doc.inflight) return null;
      const records = Object.values(doc.pending);
      if (records.length === 0) return null;
      return { endpoint: doc.config.endpoint, records };
    });
    if (!prepared) return;
    this.#sending = true;
    try {
      const canonical = new TextEncoder().encode(collectorCanonicalJson(prepared.records));
      const gzip = await (this.#deps.gzip ?? defaultCollectorGzip)(canonical);
      const digest = await (this.#deps.sha256 ?? defaultCollectorSha256)(collectorDigestInput(gzip));
      const signer = await this.#buildSigner();
      const signature = await signer.signDigest(digest);
      const signatureHex = collectorHex(signature);
      await this.#store.update((doc) => {
        const inflight: CollectorInflight = {
          gzipBase64: collectorBase64Encode(gzip),
          signatureHex,
          pubkeyHex: signer.pubkeyHex,
          records: Object.fromEntries(prepared.records.map((record) => [record.seedHashHex, record])),
          trigger,
        };
        doc.inflight = inflight;
        doc.meta.lastAttemptAt = this.nowMs();
      });
      await this.#sendInflight();
    } catch (error) {
      this.#log("submit.prepare-failed", error instanceof Error ? error.message : String(error));
      await this.#store.update((doc) => {
        doc.meta.lastError = error instanceof Error ? error.message : String(error);
      });
      this.#scheduleRetry();
    } finally {
      this.#sending = false;
    }
  }

  async #buildSigner(): Promise<CollectorSigner> {
    const crypto = await this.#deps.crypto();
    const identity = crypto.getIdentity();
    const pubkeyHex = identity.publicKeyHex.toLowerCase();
    if (!/^[0-9a-f]{66}$/.test(pubkeyHex)) throw new Error("采集签名需要 33 字节压缩公钥");
    return {
      pubkeyHex,
      signDigest: async (digest: Uint8Array) => {
        if (digest.byteLength !== 32) throw new Error("采集签名摘要必须为 32 字节");
        const current = crypto.getIdentity();
        if (current.publicKeyHex.toLowerCase() !== pubkeyHex) throw new Error("签名期间 active Key 已变化");
        const result = await crypto.signDigest({ digest: digest.slice().buffer as ArrayBuffer, format: "der" });
        if (result.format !== "der") throw new Error("Vault 返回了错误的签名格式");
        return new Uint8Array(result.signature).slice();
      },
    };
  }

  /** 发送发送中批次：成功只确认该批版本，失败保留原字节按退避重试。 */
  async #sendInflight(): Promise<void> {
    const snapshot = await this.#store.snapshot();
    const inflight = snapshot.inflight;
    const endpoint = snapshot.config.endpoint;
    if (!inflight || endpoint === "") return;
    if (!this.#alive()) return;
    const gzip = collectorBase64Decode(inflight.gzipBase64);
    const fetchFn = this.#deps.fetchFn ?? fetch;
    let response: Response;
    try {
      // 提交地址为完整 URL（含 path 原样使用，旧基地址自动补路径）。
      response = await fetchFn(collectorSubmissionUrl(endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          [COLLECTOR_HEADERS.pubkey]: inflight.pubkeyHex,
          [COLLECTOR_HEADERS.signature]: inflight.signatureHex,
          [COLLECTOR_HEADERS.sigVersion]: String(COLLECTOR_SIG_VERSION),
        },
        body: gzip as BodyInit,
      });
    } catch (error) {
      await this.#fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!response.ok) {
      const code = response.status === 401 ? "unauthorized"
        : response.status === 429 ? "rate_limited"
        : response.status === 400 || response.status === 413 ? "invalid_request" : "storage_failed";
      if (code === "invalid_request" || code === "unauthorized") {
        // 不可重试：丢弃该批次（保留队列，等待下次变化重新生成）。
        await this.#store.update((doc) => {
          doc.inflight = null;
          doc.meta.lastError = `${code}: http-${response.status}`;
        });
        this.#log("send.rejected", { status: response.status });
        return;
      }
      await this.#fail(`${code}: http-${response.status}`);
      return;
    }
    const receipt = (await response.json().catch(() => ({}))) as { archiveId?: string };
    if (!receipt.archiveId) {
      await this.#fail("storage_failed: missing archiveId");
      return;
    }
    await this.#store.update((doc) => {
      if (!doc.inflight) return;
      collectorConfirm(doc.confirmed, doc.pending, doc.inflight.records);
      doc.inflight = null;
      doc.meta.lastSuccessAt = this.nowMs();
      doc.meta.lastError = null;
    });
    this.#retryDelayMs = this.#deps.retryBaseMs ?? RETRY_BASE_MS;
    this.#log("send.ok", { archive: receipt.archiveId });
  }

  async #fail(reason: string): Promise<void> {
    await this.#store.update((doc) => {
      doc.meta.lastError = reason;
    });
    this.#log("send.failed", { reason });
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    if (this.#retryTimer !== undefined) return;
    const base = this.#deps.retryBaseMs ?? RETRY_BASE_MS;
    if (this.#retryDelayMs < base) this.#retryDelayMs = base;
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, RETRY_CAP_MS);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#alive()) {
        this.stop();
        return;
      }
      void this.#sendInflight();
    }, delay);
    this.#retryTimer.unref?.();
  }
}
