// P2PKH 状态仓储（2026-09-20 解耦后的真值模型）。
//
// 真值边界：
//   - 链上历史元数据（txid/height/fee）= `p2pkh/<net>/history.json`；
//   - UTXO = 只存在于 Coordinator Worker 内存快照（本仓储不保存、不派生）；
//   - 资源表、本地提交、协议提交、历史/协议兼容 claim、同步状态 = 仅内存；
//   - 不再有 raw tx 文件、高度文件、owned outpoint 投影或交易 DAG。

import type { BorrowedOwnerFileStore, BsvNetwork } from "@keymaster/contracts";
import type {
  P2pkhHistoryRecord,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhLocalTransaction,
  P2pkhProtocolSubmission,
  P2pkhTransactionSyncState,
} from "../p2pkhContracts.js";
import { makeResourceId } from "../p2pkhContracts.js";
import { createP2pkhFileRepository } from "./p2pkhFileRepository.js";
import type { P2pkhHistoryEntryV1 } from "./p2pkhFileFormats.js";

const openHandles = new Set<P2pkhStateRepositoryBundle>();
/**
 * 同一 owner 文件句柄必须共享同一份内存本地态（资源表/本地提交/协议兼容 claim/游标）；
 * 否则 service 与 Coordinator task 各自 open 会得到互不可见的空状态。
 */
const bundlesByFiles = new WeakMap<object, P2pkhStateRepositoryBundle>();

/** 同一 owner 文件句柄共享的内存态；bundle 缓存保证跨实例可见。 */
export interface P2pkhStateMemory {
  resources: Map<string, P2pkhKeyResource>;
  localTransactions: Map<string, P2pkhLocalTransaction>;
  localClaims: Map<string, P2pkhLocalInputClaim>;
  protocolSubmissions: Map<string, P2pkhProtocolSubmission>;
  syncStates: Map<string, P2pkhTransactionSyncState>;
  history: Map<string, P2pkhHistoryRecord[]>;
}

export interface P2pkhStateRepositoryBundle {
  close(): void;
  readonly files: BorrowedOwnerFileStore;
  /** 共享内存本地态 + 历史缓存。 */
  readonly memory: P2pkhStateMemory;
}

