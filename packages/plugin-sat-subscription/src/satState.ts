// SatSubscription owner-scoped 状态机。
//
// 这里不做网络请求，也不保存私钥或 App 明文。网络层只通过这些方法提交
// “已观察到”的结果；desired 与 observed 永远分开，避免把本地意图误当远端真值。

import type {
  SatCollectResult,
  SatErrorCode,
  SatOwnerSupplierSettingsV1,
  SatSpiInformation,
  SatSubscriptionState,
  SatSupplierConfigV1,
  SatSupplierRuntimeView
} from "@keymaster/contracts";

const MAX_AUDIT_ENTRIES = 256;
const MAX_DEDUP_ENTRIES = 2048;
const MAX_ACK_SUPPLIERS_PER_MESSAGE = 16;
const MAX_STATE_WIRE_BYTES = 1024 * 1024;
const MAX_UINT64 = 0xffffffffffffffffn;

function nextSupplierGeneration(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next)) throw new Error("supplierGeneration exhausted");
  return next;
}

function assertBoundedWire(value: Uint8Array, field: string): void {
  if (value.byteLength > MAX_STATE_WIRE_BYTES) throw new Error(`${field} exceeds the local limit`);
}

/** SSP 扣费或未知结果的有界审计记录。 */
export interface SatFeeAuditEntry {
  /** 本地递增审计编号。 */
  auditId: string;
  /** 动作类型。 */
  action: "publish" | "subscribe" | "unsubscribe" | "subscriptions" | "ack";
  /** 本地供应商编号。 */
  supplierId: string;
  /** SSP 精确 channel；ACK 也记录实际 channel。 */
  channel: string;
  /** SSP request id 的小写 hex。 */
  requestIdHex: string;
  /** 供应商返回的精确扣费字符串。 */
  chargedAmount: string;
  /** 结果分类。 */
  result: "ok" | "error" | "unknown_result";
  /** 稳定错误码。 */
  errorCode?: SatErrorCode;
  /** 创建时间。 */
  createdAtMs: number;
}

/** Channel 去重关系；只保存密文摘要，不保存 App 明文或完整密文。 */
export interface SatChannelDedupEntry {
  /** protocol/from/message_id 的稳定组合键。 */
  dedupKey: string;
  /** 入站或出站方向；出站记录用于匹配回来的 ACK。 */
  direction: "inbound" | "outbound";
  /** Channel 签名消息内容的 SHA-256 摘要，不是外层随机密文摘要。 */
  contentDigestHex: string;
  /** Channel sender 公钥。 */
  fromPublicKeyHex: string;
  /** Channel recipient 公钥。 */
  recipientPublicKeyHex: string;
  /** Channel message_id 的 canonical base64url。 */
  messageIdBase64Url: string;
  /** 原始 ingress Supplier，用于 ACK 原路发送。 */
  ingressSupplierId: string;
  /** 首次可靠持久化时间。 */
  firstPersistedAtMs: number;
  /** 当前 ACK 状态。 */
  ackState: "pending" | "acknowledged" | "failed" | "conflict";
  /** 最近一次 ACK 稳定错误。 */
  ackErrorCode?: SatErrorCode;
  /** 每个实际 ingress 的独立 ACK 状态；旧快照会自动迁移。 */
  ackBySupplier?: SatChannelAckDelivery[];
}

/** 单个 Supplier ingress 的 ACK 状态。 */
export interface SatChannelAckDelivery {
  /** 实际收到该 Deliver 的本地 Supplier。 */
  supplierId: string;
  /** 该 ingress 的 Channel ACK 状态。 */
  state: "pending" | "acknowledged" | "failed" | "conflict";
  /** 最近一次 ACK 稳定错误。 */
  errorCode?: SatErrorCode;
  /** 最近一次更新的本地时间。 */
  updatedAtMs: number;
}

/** 单个 Supplier 某频道的本地/远端订阅记录。 */
export interface SatSubscriptionRecord {
  /** Supplier 编号。 */
  supplierId: string;
  /** 精确 channel，不裁剪、不 Unicode 归一化。 */
  channel: string;
  /** 本地 desired 状态。 */
  desired: SatSubscriptionState;
  /** 最近一次远端 observed 状态。 */
  observed: SatSubscriptionState;
  /** 最近一次远端返回的订阅时间。 */
  observedAtMs: number;
  /** observed 来源。 */
  observedSource: "action" | "refresh" | "none";
  /** 最近一次稳定错误。 */
  errorCode: SatErrorCode | null;
}

