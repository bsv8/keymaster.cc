// BitFS 同 Seed 下载计划：跨卖家共用唯一 Block 归属与每池付款预算。

import type { OwnerFileStore } from "@keymaster/contracts";

const FORMAT = "keymaster.bitfs-buyer-download-plan";
const VERSION = 2;
const locks = new Map<string, Promise<void>>();

/** 同一文件内一个卖家费用池的付款预算与调度状态。 */
export interface BitfsBuyerDownloadPool {
  /** 买卖会话编号。 */
  sessionId: string;
  /** 报价中的卖家公钥。 */
  sellerPublicKeyHex: string;
  /** 完整 Block 单价，单位聪。 */
  fullBlockPriceSatoshis: string;
  /** 报价中的 Seed 单价，单位聪。 */
  seedPriceSatoshis: string;
  /** 本池可付 Seed/Block 的最高金额，不含矿工费。 */
  contentBudgetSatoshis: string;
  /** 专用于本池可能购买 Seed 的预算；一个下载计划仍只会认领一次 Seed。 */
  seedBudgetSatoshis: string;
  /** 本池已预留 Seed 报价金额；用于 Seed 报价为零时仍能明确授权唯一费用池。 */
  seedBudgetReserved: boolean;
  /** 专用于本池购买 Block 的预算，不含 Seed 预算。 */
  blockBudgetSatoshis: string;
  /** 已由本地 Kind 5/7 验收的 Seed 付款，单位聪。 */
  seedCommittedSatoshis: string;
  /** 已由本地 Kind 5/7 验收的 Block 付款，单位聪。 */
  blockCommittedSatoshis: string;
  /** 本池已由本地 Kind 5/7 验收的累计内容付款，单位聪。 */
  committedSatoshis: string;
  /** 最近已验收速度，单位字节/秒；没有样本时为 null。 */
  recentBytesPerSecond: string | null;
  /** FundingTx 已确认且本池可以请求内容时为 true。 */
  active: boolean;
  /** 费用池已确认关闭或退款时为 true。 */
  closed: boolean;
  /** 本池当前批次的首个 Block；其余认领由 blocks 中的 sessionId 归属恢复。 */
  inFlightBlockHashHex?: string;
}

/** 同 Seed 跨卖家下载计划的公开摘要。 */
export interface BitfsBuyerDownloadPlanSnapshot {
  /** Seed 验收后登记的唯一 Block Hash 列表；Seed 尚未付款时为 null。 */
  blockHashesHex: string[] | null;
  /** 已由本地 Kind 5/7 验收付款的不同 Block 数量。 */
  completedBlockCount: number;
  /** Seed 及其本地 Kind 5/7 付款已验收时为 true。 */
  seedCompleted: boolean;
  /** 文件取消后已暂停所有新 Seed/Block 请求时为 true。 */
  stopRequested: boolean;
  /** 文件的不同 Block 数量；Seed 未验收时为 null。 */
  totalBlockCount: number | null;
  /** 已登记的卖家费用池。 */
  pools: BitfsBuyerDownloadPool[];
}

