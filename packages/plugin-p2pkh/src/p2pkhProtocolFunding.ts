// P2PKH 侧的协议专用资金能力。
//
// 协议交易不能直接花钱包的大额余额：差额会变成矿工费。这里的做法是先用一笔
// **普通** P2PKH 资金准备交易（含正常找零）拆出一个金额已知的单输入专用 UTXO，
// 之后的协议交易只花这一个 UTXO 且不带找零。
//
// 关键点：
//   - 生产 Worker 选币由同一 UTXO manager 的只读计划提供；签名前仍须
//     原子持有 protocol intent，不能以计划代替占用或回退旧 allocator；
//   - 资金准备交易提供 changeAddress，所以余额差走找零而不是矿工费；
//   - 产出的专用 UTXO 立即登记为受保护输出，普通转账不能误花；
//   - 同一个 fundingId 只对应一笔专用资金，重复准备返回同一个 UTXO；
//   - **写前日志**：fundingId、submissionId、raw 与 outpoint 在广播之前就落盘，
//     崩溃后据此对账原提交，而不是重新拆一次钱。

import {
  classifyProtocolSpendResult,
  estimateProtocolFundingMinerFee,
  type ProtectedOutpointRegistry,
  type ProtocolDedicatedFunding,
  type ProtocolDedicatedFundingState,
  type ProtocolFundingService,
  type ProtocolSubmissionObservation,
  type ProtocolSpendPreview,
  type ProtocolSpendService,
} from "@keymaster/contracts";

import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import { FUNDING_ID_SEGMENT } from "./storage/p2pkhFileFormats.js";

/**
 * 磁盘形态比运行时多三个字段。
 *
 * `ownerPublicKeyHex` 与 `network` 是恢复与保护的判据：没有 owner，生产存储的
 * owner 校验会拒绝保存这份写前日志；没有 network，恢复时只能按当前设置猜网络，
 * 开启测试网就会把主网资金也按测试网观察与保护。
 *
 * `supersededBy` 表示这笔资金已被新一笔替代但**尚未回收**：它的 UTXO 还在链上、
 * 仍属于用户，因此保护必须保留到显式回收为止。
 */
export interface ProtocolFundingStoredRecord extends ProtocolDedicatedFunding {
  readonly ownerPublicKeyHex: string;
  readonly network: "main" | "test";
  readonly ownerPluginId?: string;
  /** 被哪一笔资金替代（新的 fundingId）。存在即表示旧记录仅供恢复与回收。 */
  readonly supersededBy?: string;
}

export interface ProtocolFundingStore {
  get(fundingId: string, ownerPublicKeyHex: string): Promise<ProtocolFundingStoredRecord | undefined>;
  /**
   * 写记录。
   *
   * `ifAbsent` 用于创建竞态：写前日志必须「不存在才创建」，否则两个页面会互相
   * 覆盖同一笔资金的证据。已有记录时上层用 `get` 先读再判断，不靠这个参数更新。
   */
  put(record: ProtocolFundingStoredRecord, options?: { ifAbsent?: true }): Promise<void>;
  delete(fundingId: string): Promise<void>;
  /**
   * 列出全部记录并恢复保护登记。
   *
   * `unreadable` 非空说明磁盘上有记录但读不出来：此时必须拒绝准备新资金，
   * 因为那笔资金的 UTXO 可能已经在链上。
   */
  list(ownerPublicKeyHex: string): Promise<{ records: readonly ProtocolFundingStoredRecord[]; unreadable: readonly string[] }>;
}

/**
 * 受保护输出登记。
 *
 * 直接复用 contracts 里的 `ProtectedOutpointRegistry` 形状，而不是在这里另写一份
 * 近似类型：另写一份迟早会和真正的 provider 形状漂移。
 */
export type ProtocolFundingProtectedOutpoints = Pick<ProtectedOutpointRegistry, "register" | "unregister">;

