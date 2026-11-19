import { defineBuiltinWorkerPlugin, STORAGE_FILE_CLIENTS_CAPABILITY, CONNECT_APP_SOURCE_BATCH_CAPABILITY, MANUAL_SOURCE_ID, DEFAULT_MARKET_SOURCE_ID, traceDev, type AppSourceChangeResult, type ConnectAppSourceBatch, type AppSourceChange } from "@keymaster/contracts";
import { MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS, type MarketWorkerSnapshot } from "./marketWorkerContract.js";
import { openMarketRepository } from "./marketRepository.js";
import { decodeProtocolDirectory, marketContentKey } from "./marketValidate.js";
import { verifyManualUrl } from "./marketVerify.js";
import type { MarketPendingItem, MarketStateDocument, MarketSyncRecord } from "./marketTypes.js";
import type { AppSourceEntry } from "@keymaster/contracts";

// KeymasterMarketProtocol v1 HTTP 目录上限。
const maxDirectoryBytes = 64 * 1024 * 1024;

interface LoadSettledResult { pluginId: string; outcome: string; reason?: string }
interface LoadSettledDetail { batchId: string; runtimeInstanceId: string; results: readonly LoadSettledResult[] }

/** dev 基址覆盖仅作用于内置市场：由基址按默认路径构成完整目录 URL。 */
function builtInDirectoryURL(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const base = (env?.VITE_KEYMASTER_MARKET_URL ?? "https://market.bsv8.com").replace(/\/?$/, "/");
  return new URL("v1/apps", base).href;
}

/** 完整目录 URL 校验：HTTP(S)、无凭据；第三方可使用任何路径或静态托管 JSON。 */
function canonicalDirectoryURL(input: string): string {
  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.origin === "null") throw new Error("仅支持 HTTP(S) 目录地址");
  return u.href;
}