/** 持久化的同 Seed 多卖家计划操作。 */
export interface BitfsBuyerDownloadPlan {
  /** 固定该卖家池的预算和身份；重试值必须一致。 */
  registerPool(input: Omit<BitfsBuyerDownloadPool, "committedSatoshis" | "seedCommittedSatoshis" | "blockCommittedSatoshis" | "active" | "closed">): Promise<void>;
  /** FundingTx 被 WOC 接受后启用卖家池。 */
  activatePool(sessionId: string): Promise<void>;
  /** 按当前价格/速度优先规则认领唯一 Seed。 */
  claimSeed(sessionId: string, priority: "price" | "recent-speed"): Promise<"assigned" | "waiting" | "completed" | "stopped">;
  /** 文件取消前持久化停止栅栏；已签名付款仍需先完成结算。 */
  requestStop(): Promise<void>;
  /** 所有费用池确认关闭后，允许显式重新开始未完成的文件下载。 */
  resumeAfterCancellation(): Promise<void>;
  /** Seed 付款由本地 Kind 5/7 验收后记账。 */
  completeSeed(sessionId: string, paidSatoshis: string): Promise<void>;
  /** 固定由已验收 Seed 算出的不同 Block Hash 列表。 */
  setBlockHashes(blockHashesHex: readonly string[]): Promise<void>;
  /** 按预算与优先级认领一个尚未购买的 Block。 */
  claimNextBlock(sessionId: string, priority: "price" | "recent-speed"): Promise<string | undefined>;
  /** 原子认领一个有界批次；重试返回当前池已认领的同一批 Hash。 */
  claimNextBlocks(sessionId: string, priority: "price" | "recent-speed", limit: number): Promise<string[]>;
  /** Block 付款由本地 Kind 5/7 验收后标为全局完成。 */
  completeBlock(sessionId: string, blockHashHex: string, paidSatoshis: string): Promise<void>;
  /** 一笔 Kind 7 原子验收整批 Block，避免部分完成后误发下一批。 */
  completeBlocks(sessionId: string, blocks: readonly { blockHashHex: string; paidSatoshis: string }[]): Promise<void>;
  /** 池关闭/退款确认后释放该池未完成的认领。 */
  closePool(sessionId: string): Promise<void>;
  /** 读取当前计划快照。 */
  snapshot(): Promise<BitfsBuyerDownloadPlanSnapshot>;
}

interface StoredPlan {
  /** 记录格式标识。 */
  format: typeof FORMAT;
  /** 记录版本。 */
  version: typeof VERSION;
  /** 当前 Key 公钥。 */
  ownerPublicKeyHex: string;
  /** 文件 Seed Hash。 */
  seedHashHex: string;
  /** 报价绑定的文件大小，单位字节。 */
  fileSizeBytes: string;
  /** 报价绑定的建议文件名。 */
  recommendedFilename: string;
  /** 唯一 Seed 买家池会话编号。 */
  seedOwnerSessionId?: string;
  /** Seed 已验收且其付款已由本地 Kind 5/7 验收时为 true。 */
  seedCompleted: boolean;
  /** Seed 检验后得出的不同 Block Hash 顺序。 */
  blockHashesHex?: string[];
  /** 每个 Block 的独占认领或已付款归属。 */
  blocks: Record<string, { sessionId: string; state: "claimed" | "completed"; paidSatoshis?: string }>;
  /** 全部不同 Block 已验收付款时为 true。 */
  fileComplete: boolean;
  /** 已请求取消整份文件，禁止产生新的 Seed/Block 请求。 */
  stopRequested: boolean;
  /** CAS 修订号。 */
  revision: number;
  /** 卖家调度优先级。 */
  priority: "price" | "recent-speed";
  /** 当前 Seed 已登记的卖家池。 */
  pools: Record<string, BitfsBuyerDownloadPool>;
}