export interface P2pkhInputOutpoint {
  txid: string;
  vout: number;
  /** 已验证的输入金额（聪）；协议 claim 必须带上，余额才能立即扣除。 */
  value?: number;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

interface CursorPage<T> { items: T[]; nextCursor?: string; }

/** 内存游标分页：cursor 是不透明 last-key；列表顺序稳定时可用。 */
function pageRows<T>(rows: readonly T[], keyOf: (row: T) => string, cursor: string | undefined, limit: number): CursorPage<T> {
  const sorted = [...rows].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  const start = cursor === undefined ? 0 : sorted.findIndex((row) => keyOf(row) === cursor) + 1;
  const from = start < 0 ? sorted.length : start;
  const items = sorted.slice(from, from + limit);
  const last = items[items.length - 1];
  const hasMore = last !== undefined && from + items.length < sorted.length;
  return hasMore ? { items, nextCursor: keyOf(last) } : { items };
}

function claimId(resourceId: string, txid: string, vout: number): string { return `${resourceId}:${txid}:${vout}`; }

export async function openP2pkhStateRepository(files: BorrowedOwnerFileStore): Promise<P2pkhStateRepositoryBundle> {
  const cached = bundlesByFiles.get(files);
  if (cached) return cached;
  const bundle: P2pkhStateRepositoryBundle = {
    files,
    memory: {
      resources: new Map(),
      localTransactions: new Map(),
      localClaims: new Map(),
      protocolSubmissions: new Map(),
      syncStates: new Map(),
      history: new Map(),
    },
    close: () => {
      if (openHandles.has(bundle)) {
        openHandles.delete(bundle);
        bundlesByFiles.delete(files);
      }
    },
  };
  openHandles.add(bundle);
  bundlesByFiles.set(files, bundle);
  return bundle;
}

export function disposeP2pkhStateRepository(): void { for (const bundle of [...openHandles.values()]) bundle.close(); openHandles.clear(); }

export function createP2pkhStateRepository(handle: P2pkhStateRepositoryBundle) {
  const { files } = handle;
  const fileRepository = createP2pkhFileRepository(files);
  const { resources, localTransactions, localClaims, protocolSubmissions, syncStates, history } = handle.memory;

  function historyFor(resource: P2pkhKeyResource): P2pkhHistoryRecord[] {
    return history.get(resource.resourceId) ?? [];
  }

  /** 冷启动从文件加载历史元数据；失败按空历史处理（不清空本地已加载数据）。 */
  async function ensureHistory(resource: P2pkhKeyResource): Promise<P2pkhHistoryRecord[]> {
    const cached = history.get(resource.resourceId);
    if (cached) return cached;
    let entries: P2pkhHistoryEntryV1[] | undefined;
    try {
      entries = await fileRepository.readHistory(resource.network);
    } catch {
      entries = undefined;
    }
    if (entries === undefined) {
      // 文件不存在/损坏：返回空但不缓存，下次读取重试。
      return [];
    }
    const loaded = entries.map((entry) => historyRecord(resource, entry, new Date().toISOString()));
    history.set(resource.resourceId, loaded);
    return loaded;
  }

  function historyRecord(resource: P2pkhKeyResource, entry: P2pkhHistoryEntryV1, firstSeenAt: string): P2pkhHistoryRecord {
    return {
      id: `${resource.resourceId}:${entry.txid}`,
      resourceId: resource.resourceId,
      publicKeyHex: resource.publicKeyHex,
      network: resource.network,
      address: resource.address,
      txid: entry.txid,
      height: entry.height,
      ...(entry.fee === undefined ? {} : { fee: entry.fee }),
      firstSeenAt,
    };
  }

  function resourceOf(resourceId: string): P2pkhKeyResource | undefined {
    return resources.get(resourceId);
  }

  function localRowsOfResource(resourceId?: string): P2pkhLocalTransaction[] {
    return [...localTransactions.values()].filter((row) => !resourceId || row.resourceId === resourceId);
  }

  function claimRows(resourceId?: string): P2pkhLocalInputClaim[] {
    return [...localClaims.values()].filter((row) => !resourceId || row.resourceId === resourceId);
  }

  /** 相同 txid 即视为链上确认；不做任何输入关系或后代派生。 */
  function reconcileHistoryConfirmed(resourceId: string, confirmedTxids: ReadonlySet<string>): void {
    const now = new Date().toISOString();
    for (const local of localRowsOfResource(resourceId)) {
      if (local.chainResolution === "chain-confirmed") continue;
      if (!confirmedTxids.has(local.txid.toLowerCase())) continue;
      local.chainResolution = "chain-confirmed";
      local.confirmedHistoryId = `${resourceId}:${local.txid.toLowerCase()}`;
      local.resolvedAt = now;
      local.updatedAt = now;
      for (const claim of claimRows(resourceId)) {
        if (claim.submissionId !== local.id) continue;
        claim.state = "confirmed";
        claim.updatedAt = now;
      }
    }
  }

  return {
    close: () => handle.close(),
    replaceLocalTransaction: async (row: P2pkhLocalTransaction) => { localTransactions.set(row.id, structuredClone(row)); },
    putAddress: async (row: P2pkhKeyResource) => { resources.set(row.resourceId, structuredClone(row)); },
    removeResource: async (id: string) => {
      resources.delete(id);
      history.delete(id);
      for (const [key, row] of [...localTransactions]) if (row.resourceId === id) localTransactions.delete(key);
      for (const [key, row] of [...localClaims]) if (row.resourceId === id) localClaims.delete(key);
    },
    listAddresses: async () => [...resources.values()].map((row) => structuredClone(row)),
    listResourcesByKey: async () => [...resources.values()].map((row) => structuredClone(row)),
    getResource: async (id: string) => {
      const row = resourceOf(id);
      return row ? structuredClone(row) : undefined;
    },

    /** 完整分页成功后整文件替换历史元数据，并原子更新内存视图。 */
    async replaceHistory(resource: P2pkhKeyResource, entries: readonly P2pkhHistoryEntryV1[]): Promise<void> {
      const previous = new Map(historyFor(resource).map((row) => [row.txid, row]));
      await fileRepository.writeHistory(resource.network, entries);
      const now = new Date().toISOString();
      const records = entries
        .map((entry) => historyRecord(resource, entry, previous.get(entry.txid)?.firstSeenAt ?? now))
        .sort((left, right) => left.txid.localeCompare(right.txid));
      history.set(resource.resourceId, records);
    },

    reconcileHistoryConfirmed: async (resourceId: string, confirmedTxids: ReadonlySet<string>) => {
      reconcileHistoryConfirmed(resourceId, new Set([...confirmedTxids].map((txid) => txid.toLowerCase())));
    },

    async listHistory(filter?: { resourceId?: string; network?: BsvNetwork; limit?: number }): Promise<P2pkhHistoryRecord[]> {
      const rows: P2pkhHistoryRecord[] = [];
      for (const resource of resources.values()) {
        if (filter?.resourceId && resource.resourceId !== filter.resourceId) continue;
        if (filter?.network && resource.network !== filter.network) continue;
        rows.push(...await ensureHistory(resource));
      }
      const limit = boundedLimit(filter?.limit);
      return limit ? rows.slice(0, limit) : rows;
    },

    async listHistoryPage(filter?: { resourceId?: string; network?: BsvNetwork; cursor?: string; limit?: number }): Promise<CursorPage<P2pkhHistoryRecord>> {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      const resource = resourceOf(filter.resourceId);
      if (!resource || (filter.network && resource.network !== filter.network)) return { items: [], nextCursor: undefined };
      const rows = await ensureHistory(resource);
      return pageRows(rows, (row) => row.txid, filter.cursor, boundedLimit(filter.limit) ?? 200);
    },

    listTransactionSyncStates: async () => [...syncStates.values()].map((row) => structuredClone(row)),
    getTransactionSyncState: async (id: string) => {
      const row = syncStates.get(id);
      return row ? structuredClone(row) : undefined;
    },
    putTransactionSyncState: async (state: P2pkhTransactionSyncState) => { syncStates.set(state.resourceId, { ...structuredClone(state), id: state.resourceId }); },

    listLocalTransactions: async (resourceId?: string, limit?: number) => {
      const rows = localRowsOfResource(resourceId).map((row) => structuredClone(row));
      const size = boundedLimit(limit);
      return size ? rows.slice(0, size) : rows;
    },
    listLocalTransactionsPage: async (filter?: { resourceId?: string; cursor?: string; limit?: number }) => {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      return pageRows(localRowsOfResource(filter.resourceId), (row) => row.id, filter.cursor, boundedLimit(filter.limit) ?? 500);
    },
    listLocalInputClaimsPage: async (filter?: { resourceId?: string; cursor?: string; limit?: number }) => {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      return pageRows(claimRows(filter.resourceId), (row) => row.id, filter.cursor, boundedLimit(filter.limit) ?? 500);
    },
    listLocalInputClaims: async (limit?: number) => {
      const rows = [...localClaims.values()].map((row) => structuredClone(row));
      const size = boundedLimit(limit);
      return size ? rows.slice(0, size) : rows;
    },
    listLocalInputClaimsByResource: async (id: string, limit?: number) => {
      const rows = claimRows(id).map((row) => structuredClone(row));
      const size = boundedLimit(limit);
      return size ? rows.slice(0, size) : rows;
    },

    /**
     * 写入本地提交审计记录。
     *
     * 普通 P2PKH 转账不再传入 claims；并发唯一由 Coordinator 的 UTXO 快照
     * seq 门禁负责。`claims` 仅作为旧数据/协议兼容入口保留，不能作为普通
     * P2PKH 选币或余额计算的依据。
     */
    async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims?: readonly P2pkhLocalInputClaim[] }): Promise<void> {
      const now = new Date().toISOString();
      // 原子性：先完整预检全部输入，全部通过后才统一写入 claim 和 submission。
      // 第二个输入冲突时不能留下第一个已写入的 claim。
      const prepared: Array<{ id: string; claim: P2pkhLocalInputClaim }> = [];
      for (const claim of input.claims ?? []) {
        const id = claim.id || claimId(claim.resourceId, claim.txid, claim.vout);
        const existing = localClaims.get(id);
        if (existing && existing.submissionId !== claim.submissionId && !["released", "confirmed"].includes(existing.state)) {
          throw new Error(`P2PKH input already claimed: ${claim.txid}:${claim.vout}`);
        }
        prepared.push({ id, claim: { ...structuredClone(claim), id, state: "active", outpointKey: `${claim.txid}:${claim.vout}`, createdAt: existing?.createdAt ?? claim.createdAt, updatedAt: now } });
      }
      for (const { id, claim } of prepared) localClaims.set(id, claim);
      localTransactions.set(input.submission.id, { ...structuredClone(input.submission), localState: "submitting", chainResolution: "unresolved" });
    },