export function createMarketWorkerPlugin() {
  return defineBuiltinWorkerPlugin("apps", [MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS], async ctx => {
    const files = ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "");
    const repository = openMarketRepository(files);
    let state: MarketStateDocument = {
      version: 1,
      markets: [{ id: DEFAULT_MARKET_SOURCE_ID, name: "内置市场", directoryUrl: builtInDirectoryURL(), builtIn: true }],
      applied: {}, pending: {}, sync: {}, journal: null,
    };
    let revision: number | undefined;
    let blocked: Error | undefined;
    let snapshotRevision = 0;
    /** 每个市场自己的在途同步：同一市场的并发刷新共用在途任务。 */
    const inflight = new Map<string, { task: Promise<void>; controller: AbortController }>();
    let initialSyncDone = false;
    const peers = new Map<string, (snapshot: MarketWorkerSnapshot) => void>();
    const getBatch = (): ConnectAppSourceBatch | undefined => ctx.optionalCapability(CONNECT_APP_SOURCE_BATCH_CAPABILITY) as ConnectAppSourceBatch | undefined;

    const buildSnapshot = (): MarketWorkerSnapshot => {
      const items = Object.values(state.pending).sort((a, b) => a.createdAt - b.createdAt);
      let appliedTotal = 0;
      const markets = state.markets.map(market => {
        const record: MarketSyncRecord = state.sync[market.id] ?? { lastSuccessAt: null, lastError: null, lastRejected: [] };
        appliedTotal += Object.keys(state.applied[market.id] ?? {}).length;
        return {
          id: market.id, name: market.name, directoryUrl: market.directoryUrl, builtIn: market.builtIn,
          lastSuccessAt: record.lastSuccessAt, lastError: record.lastError, lastRejected: record.lastRejected,
        };
      });
      return {
        revision: snapshotRevision,
        markets,
        pending: items.filter(i => i.validation !== "verified").map(i => ({ ...i })),
        manual: items.filter(i => i.validation === "verified").map(i => ({ ...i })),
        appliedMarketCount: appliedTotal,
      };
    };
    const emit = () => {
      snapshotRevision++;
      const snapshot = buildSnapshot();
      for (const push of peers.values()) {
        try { push(snapshot); } catch { /* observer isolation */ }
      }
    };
    let ready: Promise<void> | undefined;
    const ensureReady = () => ready ??= (async () => {
      try {
        ctx.scope.assertActive();
        const record = await repository.read();
        ctx.scope.assertActive();
        if (record) { state = record.document; revision = record.revision; }
        // dev 基址覆盖仅作用于内置市场；已存文档中的内置地址保持读取值。
      } catch (cause) { blocked = cause instanceof Error ? cause : new Error(String(cause)); }
      emit();
    })();
    let queue: Promise<void> = Promise.resolve();
    const transaction = (change: (doc: MarketStateDocument) => void) => {
      const work = queue.then(async () => {
        await ensureReady(); ctx.scope.assertActive(); if (blocked) throw blocked;
        const next = structuredClone(state); change(next); ctx.scope.assertActive();
        const stored = await repository.write(next, { ifRevision: revision });
        ctx.scope.assertActive(); revision = stored; state = next; emit();
      });
      queue = work.catch(cause => { traceDev("market", "write.failed", () => ({ error: cause })); });
      return work;
    };
    let controlTail: Promise<void> = Promise.resolve();
    const serial = <T>(run: () => Promise<T> | T): Promise<T> => {
      const work = controlTail.then(() => { ctx.scope.assertActive(); return run(); });
      controlTail = work.then(() => undefined, () => undefined);
      return work;
    };

    async function fetchDirectory(url: string, signal: AbortSignal): Promise<AppSourceEntry[]> {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal });
      if (!response.ok) throw new Error(`市场状态 ${response.status}`);
      if (!response.body) throw new Error("市场目录响应为空");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      const chunks: string[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxDirectoryBytes) throw new Error("市场目录超过 64 MiB");
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      return decodeProtocolDirectory(chunks.join(""));
    }

    /** 按已持久化的逐项结果更新单个市场的已应用清单；只处理本轮实际提交的变更。 */
    function accountBatch(doc: MarketStateDocument, marketId: string, changes: readonly AppSourceChange[], results: readonly AppSourceChangeResult[]) {
      const rejected: MarketSyncRecord["lastRejected"] = [];
      doc.applied[marketId] ??= {};
      for (const [index, change] of changes.entries()) {
        const result = results[index];
        if (!result) continue;
        if (result.status === "applied" || result.status === "unchanged") {
          if (change.kind === "submit") doc.applied[marketId]![change.appPublicKeyHex] = structuredClone(change.publication as AppSourceEntry);
          else delete doc.applied[marketId]![change.appPublicKeyHex];
        } else {
          rejected.push({ sourceId: result.sourceId, appPublicKeyHex: result.appPublicKeyHex, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
        }
      }
      doc.sync[marketId] ??= { lastSuccessAt: null, lastError: null, lastRejected: [] };
      doc.sync[marketId]!.lastRejected = rejected;
    }

    /**
     * 收敛上一轮在途批次（命令队列内执行）：重放同批提交——同源同内容幂等
     * unchanged，不改变提交序号——按实际结果记账后清除 journal。Connect
     * 已写入而未记账的窗口因此可恢复；Connect 不可用时保留 journal 等待。
     */
    async function settlePreviousBatch(): Promise<void> {
      if (!state.journal) return;
      const journal = structuredClone(state.journal);
      const batch = getBatch();
      if (!batch) throw new Error("Connect 不可用，无法收敛未记账批次");
      const pendingId = journal.pendingId;
      if (journal.marketId === MANUAL_SOURCE_ID) {
        const item = pendingId ? state.pending[pendingId] : undefined;
        const change = journal.changes[0];
        if (!item || item.revision !== journal.revision || item.validation !== "verified" ||
            !item.verifiedPublication || journal.changes.length !== 1 || change?.kind !== "submit" ||
            change.sourceId !== MANUAL_SOURCE_ID || change.appPublicKeyHex !== item.verifiedPublication.appPublicKeyHex ||
            change.appVersion !== item.verifiedPublication.appVersion ||
            marketContentKey(change.publication) !== marketContentKey(item.verifiedPublication)) {
          throw new Error("手工来源恢复记录与待同步发布不一致");
        }
      }
      const results = journal.changes.length ? await batch.applyChanges(journal.changes) : [];
      ctx.scope.assertActive();
      await transaction(doc => {
        if (!doc.journal || doc.journal.marketId !== journal.marketId) return;
        if (journal.marketId === MANUAL_SOURCE_ID && pendingId) {
          if (!results[0]) throw new Error("Connect 未返回手工来源结果");
          accountManual(doc, pendingId, results[0]);
        } else {
          accountBatch(doc, journal.marketId, journal.changes, results);
        }
        doc.journal = null;
      });
    }

    /**
     * 受 journal 保护的批次提交（命令队列内执行）：提交前把完整变更落盘，
     * Connect 返回逐项结果后记账并清除 journal；中途失败保留 journal，
     * 下一轮先收敛再重试。市场刷新不顺带处理手工提交。
     */
    async function commitMarketChanges(marketId: string, changes: AppSourceChange[]): Promise<readonly AppSourceChangeResult[]> {
      const batch = getBatch();
      if (!batch) throw new Error("Connect 不可用");
      if (changes.length) {
        await transaction(doc => { doc.journal = { marketId, changes: structuredClone(changes) }; });
      }
      const results = changes.length ? await batch.applyChanges(changes) : [];
      ctx.scope.assertActive();
      return results;
    }

    /** 单个市场的一轮同步：拉取在队列外，提交与记账进入命令队列。 */
    async function syncMarketNow(marketId: string, signal: AbortSignal): Promise<void> {
      await ensureReady(); ctx.scope.assertActive(); if (blocked) throw blocked;
      const market = state.markets.find(m => m.id === marketId);
      if (!market) throw new Error("市场不存在");
      let entries: AppSourceEntry[] | undefined;
      let fetchError: string | undefined;
      try {
        entries = await fetchDirectory(market.directoryUrl, signal);
        ctx.scope.assertActive();
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
        traceDev("market", "sync.fetch.failed", () => ({ marketId, error }));
      }
      await serial(async () => {
        // 市场在拉取期间被移除：迟到结果直接丢弃，不写任何状态。
        if (!state.markets.some(m => m.id === marketId)) return;
        // 先收敛上一轮待提交或待记账的结果，再按该市场的新清单计算差异。
        await settlePreviousBatch();
        const changes: AppSourceChange[] = [];
        if (entries) {
          const fresh = new Set(entries.map(e => e.appPublicKeyHex.toLowerCase()));
          const applied = state.applied[marketId] ?? {};
          for (const entry of entries) {
            const key = entry.appPublicKeyHex;
            const old = applied[key];
            if (!old || marketContentKey(old) !== marketContentKey(entry)) {
              changes.push({ kind: "submit", sourceId: marketId, appPublicKeyHex: entry.appPublicKeyHex, appVersion: entry.appVersion, publication: structuredClone(entry) });
            }
          }
          for (const key of Object.keys(applied)) {
            if (!fresh.has(key.toLowerCase())) changes.push({ kind: "invalidate", sourceId: marketId, appPublicKeyHex: key });
          }
        }
        try {
          const results = await commitMarketChanges(marketId, changes);
          await transaction(doc => {
            accountBatch(doc, marketId, changes, results);
            // 成功记账与清除本批日志同一次写入，避免中断后重放。
            if (doc.journal?.marketId === marketId) doc.journal = null;
            if (!fetchError) {
              doc.sync[marketId] ??= { lastSuccessAt: null, lastError: null, lastRejected: [] };
              doc.sync[marketId]!.lastSuccessAt = Date.now();
            }
            doc.sync[marketId] ??= { lastSuccessAt: null, lastError: null, lastRejected: [] };
            doc.sync[marketId]!.lastError = fetchError ?? null;
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          traceDev("market", "sync.failed", () => ({ marketId, error }));
          await transaction(doc => {
            doc.sync[marketId] ??= { lastSuccessAt: null, lastError: null, lastRejected: [] };
            doc.sync[marketId]!.lastError = message;
          });
        }
      });
    }

    /** 同一市场的并发刷新共用在途任务；不同市场独立拉取。 */
    function syncMarket(marketId: string): Promise<void> {
      const running = inflight.get(marketId);
      if (running) return running.task;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ctx.scope.signal]);
      const task = syncMarketNow(marketId, signal).finally(() => { inflight.delete(marketId); });
      inflight.set(marketId, { task, controller });
      return task;
    }

    /** 全部市场各一轮：单个市场挂起或失败不阻塞其他市场。 */
    async function syncAll(): Promise<void> {
      const ids = state.markets.map(m => m.id);
      await Promise.all(ids.map(id => syncMarket(id).catch(() => undefined)));
    }

    /**
     * 手工来源直接提交：验签资料直达 Connect 的批次写入，不经市场拉取。
     * 市场迟迟不响应（请求挂起而非快速失败）时，手工同步也不被阻塞。
     */
    function accountManual(doc: MarketStateDocument, pendingId: string, result: AppSourceChangeResult) {
      const item = doc.pending[pendingId]!;
      item.updatedAt = Date.now();
      if (result.status === "applied" || result.status === "unchanged") {
        item.syncStatus = "synced";
        delete item.syncError;
        const pubkey = item.verifiedPublication!.appPublicKeyHex;
        for (const [otherId, other] of Object.entries(doc.pending)) {
          if (otherId !== pendingId && other.verifiedPublication?.appPublicKeyHex === pubkey && other.validation === "verified") {
            delete doc.pending[otherId];
          }
        }
      } else if (result.status === "lower-version-rejected") {
        item.syncStatus = "lower-version";
        item.syncError = "已验证，版本较低，未更新目录";
      } else {
        item.syncStatus = "sync-failed";
        item.syncError = result.reason ?? "同步失败";
      }
    }

    async function submitManualNow(pendingId: string): Promise<void> {
      const settle = async () => {
        await settlePreviousBatch();
        const item = state.pending[pendingId];
        if (!item || item.validation !== "verified" || !item.verifiedPublication ||
            (item.syncStatus !== "unsynced" && item.syncStatus !== "sync-failed")) return;
        const publication = item.verifiedPublication;
        if (!getBatch()) throw new Error("Connect 不可用");
        await transaction(doc => {
          doc.journal = {
            marketId: MANUAL_SOURCE_ID, pendingId, revision: item.revision,
            changes: [{ kind: "submit", sourceId: MANUAL_SOURCE_ID, appPublicKeyHex: publication.appPublicKeyHex, appVersion: publication.appVersion, publication }],
          };
        });
        await settlePreviousBatch();
      };
      try {
        await settle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        traceDev("market", "manual-submit.failed", () => ({ pendingId, error }));
        await transaction(doc => {
          const item = doc.pending[pendingId];
          if (!item || item.validation !== "verified" ||
              (item.syncStatus !== "unsynced" && item.syncStatus !== "sync-failed")) return;
          item.syncStatus = "sync-failed";
          item.syncError = message;
          item.updatedAt = Date.now();
        });
      }
    }

    async function validateItem(pendingId: string, revisionAtStart: number): Promise<void> {
      try {
        await ensureReady(); ctx.scope.assertActive(); if (blocked) return;
        const current = state.pending[pendingId];
        if (!current || current.revision !== revisionAtStart) return;
        if (!current.url) {
          await transaction(doc => {
            const item = doc.pending[pendingId];
            if (!item || item.revision !== revisionAtStart) return;
            item.validation = "failed";
            item.validationError = "缺少应用网址";
            item.updatedAt = Date.now();
          });
          return;
        }
        try {
          const publication = await verifyManualUrl(current.url, ctx.scope.signal);
          ctx.scope.assertActive();
          await transaction(doc => {
            const item = doc.pending[pendingId];
            if (!item || item.revision !== revisionAtStart) return;
            item.validation = "verified";
            delete item.validationError;
            item.verifiedPublication = publication;
            item.verifiedAt = Date.now();
            item.syncStatus = "unsynced";
            delete item.syncError;
            item.updatedAt = Date.now();
            // 同公钥旧记录不在此处删除：Connect 接受本次提交后才归并（见 submitManualNow），
            // 低版本被拒时旧来源的管理记录原样保留。
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          traceDev("market", "validation.failed", () => ({ pendingId, error }));
          await transaction(doc => {
            const item = doc.pending[pendingId];
            if (!item || item.revision !== revisionAtStart) return;
            item.validation = "failed";
            item.validationError = message;
            item.updatedAt = Date.now();
          });
          return;
        }
        await submitManual(pendingId);
      } catch (error) { traceDev("market", "validation.aborted", () => ({ pendingId, error })); }
    }

    const markInitialSynced = () => { initialSyncDone = true; };
    const triggerInitialSync = (results: readonly LoadSettledResult[] | undefined, source: string) => {
      if (ctx.scope.state !== "active" || initialSyncDone) return;
      try {
        const connectResult = (results ?? []).find(r => r.pluginId === "protocol");
        const connectOk = !!connectResult && connectResult.outcome === "success" && !!getBatch();
        if (!connectOk) {
          void serial(async () => {
            // 先等存储就绪再枚举市场，避免首轮漏掉已保存的第三方市场。
            await ensureReady(); ctx.scope.assertActive(); if (blocked) throw blocked;
            for (const market of state.markets) {
              await transaction(doc => {
                doc.sync[market.id] ??= { lastSuccessAt: null, lastError: null, lastRejected: [] };
                doc.sync[market.id]!.lastError = "Connect 不可用";
                doc.sync[market.id]!.lastRejected = [];
              });
            }
          }).then(markInitialSynced).catch(() => undefined);
          return;
        }
        traceDev("market", "initial-sync.start", () => ({ source }));
        // 首次同步先等存储就绪，再收敛批次和枚举市场。
        void serial(async () => {
          await ensureReady(); ctx.scope.assertActive(); if (blocked) throw blocked;
          await settlePreviousBatch();
        }).then(() => syncAll()).then(markInitialSynced, markInitialSynced);
      } catch (error) { traceDev("market", "initial-sync.failed", () => ({ error })); }
    };
    // 唯一的首次同步触发路径：WebLoom 批次结束事件。订阅发生在 setup 中，
    // 批次在 reconcile 之后创建并异步发出，订阅必定先于发出。
    // 每轮钱包业务运行实例只触发一次；旧批次不再重放。
    // 标记只在同步落盘（成功或已记录失败）后设置；中途中断不算完成。
    const offLoadSettled = ctx.messageBus.subscribe<LoadSettledDetail>("webloom.plugin-load.settled", detail => {
      triggerInitialSync(detail?.results, "event");
    });

    /** 验签后的手工提交进入命令队列：与移除/更新依次执行，不留孤儿来源。 */
    function submitManual(pendingId: string): Promise<void> {
      return serial(() => submitManualNow(pendingId));
    }

    /** 登记第三方市场：同一完整目录地址只登记一次；新市场分配新 ID 并异步首拉一次。 */
    async function configureMarketNow(name: string, directoryUrl: string): Promise<{ marketId: string }> {
      if (!name.trim()) throw new Error("市场名称必填");
      const full = canonicalDirectoryURL(directoryUrl.trim());
      await serial(async () => {
        if (state.markets.some(m => m.directoryUrl === full)) throw new Error("该目录地址已登记");
      });
      const marketId = `market_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      await transaction(doc => {
        if (doc.markets.some(m => m.directoryUrl === full)) throw new Error("该目录地址已登记");
        doc.markets.push({ id: marketId, name: name.trim(), directoryUrl: full, builtIn: false });
        doc.sync[marketId] = { lastSuccessAt: null, lastError: null, lastRejected: [] };
      });
      // 新市场首拉一次；后台失败只记该市场同步错误。
      void syncMarket(marketId).catch(() => undefined);
      return { marketId };
    }

    /** 移除第三方市场：先收敛未记账批次，再按最新已应用清单提交该来源全部失效（journal 保护），成功后删除配置。 */
    async function discardMarketNow(marketId: string): Promise<void> {
      await serial(async () => {
        const market = state.markets.find(m => m.id === marketId);
        if (!market) throw new Error("市场不存在");
        if (market.builtIn) throw new Error("内置市场不可移除");
        // 先收敛上一轮待提交或待记账的结果，再按该来源的新清单计算差异，避免孤儿来源。
        await settlePreviousBatch();
        ctx.scope.assertActive();
        if (state.journal) throw new Error("Connect 不可用，无法收敛未记账批次");
        // 市场在收敛期间被移除：直接返回，不写任何状态。
        if (!state.markets.some(m => m.id === marketId)) throw new Error("市场不存在");
        const applied = state.applied[marketId] ?? {};
        const changes: AppSourceChange[] = Object.values(applied).map(entry => ({ kind: "invalidate", sourceId: marketId, appPublicKeyHex: entry.appPublicKeyHex }));
        const results = await commitMarketChanges(marketId, changes);
        await transaction(doc => {
          delete doc.applied[marketId];
          delete doc.sync[marketId];
          if (doc.journal?.marketId === marketId) doc.journal = null;
          doc.markets = doc.markets.filter(m => m.id !== marketId);
          void results;
        });
        inflight.get(marketId)?.controller.abort();
      });
    }

    async function execute(command: Extract<import("./marketWorkerContract.js").MarketWorkerCommand, { type: string }>): Promise<unknown> {
      await ensureReady(); if (blocked) throw blocked;
      switch (command.type) {
        case "snapshot": return;
        case "sync-now": {
          if (command.marketId !== undefined) await syncMarket(command.marketId);
          else await syncAll();
          return;
        }
        case "configure-market": return configureMarketNow(command.name, command.directoryUrl);
        case "discard-market": await discardMarketNow(command.marketId); return;
        case "add-manual": {
          if (typeof command.url !== "string" || !command.url.trim()) throw new Error("请输入应用网址");
          const parsed = new URL(command.url.trim());
          if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("仅支持 HTTP(S) 应用网址");
          const url = parsed.href;
          for (const item of Object.values(state.pending)) {
            if (item.kind === "url" && item.url === url) throw new Error("该网址已在待验证列表中");
          }
          const pendingId = crypto.randomUUID();
          const at = Date.now();
          const item: MarketPendingItem = {
            pendingId, revision: 1, kind: "url", url,
            validation: "pending", syncStatus: "unsynced", createdAt: at, updatedAt: at,
          };
          await transaction(doc => { doc.pending[pendingId] = structuredClone(item); });
          void validateItem(pendingId, 1);
          return { pendingId };
        }
        case "update-manual": {
          await settlePreviousBatch();
          const existing = state.pending[command.pendingId];
          if (!existing) throw new Error("待验证项不存在");
          if (existing.kind !== "url") throw new Error("类型不匹配");
          // 已同步来源改身份前先失效旧来源，避免旧公钥的来源在 Connect 侧成为孤儿；
          // 未同步的记录在 Connect 侧没有来源，只改 Market 数据。
          if (existing.validation === "verified" && existing.verifiedPublication && existing.syncStatus === "synced") {
            const batch = getBatch();
            if (!batch) throw new Error("Connect 不可用，无法更新已验证来源");
            const [result] = await batch.applyChanges([{ kind: "invalidate", sourceId: MANUAL_SOURCE_ID, appPublicKeyHex: existing.verifiedPublication.appPublicKeyHex }]);
            ctx.scope.assertActive();
            if (!result || (result.status !== "applied" && result.status !== "unchanged")) {
              throw new Error(result?.reason ?? "旧来源失效失败");
            }
          }
          if (typeof command.url !== "string" || !command.url.trim()) throw new Error("缺少更新内容");
          const parsed = new URL(command.url.trim());
          if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("仅支持 HTTP(S) 应用网址");
          const nextUrl = parsed.href;
          const nextRevision = existing.revision + 1;
          await transaction(doc => {
            const item = doc.pending[command.pendingId];
            if (!item) return;
            item.url = nextUrl; item.revision = nextRevision;
            item.validation = "pending"; delete item.validationError;
            delete item.verifiedPublication; delete item.verifiedAt;
            item.syncStatus = "unsynced"; delete item.syncError;
            item.updatedAt = Date.now();
          });
          void validateItem(command.pendingId, nextRevision);
          return;
        }
        case "retry": {
          const existing = state.pending[command.pendingId];
          if (!existing) throw new Error("待验证项不存在");
          if (existing.validation !== "verified") {
            const nextRevision = existing.revision + 1;
            await transaction(doc => {
              const item = doc.pending[command.pendingId];
              if (!item) return;
              item.revision = nextRevision;
              item.validation = "pending"; delete item.validationError;
              item.updatedAt = Date.now();
            });
            void validateItem(command.pendingId, nextRevision);
            return;
          }
          await transaction(doc => {
            const item = doc.pending[command.pendingId];
            if (!item) return;
            if (item.syncStatus === "sync-failed" || item.syncStatus === "unsynced") item.syncStatus = "unsynced";
            delete item.syncError;
            item.updatedAt = Date.now();
          });
          // 手工重试直接提交 Connect，不经市场拉取；市场无响应时不被阻塞。
          // retry 已在命令队列内执行，直接调用核心，不再二次入队。
          await submitManualNow(command.pendingId);
          return;
        }
        case "remove": {
          await settlePreviousBatch();
          const existing = state.pending[command.pendingId];
          if (!existing) return;
          // 只有已同步的来源才向 Connect 提交失效：未同步（验证失败、待同步、
          // 版本较低）的记录在 Connect 侧没有来源，只改 Market 数据。
          if (existing.validation === "verified" && existing.verifiedPublication && existing.syncStatus === "synced") {
            const pubkey = existing.verifiedPublication.appPublicKeyHex;
            const batch = getBatch();
            if (!batch) throw new Error("Connect 不可用，无法移除已验证来源");
            const [result] = await batch.applyChanges([{ kind: "invalidate", sourceId: MANUAL_SOURCE_ID, appPublicKeyHex: pubkey }]);
            ctx.scope.assertActive();
            if (!result || (result.status !== "applied" && result.status !== "unchanged")) {
              throw new Error(result?.reason ?? "来源失效失败");
            }
          }
          await transaction(doc => { delete doc.pending[command.pendingId]; });
          return;
        }
        default: throw new Error("Unknown Market command");
      }
    }
    ctx.handlePrivate(MARKET_PRIVATE_COMMAND, (command, call) => {
      void call;
      // sync-now 与 configure/discard 之外的手工命令进入命令队列；市场拉取
      // 请求挂起时，本页与其他页的手工命令照常执行。
      const work = command.type === "sync-now" || command.type === "configure-market" || command.type === "discard-market"
        ? execute(command as Extract<import("./marketWorkerContract.js").MarketWorkerCommand, { type: string }>)
        : serial(() => execute(command as Extract<import("./marketWorkerContract.js").MarketWorkerCommand, { type: string }>));
      return work.then(value => ({ snapshot: buildSnapshot(), ...(value === undefined ? {} : { value }) }));
    });

    ctx.handlePrivate(MARKET_PRIVATE_EVENTS, (_request, call) => {
      const queue: Array<{ type: "state"; snapshot: MarketWorkerSnapshot }> = [{ type: "state", snapshot: buildSnapshot() }];
      let wake: (() => void) | undefined, closed = false;
      const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      const push = (next: MarketWorkerSnapshot) => {
        if (closed) return;
        const index = queue.findIndex(e => e.type === "state");
        if (index >= 0) queue.splice(index, 1);
        queue.push({ type: "state", snapshot: next });
        wake?.();
      };
      peers.set(id, push);
      const stop = () => { closed = true; peers.delete(id); wake?.(); };
      call.signal.addEventListener("abort", stop, { once: true });
      return (async function* () {
        try {
          while (!closed) {
            if (queue.length) { yield queue.shift()!; continue; }
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
          }
        } finally { call.signal.removeEventListener("abort", stop); if (peers.get(id) === push) peers.delete(id); }
      })();
    });

    traceDev("market", "authority.started", () => ({ instanceId: ctx.consumer.instanceId }));
    return () => { offLoadSettled(); for (const key of [...peers.keys()]) peers.delete(key); };
  });
}