/** 创建当前 Owner + Seed 的下载计划。 */
export function createBitfsBuyerDownloadPlan(input: {
  /** 当前 Key 公钥。 */
  ownerPublicKeyHex: string;
  /** 文件 Seed Hash。 */
  seedHashHex: string;
  /** 报价绑定的文件大小，单位字节。 */
  fileSizeBytes: string;
  /** 报价绑定的文件名。 */
  recommendedFilename: string;
  /** 买方 BitFS journal 专用文件存储。 */
  store: OwnerFileStore;
}): BitfsBuyerDownloadPlan {
  const owner = assertKey(input.ownerPublicKeyHex);
  const seed = assertHash(input.seedHashHex);
  const size = assertAmount(input.fileSizeBytes, true);
  const path = `download-plans/${seed}.json`;
  const lockKey = `${owner}:${seed}`;

  const read = async (): Promise<{ plan: StoredPlan; etag?: string } | undefined> => {
    const object = await input.store.get(path);
    if (!object) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
    catch { throw new Error("BitFS 同 Seed 下载计划损坏"); }
    return { plan: validate(raw, owner, seed, size, input.recommendedFilename), ...(object.etag ? { etag: object.etag } : {}) };
  };
  const fresh = (): StoredPlan => ({
    format: FORMAT, version: VERSION, ownerPublicKeyHex: owner, seedHashHex: seed,
    fileSizeBytes: size, recommendedFilename: input.recommendedFilename,
    seedCompleted: false, blocks: {}, fileComplete: false, stopRequested: false, revision: 1,
    priority: "price", pools: {},
  });
  const mutate = async <T>(fn: (plan: StoredPlan) => { plan: StoredPlan; result: T }): Promise<T> => {
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(lockKey, current);
    await previous;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const stored = await read();
        const base = stored?.plan ?? fresh();
        const changed = fn(structuredClone(base));
        changed.plan.revision = base.revision + 1;
        const encoded = new TextEncoder().encode(`${JSON.stringify(changed.plan)}\n`);
        try {
          await input.store.put(path, encoded, stored
            ? stored.etag ? { ifMatch: stored.etag } : {}
            : { ifNoneMatch: "*" });
        } catch { continue; }
        const after = await read();
        const afterObject = await input.store.get(path);
        if (after?.plan.revision === changed.plan.revision && afterObject && sameBytes(afterObject.bytes, encoded)) return changed.result;
      }
      throw new Error("BitFS 下载计划并发修改冲突；已停止内容分配以避免重复付款");
    } finally {
      release();
      if (locks.get(lockKey) === current) locks.delete(lockKey);
    }
  };
  const load = async (): Promise<StoredPlan> => (await read())?.plan ?? fresh();

  return {
    async registerPool(value) {
      const id = assertSession(value.sessionId);
      const seller = assertKey(value.sellerPublicKeyHex);
      const blockPrice = assertAmount(value.fullBlockPriceSatoshis, true);
      const seedPrice = assertAmount(value.seedPriceSatoshis, false);
      const budget = assertAmount(value.contentBudgetSatoshis, true);
      const seedBudget = assertAmount(value.seedBudgetSatoshis, false);
      const blockBudget = assertAmount(value.blockBudgetSatoshis, true);
      if (typeof value.seedBudgetReserved !== "boolean") throw new Error("BitFS Seed 预算授权状态无效");
      if (BigInt(seedBudget) + BigInt(blockBudget) !== BigInt(budget)
        || (value.seedBudgetReserved && BigInt(seedBudget) < BigInt(seedPrice))
        || (!value.seedBudgetReserved && BigInt(seedBudget) !== 0n)) {
        throw new Error("BitFS Seed 与 Block 预算拆分无效");
      }
      const speed = value.recentBytesPerSecond === null ? null : assertAmount(value.recentBytesPerSecond, false);
      await mutate((plan) => {
        const previous = plan.pools[id];
        if (previous && (previous.sellerPublicKeyHex !== seller || previous.fullBlockPriceSatoshis !== blockPrice
          || previous.seedPriceSatoshis !== seedPrice || previous.contentBudgetSatoshis !== budget
          || previous.seedBudgetSatoshis !== seedBudget || previous.seedBudgetReserved !== value.seedBudgetReserved
          || previous.blockBudgetSatoshis !== blockBudget)) {
          throw new Error("BitFS 同一池预算已固定；拒绝替换卖家或金额");
        }
        plan.pools[id] = {
          sessionId: id, sellerPublicKeyHex: seller, fullBlockPriceSatoshis: blockPrice,
          seedPriceSatoshis: seedPrice, contentBudgetSatoshis: budget,
          seedBudgetSatoshis: seedBudget, seedBudgetReserved: value.seedBudgetReserved,
          blockBudgetSatoshis: blockBudget,
          committedSatoshis: previous?.committedSatoshis ?? "0", recentBytesPerSecond: speed,
          seedCommittedSatoshis: previous?.seedCommittedSatoshis ?? "0",
          blockCommittedSatoshis: previous?.blockCommittedSatoshis ?? "0",
          active: previous?.active ?? false, closed: previous?.closed ?? false,
          ...(previous?.inFlightBlockHashHex ? { inFlightBlockHashHex: previous.inFlightBlockHashHex } : {}),
        };
        return { plan, result: undefined };
      });
    },
    async activatePool(sessionId) {
      await mutate((plan) => {
        const pool = needPool(plan, sessionId);
        if (pool.closed) throw new Error("BitFS 已关闭费用池不能重新启用");
        pool.active = true;
        return { plan, result: undefined };
      });
    },
    async claimSeed(sessionId, priority) {
      return mutate((plan) => {
        plan.priority = priority;
        if (plan.stopRequested) return { plan, result: "stopped" as const };
        if (plan.seedCompleted) return { plan, result: "completed" as const };
        if (plan.seedOwnerSessionId) return { plan, result: plan.seedOwnerSessionId === sessionId ? "assigned" as const : "waiting" as const };
        const winner = sortedPools(plan).find((pool) => pool.active && !pool.closed
          && pool.seedBudgetReserved
          && BigInt(pool.seedCommittedSatoshis) === 0n
          && BigInt(pool.seedBudgetSatoshis) >= BigInt(pool.seedPriceSatoshis));
        if (!winner || winner.sessionId !== sessionId) return { plan, result: "waiting" as const };
        plan.seedOwnerSessionId = sessionId;
        return { plan, result: "assigned" as const };
      });
    },
    async requestStop() {
      await mutate((plan) => {
        plan.stopRequested = true;
        return { plan, result: undefined };
      });
    },
    async resumeAfterCancellation() {
      await mutate((plan) => {
        if (Object.values(plan.pools).some((pool) => !pool.closed)) {
          throw new Error("BitFS 仍有未确认关闭的费用池；不能恢复新的内容请求");
        }
        if (plan.fileComplete) throw new Error("BitFS 文件已完整付款；不能重新开始下载");
        plan.stopRequested = false;
        return { plan, result: undefined };
      });
    },
    async completeSeed(sessionId, paidSatoshis) {
      const paid = assertAmount(paidSatoshis, true);
      await mutate((plan) => {
        if (plan.seedCompleted && plan.seedOwnerSessionId === sessionId) {
          const previous = needPool(plan, sessionId).seedCommittedSatoshis;
          if (previous !== paid) throw new Error("BitFS 重放的 Seed 付款金额与已验收记录不一致");
          return { plan, result: undefined };
        }
        if (plan.seedOwnerSessionId !== sessionId) throw new Error("BitFS Seed 付款未由当前费用池认领");
        const pool = needPool(plan, sessionId);
        if (BigInt(pool.seedCommittedSatoshis) > 0n || BigInt(paid) > BigInt(pool.seedBudgetSatoshis)) {
          throw new Error("BitFS Seed 付款超过本池专用 Seed 预算");
        }
        addPayment(pool, paid);
        pool.seedCommittedSatoshis = paid;
        plan.seedCompleted = true;
        return { plan, result: undefined };
      });
    },
    async setBlockHashes(values) {
      const hashes = [...new Set(values.map(assertHash))];
      if (hashes.length === 0) throw new Error("BitFS Seed 没有文件 Block");
      await mutate((plan) => {
        if (!plan.seedCompleted) throw new Error("BitFS Seed 付款由 Kind 5/7 验收前不能登记 Block");
        if (plan.blockHashesHex && !same(plan.blockHashesHex, hashes)) throw new Error("BitFS 同 Seed 收到冲突的 Block Hash 清单");
        plan.blockHashesHex = hashes;
        plan.fileComplete = hashes.every((hash) => plan.blocks[hash]?.state === "completed");
        return { plan, result: undefined };
      });
    },
    async claimNextBlock(sessionId, priority) {
      return mutate((plan) => {
        plan.priority = priority;
        if (plan.stopRequested) return { plan, result: undefined };
        if (!plan.seedCompleted || !plan.blockHashesHex || plan.fileComplete) return { plan, result: undefined };
        const pool = needPool(plan, sessionId);
        if (!pool.active || pool.closed) return { plan, result: undefined };
        if (pool.inFlightBlockHashHex) return { plan, result: pool.inFlightBlockHashHex };
        const nextPool = sortedPools(plan).find((item) => item.active && !item.closed && !item.inFlightBlockHashHex
          && BigInt(item.blockBudgetSatoshis) - BigInt(item.blockCommittedSatoshis) >= BigInt(item.fullBlockPriceSatoshis));
        if (!nextPool || nextPool.sessionId !== sessionId) return { plan, result: undefined };
        const hash = plan.blockHashesHex.find((item) => !plan.blocks[item]);
        if (!hash) return { plan, result: undefined };
        plan.blocks[hash] = { sessionId, state: "claimed" };
        pool.inFlightBlockHashHex = hash;
        return { plan, result: hash };
      });
    },
    async claimNextBlocks(sessionId, priority, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new Error("BitFS 批次块数必须在 1–16 之间");
      return mutate((plan) => {
        plan.priority = priority;
        if (plan.stopRequested || !plan.seedCompleted || !plan.blockHashesHex || plan.fileComplete) return { plan, result: [] };
        const pool = needPool(plan, sessionId);
        if (!pool.active || pool.closed) return { plan, result: [] };
        const claimed = plan.blockHashesHex.filter((hash) => {
          const block = plan.blocks[hash];
          return block?.sessionId === sessionId && block.state === "claimed";
        });
        if (claimed.length > 0) {
          if (pool.inFlightBlockHashHex !== claimed[0]) throw new Error("BitFS 批次认领与池内状态不一致");
          return { plan, result: claimed };
        }
        if (pool.inFlightBlockHashHex) throw new Error("BitFS 池内首块认领缺失");
        const nextPool = sortedPools(plan).find((item) => item.active && !item.closed && !item.inFlightBlockHashHex
          && BigInt(item.blockBudgetSatoshis) - BigInt(item.blockCommittedSatoshis) >= BigInt(item.fullBlockPriceSatoshis));
        if (!nextPool || nextPool.sessionId !== sessionId) return { plan, result: [] };
        const affordable = Number((BigInt(pool.blockBudgetSatoshis) - BigInt(pool.blockCommittedSatoshis)) / BigInt(pool.fullBlockPriceSatoshis));
        const hashes = plan.blockHashesHex.filter((hash) => !plan.blocks[hash]).slice(0, Math.min(limit, affordable));
        for (const hash of hashes) plan.blocks[hash] = { sessionId, state: "claimed" };
        pool.inFlightBlockHashHex = hashes[0];
        return { plan, result: hashes };
      });
    },
    async completeBlock(sessionId, blockHashHex, paidSatoshis) {
      const hash = assertHash(blockHashHex);
      const paid = assertAmount(paidSatoshis, true);
      await mutate((plan) => {
        const block = plan.blocks[hash];
        if (block?.state === "completed" && block.sessionId === sessionId && block.paidSatoshis === paid) return { plan, result: undefined };
        if (!block || block.sessionId !== sessionId || block.state !== "claimed") throw new Error("BitFS 当前池没有独占认领此 Block");
        const pool = needPool(plan, sessionId);
        if (pool.inFlightBlockHashHex !== hash) throw new Error("BitFS 池内 Block 与下载计划不一致");
        if (BigInt(pool.blockCommittedSatoshis) + BigInt(paid) > BigInt(pool.blockBudgetSatoshis)) {
          throw new Error("BitFS Block 付款超过本池专用 Block 预算");
        }
        addPayment(pool, paid);
        pool.blockCommittedSatoshis = (BigInt(pool.blockCommittedSatoshis) + BigInt(paid)).toString(10);
        pool.inFlightBlockHashHex = undefined;
        plan.blocks[hash] = { sessionId, state: "completed", paidSatoshis: paid };
        plan.fileComplete = plan.blockHashesHex?.every((item) => plan.blocks[item]?.state === "completed") ?? false;
        return { plan, result: undefined };
      });
    },
    async completeBlocks(sessionId, blocks) {
      if (blocks.length < 1 || blocks.length > 16) throw new Error("BitFS 验收批次块数无效");
      const entries = blocks.map(({ blockHashHex, paidSatoshis }) => ({
        hash: assertHash(blockHashHex), paid: assertAmount(paidSatoshis, true),
      }));
      if (new Set(entries.map((entry) => entry.hash)).size !== entries.length) throw new Error("BitFS 批次含重复 Block");
      await mutate((plan) => {
        const pool = needPool(plan, sessionId);
        if (entries.every(({ hash, paid }) => {
          const block = plan.blocks[hash];
          return block?.sessionId === sessionId && block.state === "completed" && block.paidSatoshis === paid;
        })) return { plan, result: undefined };
        const claimed = plan.blockHashesHex?.filter((hash) => {
          const block = plan.blocks[hash];
          return block?.sessionId === sessionId && block.state === "claimed";
        }) ?? [];
        if (pool.inFlightBlockHashHex !== claimed[0] || !same(claimed, entries.map((entry) => entry.hash))) {
          throw new Error("BitFS 验收批次与当前池独占认领不一致");
        }
        const total = entries.reduce((sum, entry) => sum + BigInt(entry.paid), 0n);
        if (BigInt(pool.blockCommittedSatoshis) + total > BigInt(pool.blockBudgetSatoshis)) {
          throw new Error("BitFS 批次付款超过本池专用 Block 预算");
        }
        addPayment(pool, total.toString(10));
        pool.blockCommittedSatoshis = (BigInt(pool.blockCommittedSatoshis) + total).toString(10);
        for (const { hash, paid } of entries) plan.blocks[hash] = { sessionId, state: "completed", paidSatoshis: paid };
        pool.inFlightBlockHashHex = undefined;
        plan.fileComplete = plan.blockHashesHex?.every((hash) => plan.blocks[hash]?.state === "completed") ?? false;
        return { plan, result: undefined };
      });
    },
    async closePool(sessionId) {
      await mutate((plan) => {
        const pool = plan.pools[sessionId];
        if (!pool) return { plan, result: undefined };
        pool.active = false;
        pool.closed = true;
        for (const [hash, claim] of Object.entries(plan.blocks)) {
          if (claim.sessionId === sessionId && claim.state === "claimed") delete plan.blocks[hash];
        }
        pool.inFlightBlockHashHex = undefined;
        if (!plan.seedCompleted && plan.seedOwnerSessionId === sessionId) plan.seedOwnerSessionId = undefined;
        plan.fileComplete = plan.blockHashesHex?.every((hash) => plan.blocks[hash]?.state === "completed") ?? false;
        return { plan, result: undefined };
      });
    },
    async snapshot() {
      const plan = await load();
      return {
        blockHashesHex: plan.blockHashesHex?.slice() ?? null,
        completedBlockCount: Object.values(plan.blocks).filter((item) => item.state === "completed").length,
        seedCompleted: plan.seedCompleted,
        stopRequested: plan.stopRequested,
        totalBlockCount: plan.blockHashesHex?.length ?? null,
        pools: Object.values(plan.pools).sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map((pool) => ({ ...pool })),
      };
    },
  };
}