/** Worker 运行态快照；Repository 只从中提取本地设置字段。 */
export interface SatSubscriptionStateSnapshot {
  /** 当前 owner。 */
  ownerPublicKeyHex: string | null;
  /** Supplier catalog 配置代际；每次供应商新增/修改/删除递增。 */
  supplierGeneration: number;
  /** 当前供应商目录。 */
  suppliers: SatSupplierConfigV1[];
  /** owner 选择。 */
  ownerSettings: SatOwnerSupplierSettingsV1 | null;
  /** owner 的订阅状态。 */
  subscriptions: SatSubscriptionRecord[];
  /** 有界扣费审计。 */
  feeAudit: SatFeeAuditEntry[];
  /** 有界 Channel 去重关系。 */
  channelDedup: SatChannelDedupEntry[];
  /** 有界 SPI 信息缓存。 */
  spiInformation: SatSpiInformation[];
  /** Collect 终态摘要。 */
  collectResults: SatCollectResult[];
}

/** 允许状态存储接入 owner setting 文件 Repository；纯测试可省略。 */
export interface SatSubscriptionStatePersistence {
  save(snapshot: SatSubscriptionStateSnapshot): Promise<void>;
}

export interface SatSubscriptionStateStore {
  readonly ownerPublicKeyHex: string | null;
  /** 读取当前 Supplier catalog 配置代际。 */
  supplierGeneration(): number;
  snapshot(): SatSubscriptionStateSnapshot;
  listSuppliers(): SatSupplierConfigV1[];
  getSupplier(supplierId: string): SatSupplierConfigV1 | undefined;
  upsertSupplier(config: SatSupplierConfigV1): Promise<void>;
  deleteSupplier(supplierId: string): Promise<void>;
  getOwnerSettings(): SatOwnerSupplierSettingsV1 | null;
  setOwnerSettings(settings: SatOwnerSupplierSettingsV1): Promise<void>;
  setDesiredSubscription(input: { supplierId: string; channel: string; state: SatSubscriptionState; errorCode?: SatErrorCode | null }): Promise<void>;
  setObservedSubscription(input: { supplierId: string; channel: string; state: SatSubscriptionState; source: "action" | "refresh"; errorCode?: SatErrorCode | null; observedAtMs?: number }): Promise<void>;
  listSubscriptions(supplierId?: string): SatSubscriptionRecord[];
  recordFee(input: Omit<SatFeeAuditEntry, "auditId" | "createdAtMs"> & { createdAtMs?: number }): Promise<void>;
  listFeeAudit(limit?: number): SatFeeAuditEntry[];
  rememberChannel(input: Omit<SatChannelDedupEntry, "firstPersistedAtMs" | "ackState"> & { firstPersistedAtMs?: number }): Promise<"new" | "duplicate" | "conflict">;
  updateChannelAck(input: { dedupKey: string; supplierId?: string; state: SatChannelDedupEntry["ackState"]; errorCode?: SatErrorCode }): Promise<void>;
  getChannel(dedupKey: string): SatChannelDedupEntry | undefined;
  putSpiInformation(value: SatSpiInformation): Promise<void>;
  getSpiInformation(supplierId: string): SatSpiInformation | undefined;
  putCollectResult(value: SatCollectResult): Promise<void>;
  getCollectResult(requestIdHex: string): SatCollectResult | undefined;
  supplierViews(): SatSupplierRuntimeView[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function subscriptionKey(supplierId: string, channel: string): string {
  return `${supplierId}\u0000${channel}`;
}

function lastMatching<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

/** Bound retention, recovery readiness and cross-record business relationships. */
function applyStatePolicies(input: SatSubscriptionStateSnapshot, ownerPublicKeyHex: string | null): SatSubscriptionStateSnapshot {
  const supplierGeneration = input.supplierGeneration;
  const suppliers = input.suppliers.map(item => clone(item));
  const supplierIds = new Set(suppliers.map((item) => item.supplierId));
  if (supplierIds.size !== suppliers.length) throw new Error("supplier catalog contains duplicate ids");
  const ownerSettings = input.ownerSettings ? clone(input.ownerSettings) : null;
  if (ownerSettings && ownerSettings.ownerPublicKeyHex !== ownerPublicKeyHex) throw new Error("owner supplier settings do not match active owner");
  if (ownerSettings?.defaultPublishSupplierId && !supplierIds.has(ownerSettings.defaultPublishSupplierId)) throw new Error("default publish supplier is not configured");
  const receiveIds = ownerSettings?.receiveSupplierIds ?? [];
  if (new Set(receiveIds).size !== receiveIds.length) throw new Error("receive supplier selection contains duplicates");
  for (const supplierId of receiveIds) if (!supplierIds.has(supplierId)) throw new Error("receive supplier is not configured");
  const subscriptions = input.subscriptions.slice(-2048).map((item) => {
    if (!supplierIds.has(item.supplierId)) throw new Error("subscription supplier is not configured");
    return { ...item };
  });
  const uniqueSubscriptions = new Map<string, SatSubscriptionRecord>();
  for (const item of subscriptions) {
    const key = subscriptionKey(item.supplierId, item.channel);
    if (uniqueSubscriptions.has(key)) throw new Error("subscription collection contains duplicate channels");
    uniqueSubscriptions.set(key, item);
  }
  const feeAudit = input.feeAudit.slice(-MAX_AUDIT_ENTRIES).map((item) => {
    if (item.action === "subscriptions" && item.channel !== "") throw new Error("subscriptions audit channel must be empty");
    return { ...item };
  });
  const channelDedup = input.channelDedup.slice(-MAX_DEDUP_ENTRIES).map((item) => {
    const rawAckBySupplier = item.ackBySupplier ?? [{ supplierId: item.ingressSupplierId, state: item.ackState, errorCode: item.ackErrorCode, updatedAtMs: item.firstPersistedAtMs }];
    if (rawAckBySupplier.length === 0 || rawAckBySupplier.length > MAX_ACK_SUPPLIERS_PER_MESSAGE) throw new Error("channel dedup ACK supplier capacity exceeded");
    const ackBySupplier = rawAckBySupplier.map(ack => ({ ...ack }));
    const ackSupplierIds = new Set(ackBySupplier.map((ack) => ack.supplierId));
    if (ackSupplierIds.size !== ackBySupplier.length) throw new Error("channel dedup ackBySupplier contains duplicate suppliers");
    if (!ackSupplierIds.has(item.ingressSupplierId)) throw new Error("channel dedup ackBySupplier misses primary ingress");
    return { ...item, ackBySupplier };
  });
  const channelKeys = new Set<string>();
  for (const item of channelDedup) {
    if (channelKeys.has(item.dedupKey)) throw new Error("channel dedup collection contains duplicate keys");
    channelKeys.add(item.dedupKey);
  }
  const spiInformation = input.spiInformation.slice(-64).map((item) => {
    if (item.ownerPublicKeyHex !== ownerPublicKeyHex || !supplierIds.has(item.supplierId)) throw new Error("SPI information owner or supplier is unavailable");
    assertBoundedWire(item.projectInfoCbor, "SPI projectInfoCbor");
    for (const currency of item.currencies) {
      if (currency.balance < 0n || currency.balance > MAX_UINT64) throw new Error("SPI currency balance is out of range");
    }
    return { ...item, currencies: item.currencies.map((currency) => ({ ...currency })), projectInfoCbor: item.projectInfoCbor.slice() };
  });
  const spiSupplierIds = new Set<string>();
  for (const item of spiInformation) {
    if (spiSupplierIds.has(item.supplierId)) throw new Error("SPI information contains duplicate suppliers");
    spiSupplierIds.add(item.supplierId);
  }
  const collectResults = input.collectResults.slice(-64).map((item) => {
    if (item.ownerPublicKeyHex !== undefined && item.ownerPublicKeyHex !== ownerPublicKeyHex) throw new Error("Collect owner does not match active owner");
    if (item.amount <= 0n || item.amount > MAX_UINT64) throw new Error("Collect amount is out of range");
    if (item.requestWire !== undefined && item.requestWire.byteLength === 0) throw new Error("Collect request wire is unavailable");
    if (item.requestWire) assertBoundedWire(item.requestWire, "Collect request wire");
    const unresolved = item.state === "pending" || item.state === "unknown_result";
    const hasRecoveryFields = item.ownerPublicKeyHex !== undefined
      && item.ownerGeneration !== undefined
      && item.supplierGeneration !== undefined
      && item.requestWire !== undefined;
    // 不完整的运行态恢复字段只能封存为 unknown_result；不能用当前会话值
    // 补齐，否则可能把未知扣费请求发给错误的 owner。
    const recoveryBlocked = unresolved && (!hasRecoveryFields || item.recoveryBlocked === true);
    return {
      ...item,
      ...(item.ownerPublicKeyHex ? { ownerPublicKeyHex: item.ownerPublicKeyHex } : {}),
      ...(item.ownerGeneration === undefined ? {} : { ownerGeneration: item.ownerGeneration }),
      ...(item.supplierGeneration === undefined ? {} : { supplierGeneration: item.supplierGeneration }),
      ...(item.requestWire ? { requestWire: item.requestWire.slice() } : {}),
      ...(recoveryBlocked ? { state: "unknown_result" as const, recoveryBlocked: true, errorCode: "unknown_result" as const } : {})
    };
  });
  const collectRequestIds = new Set<string>();
  for (const item of collectResults) {
    if (collectRequestIds.has(item.requestIdHex)) throw new Error("Collect results contain duplicate request ids");
    collectRequestIds.add(item.requestIdHex);
  }
  return {
    ownerPublicKeyHex,
    supplierGeneration,
    suppliers,
    ownerSettings,
    subscriptions: [...uniqueSubscriptions.values()],
    feeAudit,
    channelDedup,
    spiInformation,
    collectResults
  };
}

/** 创建 owner-scoped 的 SatSubscription 状态存储。 */
export function createSatSubscriptionState(input: {
  ownerPublicKeyHex: string | null;
  initial?: Partial<SatSubscriptionStateSnapshot>;
  persistence?: SatSubscriptionStatePersistence;
}): SatSubscriptionStateStore {
  let state = applyStatePolicies({
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    supplierGeneration: input.initial?.supplierGeneration ?? 1,
    suppliers: input.initial?.suppliers ?? [],
    ownerSettings: input.initial?.ownerSettings ?? null,
    subscriptions: input.initial?.subscriptions ?? [],
    feeAudit: input.initial?.feeAudit ?? [],
    channelDedup: input.initial?.channelDedup ?? [],
    spiInformation: input.initial?.spiInformation ?? [],
    collectResults: input.initial?.collectResults ?? []
  }, input.ownerPublicKeyHex);

  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = <T>(fn: (candidate: SatSubscriptionStateSnapshot) => T | Promise<T>): Promise<T> => {
    const run = mutationTail.then(async () => {
      const candidate = clone(state);
      const result = await fn(candidate);
      const committed = applyStatePolicies(candidate, input.ownerPublicKeyHex);
      await input.persistence?.save(clone(committed));
      // Readers continue to see the previous committed state while I/O runs.
      state = committed;
      return result;
    });
    mutationTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const api: SatSubscriptionStateStore = {
    get ownerPublicKeyHex() { return input.ownerPublicKeyHex; },
    supplierGeneration: () => state.supplierGeneration,
    snapshot: () => clone(state),
    listSuppliers: () => state.suppliers.map((item) => ({ ...item, multiaddrs: [...item.multiaddrs] })),
    getSupplier: (supplierId) => {
      const item = state.suppliers.find((value) => value.supplierId === supplierId);
      return item ? { ...item, multiaddrs: [...item.multiaddrs] } : undefined;
    },
    upsertSupplier: async (config) => mutate(state => {
      const nextSupplier = clone(config);
      const index = state.suppliers.findIndex((item) => item.supplierId === nextSupplier.supplierId);
      if (index < 0) state.suppliers.push(nextSupplier); else state.suppliers[index] = nextSupplier;
      // A disabled supplier cannot remain selected as an active ingress.
      if (!nextSupplier.enabled && state.ownerSettings) {
        state.ownerSettings = {
          ...state.ownerSettings,
          defaultPublishSupplierId: state.ownerSettings.defaultPublishSupplierId === nextSupplier.supplierId
            ? null
            : state.ownerSettings.defaultPublishSupplierId,
          receiveSupplierIds: state.ownerSettings.receiveSupplierIds.filter((supplierId) => supplierId !== nextSupplier.supplierId)
        };
      }
      state.supplierGeneration = nextSupplierGeneration(state.supplierGeneration);
    }),
    deleteSupplier: async (supplierId) => mutate(state => {
      state.suppliers = state.suppliers.filter((item) => item.supplierId !== supplierId);
      state.subscriptions = state.subscriptions.filter((item) => item.supplierId !== supplierId);
      state.spiInformation = state.spiInformation.filter((item) => item.supplierId !== supplierId);
      state.supplierGeneration = nextSupplierGeneration(state.supplierGeneration);
      if (state.ownerSettings) {
        state.ownerSettings = {
          ...state.ownerSettings,
          defaultPublishSupplierId: state.ownerSettings.defaultPublishSupplierId === supplierId ? null : state.ownerSettings.defaultPublishSupplierId,
          receiveSupplierIds: state.ownerSettings.receiveSupplierIds.filter((item) => item !== supplierId)
        };
      }
    }),
    getOwnerSettings: () => state.ownerSettings ? clone(state.ownerSettings) : null,
    setOwnerSettings: async (settings) => mutate(state => {
      state.ownerSettings = clone(settings);
    }),
    setDesiredSubscription: async (value) => mutate(state => {
      const key = subscriptionKey(value.supplierId, value.channel);
      const existing = state.subscriptions.find((item) => subscriptionKey(item.supplierId, item.channel) === key);
      if (existing) {
        existing.desired = value.state;
        existing.errorCode = value.errorCode ?? null;
      } else {
        state.subscriptions.push({ supplierId: value.supplierId, channel: value.channel, desired: value.state, observed: "unknown", observedAtMs: 0, observedSource: "none", errorCode: value.errorCode ?? null });
      }
    }),
    setObservedSubscription: async (value) => mutate(state => {
      const key = subscriptionKey(value.supplierId, value.channel);
      const existing = state.subscriptions.find((item) => subscriptionKey(item.supplierId, item.channel) === key);
      if (!existing) {
        state.subscriptions.push({ supplierId: value.supplierId, channel: value.channel, desired: "unknown", observed: value.state, observedAtMs: value.observedAtMs ?? Date.now(), observedSource: value.source, errorCode: value.errorCode ?? null });
      } else {
        existing.observed = value.state;
        existing.observedAtMs = value.observedAtMs ?? Date.now();
        existing.observedSource = value.source;
        existing.errorCode = value.errorCode ?? null;
      }
    }),
    listSubscriptions: (supplierId) => state.subscriptions.filter((item) => supplierId === undefined || item.supplierId === supplierId).map((item) => ({ ...item })),
    recordFee: async (value) => mutate(state => {
      state.feeAudit.push({ ...value, auditId: `fee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAtMs: value.createdAtMs ?? Date.now() });
      state.feeAudit = state.feeAudit.slice(-MAX_AUDIT_ENTRIES);
    }),
    listFeeAudit: (limit = MAX_AUDIT_ENTRIES) => state.feeAudit.slice(-Math.max(0, Math.min(MAX_AUDIT_ENTRIES, limit))).map((item) => ({ ...item })),
    rememberChannel: (value) => mutate(state => {
      const existing = state.channelDedup.find((item) => item.dedupKey === value.dedupKey);
      if (existing) {
        const ackBySupplier = existing.ackBySupplier!;
        if (existing.contentDigestHex !== value.contentDigestHex) {
          existing.ackState = "conflict";
          existing.ackErrorCode = "conflict";
          const primaryAck = existing.ackBySupplier?.find((item) => item.supplierId === existing.ingressSupplierId);
          if (primaryAck) {
            primaryAck.state = "conflict";
            primaryAck.errorCode = "conflict";
            primaryAck.updatedAtMs = Date.now();
          }
          if (!ackBySupplier.some((item) => item.supplierId === value.ingressSupplierId) && ackBySupplier.length < MAX_ACK_SUPPLIERS_PER_MESSAGE) {
            ackBySupplier.push({ supplierId: value.ingressSupplierId, state: "conflict", errorCode: "conflict", updatedAtMs: Date.now() });
          }
          return "conflict" as const;
        }
        // 首次 ingress 是稳定的主关系，绝不能被重复 Deliver 改写。
        // 每个实际 ingress 单独记录 ACK，发送时使用调用方明确传入的 Supplier。
        if (!ackBySupplier.some((item) => item.supplierId === value.ingressSupplierId) && ackBySupplier.length < MAX_ACK_SUPPLIERS_PER_MESSAGE) {
          ackBySupplier.push({ supplierId: value.ingressSupplierId, state: "pending", updatedAtMs: Date.now() });
        }
        return "duplicate" as const;
      }
      const firstPersistedAtMs = value.firstPersistedAtMs ?? Date.now();
      state.channelDedup.push({
        ...value,
        firstPersistedAtMs,
        ackState: "pending",
        ackBySupplier: [{ supplierId: value.ingressSupplierId, state: "pending", updatedAtMs: firstPersistedAtMs }]
      });
      state.channelDedup = state.channelDedup.slice(-MAX_DEDUP_ENTRIES);
      return "new" as const;
    }),
    updateChannelAck: async (value) => mutate(state => {
      const existing = state.channelDedup.find((item) => item.dedupKey === value.dedupKey);
      if (!existing) return;
      const supplierId = value.supplierId ?? existing.ingressSupplierId;
      const ackBySupplier = existing.ackBySupplier!;
      let delivery = ackBySupplier.find((item) => item.supplierId === supplierId);
      if (!delivery) {
        if (ackBySupplier.length >= MAX_ACK_SUPPLIERS_PER_MESSAGE) return;
        delivery = { supplierId, state: value.state, errorCode: value.errorCode, updatedAtMs: Date.now() };
        ackBySupplier.push(delivery);
      } else {
        delivery.state = value.state;
        delivery.errorCode = value.errorCode;
        delivery.updatedAtMs = Date.now();
      }
      // The aggregate fields describe the primary ingress only.
      if (supplierId === existing.ingressSupplierId) {
        existing.ackState = value.state;
        existing.ackErrorCode = value.errorCode;
      }
    }),
    getChannel: (dedupKey) => {
      const item = state.channelDedup.find((value) => value.dedupKey === dedupKey);
      return item ? clone(item) : undefined;
    },
    putSpiInformation: async (value) => mutate(state => {
      const index = state.spiInformation.findIndex((item) => item.supplierId === value.supplierId);
      if (index < 0) state.spiInformation.push(clone(value)); else state.spiInformation[index] = clone(value);
    }),
    getSpiInformation: (supplierId) => {
      const item = state.spiInformation.find((value) => value.supplierId === supplierId);
      return item ? clone(item) : undefined;
    },
    putCollectResult: async (value) => mutate(state => {
      const index = state.collectResults.findIndex((item) => item.requestIdHex === value.requestIdHex);
      if (index < 0) state.collectResults.push(clone(value)); else state.collectResults[index] = clone(value);
    }),
    getCollectResult: (requestIdHex) => {
      const item = state.collectResults.find((value) => value.requestIdHex === requestIdHex);
      return item ? clone(item) : undefined;
    },
    supplierViews: () => state.suppliers.map((supplier) => {
      const records = state.subscriptions.filter((item) => item.supplierId === supplier.supplierId);
      const info = state.spiInformation.find((item) => item.supplierId === supplier.supplierId);
      return {
        supplierId: supplier.supplierId,
        name: supplier.name,
        supplierPublicKeyHex: supplier.supplierPublicKeyHex,
        connectionState: supplier.enabled ? "disconnected" : "disabled",
        inboxChannel: input.ownerPublicKeyHex ? `bsv8.inbox.${input.ownerPublicKeyHex}` : null,
        desiredChannels: records.filter((item) => item.desired === "subscribed" || item.desired === "subscribing").map((item) => item.channel),
        observedChannels: records.filter((item) => item.observed === "subscribed").map((item) => item.channel),
        lastChargedAmount: lastMatching(state.feeAudit, (item) => item.supplierId === supplier.supplierId)?.chargedAmount ?? null,
        lastErrorCode: lastMatching(state.feeAudit, (item) => item.supplierId === supplier.supplierId && item.errorCode !== undefined)?.errorCode ?? null
      } satisfies SatSupplierRuntimeView;
    })
  };
  return api;
}
