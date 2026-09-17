// P2PKH 状态仓储（硬切换后的真值模型）。
//
// 真值边界（KeymasterFormats《P2PKH 交易 / 高度 / 设置》）：
//   - 确认交易、区块高度 = 桶内文件（keys 见 p2pkhFileRepository）；
//   - UTXO、花费关系、排序 = 由文件在内存回放（p2pkhChainStore）；
//   - 未确认提交、输入占用、协议提交、同步游标 = 仅内存（刷新即重同步）；
//   - 资源表（address/generation）= 内存，可由 keyspace 重建。
//
// 旧 IndexedDB 风格记录仓储与持久化游标已删除；本文件保持消费者使用的
// 方法名与返回形状，便于服务层无感迁移。

import type { BorrowedOwnerFileStore, BsvNetwork } from "@keymaster/contracts";
import type {
  P2pkhKeyResource,
  P2pkhLocalInputClaim, P2pkhLocalOutpoint,
  P2pkhLocalTransaction, P2pkhOwnedOutpointProjection, P2pkhProtocolSubmission,
  P2pkhTransactionFact,
  P2pkhTransactionSyncState, P2pkhUtxo,
} from "../p2pkhContracts.js";
import { makeResourceId } from "../p2pkhContracts.js";
import { parseP2pkhTransaction } from "../p2pkhTransactionParser.js";
import { createP2pkhChainStore, type P2pkhChainSnapshot } from "./p2pkhChainStore.js";

const openHandles = new Set<P2pkhStateRepositoryBundle>();
/**
 * 同一 owner 文件句柄必须共享同一份内存本地态（资源表/本地提交/占用/游标）；
 * 否则 service 与 Coordinator task 各自 open 会得到互不可见的空状态。
 */
const bundlesByFiles = new WeakMap<object, P2pkhStateRepositoryBundle>();

/** 同一 owner 文件句柄共享的内存态；bundle 缓存保证跨实例可见。 */
export interface P2pkhStateMemory {
  resources: Map<string, P2pkhKeyResource>;
  localTransactions: Map<string, P2pkhLocalTransaction>;
  localOutpoints: Map<string, P2pkhLocalOutpoint>;
  localClaims: Map<string, P2pkhLocalInputClaim>;
  protocolSubmissions: Map<string, P2pkhProtocolSubmission>;
  syncStates: Map<string, P2pkhTransactionSyncState>;
}

export interface P2pkhStateRepositoryBundle {
  close(): void;
  /** 链上真值存储（文件 + 内存回放）。 */
  readonly chainStore: ReturnType<typeof createP2pkhChainStore>;
  readonly files: BorrowedOwnerFileStore;
  /** 共享内存本地态。 */
  readonly memory: P2pkhStateMemory;
}

export interface P2pkhInputOutpoint { txid: string; vout: number; }