    async finishLocalSubmission(input: { submissionId: string; localState: "local-confirmed" | "isolated"; reason?: string; attempt?: unknown }): Promise<void> {
      const now = new Date().toISOString();
      const row = localTransactions.get(input.submissionId);
      if (!row) throw new Error("Local submission not found");
      if (row.chainResolution === "chain-confirmed") {
        // 同步已定真值：迟到的广播结果只能追加审计，不能改写状态。
        if (input.attempt) {
          row.attempts = [...row.attempts, input.attempt as P2pkhLocalTransaction["attempts"][number]];
          row.updatedAt = now;
        }
        return;
      }
      row.localState = input.localState;
      row.updatedAt = now;
      row.isolationReason = input.localState === "local-confirmed" ? undefined : input.reason ?? row.isolationReason;
      if (input.attempt) row.attempts = [...row.attempts, input.attempt as P2pkhLocalTransaction["attempts"][number]];
      for (const claim of claimRows(row.resourceId)) {
        if (claim.submissionId !== input.submissionId) continue;
        claim.state = row.localState === "isolated" ? "isolated" : "active";
        claim.updatedAt = now;
      }
    },

    async abortUnattemptedLocalSubmission(input: { submissionId: string; reason?: string }): Promise<void> {
      const row = localTransactions.get(input.submissionId);
      const attempts = row && Array.isArray(row.attempts) ? row.attempts : [];
      if (!row || row.chainResolution !== "unresolved" || attempts.length > 0 || (row.localState !== "prepared" && row.localState !== "submitting")) return;
      localTransactions.delete(input.submissionId);
      for (const [id, claim] of [...localClaims]) if (claim.resourceId === row.resourceId && claim.submissionId === input.submissionId) localClaims.delete(id);
    },