function validate(value: unknown, owner: string, seed: string, size: string, filename: string): StoredPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 下载计划格式错误");
  const row = value as Record<string, unknown>;
  if (row.format !== FORMAT || row.version !== VERSION || row.ownerPublicKeyHex !== owner || row.seedHashHex !== seed
    || row.fileSizeBytes !== size || row.recommendedFilename !== filename) throw new Error("BitFS 下载计划身份或文件信息冲突");
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || typeof row.seedCompleted !== "boolean"
    || typeof row.fileComplete !== "boolean" || (row.stopRequested !== undefined && typeof row.stopRequested !== "boolean")
    || (row.priority !== "price" && row.priority !== "recent-speed")
    || !objectRecord(row.blocks) || !objectRecord(row.pools)) throw new Error("BitFS 下载计划字段无效");
  const hashes = row.blockHashesHex === undefined ? undefined
    : Array.isArray(row.blockHashesHex) ? row.blockHashesHex.map(assertHash) : invalid("Block Hash 列表无效");
  if (hashes && new Set(hashes).size !== hashes.length) throw new Error("BitFS 下载计划含重复 Block Hash");
  const pools: StoredPlan["pools"] = {};
  for (const [id, rawPool] of Object.entries(row.pools)) pools[id] = parsePool(rawPool, id);
  const blocks: StoredPlan["blocks"] = {};
  for (const [hash, rawBlock] of Object.entries(row.blocks)) {
    assertHash(hash);
    if (!objectRecord(rawBlock)) throw new Error("BitFS Block 归属格式无效");
    const sessionId = assertSession(rawBlock.sessionId);
    if (rawBlock.state === "completed") blocks[hash] = { sessionId, state: "completed", paidSatoshis: assertAmount(rawBlock.paidSatoshis, true) };
    else if (rawBlock.state === "claimed") blocks[hash] = { sessionId, state: "claimed" };
    else throw new Error("BitFS Block 归属状态无效");
  }
  if (hashes && Object.keys(blocks).some((hash) => !hashes.includes(hash))) throw new Error("BitFS 下载计划包含文件之外的 Block");
  if (row.seedCompleted && !row.seedOwnerSessionId) throw new Error("BitFS 下载计划缺少 Seed 付款归属");
  return {
    format: FORMAT, version: VERSION, ownerPublicKeyHex: owner, seedHashHex: seed,
    fileSizeBytes: size, recommendedFilename: filename,
    ...(row.seedOwnerSessionId === undefined ? {} : { seedOwnerSessionId: assertSession(row.seedOwnerSessionId) }),
    seedCompleted: row.seedCompleted, ...(hashes === undefined ? {} : { blockHashesHex: hashes }),
    blocks, fileComplete: row.fileComplete, stopRequested: row.stopRequested === true, revision: row.revision as number,
    priority: row.priority, pools,
  };
}

