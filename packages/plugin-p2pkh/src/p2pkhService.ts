// packages/plugin-p2pkh/src/p2pkhService.ts
// P2PKH 服务实现（硬切换 007 + 硬切换 005 + 硬切换 002 收尾）。
// 关键设计：
//   - 默认方法只读当前 active key namespace；不再支持 all-mode 聚合。
//   - transfer / 跨 owner 读路径走 `ensureDbForOwner(publicKeyHex)`：
//     transfer 严格按 session owner 取 DB，listUtxos / listHistory 在
//     filter 传 `ownerPublicKeyHex` 时也按 owner 取 DB。**owner 由调
//     用方提供**，service 层不主动从 active key 推导——在硬门禁下
//     `session.owner === active` 由 protocol / caller 保证。
//   - DB handle 缓存由 p2pkhDb module 的 per-owner map 负责；
//     service 层不持有单一 handle / currentPublicKeyHash。
//   - 确认同步由 Coordinator 的 p2pkh.transactions-sync 统一调度；本 service
//     只负责 namespace、投影读取、选币和旧协议 spend。
//   - key.deleting 时取消资源通道；删除由 keyspace.deleteKey 统一调度。
//   - 硬切换 005：active key 不再有 `mode: "all"` 状态。本 service 所有
//     守护检查只看 `activePublicKeyHex` 是否存在。

import type {
  AssetDataNotifier,
  ProtectedOutpointRegistry,
  KeyIdentity,
  KeyspaceService,
  MessageBus,
  PluginLogger,
  VaultService,
  SessionCoordinatorClient
} from "@keymaster/contracts";
import { ASSET_DATA_NOTIFIER_CAPABILITY } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhBalance,
  P2pkhBalanceBreakdown,
  P2pkhGlobalSettings,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhTransactionFact,
  P2pkhOwnedOutpointProjection,
  P2pkhLocalTransaction,
  P2pkhLocalOutpoint,
  P2pkhService as IP2pkhService,
  P2pkhSyncStatus,
  P2pkhTransferInput,
  P2pkhTransferPreview,
  P2pkhTransferResult,
  P2pkhUtxo,
  UtxoAllocation,
  UtxoAllocationRequest,
  P2pkhUtxoFilter
} from "./p2pkhContracts.js";
import {
  assetIdToNetwork,
  makeResourceId,
  P2PKH_ASSETS,
  requireReadyKey,
  resolveP2pkhFeeRateSatoshisPerKb,
  type ReadyKeyIdentity
} from "./p2pkhContracts.js";
import { createP2pkhDb, disposeP2pkhDb, openP2pkhDb, P2PKH_DB_VERSION, type P2pkhDbBundle, type P2pkhDbHandle } from "./p2pkhDb.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhTransferService, type P2pkhTransferService } from "./p2pkhTransferService.js";
import { allocateUtxos, P2pkhAllocationError } from "./utxoAllocator.js";
import { P2PKH_MSG } from "./p2pkhMessages.js";

export const P2PKH_TASK_TRANSACTIONS_SYNC = "p2pkh.transactions-sync";

/**
 * 硬切换 001：P2PKH 全局产品设置存储键名。
 * 设计缘由：P2pkhGlobalSettings 是产品级显示与同步范围配置，不属于
 * 任何 key 的链上状态，因此放在 localStorage（跨 key 共享）。
 */
const P2PKH_GLOBAL_SETTINGS_KEY = "p2pkh.settings";

/** 进程内的 default；service 启动时会被 real localStorage 值覆盖。 */
function readGlobalSettingsFromStorage(): P2pkhGlobalSettings {
  if (typeof localStorage === "undefined") {
    return { includeTestnet: false };
  }
  try {
    const raw = localStorage.getItem(P2PKH_GLOBAL_SETTINGS_KEY);
    if (!raw) return { includeTestnet: false };
    const obj = JSON.parse(raw) as { includeTestnet?: unknown; feeRateSatoshisPerKb?: unknown };
    const feeRateSatoshisPerKb = normalizeFeeRates(obj.feeRateSatoshisPerKb);
    return { includeTestnet: obj.includeTestnet === true, ...(feeRateSatoshisPerKb ? { feeRateSatoshisPerKb } : {}) };
  } catch {
    return { includeTestnet: false };
  }
}

function normalizeFeeRates(value: unknown): P2pkhGlobalSettings["feeRateSatoshisPerKb"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const rates: Partial<Record<"low" | "medium" | "high", number>> = {};
  for (const tier of ["low", "medium", "high"] as const) {
    const rate = input[tier];
    if (typeof rate === "number" && Number.isInteger(rate) && rate > 0) rates[tier] = rate;
  }
  return Object.keys(rates).length > 0 ? rates : undefined;
}

function sameGlobalSettings(left: P2pkhGlobalSettings, right: P2pkhGlobalSettings): boolean {
  if (left.includeTestnet !== right.includeTestnet) return false;
  const a = resolveP2pkhFeeRateSatoshisPerKb(left);
  const b = resolveP2pkhFeeRateSatoshisPerKb(right);
  return a.low === b.low && a.medium === b.medium && a.high === b.high;
}

function writeGlobalSettingsToStorage(s: P2pkhGlobalSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(P2PKH_GLOBAL_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // swallow: 写入失败不影响内存 cache 与本次流程。
  }
}