    putProtocolSubmission: async (row: P2pkhProtocolSubmission) => { protocolSubmissions.set(row.id, structuredClone(row)); },
    getProtocolSubmission: async (id: string) => {
      const row = protocolSubmissions.get(id);
      return row ? structuredClone(row) : undefined;
    },
    listProtocolSubmissions: async () => [...protocolSubmissions.values()].map((row) => structuredClone(row)),
    listProtocolSubmissionsByResource: async (id: string) => [...protocolSubmissions.values()].filter((row) => row.resourceId === id).map((row) => structuredClone(row)),
    removeProtocolSubmission: async (id: string) => { protocolSubmissions.delete(id); },

    async tryClaimInputs(input: { submissionId: string; resourceId: string; publicKeyHex: string; network: BsvNetwork; inputs: P2pkhInputOutpoint[]; expectedCanonicalTxid?: string; observation?: "unconfirmed" | "confirmed" }): Promise<{ claimIds: string[] }> {
      const now = new Date().toISOString();
      const ids: string[] = [];
      // 原子性：先完整预检，再统一写入；任一个冲突时不留下部分 claim。
      const prepared: P2pkhLocalInputClaim[] = [];
      for (const value of input.inputs) {
        const id = claimId(input.resourceId, value.txid, value.vout);
        const existing = localClaims.get(id);
        if (existing && existing.submissionId !== input.submissionId && !["released", "confirmed"].includes(existing.state)) {
          throw new Error(`P2PKH input already claimed: ${value.txid}:${value.vout}`);
        }
        ids.push(id);
        prepared.push({
          id,
          submissionId: input.submissionId,
          resourceId: input.resourceId,
          publicKeyHex: input.publicKeyHex,
          network: input.network,
          txid: value.txid,
          vout: value.vout,
          ...(Number.isSafeInteger(value.value) && (value.value as number) >= 0 ? { value: value.value as number } : {}),
          state: "active",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          outpointKey: `${value.txid}:${value.vout}`,
        });
      }
      for (const claim of prepared) localClaims.set(claim.id, claim);
      return { claimIds: ids };
    },
    releaseLocalInputClaims: async (ids: string[]) => {
      const now = new Date().toISOString();
      for (const id of ids) {
        const row = localClaims.get(id);
        if (!row) continue;
        row.state = "released";
        row.updatedAt = now;
      }
    },

    clearAll: async () => {
      resources.clear();
      localTransactions.clear();
      localClaims.clear();
      protocolSubmissions.clear();
      syncStates.clear();
      history.clear();
    },
  };
}

export type P2pkhStateRepositoryHandle = ReturnType<typeof createP2pkhStateRepository>;
export function resourceIdFor(network: BsvNetwork): string { return makeResourceId(network); }
export function localInputClaimIdFor(resourceId: string, txid: string, vout: number): string { return claimId(resourceId, txid, vout); }