function boundedLimit(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

interface CursorPage<T> { items: T[]; nextCursor?: string; }

/**
 * 内存游标分页：cursor 是本仓储返回的不透明 last-key；列表顺序稳定时可用。
 * 元素键由调用方提供（排序后）。
 */
function pageRows<T>(rows: readonly T[], keyOf: (row: T) => string, cursor: string | undefined, limit: number): CursorPage<T> {
  const sorted = [...rows].sort((left, right) => keyOf(left).localeCompare(keyOf(right)));
  const start = cursor === undefined ? 0 : sorted.findIndex((row) => keyOf(row) === cursor) + 1;
  const items = sorted.slice(start < 0 ? sorted.length : start, (start < 0 ? sorted.length : start) + limit);
  const last = items[items.length - 1];
  const hasMore = last !== undefined && sorted.findIndex((row) => keyOf(row) === keyOf(last)) + items.length < sorted.length;
  return hasMore ? { items, nextCursor: keyOf(last) } : { items };
}

function claimId(resourceId: string, txid: string, vout: number): string { return `${resourceId}:${txid}:${vout}`; }
function outpointId(resourceId: string, txid: string, vout: number): string { return `${resourceId}:${txid}:${vout}`; }

function utxoFromOutpoint(row: P2pkhOwnedOutpointProjection): P2pkhUtxo {
  return {
    id: `utxo:${row.id}`,
    resourceId: row.resourceId,
    publicKeyHex: row.publicKeyHex,
    network: row.network,
    address: row.address,
    txid: row.txid,
    vout: row.vout,
    value: row.value,
    height: row.createdBlockHeight ?? 0,
    script: row.scriptHex,
    status: "confirmed",
    isSpentInMempoolTx: false,
    syncedAt: row.updatedAt,
  };
}

export async function openP2pkhStateRepository(files: BorrowedOwnerFileStore): Promise<P2pkhStateRepositoryBundle> {
  const cached = bundlesByFiles.get(files);
  if (cached) return cached;
  const chainStore = createP2pkhChainStore(files);
  let closed = false;
  const bundle: P2pkhStateRepositoryBundle = {
    chainStore,
    files,
    memory: {
      resources: new Map(),
      localTransactions: new Map(),
      localOutpoints: new Map(),
      localClaims: new Map(),
      protocolSubmissions: new Map(),
      syncStates: new Map(),
    },
    close: () => {
      if (closed) return;
      closed = true;
      openHandles.delete(bundle);
      bundlesByFiles.delete(files);
      chainStore.clearAll();
    },
  };
  openHandles.add(bundle);
  bundlesByFiles.set(files, bundle);
  return bundle;
}

export function disposeP2pkhStateRepository(): void { for (const bundle of [...openHandles.values()]) bundle.close(); openHandles.clear(); }

export function createP2pkhStateRepository(handle: P2pkhStateRepositoryBundle) {
  const { chainStore } = handle;
  // 资源表（可由 keyspace 重建）与未确认/本地状态（仅内存）都挂在 bundle 上，
  // 保证同一 owner 句柄的多个 repository 实例共享同一份状态。
  const { resources, localTransactions, localOutpoints, localClaims, protocolSubmissions, syncStates } = handle.memory;

  function resourceOf(resourceId: string): P2pkhKeyResource | undefined {
    return resources.get(resourceId) ?? chainStore.getResource(resourceId);
  }

  function localRowsOfResource(resourceId?: string): P2pkhLocalTransaction[] {
    return [...localTransactions.values()].filter((row) => !resourceId || row.resourceId === resourceId);
  }

  function localOutpointRows(resourceId?: string): P2pkhLocalOutpoint[] {
    return [...localOutpoints.values()].filter((row) => !resourceId || row.resourceId === resourceId);
  }

  function claimRows(resourceId?: string): P2pkhLocalInputClaim[] {
    return [...localClaims.values()].filter((row) => !resourceId || row.resourceId === resourceId);
  }

  /** 输出组规范化：同一 outpoint 的多个本地候选按子交易状态收敛。 */
  function normalizeLocalOutputGroups(resourceId: string, affectedOutpointKeys: Iterable<string>): void {
    const now = new Date().toISOString();
    for (const outpointKey of new Set(affectedOutpointKeys)) {
      const separator = outpointKey.lastIndexOf(":");
      const txid = outpointKey.slice(0, separator);
      const vout = Number(outpointKey.slice(separator + 1));
      if (!Number.isSafeInteger(vout) || vout < 0) continue;
      const group = [...localOutpoints.values()].filter((row) => row.resourceId === resourceId && row.txid === txid && row.vout === vout);
      if (group.length === 0) continue;
      const localById = new Map(group.map((output) => [output.submissionId, localTransactions.get(output.submissionId)]));
      const children = [...localTransactions.values()].filter((row) => row.resourceId === resourceId && row.inputOutpointKeys.includes(outpointKey));
      const hasIsolatedChild = children.some((row) => row.chainResolution === "unresolved" && row.localState === "isolated");
      const hasUnresolvedChild = children.some((row) => row.chainResolution === "unresolved" && row.localState !== "isolated");
      const mutable = group.filter((output) => output.state !== "isolated" && output.state !== "invalidated");
      if (hasIsolatedChild) {
        for (const output of mutable) output.state = "isolated";
      } else if (hasUnresolvedChild) {
        for (const output of mutable) output.state = "claimed";
      } else {
        const eligible = mutable
          .filter((output) => localById.get(output.submissionId)?.localState === "local-confirmed" && localById.get(output.submissionId)?.chainResolution === "unresolved")
          .sort((left, right) => left.id.localeCompare(right.id));
        const canonical = eligible[0];
        for (const output of mutable) output.state = output === canonical ? "available" : "unavailable";
      }
      for (const output of group) output.updatedAt = now;
    }
  }

  /**
   * 用链上真值收敛本地状态：确认、冲突、后代传播与占用清理。
   *
   * 与旧实现的差别：链上集合来自文件回放;这里只更新内存本地状态。
   */
  function reconcileLocalsWithChain(resourceId: string, snapshot: P2pkhChainSnapshot): void {
    const now = new Date().toISOString();
    const factByTxid = new Map(snapshot.facts.map((fact) => [fact.txid, fact]));
    const chainSpentBy = new Map<string, string>();
    for (const fact of snapshot.facts) {
      for (const inputKey of fact.inputOutpointKeys) {
        if (!chainSpentBy.has(inputKey)) chainSpentBy.set(inputKey, fact.txid);
      }
    }
    const childrenByParentTxid = new Map<string, P2pkhLocalTransaction[]>();
    for (const candidate of localRowsOfResource(resourceId)) {
      for (const parent of candidate.parentTxids) {
        const children = childrenByParentTxid.get(parent) ?? [];
        children.push(candidate);
        childrenByParentTxid.set(parent, children);
      }
    }
    const branch = (root: P2pkhLocalTransaction): P2pkhLocalTransaction[] => {
      const result: P2pkhLocalTransaction[] = [];
      const seen = new Set<string>();
      const queue = [root];
      while (queue.length > 0) {
        const candidate = queue.shift()!;
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        result.push(candidate);
        for (const child of childrenByParentTxid.get(candidate.txid) ?? []) queue.push(child);
      }
      return result;
    };
    const competingRoots = new Set<string>();
    for (const local of localRowsOfResource(resourceId)) {
      const confirmed = factByTxid.get(local.txid);
      if (confirmed && confirmed.txid === local.txid) {
        local.chainResolution = "chain-confirmed";
        local.confirmedFactId = confirmed.id;
        local.conflictSourceTxids = undefined;
        local.resolvedAt = now;
        local.updatedAt = now;
        // 已上链：本地输出与占用不再需要,旧实现同样清理。
        for (const output of [...localOutpoints.values()]) {
          if (output.resourceId === resourceId && output.submissionId === local.id) localOutpoints.delete(output.id);
        }
        for (const claim of [...localClaims.values()]) {
          if (claim.resourceId === resourceId && claim.submissionId === local.id) localClaims.delete(claim.id);
        }
        continue;
      }
      if (local.chainResolution === "unresolved") {
        const conflictedBy = local.inputOutpointKeys
          .map((key) => chainSpentBy.get(key))
          .find((spender) => spender !== undefined && spender !== local.txid);
        if (conflictedBy) competingRoots.add(local.id);
      }
    }
    for (const rootId of competingRoots) {
      const root = localTransactions.get(rootId);
      if (!root) continue;
      for (const candidate of branch(root)) {
        candidate.chainResolution = "conflicted";
        candidate.conflictSourceTxids = [...new Set([...(candidate.conflictSourceTxids ?? []), ...(root.conflictSourceTxids ?? [])])];
        if (candidate.conflictSourceTxids.length === 0) candidate.conflictSourceTxids = [...factByTxid.keys()].slice(0, 1);
        candidate.resolvedAt = now;
        candidate.updatedAt = now;
        for (const output of [...localOutpoints.values()]) {
          if (output.resourceId === resourceId && output.submissionId === candidate.id) output.state = "invalidated";
        }
      }
    }
    for (const claim of claimRows(resourceId)) {
      const local = localTransactions.get(claim.submissionId);
      if (!local) continue;
      if (local.chainResolution === "conflicted") claim.state = "isolated";
      else if (local.chainResolution === "chain-confirmed") claim.state = "confirmed";
      else claim.state = "active";
      claim.updatedAt = now;
    }
    for (const output of localOutpoints.values()) {
      if (output.resourceId !== resourceId) continue;
      const local = localTransactions.get(output.submissionId);
      if (local?.chainResolution === "conflicted") output.state = "invalidated";
    }
  }

  async function ingestConfirmed(input: { resource: P2pkhKeyResource; tx: { txid: string; rawTxHex: string; blockHeight?: number } }): Promise<P2pkhTransactionFact> {
    const snapshot = await chainStore.ingestConfirmed(input.resource, [{ txid: input.tx.txid, rawTxHex: input.tx.rawTxHex, blockHeight: input.tx.blockHeight }]);
    reconcileLocalsWithChain(input.resource.resourceId, snapshot);
    const fact = snapshot.facts.find((candidate) => candidate.txid === input.tx.txid.toLowerCase());
    if (!fact) throw new Error("P2PKH confirmed transaction was not persisted");
    return fact;
  }

  return {
    close: () => handle.close(),
    replaceLocalTransaction: async (row: P2pkhLocalTransaction) => { localTransactions.set(row.id, structuredClone(row)); },
    putAddress: async (row: P2pkhKeyResource) => { resources.set(row.resourceId, structuredClone(row)); chainStore.putAddress(row); },
    removeResource: async (id: string) => { resources.delete(id); chainStore.removeResource(id); },
    listAddresses: async () => [...resources.values()].map((row) => structuredClone(row)),
    listResourcesByKey: async () => [...resources.values()].map((row) => structuredClone(row)),
    getResource: async (id: string) => {
      const row = resourceOf(id);
      return row ? structuredClone(row) : undefined;
    },

    async ingestConfirmedTransaction(input: { resource: P2pkhKeyResource; tx: { txid: string; rawTxHex: string; blockHeight?: number; blockHash?: string; blockTime?: number }; expectedGeneration?: number }): Promise<P2pkhTransactionFact> {
      const current = resourceOf(input.resource.resourceId);
      if (current && input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration) throw new Error("P2PKH resource generation changed");
      return ingestConfirmed({ resource: input.resource, tx: input.tx });
    },

    async ingestConfirmedTransactionPage(input: { resource: P2pkhKeyResource; transactions: Array<{ txid: string; rawTxHex: string; blockHeight?: number; blockHash?: string; blockTime?: number }>; syncState: P2pkhTransactionSyncState; reorgCheck?: { observedTxids: string[]; completeHistory: boolean; anchorTxid?: string } }): Promise<void> {
      const snapshot = await chainStore.ingestConfirmed(input.resource, input.transactions.map((tx) => ({ txid: tx.txid, rawTxHex: tx.rawTxHex, blockHeight: tx.blockHeight })));
      const finalSnapshot = input.reorgCheck
        ? await chainStore.applyReorg(input.resource, input.reorgCheck)
        : snapshot;
      reconcileLocalsWithChain(input.resource.resourceId, finalSnapshot);
      syncStates.set(input.resource.resourceId, { ...structuredClone(input.syncState), id: input.resource.resourceId });
    },

    listTransactionFactsPage: async (filter?: { resourceId?: string; network?: BsvNetwork; cursor?: string; limit?: number }) => {
      const resourceId = filter?.resourceId;
      if (!resourceId) return { items: [], nextCursor: undefined };
      const snapshot = chainStore.getSnapshot(resourceId) ?? (await chainStore.hydrate(requireResource(resourceOf, resourceId)));
      const rows = snapshot.facts.filter((row) => !filter?.network || row.network === filter.network);
      return pageRows(rows, (row) => row.txid, filter?.cursor, boundedLimit(filter?.limit) ?? 200);
    },
    listOwnedOutpointsPage: async (filter?: { resourceId?: string; network?: BsvNetwork; chainState?: string; cursor?: string; limit?: number }) => {
      const resourceId = filter?.resourceId;
      if (!resourceId) return { items: [], nextCursor: undefined };
      const snapshot = chainStore.getSnapshot(resourceId) ?? (await chainStore.hydrate(requireResource(resourceOf, resourceId)));
      const rows = snapshot.ownedOutpoints.filter((row) => (!filter?.network || row.network === filter.network) && (!filter?.chainState || row.chainState === filter.chainState));
      return pageRows(rows, (row) => row.outpointKey, filter?.cursor, boundedLimit(filter?.limit) ?? 500);
    },
    listOwnedOutpointValues: async (resourceId: string, outpointKeys: string[]) => {
      const snapshot = chainStore.getSnapshot(resourceId) ?? (await chainStore.hydrate(requireResource(resourceOf, resourceId)));
      const byKey = new Map(snapshot.ownedOutpoints.map((row) => [row.outpointKey, row]));
      const values: Record<string, number> = {};
      for (const key of [...new Set(outpointKeys)]) {
        const row = byKey.get(key);
        if (row) values[key] = row.value;
      }
      return values;
    },
    listTransactionFacts: async (filter?: { resourceId?: string; network?: BsvNetwork; limit?: number }) => {
      const rows: P2pkhTransactionFact[] = [];
      if (filter?.resourceId) {
        const snapshot = chainStore.getSnapshot(filter.resourceId) ?? (await chainStore.hydrate(requireResource(resourceOf, filter.resourceId)));
        rows.push(...snapshot.facts);
      } else {
        for (const resource of resources.values()) {
          const snapshot = chainStore.getSnapshot(resource.resourceId) ?? (await chainStore.hydrate(resource));
          rows.push(...snapshot.facts);
        }
      }
      const filtered = rows.filter((row) => !filter?.network || row.network === filter.network);
      const limit = boundedLimit(filter?.limit);
      return limit ? filtered.slice(0, limit) : filtered;
    },
    listOwnedOutpoints: async (filter?: { resourceId?: string; network?: BsvNetwork; chainState?: string; limit?: number }) => {
      const rows: P2pkhOwnedOutpointProjection[] = [];
      const resourceIds = filter?.resourceId ? [filter.resourceId] : [...resources.keys()];
      for (const resourceId of resourceIds) {
        const snapshot = chainStore.getSnapshot(resourceId) ?? (await chainStore.hydrate(requireResource(resourceOf, resourceId)));
        rows.push(...snapshot.ownedOutpoints);
      }
      const filtered = rows.filter((row) => (!filter?.network || row.network === filter.network) && (!filter?.chainState || row.chainState === filter.chainState));
      const limit = boundedLimit(filter?.limit);
      return limit ? filtered.slice(0, limit) : filtered;
    },
    listTransactionSyncStates: async () => [...syncStates.values()].map((row) => structuredClone(row)),
    getTransactionSyncState: async (id: string) => {
      const row = syncStates.get(id);
      return row ? structuredClone(row) : undefined;
    },
    putTransactionSyncState: async (state: P2pkhTransactionSyncState) => { syncStates.set(state.resourceId, { ...structuredClone(state), id: state.resourceId }); },
    clearInProgressSyncState: async (id: string) => {
      const row = syncStates.get(id);
      if (!row) return;
      syncStates.set(id, { ...row, inProgressProviderId: undefined, inProgressProviderGeneration: undefined, inProgressCursor: undefined, runId: undefined, runHeadTxid: undefined, runObservedTxids: undefined });
    },
    rebuildOwnedOutpoints: async (resourceId?: string) => {
      const targets = resourceId ? [requireResource(resourceOf, resourceId)] : [...resources.values()];
      for (const resource of targets) await chainStore.hydrate(resource);
    },

    listLocalTransactions: async (resourceId?: string, limit?: number) => {
      const rows = localRowsOfResource(resourceId).map((row) => structuredClone(row));
      const size = boundedLimit(limit);
      return size ? rows.slice(0, size) : rows;
    },
    listLocalOutpoints: async (resourceId?: string, limit?: number) => {
      const rows = localOutpointRows(resourceId).map((row) => structuredClone(row));
      const size = boundedLimit(limit);
      return size ? rows.slice(0, size) : rows;
    },
    listLocalTransactionsPage: async (filter?: { resourceId?: string; cursor?: string; limit?: number }) => {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      return pageRows(localRowsOfResource(filter.resourceId), (row) => row.id, filter.cursor, boundedLimit(filter.limit) ?? 500);
    },
    listLocalOutpointsPage: async (filter?: { resourceId?: string; cursor?: string; limit?: number }) => {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      return pageRows(localOutpointRows(filter.resourceId), (row) => row.id, filter.cursor, boundedLimit(filter.limit) ?? 500);
    },
    listLocalInputClaimsPage: async (filter?: { resourceId?: string; cursor?: string; limit?: number }) => {
      if (!filter?.resourceId) return { items: [], nextCursor: undefined };
      return pageRows(claimRows(filter.resourceId), (row) => row.id, filter.cursor, boundedLimit(filter.limit) ?? 500);
    },

    async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims: P2pkhLocalInputClaim[]; localOutpoints: P2pkhLocalOutpoint[] }): Promise<void> {
      const now = new Date().toISOString();
      const affected = new Set<string>(input.localOutpoints.map((output) => `${output.txid}:${output.vout}`));
      for (const claim of input.claims) {
        const id = claim.id || claimId(claim.resourceId, claim.txid, claim.vout);
        const existing = localClaims.get(id);
        if (existing && existing.submissionId !== claim.submissionId && !["released", "confirmed"].includes(existing.state)) {
          throw new Error(`P2PKH input already claimed: ${claim.txid}:${claim.vout}`);
        }
        const outpointKey = `${claim.txid}:${claim.vout}`;
        affected.add(outpointKey);
        localClaims.set(id, { ...structuredClone(claim), id, state: "active", outpointKey, createdAt: existing?.createdAt ?? claim.createdAt, updatedAt: now });
        for (const parent of localOutpointRows(claim.resourceId)) {
          if (parent.txid === claim.txid && parent.vout === claim.vout && parent.submissionId !== claim.submissionId && parent.state === "available") parent.state = "claimed";
        }
      }
      localTransactions.set(input.submission.id, { ...structuredClone(input.submission), localState: "submitting", chainResolution: "unresolved" });
      for (const output of input.localOutpoints) localOutpoints.set(output.id, { ...structuredClone(output), state: "unavailable" });
      normalizeLocalOutputGroups(input.submission.resourceId, affected);
    },

    async finishLocalSubmission(input: { submissionId: string; localState: "local-confirmed" | "isolated"; reason?: string; attempt?: unknown }): Promise<void> {
      const now = new Date().toISOString();
      const row = localTransactions.get(input.submissionId);
      if (!row) throw new Error("Local submission not found");
      const chainTruth = row.chainResolution === "chain-confirmed" || row.chainResolution === "conflicted";
      if (chainTruth) {
        // 同步已定真值：迟到的广播结果只能追加审计,不能改写状态。
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
      const affected = new Set(row.inputOutpointKeys);
      for (const output of localOutpointRows(row.resourceId)) {
        if (output.submissionId !== input.submissionId) continue;
        affected.add(`${output.txid}:${output.vout}`);
        output.state = row.localState === "local-confirmed" ? "available" : "isolated";
        output.updatedAt = now;
      }
      const consumedParentState = row.localState === "local-confirmed" ? "claimed" : "isolated";
      for (const outpointKey of row.inputOutpointKeys) {
        for (const parent of localOutpointRows(row.resourceId)) {
          if (`${parent.txid}:${parent.vout}` === outpointKey && parent.submissionId !== row.id && parent.state === "available") {
            parent.state = consumedParentState;
            parent.updatedAt = now;
          }
        }
      }
      for (const claim of claimRows(row.resourceId)) {
        if (claim.submissionId !== input.submissionId) continue;
        claim.state = row.localState === "isolated" ? "isolated" : "active";
        claim.updatedAt = now;
      }
      normalizeLocalOutputGroups(row.resourceId, affected);
    },

    async abortUnattemptedLocalSubmission(input: { submissionId: string; reason?: string; requestKind: "initial" | "rebroadcast" }): Promise<void> {
      if (input.requestKind !== "initial") return;
      const now = new Date().toISOString();
      const row = localTransactions.get(input.submissionId);
      const attempts = row && Array.isArray(row.attempts) ? row.attempts : [];
      if (!row || row.chainResolution !== "unresolved" || attempts.length > 0 || (row.localState !== "prepared" && row.localState !== "submitting")) return;
      const affected = new Set(row.inputOutpointKeys);
      for (const output of [...localOutpoints.values()]) {
        if (output.resourceId !== row.resourceId || output.submissionId !== row.id) continue;
        affected.add(`${output.txid}:${output.vout}`);
        localOutpoints.delete(output.id);
      }
      for (const outpointKey of row.inputOutpointKeys) {
        for (const parent of localOutpointRows(row.resourceId)) {
          if (`${parent.txid}:${parent.vout}` === outpointKey && parent.submissionId !== row.id && parent.state === "claimed") {
            parent.state = "available";
            parent.updatedAt = now;
          }
        }
      }
      localTransactions.delete(input.submissionId);
      for (const claim of [...localClaims.values()]) {
        if (claim.resourceId === row.resourceId && claim.submissionId === input.submissionId) localClaims.delete(claim.id);
      }
      normalizeLocalOutputGroups(row.resourceId, affected);
    },

    listUtxos: async (): Promise<P2pkhUtxo[]> => {
      const rows: P2pkhUtxo[] = [];
      for (const resource of resources.values()) {
        const snapshot = chainStore.getSnapshot(resource.resourceId) ?? (await chainStore.hydrate(resource));
        rows.push(...snapshot.utxos);
      }
      return rows;
    },
    listUtxosByResource: async (id: string): Promise<P2pkhUtxo[]> => {
      const snapshot = chainStore.getSnapshot(id) ?? (await chainStore.hydrate(requireResource(resourceOf, id)));
      return snapshot.utxos.map((utxo) => structuredClone(utxo));
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
      for (const value of input.inputs) {
        const id = claimId(input.resourceId, value.txid, value.vout);
        const existing = localClaims.get(id);
        if (existing && existing.submissionId !== input.submissionId && !["released", "confirmed"].includes(existing.state)) {
          throw new Error(`P2PKH input already claimed: ${value.txid}:${value.vout}`);
        }
        localClaims.set(id, {
          id,
          submissionId: input.submissionId,
          resourceId: input.resourceId,
          publicKeyHex: input.publicKeyHex,
          network: input.network,
          txid: value.txid,
          vout: value.vout,
          state: "active",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          outpointKey: `${value.txid}:${value.vout}`,
        });
        ids.push(id);
      }
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

    clearUtxosForResource: async (id: string) => {
      const resource = resourceOf(id);
      if (resource) await chainStore.hydrate(resource);
    },
    clearAll: async () => {
      resources.clear();
      localTransactions.clear();
      localOutpoints.clear();
      localClaims.clear();
      protocolSubmissions.clear();
      syncStates.clear();
      chainStore.clearAll();
    },
  };
}

function requireResource(finder: (id: string) => P2pkhKeyResource | undefined, id: string): P2pkhKeyResource {
  const resource = finder(id);
  if (!resource) throw new Error(`P2PKH resource is not registered: ${id}`);
  return resource;
}

export type P2pkhStateRepositoryHandle = ReturnType<typeof createP2pkhStateRepository>;
export function resourceIdFor(network: BsvNetwork): string { return makeResourceId(network); }
export function localInputClaimIdFor(resourceId: string, txid: string, vout: number): string { return claimId(resourceId, txid, vout); }
export { outpointId, utxoFromOutpoint };