export function calculateP2pkhBalanceBreakdown(input: {
  chain: P2pkhOwnedOutpointProjection[];
  locals: P2pkhLocalOutpoint[];
  localTransactions: P2pkhLocalTransaction[];
  claims: P2pkhLocalInputClaim[];
  protectedOutpoints?: Set<string>;
  network?: "main" | "test";
}): P2pkhBalanceBreakdown {
  const chain = input.chain.filter((row) => !input.network || row.network === input.network);
  const localTransactions = new Map(input.localTransactions.map((row) => [row.id, row]));
  const claims = input.claims.filter((row) => !input.network || row.network === input.network);
  const chainValueByOutpoint = new Map(chain.map((row) => [row.outpointKey, row.value]));
  const localSpendableRows = input.locals.filter((row) => row.state === "available" && localTransactions.get(row.submissionId)?.state === "local-confirmed" && (!input.network || localTransactions.get(row.submissionId)?.network === input.network));
  const localValueByOutpoint = new Map(localSpendableRows.map((row) => [`${row.txid}:${row.vout}`, row.value]));
  const claimAmount = (states: string[]) => {
    const seen = new Set<string>();
    return claims.filter((claim) => {
      const key = claim.outpointKey ?? `${claim.txid}:${claim.vout}`;
      if (!states.includes(claim.state) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).reduce((sum, claim) => {
      const key = claim.outpointKey ?? `${claim.txid}:${claim.vout}`;
      return sum + (claim.value ?? chainValueByOutpoint.get(key) ?? localValueByOutpoint.get(key) ?? 0);
    }, 0);
  };
  const activeClaims = claimAmount(["active"]);
  const isolatedClaims = claimAmount(["isolated"]);
  const protectedKeys = input.protectedOutpoints ?? new Set<string>();
  const localConfirmedChange = localSpendableRows.reduce((sum, row) => sum + row.value, 0);
  const claimStatesByOutpoint = new Map<string, Set<string>>();
  for (const claim of claims) {
    const key = claim.outpointKey ?? `${claim.txid}:${claim.vout}`;
    const states = claimStatesByOutpoint.get(key) ?? new Set<string>();
    states.add(claim.state);
    claimStatesByOutpoint.set(key, states);
  }
  const isReserved = (key: string) => protectedKeys.has(key) || Boolean(claimStatesByOutpoint.get(key)?.has("active") || claimStatesByOutpoint.get(key)?.has("isolated"));
  // A protocol spend can create both a protected registry entry and a local
  // input claim for the same outpoint. Deduct the outpoint once, regardless of
  // which protections currently describe it.
  const reservedChain = chain.filter((row) => isReserved(row.outpointKey)).reduce((sum, row) => sum + row.value, 0);
  const reservedLocal = localSpendableRows.filter((row) => isReserved(`${row.txid}:${row.vout}`)).reduce((sum, row) => sum + row.value, 0);
  const blockConfirmed = chain.reduce((sum, row) => sum + row.value, 0);
  return {
    blockConfirmed,
    // Claims over confirmed outpoints reduce the chain projection; claims
    // over local change reduce the local projection. A chained local spend
    // must not subtract its change from blockConfirmed a second time.
    localSpendable: Math.max(0, blockConfirmed - reservedChain + localConfirmedChange - reservedLocal),
    localConfirmedChange,
    pendingInputClaims: activeClaims,
    isolated: isolatedClaims
  };
}

export interface P2pkhServiceDeps {
  vault: VaultService;
  coordinator?: SessionCoordinatorClient;
  messageBus: MessageBus;
  keyspace: KeyspaceService;
  protectedOutpoints?: ProtectedOutpointRegistry;
  assetDataNotifier?: AssetDataNotifier;
  /**
   * 硬切换 002：业务插件注入的 logger。
   * P2PKH 关键轨迹（资源、自愈、broadcast）走统一日志。
   * 不传时不记日志。
   */
  logger?: PluginLogger;
}

export function createP2pkhService(deps: P2pkhServiceDeps): IP2pkhService {
  // 硬切换 002 收尾 + 多 owner 支持：p2pkhDb module 自己用 per-owner
  // map 做缓存（openP2pkhDb / disposeP2pkhDb），service 层不再持有
  // 单一 handle / 单一 currentPublicKeyHash。所有 DB 入口走
  // `ensureDbForOwner(publicKeyHex)`，由 p2pkhDb 内部按 hex 复用。
  // 硬切换 002 收尾：active key 的"内部 id"已删除；signing 走
  // `vault.createActiveKeyCrypto(publicKeyHex)` 唯一入口。`activeKeyId`
  // 硬切换 008 收尾 + 硬切换 003 收尾：activeIdentity 是 ReadyKeyIdentity，
  // publicKeyHex 必填。rebind 时通过 requireReadyKey 断言；写入
  // P2pkhKeyResource 时不需要再 `!`。短公钥不再作为字段持有，UI 需要
  // 展示时由 `formatShortPublicKey(publicKeyHex)` 现算。
  let activeIdentity: ReadyKeyIdentity | undefined;
  // 硬切换 001：进程内 settings 缓存。所有 read 路径在做 testnet 过滤
  // 时都通过 `getCurrentSettings()` 拿值，确保与最近一次写入一致。
  // 跨 tab 变更由 storage 事件回灌到本缓存。
  let cachedSettings: P2pkhGlobalSettings = readGlobalSettingsFromStorage();
  const settingsListeners = new Set<(s: P2pkhGlobalSettings) => void>();
  /**
   * 内部使用：把缓存刷新到 s，并通知订阅者与 messageBus。
   * 调用方需先判断 s 与当前缓存是否相等——不相等才更新，避免重复 trigger。
   */
  function setCachedSettingsAndEmit(next: P2pkhGlobalSettings): void {
    if (sameGlobalSettings(cachedSettings, next)) return;
    cachedSettings = next;
    deps.messageBus.publish(P2PKH_MSG.SETTINGS_CHANGED, next);
    for (const l of [...settingsListeners]) l(next);
  }

  const transfer = createP2pkhTransferService({
    vault: deps.vault,
    protectedOutpoints: deps.protectedOutpoints,
    broadcastPreflight: deps.coordinator ? async ({ network }) => {
      const snapshot = await deps.coordinator!.p2pkhProvidersGet();
      if (snapshot.status !== "ok") throw new Error("P2PKH provider snapshot unavailable");
      const selected = snapshot.value.selection[network].broadcastProviderId;
      const descriptor = snapshot.value.broadcastProviders.find((provider) => provider.id === selected && provider.supportedNetworks.includes(network));
      if (!selected || !descriptor) throw new Error(`No broadcast provider configured for ${network}`);
      return { generation: snapshot.value.selection.generation };
    } : undefined,
    broadcastWithCoordinator: deps.coordinator ? async (input) => {
      return deps.coordinator!.p2pkhBroadcast(input);
    } : undefined,
    messageBus: deps.messageBus,
    assetDataNotifier: deps.assetDataNotifier,
    /**
     * 硬切换 002 收尾 + 多 owner 支持：transfer 走 session owner 的
     * namespace DB。在硬门禁（`keyspace.openKeyStorage` 要求
     * `active === input.publicKeyHex`）下，session owner 在调用
     * transfer 时必须等于 active key——上层 protocol 必须先校验这
     * 个不变量，否则 `ensureDbForOwner` 会被硬门禁挡掉，transfer
     * 安全失败。
     */
    getDb: (publicKeyHex) => ensureDbForOwner(publicKeyHex),
    logger: deps.logger,
    getActiveKey: () => {
      const state = getActiveKeyState();
      if (!state.activePublicKeyHex) {
        throw new Error("Active key is required");
      }
      if (!activeIdentity) {
        throw new Error("Active key is not ready");
      }
      if (activeIdentity.publicKeyHex !== state.activePublicKeyHex) {
        throw new Error("Active key is not ready");
      }
      return activeIdentity;
    },
    /**
     * 硬切换 002 收尾：按 owner public key hex 解析 ReadyKeyIdentity。
     * plugin-protocol 调用 transfer.prepare / transfer.submit 时必传
     * `ownerPublicKeyHex`；transfer 内部用本函数解析出 publicKeyHex
     * 走签名 + 选币 + resourceId 解析。
     *
     * 设计缘由：transfer 的 owner 由调用方（protocol）提供，不在
     * service 层从 active key 取——这是修复"session owner 与 active
     * key DB 不一致"语义的关键。硬门禁（`keyspace.openKeyStorage`）
     * 会保证 `session.ownerPublicKeyHex === active.publicKeyHex`
     * 时才能开库；上层 protocol 在调用 transfer 前必须先做这个校验。
     */
    getKeyForOwner: async (ownerPublicKeyHex: string) => {
      const key = await deps.keyspace.getKey(ownerPublicKeyHex);
      if (!key) {
        throw new Error(`P2PKH owner key not found: ${ownerPublicKeyHex}`);
      }
      if (!key.publicKeyHex) {
        throw new Error(`P2PKH owner key not ready: ${ownerPublicKeyHex}`);
      }
      return {
        publicKeyHex: key.publicKeyHex,
        label: key.label,
        capabilities: key.capabilities,
        createdAt: key.createdAt
      } as ReadyKeyIdentity;
    }
  });

  const statusListeners = new Set<(s: P2pkhSyncStatus) => void>();
  // 硬切换 001：messageBus 订阅的取消句柄收集器；dispose 时统一释放。
  const messageBusUnsubs: Array<() => void> = [];
  function trackSubscribe<TPayload>(type: string, handler: (p: TPayload) => void) {
    const off = deps.messageBus.subscribe<TPayload>(type, handler);
    messageBusUnsubs.push(off);
    return off;
  }
  let status: P2pkhSyncStatus = "idle";

  // 硬切换 001：跨 tab 同步全局设置——其他标签页修改 p2pkh.settings 后
  // 通过 storage 事件回到本服务，本服务刷新缓存 + 通知订阅者 + 按需触发
  // rehydrate / sync。同 tab 写入由 applyGlobalSettings 主动通知，不走
  // storage 事件。
  if (typeof window !== "undefined") {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== P2PKH_GLOBAL_SETTINGS_KEY) return;
      const next = readGlobalSettingsFromStorage();
      const prev = cachedSettings;
      if (sameGlobalSettings(prev, next)) return;
      setCachedSettingsAndEmit(next);
      void deps.coordinator?.p2pkhSettingsUpdate({ includeTestnet: next.includeTestnet });
      if (!prev.includeTestnet && next.includeTestnet) {
        deps.logger?.info({
          scope: "p2pkh.service",
          event: "settings.testnet.enabled.crossTab",
          message: "P2PKH includeTestnet enabled in another tab; rehydrating testnet resources",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null }
        });
        void rehydrateResources()
          .catch((err) => {
            deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
              error: err instanceof Error ? err.message : String(err)
            });
          });
      } else if (prev.includeTestnet && !next.includeTestnet) {
        deps.logger?.info({
          scope: "p2pkh.service",
          event: "settings.testnet.disabled.crossTab",
          message: "P2PKH includeTestnet disabled in another tab; confirmed sync will skip testnet",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null }
        });
      }
    };
    window.addEventListener("storage", onStorage);
    messageBusUnsubs.push(() => window.removeEventListener("storage", onStorage));
  }

  function setStatus(next: P2pkhSyncStatus) {
    status = next;
    for (const l of statusListeners) l(next);
    deps.messageBus.publish(P2PKH_MSG.SYNC, { status: next });
  }

  /**
   * 列出当前 active key 的资源。硬切换 001：受 includeTestnet 控制；
   * includeTestnet=false 时只返回 main 资源（即使 DB 中还有 test
   * dormant cache），Coordinator confirmed sync 因此自然不会处理 testnet。
   */
  /** 硬切换 001：所有 read 路径都必须经过这里拿当前设置。 */
  function getCurrentSettings(): P2pkhGlobalSettings {
    return cachedSettings;
  }

  async function listAllResources(): Promise<P2pkhKeyResource[]> {
    const db = await ensureDb();
    const all = await db.listAddresses();
    const settings = getCurrentSettings();
    if (settings.includeTestnet) return all;
    return all.filter((r) => r.network === "main");
  }

  function getActiveKeyState() {
    return deps.keyspace.active();
  }

  function requireActiveKeyIdentity(): ReadyKeyIdentity {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      throw new Error("Active key is required");
    }
    if (!activeIdentity || activeIdentity.publicKeyHex !== state.activePublicKeyHex) {
      // 硬切换 002 收尾：active identity 不再持有 vault 内部 surrogate id；
      // 签名路径由 `vault.createActiveKeyCrypto(publicKeyHex)` 自行解析。
      throw new Error("Active key is not ready");
    }
    return activeIdentity;
  }

  /**
   * 打开 owner publicKeyHex 的 P2PKH namespace DB。多次打开由
   * p2pkhDb module 内部 per-owner map 缓存负责——service 层不再
   * 持有单一 handle / currentPublicKeyHash。
   *
   * 设计缘由：硬切换 002 收尾 + 多 owner 支持——
   *   - transfer 走 session owner；session owner 在硬门禁下必须
   *     等于 active key，否则 `keyspace.openKeyStorage` 会 fail-closed。
   *   - Coordinator task 走 active key namespace。
   *   - 两种调用方都通过本函数传 owner，p2pkhDb 内部按 hex 复用。
   *
   * 硬切换 003：缺 DB / 缺表 / 版本旧都通过 `keyspace.openKeyStorage({ version, upgrade })`
   * 自动修复到 P2PKH_DB_VERSION；这是 P2PKH 存储自愈的唯一入口。底
   * 层 `openP2pkhDb` 内部不再调用 legacy migration——本系统对旧全局
   * `p2pkh` DB 不做任何迁移，链上真值才是 P2PKH 的恢复路径。
   *
   * 日志：db.opening / db.opened / db.reused 全部由 p2pkhDb module
   * 内部按 hex 缓存命中状态发出；本函数不再额外打日志，避免 cache
   * hit 时误报 db.opening。
   */
  async function ensureDbForOwner(publicKeyHex: string): Promise<P2pkhDbHandle> {
    try {
      const bundle: P2pkhDbBundle = await openP2pkhDb({
        keyspace: deps.keyspace,
        publicKeyHex,
        logger: deps.logger
      });
      return createP2pkhDb(bundle);
    } catch (err) {
      // 硬切换 003：浏览器层面 `indexedDB.open` 失败是真实错误，必须可观测。
      deps.logger?.error({
        scope: "p2pkh.service",
        event: "db.openFailed",
        message: "P2PKH failed to open namespace db",
        data: { publicKeyHex },
        error: { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) }
      });
      throw err;
    }
  }

  /**
   * Active key 的 namespace DB 入口。语义同
   * `ensureDbForOwner(active)`，但额外校验 active 必须就绪。
   * Coordinator task / 业务读路径走这里；transfer 走
   * `ensureDbForOwner(sessionOwner)`。
   */
  async function ensureDb(): Promise<P2pkhDbHandle> {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      throw new Error("Key storage is not ready");
    }
    return ensureDbForOwner(state.activePublicKeyHex);
  }

  async function calculateBalanceBreakdown(network?: "main" | "test"): Promise<P2pkhBalanceBreakdown> {
    const db = await ensureDb();
    const chain = await db.listOwnedOutpoints({ ...(network ? { network } : {}), chainState: "available" });
    const locals = await db.listLocalOutpoints();
    const protectedKeys = new Set((deps.protectedOutpoints?.list({ ...(network ? { network } : {}), publicKeyHex: getActiveKeyState().activePublicKeyHex ?? undefined }) ?? []).map((row) => `${row.txid}:${row.vout}`));
    return calculateP2pkhBalanceBreakdown({ chain, locals, localTransactions: await db.listLocalTransactions(), claims: await db.listLocalInputClaims(), protectedOutpoints: protectedKeys, network });
  }

  /** 切换 active key 后的 hook：重建 identity 缓存。
   * 设计缘由：硬切换 008 收尾 + 硬切换 003 收尾——通过 requireReadyKey
   * 把 KeyIdentity 收窄成 ReadyKeyIdentity，publicKeyHex 必填；写
   * 入 P2pkhKeyResource 等位置时不再需要 `!`。短公钥不再是 contract
   * 字段，UI 需要时由 `formatShortPublicKey(publicKeyHex)` 现算。
   *
   * 硬切换 002 收尾 + 多 owner 支持：DB handle 不再在 service 层缓
   * 存——p2pkhDb module 的 per-owner map 负责 reuse。rebind 仅刷
   * activeIdentity，不预开 DB（DB 在下次 `ensureDb / ensureDbForOwner`
   * 时按需打开）。
   */
  async function rebindActiveKey() {
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) {
      activeIdentity = undefined;
      return;
    }
    const identity = await deps.keyspace.getKey(state.activePublicKeyHex);
    if (!identity) {
      throw new Error("Active key identity not found");
    }
    // requireReadyKey 会断言 publicKeyHex 必填；硬切换 002 收尾后已无
    // `identityStatus = failed | uninitialized` 稳态，调用方
    // (keyspace.listActiveCandidates 选出来的就是 ready) 一般不会触发，
    // 但保留断言作为 fail-closed 保险。
    activeIdentity = requireReadyKey(identity);
  }

  // 监听 keyspace 变化。
  // 硬切换 008 收尾：切 active key 走与 onVaultUnlocked 同构的完整序列——
  // rebind + rehydrate——确保任何路径切到新 active
  // 都不会漏建 P2PKH 资源。
  // 硬切换 001：必须保存取消句柄，dispose 时调用，否则 disable 后旧 service
  // 实例仍会响应 active-key 事件，破坏热卸载语义。
  const keyspaceUnsubs: Array<() => void> = [];
  function trackKeyspaceSubscribe(handler: () => void) {
    const off = deps.keyspace.onActiveKeyChanged(handler);
    keyspaceUnsubs.push(off);
    return off;
  }
  trackKeyspaceSubscribe(() => {
    void (async () => {
      try {
        const state = getActiveKeyState();
        deps.logger?.info({
          scope: "p2pkh.service",
          event: "activeKey.changed",
          message: "P2PKH active key changed; rebinding and rehydrating",
          data: {
            publicKeyHex: state.activePublicKeyHex ?? null,
            label: activeIdentity?.label ?? null
          }
        });
        await rebindActiveKey();
        await rehydrateResources();
      } catch (err) {
        deps.logger?.error({
          scope: "p2pkh.service",
          event: "activeKey.changeFailed",
          message: "P2PKH onActiveChange handler failed",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null },
          error: { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) }
        });
      }
    })();
  });

  // 硬切换 016：keyspace 在随后删除 namespace DB 前会等待本 handler 返回；
  // 必须同步丢弃本模块 owner cache，不能等 key.deleted（那时 deleteDatabase
  // 已经可能因 cached handle 进入 blocked）。key.deleted 仍保留幂等兜底。
  trackSubscribe<{ publicKeyHex: string }>("key.deleting", (payload) => {
    try {
      disposeP2pkhDb(payload.publicKeyHex);
    } catch {
      // key.deleted handler below remains an idempotent safety net.
    }
  });
  trackSubscribe<{ publicKeyHex: string }>("key.deleted", async (payload) => {
    try {
      const resources = await listAllResources().catch(() => []);
      void resources;
    } catch (err) {
      console.error("P2PKH key.deleted handler failed", err);
    }
    // 硬切换 002 收尾 + 多 owner 支持：只关掉被删 key 的 cached handle，
    // 其它 owner 的 namespace DB 不动（不影响它们的资源 / UTXO）。
    try {
      disposeP2pkhDb(payload.publicKeyHex);
    } catch {
      // swallow
    }
  });

  async function getOrCreateAddress(network: "main" | "test"): Promise<P2pkhKeyResource | null> {
    const db = await ensureDb();
    const resourceId = makeResourceId(network);
    const existing = await db.getResource(resourceId);
    if (existing) {
      deps.logger?.info({
        scope: "p2pkh.service",
        event: "address.reused",
        message: "P2PKH resource already exists for active key",
        data: {
          resourceId,
          network,
          publicKeyHex: existing.publicKeyHex,
          address: existing.address,
          created: false
        }
      });
      return existing;
    }
    const key = requireActiveKeyIdentity();
    const crypto = await resolveActiveKeyCrypto(deps.vault, key.publicKeyHex);
    const { address } = await crypto.deriveP2pkhAddress({
      publicKeyHex: key.publicKeyHex,
      network
    });
    const resource: P2pkhKeyResource = {
      resourceId,
      publicKeyHex: key.publicKeyHex,
      label: key.label,
      address,
      network,
      createdAt: key.createdAt,
      lastSyncedAt: undefined,
      generation: 0
    };
    await db.putAddress(resource);
    deps.messageBus.publish(P2PKH_MSG.ADDRESS_DERIVED, {
      publicKeyHex: key.publicKeyHex,
      network,
      address,
      generation: 0
    });
    deps.logger?.info({
      scope: "p2pkh.service",
      event: "address.created",
      message: "P2PKH resource created via self-heal for active key",
      data: {
        resourceId,
        network,
        publicKeyHex: key.publicKeyHex,
        address,
        created: true
      }
    });
    return resource;
  }

  // Confirmed synchronization is owned by the Coordinator's single
  // `p2pkh.transactions-sync` task. This service deliberately registers no
  // provider-specific background task and never calls a confirmed provider.

  // 监听 vault 锁定/解锁。
  trackSubscribe("vault.locked", () => {
    onVaultLocked();
  });
  trackSubscribe("vault.unlocked", () => {
    void onVaultUnlocked();
  });

  /**
   * 硬切换 004：onVaultLocked 不再承担"正确性依赖于我先 cancel"的
   * 职责——锁屏前的任务退出屏障由 keyspace（quiesceNamespace ->
   * background.cancelByKey + await 旧 task 退出）统一掌控，vault.locked
   * 是"平台资源已停稳"的事件。
   *
   * 本方法只做本地缓存 / 句柄释放：
   *   - status 收回 idle；
   *   - 释放所有 owner 的 p2pkh DB handle（lock 后没有任何 owner 可
   *     访问，硬门禁会一律 fail-closed，所以可以全关）；
   *   - 清空 activeIdentity。
   *
   * 故意不调 backgroundService.cancel —— 该调用在旧实现里是 fire-and-forget
   * 保险，但它的正确性依赖于"keyspace 没在切换 active 前先 cancel"，
   * 而新链路已把 cancel 提前到 keyspace.onVaultLocked()，这里再 cancel
   * 一次既冗余又可能掩盖"边界外的 cancel 被依赖"的回归。
   */
  function onVaultLocked() {
    setStatus("idle");
    disposeP2pkhDb();
    activeIdentity = undefined;
  }

  async function onVaultUnlocked() {
    deps.logger?.info({
      scope: "p2pkh.service",
      event: "vault.unlocked",
      message: "P2PKH reacting to vault unlocked; rebinding and rehydrating",
      data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null }
    });
    try {
      await rebindActiveKey();
      await rehydrateResources();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
      deps.logger?.warn({
        scope: "p2pkh.service",
        event: "vault.unlocked.rehydrateFailed",
        message: "P2PKH vault unlocked rehydrate failed",
        data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null },
        error: { name: err instanceof Error ? err.name : "Error", message: msg }
      });
    }
  }

  /**
   * 为当前 active key 补齐 main/test 资源（受 includeTestnet 控制）。
   * 硬切换 001：includeTestnet=false 时不创建 test 资源；Coordinator
   * confirmed sync 也会因为 `listAllResources` 不返回 test 而自然跳过 testnet。
   * 重新开启 includeTestnet=true 时也会调用本方法（idempotent：已存在的
   * resource 不会被覆盖）。
   *
   * 硬切换 003：手工同步 / rehydrate 触发同步 / settings 触发同步前都必须
   * 调用本方法——这是当前 active key 在链下缓存缺失时唯一不依赖用户手工
   * 修库的自愈路径。同时本方法必须输出 info 日志，明确写出：
   *   - 当前 active key 是谁；
   *   - includeTestnet 是否开启；
   *   - 本次尝试补的网络；
   *   - 哪些 resource 已存在；
   *   - 哪些 resource 是本次新建。
   * 这样"为什么 confirmed sync 没有 resource"以及"为什么 sync 仍然 0
   * resource"在日志上能直接看出来。
   */
  async function rehydrateResources(): Promise<void> {
    if (deps.vault.status() !== "unlocked") return;
    const state = getActiveKeyState();
    if (!state.activePublicKeyHex) return;
    if (!activeIdentity) return;
    const includeTestnet = getCurrentSettings().includeTestnet;
    const targetNetworks: Array<"main" | "test"> = includeTestnet ? ["main", "test"] : ["main"];
    deps.logger?.info({
      scope: "p2pkh.service",
      event: "rehydrate.started",
      message: "P2PKH rehydrate started for active key",
      data: {
        publicKeyHex: state.activePublicKeyHex,
        includeTestnet,
        targetNetworks
      }
    });
    const existingResources: string[] = [];
    const createdResources: string[] = [];
    let rehydrateError: unknown;
    try {
      const db = await ensureDb();
      const mainId = makeResourceId("main");
      const mainExisted = Boolean(await db.getResource(mainId));
      await getOrCreateAddress("main");
      // getOrCreateAddress 在已存在时只 putAddress 不会变 ——
      // 通过调用前是否存在判断是否本次新建，避免误把刚 putAddress 的
      // 行误判成"新建"。
      if (mainExisted) existingResources.push(mainId);
      else createdResources.push(mainId);
      if (includeTestnet) {
        const testId = makeResourceId("test");
        const testExisted = Boolean(await db.getResource(testId));
        await getOrCreateAddress("test");
        if (testExisted) existingResources.push(testId);
        else createdResources.push(testId);
      }
    } catch (err) {
      rehydrateError = err;
    }
    if (rehydrateError) {
      const msg = rehydrateError instanceof Error ? rehydrateError.message : String(rehydrateError);
      deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
        error: msg
      });
      deps.logger?.warn({
        scope: "p2pkh.service",
        event: "rehydrate.failed",
        message: "P2PKH rehydrate failed",
        data: {
          publicKeyHex: state.activePublicKeyHex,
          includeTestnet
        },
        error: { name: rehydrateError instanceof Error ? rehydrateError.name : "Error", message: msg }
      });
      return;
    }
    deps.logger?.info({
      scope: "p2pkh.service",
      event: "rehydrate.completed",
      message: "P2PKH rehydrate completed",
      data: {
        publicKeyHex: state.activePublicKeyHex,
        includeTestnet,
        existingResources,
        createdResources
      }
    });

    // 发布 resource data-changed 通知：P2PKH 地址已就绪。
    // 设计缘由：token 插件（BSV-21 / STAS）订阅此事件来触发同步，
    // 确保在 P2PKH 地址就绪后才拉取 token 持仓，避免产生空快照。
    if (deps.assetDataNotifier) {
      deps.assetDataNotifier.emit({
        providerId: "p2pkh",
        publicKeyHex: state.activePublicKeyHex,
        revision: Date.now(),
        kinds: ["resource"],
      });
    }
  }

  trackSubscribe(P2PKH_MSG.TRANSFER_BROADCAST, () => undefined);

  // data-changed 订阅者集合。
  const dataChangedListeners = new Set<() => void>();

  // 订阅 assetDataNotifier：收到 p2pkh provider 的 data-changed 后通知本地订阅者。
  if (deps.assetDataNotifier) {
    messageBusUnsubs.push(
      deps.assetDataNotifier.subscribe((event) => {
        if (event.providerId === "p2pkh") {
          for (const l of dataChangedListeners) {
            try { l(); } catch { /* 静默 */ }
          }
        }
      })
    );
  }

  return {
    syncStatus() {
      return status;
    },
    onSyncStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    onDataChanged(handler) {
      dataChangedListeners.add(handler);
      return () => dataChangedListeners.delete(handler);
    },

    /**
     * 硬切换 001：余额每次从当前 UTXO 快照现算，不再读取任何余额缓存。
     * 不允许引入"为了性能保留最近一次余额"的内存缓存——余额实时性优先。
     * 若 includeTestnet=false，则 testnet 资产直接返回 { total: 0 }。
     */
    async getAssetBalance(assetId) {
      const network = assetIdToNetwork(assetId);
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && network === "test") {
        return { total: 0, breakdown: { blockConfirmed: 0, localSpendable: 0, localConfirmedChange: 0, pendingInputClaims: 0, isolated: 0 } };
      }
      const breakdown = await calculateBalanceBreakdown(network);
      return { total: breakdown.localSpendable, breakdown };
    },
    async getResourceBalance(resourceId) {
      const settings = getCurrentSettings();
      // 硬切换 001：includeTestnet=false 时 testnet 资源视为不存在。
      // 通过 resourceId 前缀识别 testnet（resourceId = "p2pkh:test"）。
      if (!settings.includeTestnet && /:test$/.test(resourceId)) {
        return { total: 0 };
      }
      const network = /:test$/.test(resourceId) ? "test" : "main";
      const breakdown = await calculateBalanceBreakdown(network);
      return { total: breakdown.localSpendable, breakdown };
    },

    /**
     * 硬切换 001：list 路径必须在 service 层做 includeTestnet 过滤。
     * 设计缘由：仅靠 UI 隐藏按钮不能阻止"全部"视图或直链 URL 访问
     * dormant testnet 缓存；所有 read 路径都按当前 settings 过滤。
     */
    async listResources(assetId) {
      const db = await ensureDb();
      const all = await db.listAddresses();
      const settings = getCurrentSettings();
      // includeTestnet=false 时直接屏蔽 testnet 资源（即使 DB 还在）。
      const filtered = settings.includeTestnet
        ? all
        : all.filter((r) => r.network === "main");
      if (!assetId) return filtered;
      const network = assetIdToNetwork(assetId);
      // 即便 assetId === "bsvtest"，includeTestnet=false 时也返回空。
      if (!settings.includeTestnet && network === "test") return [];
      return filtered.filter((r) => r.network === network);
    },
    async listUtxos(filter) {
      // 硬切换 002 收尾：owner 感知读路径。filter 传 `ownerPublicKeyHex`
      // 时严格按该 owner 走 namespace DB（protocol feepool 等跨 owner
      // 调用必须传）；未传时仅作 UI 本地读路径兜底（= 当前 active key
      // namespace），**不**作为对外契约——见 P2pkhUtxoFilter 注释。
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const all = await db.listUtxos();
      const settings = getCurrentSettings();
      const withoutTestnet = settings.includeTestnet
        ? all
        : all.filter((u) => u.network === "main");
      const filtered = filterUtxos(withoutTestnet, filter);
      return excludeProtectedUtxos(filtered, deps.protectedOutpoints, filter?.ownerPublicKeyHex);
    },
    async listUtxosRaw(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const all = await db.listUtxos();
      const settings = getCurrentSettings();
      const withoutTestnet = settings.includeTestnet
        ? all
        : all.filter((u) => u.network === "main");
      return filterUtxos(withoutTestnet, filter);
    },
    async listTransactionFacts(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      const rows = await db.listTransactionFacts({ network, resourceId: filter?.resourceId, limit: filter?.limit });
      return getCurrentSettings().includeTestnet ? rows : rows.filter((row) => row.network === "main");
    },
    async listOwnedOutpoints(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      const rows = await db.listOwnedOutpoints({ network, resourceId: filter?.resourceId, limit: filter?.limit });
      return getCurrentSettings().includeTestnet ? rows : rows.filter((row) => row.network === "main");
    },
    async listTransactionFactsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      const page = await db.listTransactionFactsPage({ network, resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      return { items: getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main"), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listOwnedOutpointsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      const page = await db.listOwnedOutpointsPage({ network, resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      return { items: getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main"), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listOwnedOutpointValues(resourceId, outpointKeys) {
      const db = await ensureDb();
      return db.listOwnedOutpointValues(resourceId, outpointKeys);
    },
    async listLocalTransactions(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const rows = await db.listLocalTransactions(filter?.resourceId, filter?.limit);
      return getCurrentSettings().includeTestnet ? rows.filter((row) => !filter?.assetId || row.network === assetIdToNetwork(filter.assetId)) : rows.filter((row) => row.network === "main");
    },
    async listLocalOutpoints(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const rows = await db.listLocalOutpoints(filter?.resourceId, filter?.limit);
      return getCurrentSettings().includeTestnet ? rows : rows.filter((row) => row.id.includes(":main:"));
    },
    async abortUnattemptedLocalSubmission(input) {
      const db = await ensureDbForOwner(input.ownerPublicKeyHex);
      await db.abortUnattemptedLocalSubmission({ submissionId: input.submissionId, reason: input.reason, requestKind: "initial" });
      deps.assetDataNotifier?.emit({ providerId: "p2pkh", publicKeyHex: input.ownerPublicKeyHex, revision: Date.now(), kinds: ["utxo", "submission", "claim"] });
    },
    async listLocalTransactionsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const page = await db.listLocalTransactionsPage({ resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      const items = getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main");
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      return { items: network ? items.filter((row) => row.network === network) : items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listLocalOutpointsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const page = await db.listLocalOutpointsPage({ resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      const items = getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.id.includes(":main:"));
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      return { items: network ? items.filter((row) => row.resourceId === `p2pkh:${network}`) : items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async listLocalInputClaimsPage(filter) {
      const ownerHex = filter?.ownerPublicKeyHex;
      const db = ownerHex ? await ensureDbForOwner(ownerHex) : await ensureDb();
      const page = await db.listLocalInputClaimsPage({ resourceId: filter?.resourceId, cursor: filter?.cursor, limit: filter?.limit });
      const items = getCurrentSettings().includeTestnet ? page.items : page.items.filter((row) => row.network === "main");
      const network = filter?.assetId ? assetIdToNetwork(filter.assetId) : undefined;
      return { items: network ? items.filter((row) => row.network === network) : items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    },
    async getBalanceBreakdown(network) {
      return calculateBalanceBreakdown(network);
    },
    async listLocalInputClaims(resourceId?: string, limit?: number) {
      const db = await ensureDb();
      const all = resourceId && typeof db.listLocalInputClaimsByResource === "function"
        ? await db.listLocalInputClaimsByResource(resourceId, limit)
        : await db.listLocalInputClaims(limit);
      const settings = getCurrentSettings();
      return settings.includeTestnet
        ? all.filter((r) => !resourceId || r.resourceId === resourceId)
        : all.filter((r) => r.network === "main" && (!resourceId || r.resourceId === resourceId));
    },

    async allocateUtxos(request) {
      if (!request.assetId || !(request.assetId in P2PKH_ASSETS)) {
        throw new Error("P2PKH provider requires an assetId");
      }
      // 硬切换 001：includeTestnet=false 时禁止 testnet 选币。
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && request.assetId === "bsvtest") {
        throw new P2pkhAllocationError({
          required: request.amountSatoshis,
          available: 0,
          feeReserve: request.feeReserveSatoshis ?? 0,
          reason: "no-utxos"
        });
      }
      const db = await ensureDb();
      const all = await db.listUtxos();
      const withoutTestnet = settings.includeTestnet
        ? all
        : all.filter((u) => u.network === "main");
      const filtered = filterUtxos(withoutTestnet, {
        assetId: request.assetId
      });
      const resource = (await db.listAddresses()).find((row) => row.network === assetIdToNetwork(request.assetId));
      const localTransactions = typeof db.listLocalTransactions === "function" ? await db.listLocalTransactions(resource?.resourceId) : [];
      const localTransactionIds = new Set(localTransactions.filter((row) => row.state === "local-confirmed").map((row) => row.id));
      const localCandidates: P2pkhUtxo[] = resource && typeof db.listLocalOutpoints === "function"
        ? (await db.listLocalOutpoints(resource.resourceId)).filter((row) => row.state === "available" && localTransactionIds.has(row.submissionId)).map((row) => ({ id: row.id, resourceId: row.resourceId, publicKeyHex: resource.publicKeyHex, network: resource.network, address: resource.address, txid: row.txid, vout: row.vout, value: row.value, script: row.scriptHex, status: "unconfirmed", isSpentInMempoolTx: false, syncedAt: row.updatedAt }))
        : [];
      const reservations = await db.listLocalInputClaims();
      const reserved = new Set(
        reservations.filter((r) => r.state === "active" || r.state === "isolated").map((r) => `${r.txid}:${r.vout}`)
      );
      const protectedFiltered = [...excludeProtectedUtxos(filtered, deps.protectedOutpoints), ...excludeProtectedUtxos(localCandidates, deps.protectedOutpoints)];
      const candidates = protectedFiltered.filter((u) => !reserved.has(`${u.txid}:${u.vout}`));
      const result = allocateUtxos(candidates, request);
      if (result.ok) return result.allocation;
      throw new P2pkhAllocationError(result.error);
    },

    prepareTransfer: (input) => {
      // 硬切换 002 收尾：`ownerPublicKeyHex` 是**强制**输入字段
      // (plugin-protocol 调用时永远传 session 绑定 owner)。系统不再
      if (!input.ownerPublicKeyHex) {
        return Promise.reject(
          new Error("P2PKH prepareTransfer requires ownerPublicKeyHex")
        );
      }
      // 硬切换 001：includeTestnet=false 时禁止 testnet 转账。
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && input.assetId === "bsvtest") {
        return Promise.reject(new Error("Testnet is not enabled in P2PKH settings"));
      }
      return transfer.prepare(input);
    },
    submitTransfer: (preview) => {
      // 硬切换 002 收尾：submit 阶段必须能解析出 owner——preview 上若
      // 没带 ownerPublicKeyHex 即拒绝。**不**做静默 fallback。
      if (!preview.ownerPublicKeyHex) {
        return Promise.reject(
          new Error("P2PKH submitTransfer requires ownerPublicKeyHex")
        );
      }
      const settings = getCurrentSettings();
      if (!settings.includeTestnet && preview.assetId === "bsvtest") {
        return Promise.reject(new Error("Testnet is not enabled in P2PKH settings"));
      }
      return transfer.submit(preview);
    },

    /**
     * 硬切换 001：读取当前全局产品设置。
     * 设计缘由：返回的是 service 维护的进程内缓存（与最近一次写入、
     * 跨 tab storage 事件同步后的值一致），所有 read 路径都通过
     * getCurrentSettings() 拿值，避免读到的状态与过滤逻辑不一致。
     */
    getGlobalSettings() {
      return cachedSettings;
    },
    /**
     * 订阅全局设置变更（同标签页）。
     * 设计缘由：localStorage 的 `storage` 事件在同标签页不会触发，
     * 写入路径必须主动通知订阅者；本接口就是这条主动通知链路。
     */
    onGlobalSettingsChange(handler) {
      settingsListeners.add(handler);
      return () => settingsListeners.delete(handler);
    },
    /**
     * 应用新的全局设置：
     * 1. 写 localStorage；
     * 2. 刷新进程内缓存；
     * 3. 通知订阅者、广播 messageBus；
     * 4. includeTestnet 由 false → true 时立即触发 rehydrate + recent +
     *    confirmed sync，让 testnet 重新进入运行范围。
     * 5. includeTestnet 由 true → false 时不需要清理 dormant cache；
     *    后续 Coordinator confirmed sync 通过 `listAllResources()` 自然不再
     *    处理 testnet，read 路径通过 service 过滤也不再暴露 testnet。
     */
    async applyGlobalSettings(settings) {
      const prev = cachedSettings;
      if (deps.coordinator) {
        const result = await deps.coordinator.p2pkhSettingsUpdate({ includeTestnet: settings.includeTestnet });
        if (result.status !== "accepted" && result.status !== "ok") throw new Error("Coordinator rejected P2PKH network settings");
      }
      writeGlobalSettingsToStorage(settings);
      // setCachedSettingsAndEmit 内部做相等比较，相等时不会 emit 也不会
      // 触发副作用。
      setCachedSettingsAndEmit(settings);
      if (!prev.includeTestnet && settings.includeTestnet) {
        // 重新开启 testnet：立刻纳入运行范围。
        deps.logger?.info({
          scope: "p2pkh.service",
          event: "settings.testnet.enabled",
          message: "P2PKH includeTestnet enabled; rehydrating testnet and triggering sync",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null }
        });
        try {
          await rehydrateResources();
        } catch (err) {
          deps.messageBus.publish(P2PKH_MSG.REHYDRATE_ERROR, {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      } else if (prev.includeTestnet && !settings.includeTestnet) {
        // 关闭 testnet：取消可能正在跑的 recent（仅对 test 资源有效；
        // recent 自身的 resource list 由 listAllResources 提供，已经不会
        // 返回 test），并强制再触发一次 recent 让用户尽快看到 main 刷新。
        deps.logger?.info({
          scope: "p2pkh.service",
          event: "settings.testnet.disabled",
          message: "P2PKH includeTestnet disabled; confirmed sync will skip testnet",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null }
        });
      }
    },

    async onKeyImported(publicKeyHex: string) {
      // 当前 namespace 是 active key；rehydrate 会为 active key 补齐资源。
      // 硬切换 002 收尾：入参改为 publicKeyHex；plugin 内部用对应 hex
      // 决定是否触发同步（本参数当前仅供日志使用，未来按 hex 决定
      // 同步范围时再扩展）。
      deps.logger?.info({
        scope: "p2pkh.service",
        event: "key.imported",
        message: "P2PKH reacting to key import; rehydrating active key",
        data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null, importedHex: publicKeyHex }
      });
      try {
        await rehydrateResources();
      } catch (err) {
        deps.logger?.error({
          scope: "p2pkh.service",
          event: "key.imported.failed",
          message: "P2PKH onKeyImported failed",
          data: { publicKeyHex: getActiveKeyState().activePublicKeyHex ?? null },
          error: { name: err instanceof Error ? err.name : "Error", message: err instanceof Error ? err.message : String(err) }
        });
      }
    },
    async onKeyRemoved(publicKeyHex: string) {
      // 实际删除由 keyspace.deleteKey 统一调度；这里只清理协调器 lane。
      // 入参为被删 key 的 publicKeyHex；目前只用于日志与扩展点。
      try {
        const resources = await listAllResources().catch(() => []);
        void resources;
      } catch (err) {
        console.error("P2PKH onKeyRemoved failed", err, publicKeyHex);
      }
    },
    onVaultLocked,
    onVaultUnlocked,
    async rehydrate() {
      await rebindActiveKey();
      await rehydrateResources();
    },
    /**
     * 硬切换 001：宿主 teardown 时调用。幂等。
     * 回收：取消 vault / key 事件订阅、keyspace active 订阅、释放同步协调器、丢弃 db handle。
     */
    dispose() {
      for (const off of messageBusUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      messageBusUnsubs.length = 0;
      // 硬切换 001 补：keyspace.onActiveChange 句柄。
      for (const off of keyspaceUnsubs) {
        try {
          off();
        } catch {
          // swallow
        }
      }
      keyspaceUnsubs.length = 0;
      // 释放 db handle
      try {
        disposeP2pkhDb();
      } catch {
        // swallow
      }
    }
  };
}

async function resolveActiveKeyCrypto(vault: VaultService, publicKeyHex: string) {
  const anyVault = vault as VaultService & {
    createActiveKeyCrypto?: (hex: string) => Promise<{
      deriveP2pkhAddress: (input: { publicKeyHex: string; network: "main" | "test" }) => Promise<{
        publicKeyHex: string;
        address: string;
      }>;
    }>;
  };
  if (typeof anyVault.createActiveKeyCrypto === "function") {
    return await anyVault.createActiveKeyCrypto(publicKeyHex);
  }
  throw new Error("Vault does not provide createActiveKeyCrypto");
}

function filterUtxos<T extends { network: "main" | "test"; publicKeyHex: string; resourceId: string }>(
  rows: T[],
  filter: P2pkhUtxoFilter | undefined
): T[] {
  if (!filter) return rows;
  return rows.filter((r) => {
    if (filter.assetId) {
      const net = assetIdToNetwork(filter.assetId);
      if (r.network !== net) return false;
    }
    // 硬切换 002 收尾：owner 真值 = publicKeyHex；vault 不再保留
    // 任何 key 域 surrogate id 维度。
    if (filter.ownerPublicKeyHex && r.publicKeyHex !== filter.ownerPublicKeyHex) {
      return false;
    }
    if (filter.resourceId && r.resourceId !== filter.resourceId) return false;
    return true;
  });
}

function excludeProtectedUtxos<T extends { network: "main" | "test"; publicKeyHex: string; txid: string; vout: number }>(
  rows: T[],
  registry: ProtectedOutpointRegistry | undefined,
  publicKeyHex?: string
): T[] {
  if (!registry) return rows;
  return rows.filter((row) => !registry.isProtected({ txid: row.txid, vout: row.vout, network: row.network, publicKeyHex }));
}

void (null as unknown as P2pkhTransferService);
void (null as unknown as P2pkhBalance);
void (null as unknown as P2pkhUtxo);
void (null as unknown as UtxoAllocation);
void (null as unknown as UtxoAllocationRequest);
void (null as unknown as P2pkhLocalInputClaim);
void (null as unknown as P2pkhTransferInput);
void (null as unknown as P2pkhTransferPreview);
void (null as unknown as P2pkhTransferResult);
void (null as unknown as P2pkhAssetId);