function parsePool(value: unknown, id: string): BitfsBuyerDownloadPool {
  assertSession(id);
  if (!objectRecord(value) || value.sessionId !== id || typeof value.active !== "boolean" || typeof value.closed !== "boolean") throw new Error("BitFS 下载计划池身份无效");
  if (typeof value.seedBudgetReserved !== "boolean") throw new Error("BitFS Seed 预算授权状态无效");
  if (value.recentBytesPerSecond !== null && typeof value.recentBytesPerSecond !== "string") throw new Error("BitFS 下载计划速度无效");
  const pool: BitfsBuyerDownloadPool = {
    sessionId: id, sellerPublicKeyHex: assertKey(value.sellerPublicKeyHex),
    fullBlockPriceSatoshis: assertAmount(value.fullBlockPriceSatoshis, true),
    seedPriceSatoshis: assertAmount(value.seedPriceSatoshis, false),
    contentBudgetSatoshis: assertAmount(value.contentBudgetSatoshis, true),
    seedBudgetSatoshis: assertAmount(value.seedBudgetSatoshis, false),
    seedBudgetReserved: value.seedBudgetReserved,
    blockBudgetSatoshis: assertAmount(value.blockBudgetSatoshis, true),
    committedSatoshis: assertAmount(value.committedSatoshis, false),
    seedCommittedSatoshis: assertAmount(value.seedCommittedSatoshis, false),
    blockCommittedSatoshis: assertAmount(value.blockCommittedSatoshis, false),
    recentBytesPerSecond: value.recentBytesPerSecond === null ? null : assertAmount(value.recentBytesPerSecond, false),
    active: value.active, closed: value.closed,
    ...(value.inFlightBlockHashHex === undefined ? {} : { inFlightBlockHashHex: assertHash(value.inFlightBlockHashHex) }),
  };
  if (BigInt(pool.seedBudgetSatoshis) + BigInt(pool.blockBudgetSatoshis) !== BigInt(pool.contentBudgetSatoshis)
    || BigInt(pool.committedSatoshis) !== BigInt(pool.seedCommittedSatoshis) + BigInt(pool.blockCommittedSatoshis)
    || BigInt(pool.committedSatoshis) > BigInt(pool.contentBudgetSatoshis)
    || BigInt(pool.seedCommittedSatoshis) > BigInt(pool.seedBudgetSatoshis)
    || BigInt(pool.blockCommittedSatoshis) > BigInt(pool.blockBudgetSatoshis)
    || (pool.seedBudgetReserved && BigInt(pool.seedBudgetSatoshis) < BigInt(pool.seedPriceSatoshis))
    || (!pool.seedBudgetReserved && BigInt(pool.seedBudgetSatoshis) !== 0n)) {
    throw new Error("BitFS 下载计划池预算或付款累计无效");
  }
  return pool;
}