export interface CreateProtocolFundingServiceDeps {
  binding: { readonly identity: { publicKeyHex: string; bsvNetwork: "main" | "test" }; assertActive(): void };
  /** 受控协议 spend：构造并签名资金准备交易。 */
  protocolSpend(): ProtocolSpendService | undefined;
  protectedOutpoints: ProtocolFundingProtectedOutpoints;
  store: ProtocolFundingStore;
  now?(): number;
  /** 枚举并分配钱包 UTXO；金额单位为 number，越界必须由调用方拒绝。 */
  allocate(input: { assetId: "bsv" | "bsvtest"; amountSatoshis: number; feeReserveSatoshis: number; feeRateSatoshisPerKb: number }): Promise<{
    selected: { txid: string; vout: number; value: number; address: string; previousTransactionHex?: string }[];
    totalInputSatoshis: number;
  }>;
  /** 派发后观察一笔已广播交易的链上状态。 */
  observeChain(network: "main" | "test", txid: string): Promise<ProtocolDedicatedFundingState>;
  /**
   * 按 outpoint 观察这个**具体 UTXO** 是否已被花费。
   *
   * 与 `observeChain` 的差别是回收路径的关键：交易还在链上不代表这个输出还在。
   * 只看交易会把「资金交易已确认、UTXO 已被协议交易花掉」误判成可回收，从而构造
   * 一笔双花。缺席时回收必须拒绝。
   */
  observeOutpoint?(input: { network: "main" | "test"; txid: string; vout: number }): Promise<"spent" | "unspent" | "unknown">;
  /**
   * 按持久提交编号观察广播结果；缺席时恢复路径不能猜测原提交是否派发。
   *
   * 恢复的唯一依据是**同一个**提交，绝不重建、绝不二次派发。
   */
  observeSubmission?(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    txid: string;
    submissionId: string;
  }): Promise<ProtocolSubmissionObservation>;
  /** 由 Vault 派生的当前 owner 找零地址。 */
  deriveChangeAddress(ownerPublicKeyHex: string, network: "main" | "test"): Promise<string>;
}

export const PROTOCOL_FUNDING_PROTECTION_KIND = "protocol-dedicated-funds";

/** 资金准备失败的稳定错误类型；恢复路径用它区分「可重试」与「必须先对账」。 */
export class ProtocolFundingError extends Error {
  constructor(
    readonly code:
      | "funding-state-unknown"
      | "funding-rejected"
      | "funding-observation-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolFundingError";
  }
}

export function createProtocolFundingService(deps: CreateProtocolFundingServiceDeps): ProtocolFundingService {
  const binding = deps.binding;
  binding.assertActive();
  const identity = { ownerPublicKeyHex: binding.identity.publicKeyHex.toLowerCase(), network: binding.identity.bsvNetwork };
  const scoped = <T extends object>(request: T) => {
    binding.assertActive();
    if ("ownerPublicKeyHex" in request || "network" in request) throw new TypeError("Funding requests cannot select a wallet");
    return { ...structuredClone(request), ...identity };
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    binding.assertActive(); const value = await operation(); binding.assertActive(); return value;
  };
  const original = deps;
  deps = { ...deps,
    store: {
      get: (...args) => run(() => original.store.get(...args)),
      put: (...args) => run(() => original.store.put(...args)),
      delete: (...args) => run(() => original.store.delete(...args)),
      list: (...args) => run(() => original.store.list(...args)),
    },
    allocate: input => run(() => original.allocate(input)),
    deriveChangeAddress: (...args) => run(() => original.deriveChangeAddress(...args)),
    observeChain: (...args) => run(() => original.observeChain(...args)),
    ...(original.observeOutpoint ? { observeOutpoint: input => run(() => original.observeOutpoint!(input)) } : {}),
    ...(original.observeSubmission ? { observeSubmission: input => run(() => original.observeSubmission!(input)) } : {}),
  };
  const now = deps.now ?? Date.now;
  const protectionId = (fundingId: string): string => `protocol-funding:${fundingId}`;

  /** 记录必须属于当前 owner 才可复用；别的身份的记录一律当作不存在。 */
  const ownedRecord = (record: ProtocolFundingStoredRecord | undefined, ownerPublicKeyHex: string): ProtocolFundingStoredRecord | undefined => {
    if (record === undefined) return undefined;
    if (record.ownerPublicKeyHex !== undefined && record.ownerPublicKeyHex.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) {
      return undefined;
    }
    return record;
  };

  /**
   * 登记（并幂等重申）专用 UTXO 的保护。
   *
   * 保护登记是纯内存状态：重启后必须重新登记，否则普通选币会把协议专用资金当成
   * 可用余额花掉。恢复路径返回已有记录时同样要过这里。
   */
  // Provider ID 在注册表中必须唯一；复用可变 provider，刷新时保留现有 claim。
  const protections = new Map<string, {
    outpoint: ReturnType<ProtectedOutpointRegistry["list"]>[number];
    listeners: Set<() => void>;
  }>();
  const ensureProtection = (record: ProtocolFundingStoredRecord, input: { ownerPublicKeyHex: string; network: "main" | "test"; ownerPluginId?: string; protectionReason?: string }): void => {
    binding.assertActive();
    const ownerPluginId = record.ownerPluginId ?? input.ownerPluginId ?? (record.fundingId.startsWith("forum:") ? "forum" : "protocol");
    const id = protectionId(record.fundingId);
    const outpoint = {
      txid: record.txid, vout: record.vout, network: record.network,
      ownerPluginId, publicKeyHex: record.ownerPublicKeyHex,
      kind: PROTOCOL_FUNDING_PROTECTION_KIND,
      reason: input.protectionReason ?? `协议专用资金 ${record.fundingId}`,
    };
    const existing = protections.get(id);
    if (existing !== undefined) {
      existing.outpoint = outpoint;
      for (const listener of existing.listeners) listener();
      return;
    }
    const entry = { outpoint, listeners: new Set<() => void>() };
    binding.assertActive();
    deps.protectedOutpoints.register({
      id, ownerPluginId,
      listProtectedOutpoints: () => [entry.outpoint],
      onChange: (listener) => {
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
      },
    });
    protections.set(id, entry);
  };
  const removeProtection = (fundingId: string): void => {
    binding.assertActive();
    deps.protectedOutpoints.unregister(protectionId(fundingId));
    protections.delete(protectionId(fundingId));
  };

  const withRecord = (
    base: Omit<ProtocolFundingStoredRecord, "broadcastState" | "updatedAtMs">,
    state: ProtocolDedicatedFunding["broadcastState"],
  ): ProtocolFundingStoredRecord => ({
    ...base,
    broadcastState: state,
    updatedAtMs: now(),
  });

  return {
    estimateFundingMinerFee(input) {
      binding.assertActive();
      return estimateProtocolFundingMinerFee(
        parseAmount(input.requiredSatoshis, "requiredSatoshis"),
        input.feeRateSatoshisPerKb,
      ).toString();
    },

    /**
     * 启动时恢复全部专用资金的保护登记。
     *
     * 保护是内存态，重启后必须主动重建：否则在用户做任何 Forum 操作之前，一次普通
     * P2PKH 转账就可能把仍挂着的专用 UTXO 当可用余额花掉。
     *
     * 判据只有一条：**能否证明它已被花费**。链上状态未知时必须继续保护——「查不到」
     * 不是「不存在」，按不存在处理会让一次网络抖动变成用户的静默资金损失。
     */
    async restoreProtections(...args: []) {
      if (args.length) throw new TypeError("Protection restore does not accept wallet selectors");
      const input = scoped({});
      const known = await deps.store.list(input.ownerPublicKeyHex);
      let restored = 0;
      for (const record of known.records) {
        if (record.ownerPublicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) continue;
        // 明确被拒：交易没进网络，UTXO 不存在，可以不保护。
        if (record.broadcastState === "rejected") continue;
        // 按记录自己的网络观察：`bsvNetwork` 这类设置不是记录的网络。
        const state = await deps.observeChain(record.network, record.txid).catch(() => "unknown" as const);
        if (state === "spent") {
          // 已证明被花费：UTXO 不存在，解除保护。
          removeProtection(record.fundingId);
          continue;
        }
        ensureProtection(record, { ...input, network: record.network });
        restored += 1;
      }
      if (known.unreadable.length > 0) {
        throw new ProtocolFundingError("funding-state-unknown", `专用资金记录无法读取：${known.unreadable.join("、")}，暂停选币`);
      }
      return { restored, unreadable: known.unreadable };
    },

    /**
     * 调用方已有资金记录时的核对入口。
     *
     * 直接返回调用方记录会绕过两件事：链上状态核对（已花费的 UTXO 不能复用）与
     * 保护登记恢复（重启后保护是空的）。因此复用必须经过这里。
     */
    async reconcileDedicatedFunding(request) {
      const input = scoped(request);
      const known = await deps.store.list(input.ownerPublicKeyHex);
      const record = ownedRecord(known.records.find((candidate) => candidate.fundingId === input.fundingId), input.ownerPublicKeyHex);
      if (record === undefined) {
        return { state: "unknown", usable: false, reason: known.unreadable.includes(input.fundingId) ? "记录无法读取" : "记录不存在" };
      }
      if (record.network !== input.network || record.txid !== input.txid || record.vout !== input.vout) {
        return { state: "unknown", usable: false, reason: "记录与请求的 outpoint 不一致" };
      }
      // 被替代但未回收的记录不可复用：它的 UTXO 归新的那笔，本笔只作恢复与回收用。
      if (record.supersededBy !== undefined) {
        return { state: "unknown", usable: false, reason: `该记录已被 ${record.supersededBy} 替代，不可复用` };
      }
      const state = await deps.observeChain(record.network, record.txid).catch(() => "unknown" as const);
      if (state === "spent") return { state, usable: false, reason: "专用资金已被花费" };
      if (state === "unknown") return { state, usable: false, reason: "链上状态未知" };
      if (!coversRequired(record, parseAmount(input.requiredSatoshis, "requiredSatoshis"))) {
        return { state, usable: false, reason: `已有资金 ${record.valueSatoshis} sat 不足 ${input.requiredSatoshis} sat` };
      }
      // 复用之前重申保护：重启后它是空的。
      ensureProtection(record, { ...input, network: record.network });
      return { state, usable: true };
    },

    async prepareDedicatedFunding(request) {
      const input = scoped(request);
      const required = parseAmount(input.requiredSatoshis, "requiredSatoshis");
      let currentId = input.fundingId;
      const visited = new Set<string>();
      for (let step = 0; step < 192; step += 1) {
        if (visited.has(currentId)) throw new ProtocolFundingError("funding-state-unknown", "专用资金后继记录存在循环");
        const known = await deps.store.list(input.ownerPublicKeyHex);
        if (known.unreadable.length > 0) {
          throw new ProtocolFundingError("funding-state-unknown", `存在无法读取的专用资金记录（${known.unreadable.join("、")}）`);
        }
        const existing = ownedRecord(known.records.find((record) => record.fundingId === currentId), input.ownerPublicKeyHex);
        if (existing === undefined) return createNew({ ...input, fundingId: currentId }, required);
        if (existing.network !== input.network) throw new ProtocolFundingError("funding-state-unknown", "专用资金网络不匹配");
        if (existing.supersededBy !== undefined) {
          visited.add(currentId);
          currentId = existing.supersededBy;
          continue;
        }
        const resolved = await resolveExisting(existing, input);
        if (resolved.kind === "reusable") {
          ensureProtection(resolved.record, { ...input, network: resolved.record.network });
          if (!coversRequired(resolved.record, required)) {
            const successor = nextFundingId(currentId);
            await supersede(existing, successor);
            visited.add(currentId);
            currentId = successor;
            continue;
          }
          return resolved.record;
        }
        await discard(existing);
        // 明确未派发或已花费：仍按这个编号重新准备，创建条件写处理竞争。
      }
      throw new ProtocolFundingError("funding-state-unknown", "专用资金后继记录超出恢复上限");
    },

    async observeDedicatedFunding(request) {
      const input = scoped(request);
      const record = ownedRecord(await deps.store.get(input.fundingId, input.ownerPublicKeyHex), input.ownerPublicKeyHex);
      // 记录必须对上 outpoint，否则不返回猜测状态。
      if (record === undefined || record.network !== input.network || record.txid !== input.txid || record.vout !== input.vout) return "unknown";
      return deps.observeChain(input.network, record.txid);
    },

    /**
     * 显式回收：把这笔专用资金花回 owner 的地址。
     *
     * 闸门按「先判断、后不可逆动作」排列，顺序本身就是安全性的一部分：
     *   1. 记录必须属于当前 owner，且调用方给出的「不再使用依据」与记录一致；
     *   2. 记录自身的广播状态必须允许回收——`dispatched`/`unknown` 意味着这笔资金
     *      可能正被一笔在途的协议交易花掉，扫走会造成双花而不是回收；
     *   3. 链上必须能证明 UTXO 的真实状态：`spent` 直接清理，`unknown` 拒绝；
     *   4. 只有全部通过才签名广播。
     *
     * 广播结果按 `classifyProtocolSpendResult` 分三类处理：只有 `accepted` 才删除
     * 记录与保护；`not-broadcast` 明确失败但钱还在，记录必须留着；`uncertain` 更要
     * 留着——它是唯一的对账依据。
     */
    async recoverDedicatedFunding(request) {
      const input = scoped(request);
      const spend = deps.protocolSpend();
      if (spend === undefined) throw new ProtocolFundingError("funding-state-unknown", "P2PKH 协议资金能力不可用，无法回收专用资金");
      const record = ownedRecord(await deps.store.get(input.fundingId, input.ownerPublicKeyHex), input.ownerPublicKeyHex);
      if (record === undefined) {
        throw new ProtocolFundingError("funding-state-unknown", `专用资金 ${input.fundingId} 没有可回收的记录`);
      }
      if (record.network !== input.network) throw new ProtocolFundingError("funding-state-unknown", "专用资金网络不匹配");
      // 依据必须与记录相符：说「被 X 替代」却与记录里的 supersededBy 不同，
      // 说明调用方看到的不是这笔记录。
      if ("supersededBy" in input.reason) {
        if (record.supersededBy !== input.reason.supersededBy) {
          throw new ProtocolFundingError(
            "funding-state-unknown",
            `专用资金 ${input.fundingId} 的替代编号与声明不符（记录：${record.supersededBy ?? "无"}）`,
          );
        }
      }
      // `broadcastState` 说的是**资金准备交易**，不是花掉它的那笔协议交易：
      // `dispatched` 正是「专用 UTXO 已在链上」的意思，可以回收。
      //
      // 需要拒绝的是另外两种：
      //   - `unknown`：资金准备交易本身结果不明，先对账；
      //   - `rejected`：明确没派发，UTXO 根本不存在，那条路属于 release。
      //
      // 「协议交易是否在途」由调用方仲裁（它才知道任务是否已派发），这里只保证
      // 这笔资金本身的状态是可判定的。
      if (record.broadcastState === "unknown") {
        throw new ProtocolFundingError(
          "funding-state-unknown",
          `专用资金 ${input.fundingId} 的派发结果未知，必须先对账原提交再决定是否回收`,
        );
      }
      if (record.broadcastState === "rejected") {
        throw new ProtocolFundingError(
          "funding-rejected",
          `专用资金 ${input.fundingId} 明确未派发，应走 releaseDedicatedFunding 而不是回收`,
        );
      }
      const state = await deps.observeChain(record.network, record.txid).catch(() => "unknown" as const);
      if (state === "spent") {
        // 已经被别的交易花掉：记录与保护一并清理，钱已经不在这里了。
        await deps.store.delete(input.fundingId);
        removeProtection(input.fundingId);
        return {
          txid: record.txid,
          rawTxHex: record.rawTxHex,
          recoveredSatoshis: "0",
          broadcastState: "spent",
          outcome: "already-spent" as const,
        };
      }
      if (state === "unknown") {
        throw new ProtocolFundingError(
          "funding-observation-unavailable",
          `专用资金 ${record.txid}:${record.vout} 的链上状态未知，不能回收`,
        );
      }
      // 交易层面的状态还不够：必须按 outpoint 证明这个 UTXO 还没被花掉。
      if (deps.observeOutpoint !== undefined) {
        const outpointState = await deps.observeOutpoint({
          network: record.network, txid: record.txid, vout: record.vout,
        }).catch(() => "unknown" as const);
        if (outpointState === "spent") {
          // 资金交易还在，但这个输出已经被花掉：与「整笔被花费」同样处理。
          await deps.store.delete(input.fundingId);
          removeProtection(input.fundingId);
          return {
            txid: record.txid, rawTxHex: record.rawTxHex, recoveredSatoshis: "0",
            broadcastState: "spent", outcome: "already-spent" as const,
          };
        }
        if (outpointState === "unknown") {
          throw new ProtocolFundingError(
            "funding-observation-unavailable",
            `专用 UTXO ${record.txid}:${record.vout} 的花费状态未知，不能回收`,
          );
        }
      }
      const changeAddress = await deps.deriveChangeAddress(input.ownerPublicKeyHex, record.network);
      // 专用 UTXO 是普通 P2PKH 输出，因此回收就是一笔受控的普通转账。
      const feeCap = Math.max(1, Math.ceil((250 * input.feeRateSatoshisPerKb) / 1000));
      const total = parseAmount(record.valueSatoshis, "valueSatoshis");
      if (total <= BigInt(feeCap)) {
        throw new ProtocolFundingError("funding-state-unknown", "专用资金不足以覆盖回收交易的矿工费");
      }
      const preview = await spend.presign({
        requestingPluginId: record.ownerPluginId ?? "protocol",
        inputs: [{ txid: record.txid, vout: record.vout, value: toSafeNumber(total), address: record.address }],
        outputs: [{
          value: toSafeNumber(total - BigInt(feeCap)),
          scriptHex: p2pkhAddressToScriptHex(changeAddress, record.network),
          label: "protocol-funding-recovery",
        }],
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
        noChangeRule: { maxMinerFeeSatoshis: feeCap, allowZeroValueOutputs: true },
      });
      const result = await spend.submit(preview);
      const outcome = classifyProtocolSpendResult(result.status);
      if (outcome === "uncertain") {
        // 记录与保护必须留下：结果不明时删除记录等于丢掉唯一的对账依据。
        throw new ProtocolFundingError(
          "funding-state-unknown",
          `回收交易广播结果为 ${result.status}，必须先对账原提交再决定是否重试`,
        );
      }
      if (outcome === "not-broadcast") {
        // 明确没进网络：钱还在专用 UTXO 上，记录与保护保持不变，用户可以改费率重试。
        throw new ProtocolFundingError(
          "funding-rejected",
          `回收交易被明确拒绝（${result.status}），专用资金仍在原处，可调整后重试`,
        );
      }
      await deps.store.delete(input.fundingId);
      removeProtection(input.fundingId);
      return {
        txid: result.canonicalTxid ?? result.txid,
        rawTxHex: result.rawTxHex,
        recoveredSatoshis: (total - BigInt(feeCap)).toString(),
        broadcastState: result.status,
        outcome: "recovered" as const,
      };
    },

    async releaseDedicatedFunding(request) {
      const input = scoped(request);
      const spend = deps.protocolSpend();
      const record = ownedRecord(await deps.store.get(input.fundingId, input.ownerPublicKeyHex), input.ownerPublicKeyHex);
      if (record === undefined) return;
      if (record.network !== input.network || !record.submissionId || record.submissionId !== input.submissionId
        || !spend?.releasePreparedSubmission) throw new ProtocolFundingError("funding-state-unknown", "缺少同一提交的受控释放依据");
      // The manager must prove this exact submission is not dispatched before deletion.
      await spend.releasePreparedSubmission({ txid: record.txid, submissionId: record.submissionId });
      binding.assertActive();
      await deps.store.delete(input.fundingId);
      removeProtection(input.fundingId);
    },
  };

  /**
   * 新建一笔专用资金：构造 → 写前日志 → 登记保护 → 派发 → 落盘结果。
   *
   * 顺序不可调换：`store.put` 与保护登记都必须在 `submit` 之前，否则广播成功但
   * 响应丢失时，这笔资金在磁盘上没有任何痕迹，下一次调用会重新拆钱。
   */
  async function createNew(
    input: { ownerPublicKeyHex: string; network: "main" | "test"; fundingId: string; requiredSatoshis: string; feeRateSatoshisPerKb: number; ownerPluginId?: string; protectionReason?: string },
    required: bigint,
  ): Promise<ProtocolDedicatedFunding> {
    const spend = deps.protocolSpend();
    if (spend === undefined) throw new Error("P2PKH 协议资金能力不可用");
    const assetId = assetIdFor(input.network);
    const feeReserveSatoshis = toSafeNumber(estimateProtocolFundingMinerFee(required, input.feeRateSatoshisPerKb));
    const allocation = await deps.allocate({
      assetId,
      amountSatoshis: toSafeNumber(required),
      feeReserveSatoshis,
      feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
    });
    if (allocation.selected.length === 0) throw new Error("没有可用于准备专用资金的 UTXO");

    const changeAddress = await deps.deriveChangeAddress(input.ownerPublicKeyHex, input.network);
    // 专用 UTXO 是本交易自己的 vout 0 P2PKH 输出，收款地址就是当前 owner 的地址。
    const dedicatedAddress = changeAddress;
    const dedicatedScriptHex = p2pkhAddressToScriptHex(dedicatedAddress, input.network);
    const preview = await spend.presign({
      requestingPluginId: input.ownerPluginId ?? "protocol",
      inputs: allocation.selected.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: requireSafeNumber(utxo.value, `准备资金输入 ${utxo.txid}:${utxo.vout}`),
        address: utxo.address,
        ...(utxo.previousTransactionHex === undefined ? {} : { previousTransactionHex: utxo.previousTransactionHex }),
      })),
      outputs: [{ value: toSafeNumber(required), scriptHex: dedicatedScriptHex, label: "protocol-dedicated-funding" }],
      feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
      // 余额差走找零：没有 changeAddress 时 spend 会拒绝把余款当矿工费。
      changeAddress,
      protocolKind: "fund",
    });

    const base = {
      fundingId: input.fundingId,
      txid: preview.txid,
      vout: 0,
      rawTxHex: preview.rawTxHex,
      valueSatoshis: input.requiredSatoshis,
      address: dedicatedAddress,
      // owner 与 network 是恢复与保护的判据，必须从一开始就写进记录：
      // 缺 owner 会让生产存储的 owner 校验拒绝保存（写前日志直接丢），缺 network
      // 会让恢复时按错误的网络观察与保护。
      ownerPublicKeyHex: input.ownerPublicKeyHex.toLowerCase(),
      network: input.network,
      ownerPluginId: input.ownerPluginId ?? "protocol",
      ...(preview.submissionId === undefined ? {} : { submissionId: preview.submissionId }),
    };
    const prepared = withRecord(base, "prepared");
    // **条件写**：两个页面同时发现这个编号不存在时，只有一个能创建成功。输的一方
    // 必须停下并对账赢家，而不是各自广播一笔拆钱交易覆盖写前日志。
    try {
      await deps.store.put(prepared, { ifAbsent: true });
    } catch {
      // 输的一方已经构造并占用了输入（prepare 落盘了预签名与 claim），必须释放：
      // 否则这次调用会留下一笔永远不会派发的占用，并让后续重试撞上「输入已被占用」。
      await releaseOwnPrepared(spend, preview, input);
      throw new ProtocolFundingError(
        "funding-state-unknown",
        `专用资金 ${input.fundingId} 已被另一个页面准备，本次不重复拆钱`,
      );
    }
    // 专用 UTXO 必须挡住普通选币：广播之前就登记，避免派发窗口内被普通转账选中。
    ensureProtection(prepared, input);

    const result = await spend.submit(preview);
    const settled = withRecord(
      {
        ...base,
        txid: result.canonicalTxid ?? result.txid,
        rawTxHex: result.rawTxHex,
        ...(result.submissionId ?? preview.submissionId ? { submissionId: result.submissionId ?? preview.submissionId } : {}),
      },
      mapFundingBroadcastState(result.status),
    );
    await deps.store.put(settled);
    ensureProtection(settled, input);
    if (settled.broadcastState !== "dispatched") {
      // 记录保留下来：拒绝与未知都不是「可用的专用资金」，下一次调用会据此
      // 对账或拒绝，而不是静默再拆一笔。
      throw new ProtocolFundingError(
        settled.broadcastState === "rejected" ? "funding-rejected" : "funding-state-unknown",
        settled.broadcastState === "rejected"
          ? `专用资金准备交易被拒（${result.error ?? "无原因"}）`
          : "专用资金准备交易结果未知，必须先对账原提交",
      );
    }
    return settled;
  }

  /**
   * 已有记录的恢复路径。
   *
   * 三条分支，顺序即安全等级：
   *   1. 明确未派发（`rejected`，或观察到 `not-dispatched`）：作废记录，重新准备；
   *   2. 链上已成立（mempool/confirmed）：返回同一笔，并重新登记保护；
   *   3. 其余（`unknown` / 链上看不到）：**拒绝**。拒绝与未知都不是可用资金，
   *      硬造一笔新 UTXO 会让原提交的双花风险消失。
   */
  async function resolveExisting(
    existing: ProtocolFundingStoredRecord,
    input: { ownerPublicKeyHex: string; network: "main" | "test"; ownerPluginId?: string; protectionReason?: string },
  ): Promise<{ readonly kind: "reusable"; readonly record: ProtocolFundingStoredRecord } | { readonly kind: "discard" }> {
    const state = existing.broadcastState ?? "prepared";
    if (state === "rejected") return { kind: "discard" };
    if (state === "prepared") {
      // 写前日志之后、广播结果返回之前崩溃：先问同一个提交，不要重新准备。
      const observation = existing.submissionId === undefined
        ? undefined
        : await deps.observeSubmission?.({
            ownerPublicKeyHex: input.ownerPublicKeyHex,
            network: existing.network,
            txid: existing.txid,
            submissionId: existing.submissionId,
          });
      if (observation === "not-dispatched") return { kind: "discard" };
    }
    const chain = await deps.observeChain(existing.network, existing.txid).catch(() => "unknown" as const);
    if (chain === "confirmed" || chain === "mempool") return { kind: "reusable", record: { ...existing, updatedAtMs: now() } };
    // 已被花费：作废后按同一编号重新准备。
    if (chain === "spent") return { kind: "discard" };
    throw new ProtocolFundingError(
      "funding-observation-unavailable",
      `专用资金 ${existing.txid}:${existing.vout} 的链上状态未知，必须先对账原提交再决定是否重新准备`,
    );
  }

  async function discard(existing: ProtocolFundingStoredRecord): Promise<void> {
    await deps.store.delete(existing.fundingId);
    removeProtection(existing.fundingId);
  }

  /**
   * 把旧记录标记为「被替代」，并**保留**它。
   *
   * 删除旧记录会让两件事同时坏掉：重启后没有证据知道这笔 UTXO 属于用户；登记新
   * 输出时 protectionId 会顶掉旧输出的保护，于是旧 UTXO 既没有记录也没有保护，
   * 随时可能被普通转账当可用余额花掉。因此这里只加标记，输出继续受保护，直到
   * 调用方显式回收（`releaseDedicatedFunding`）。
   */
  async function supersede(existing: ProtocolFundingStoredRecord, supersededBy: string): Promise<void> {
    await deps.store.put({ ...existing, supersededBy, updatedAtMs: now() });
  }

  /**
   * 替代准备的编号。
   *
   * 新编号而不是复用旧编号：保护登记与记录都以 fundingId 为键，复用会让新输出顶掉
   * 旧输出的保护。派生规则保持可逆（去掉后缀还原原编号），便于诊断与回收。
   */
  function nextFundingId(fundingId: string): string {
    const next = `${fundingId}+1`;
    if (!FUNDING_ID_SEGMENT.test(next)) {
      throw new ProtocolFundingError("funding-state-unknown", `替代编号 ${next} 不是合法的资金编号`);
    }
    return next;
  }
}