function sortedPools(plan: StoredPlan): BitfsBuyerDownloadPool[] {
  return Object.values(plan.pools).sort((a, b) => {
    const as = a.recentBytesPerSecond === null ? undefined : BigInt(a.recentBytesPerSecond);
    const bs = b.recentBytesPerSecond === null ? undefined : BigInt(b.recentBytesPerSecond);
    if (plan.priority === "recent-speed" && as !== bs) {
      if (as === undefined) return 1;
      if (bs === undefined) return -1;
      return as > bs ? -1 : 1;
    }
    const ap = BigInt(a.fullBlockPriceSatoshis);
    const bp = BigInt(b.fullBlockPriceSatoshis);
    if (ap !== bp) return ap < bp ? -1 : 1;
    if (as !== undefined && bs !== undefined && as !== bs) return as > bs ? -1 : 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

function addPayment(pool: BitfsBuyerDownloadPool, amount: string): void {
  const next = BigInt(pool.committedSatoshis) + BigInt(amount);
  if (next > BigInt(pool.contentBudgetSatoshis)) throw new Error("BitFS 池内内容付款超过已分配预算");
  pool.committedSatoshis = next.toString(10);
}

function needPool(plan: StoredPlan, id: string): BitfsBuyerDownloadPool {
  const pool = plan.pools[assertSession(id)];
  if (!pool) throw new Error("BitFS 卖家费用池未登记到下载计划");
  return pool;
}

function assertSession(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(value)) throw new TypeError("BitFS 计划会话编号无效");
  return value;
}
function assertHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("BitFS 计划 Hash 无效");
  return value;
}
function assertKey(value: unknown): string {
  if (typeof value !== "string" || !/^(?:02|03)[0-9a-f]{64}$/u.test(value)) throw new TypeError("BitFS 计划公钥无效");
  return value;
}
function assertAmount(value: unknown, positive: boolean): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value) || (positive && BigInt(value) === 0n)) throw new TypeError("BitFS 计划聪金额无效");
  return value;
}
function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function same(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function invalid(message: string): never { throw new Error(message); }