/**
 * 释放本次调用自己构造、但因条件写失败而不再派发的预签名。
 *
 * 只释放**本次**的 preview：释放会解除输入占用与保护 claim，必须精确对应到自己
 * 刚构造的那一笔，不能碰别人的提交。释放失败不掩盖原始冲突（那才是调用方要处理的事）。
 */
async function releaseOwnPrepared(
  spend: ProtocolSpendService,
  preview: ProtocolSpendPreview,
  input: { ownerPublicKeyHex: string; network: "main" | "test" },
): Promise<void> {
  try {
    await spend.releasePrepared?.(preview);
  } catch {
    // 释放本身失败：记录会保留为 prepared，恢复路径据此对账原提交。
  }
  void input;
}

/** 已有资金是否覆盖本次需要的额度。 */
function coversRequired(record: ProtocolDedicatedFunding, requiredSatoshis: bigint): boolean {
  try {
    return parseAmount(record.valueSatoshis, "valueSatoshis") >= requiredSatoshis;
  } catch {
    // 金额非规范：宁可当作不覆盖，也不要拿一个读不懂的额度去构造交易。
    return false;
  }
}

/** 派发结果 → 资金记录的广播阶段。`unknown` 单独表达，不折叠成失败或成功。 */
function mapFundingBroadcastState(status: string): NonNullable<ProtocolDedicatedFunding["broadcastState"]> {
  switch (status) {
    case "rejected":
      return "rejected";
    case "unknown":
      return "unknown";
    default:
      return "dispatched";
  }
}

/** 资产 id 与网络的映射；P2PKH 的资产维度是 bsv/bsvtest 而不是资源 id。 */
function assetIdFor(network: "main" | "test"): "bsv" | "bsvtest" {
  return network === "test" ? "bsvtest" : "bsv";
}

function parseAmount(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} 必须是规范十进制 uint64`);
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn) throw new Error(`${label} 超过 uint64 上限`);
  return parsed;
}

/** bigint → 钱包 number，越过安全整数明确拒绝。 */
function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`金额 ${value} 超出钱包安全整数范围，拒绝截断`);
  }
  return Number(value);
}

function requireSafeNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是安全非负整数，实际 ${value}`);
  return value;
}
