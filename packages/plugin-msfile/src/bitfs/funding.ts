// BitFS 买方专款账本与开池资金交易准备端口。
//
// 本文件只准备交易，不广播。调用方必须先把 exact bytes 写入 BitFS outbox；
// 只有 Worker 的交易广播器可以把已保存交易交给节点。

import type {
  BsvNetwork,
  ProtocolSpendPreview,
  ProtocolSpendService,
  ProtectedOutpoint,
  P2pkhUtxoSnapshotResult,
} from "@keymaster/contracts";
import type { OwnerFileStore } from "@keymaster/contracts";
import type { BitfsSessionJournal } from "./sessionJournal.js";
import type { BitfsTransactionJournal } from "./broadcast.js";

const ACCOUNT_FORMAT = "keymaster.bitfs-funding-account";
const ACCOUNT_VERSION = 1;
const OWNER_KEY_HEX = /^(02|03)[0-9a-f]{64}$/u;
const HASH_HEX = /^[0-9a-f]{64}$/u;
const SCRIPT_HEX = /^(?:[0-9a-f]{2})+$/u;

/** 专款输出的持久化状态；只有状态来自链上观察后才能变为 available。 */
export type BitfsDedicatedUtxoState =
  | "split-pending"
  | "available"
  | "pool-occupied"
  | "recovery-pending"
  | "released";

/** 专款相关交易的用途。 */
export type BitfsFundingTransactionPurpose = "split" | "opening" | "close" | "refund";

/** 专款相关交易等待恢复时的索引状态。 */
export type BitfsFundingTransactionState = "prepared" | "result-unknown" | "observed" | "failed";

/** 已通过交易解析器核验的本地专款输出。 */
export interface BitfsDedicatedUtxo {
  /** 交易哈希；与 vout 合起来唯一标识输出。 */
  txid: string;
  /** 交易输出序号。 */
  vout: number;
  /** 输出金额，使用十进制聪字符串避免 JSON 数字精度损失。 */
  valueSatoshis: string;
  /** 输出锁定脚本的小写十六进制。 */
  scriptHex: string;
  /** 当前专款状态。 */
  state: BitfsDedicatedUtxoState;
  /** 产生此专款的拆分或开池交易哈希。 */
  splitTxid?: string;
  /** 占用该输出的 BitFS 池编号。 */
  poolId?: string;
  /** 正在花费该输出的开池、关池或退款交易哈希。 */
  spendingTxid?: string;
}

/** 持久化的专款交易索引；交易原文单独保存在 BitFS transaction outbox。 */
export interface BitfsFundingTransaction {
  /** canonical 交易哈希。 */
  txid: string;
  /** 交易用途。 */
  purpose: BitfsFundingTransactionPurpose;
  /** 交易状态；`prepared` 和 `result-unknown` 都不能释放输入。 */
  state: BitfsFundingTransactionState;
  /** P2PKH 持久化预签提交编号；仅明确未派发时用于跨重启释放输入 claim。 */
  p2pkhSubmissionId?: string;
  /** 本交易花费的输入 outpoint，格式为 `txid:vout`。 */
  inputOutpoints: string[];
  /** 交易创建的预期输出，观察原文后逐项核对。 */
  expectedOutputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
  /** 关联的买卖池编号。 */
  poolId?: string;
  /** 开池交易的手续费上限，单位聪；恢复时重新校验。 */
  maxFeeSatoshis?: string;
  /** 开池交易的找零金额；没有找零时为 `0`。 */
  changeSatoshis?: string;
  /** 开池交易的找零脚本；有找零时必须回到当前 Key。 */
  changeScriptHex?: string;
  /** 是否已由新鲜 P2PKH 快照确认原输入不再是可花 UTXO。 */
  inputsReconciled?: boolean;
}

/** 某一个买方资金池的可恢复资金记录。 */
export interface BitfsFundingPool {
  /** 买方应用内部的池编号。 */
  poolId: string;
  /** 创建资金池的开池交易哈希。 */
  fundingTxid: string;
  /** 开池交易创建的首个池输出。 */
  openingOutpoint: string;
  /** 开池时占用的本文件专款输入。 */
  inputOutpoints: string[];
  /** 池当前状态。 */
  state: "funding-pending" | "funding-failed" | "open" | "recovery-pending" | "closed";
  /** 关池或退款交易哈希；提交后按该哈希对账。 */
  recoveryTxid?: string;
}

/** 一个 Seed 的专款账本；账本根位于独立的 `bitfs-journal` storage purpose。 */
export interface BitfsFundingAccount {
  /** 账本所属的当前 Key 压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 本账本专属的 Seed Hash。 */
  seedHashHex: string;
  /** 专款所属公链网络。 */
  network: BsvNetwork;
  /** schema 版本；升级时不能误读旧资金记录。 */
  version: 1;
  /** 并发更新用的单调修订号。 */
  revision: number;
  /** 最后一次更新的 UTC ISO-8601 时间。 */
  updatedAt: string;
  /** 已登记的专款输出，包括尚未观察到的预期输出。 */
  utxos: BitfsDedicatedUtxo[];
  /** 该 Seed 的资金交易索引。 */
  transactions: BitfsFundingTransaction[];
  /** 已开池或待恢复的资金池。 */
  pools: BitfsFundingPool[];
}

/** 专款账本的持久化操作。 */
export interface BitfsFundingLedger {
  /** 读取或创建当前 Key + Seed + 网络对应的账本。 */
  getAccount(input: { ownerPublicKeyHex: string; seedHashHex: string; network: BsvNetwork; nowMs: number }): Promise<BitfsFundingAccount>;
  /** 登记拆分交易计划并先保护其输入、输出；随后必须把原文写入交易 outbox。 */
  prepareSplit(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision: number;
    txid: string;
    /** P2PKH 持久化预签提交编号。 */
    p2pkhSubmissionId: string;
    inputs: string[];
    outputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 只有节点已观察到拆分交易后，才把对应输出开放给开池使用。 */
  observeSplit(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    txid: string;
    actualOutputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 记录拆分交易的广播结果未知状态；输入继续保持不可用。 */
  markTransactionUnknown(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    txid: string;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /**
   * 只有 Worker 已证明交易确定未派发后才能释放占用；结果未知时必须先按 txid 对账。
   */
  releaseDefinitelyUndispatchedTransaction(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision: number;
    txid: string;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 原子占用本文件专款，并登记固定开池首输出。 */
  reservePoolFunding(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision: number;
    poolId: string;
    txid: string;
    /** P2PKH 持久化预签提交编号。 */
    p2pkhSubmissionId: string;
    inputs: string[];
    openingOutput: Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">;
    /** 开池交易的当前 Key 找零输出；确认前也必须受专款保护。 */
    changeOutput?: Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">;
    /** FundingTx 的最高手续费，恢复时重新核对。 */
    maxFeeSatoshis: string;
    /** FundingTx 的找零金额，恢复时重新核对。 */
    changeSatoshis: string;
    /** 当前 Key 的找零脚本。 */
    changeScriptHex: string;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 开池交易被节点观察后释放已花费的专款输入，保留池输出。 */
  observePoolFunding(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    poolId: string;
    actualInputs: string[];
    actualOutputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 持久化关池或退款交易及待回收输出；观察完成前继续保护资金。 */
  preparePoolRecovery(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision: number;
    poolId: string;
    purpose: "close" | "refund";
    txid: string;
    /** 关池/退款交易实际花费的池状态 outpoint；必须从经 go-bitfs 验证的交易原文解析。 */
    spendingOutpoint: string;
    outputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 只在关池/退款交易被观察后恢复专款可用性。 */
  observePoolRecovery(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    poolId: string;
    actualInputs: string[];
    actualOutputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>;
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 已确认不再需要的未开池输出可以解除保护。 */
  releaseAvailable(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision: number;
    outpoints: string[];
    nowMs: number;
  }): Promise<BitfsFundingAccount>;
  /** 新鲜 UTXO 快照确认链上已观察交易的输入不再可花后，解除旧输入保护。 */
  reconcileObservedTransactionInputs(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    unspentOutpoints: string[];
    nowMs: number;
  }): Promise<void>;
  /** 列出仍受保护的全部专款输出，供普通钱包选币与签名前做拦截。 */
  listProtectedOutpoints(filter?: { ownerPublicKeyHex?: string; network?: BsvNetwork }): Promise<ProtectedOutpoint[]>;
}

/** 创建使用条件写与 Worker 内串行队列的专款账本。 */
export function createBitfsFundingLedger(store: OwnerFileStore): BitfsFundingLedger {
  if (!store) throw new TypeError("BitFS 专款账本需要文件存储");
  const queuedMutations = new Map<string, Promise<void>>();
  const accountPath = (seedHashHex: string, network: BsvNetwork) => `funding/accounts/${assertNetwork(network)}/${assertHash(seedHashHex)}.json`;

  async function readAccount(path: string, owner: string, seed: string, network: BsvNetwork): Promise<{ account: BitfsFundingAccount; etag?: string } | undefined> {
    const object = await store.get(path);
    if (!object) return undefined;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
    catch { throw new BitfsFundingError("integrity", "BitFS 专款账本格式损坏"); }
    return { account: parseAccount(value, owner, seed, network), ...(object.etag === undefined ? {} : { etag: object.etag }) };
  }

  async function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = queuedMutations.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    queuedMutations.set(path, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (queuedMutations.get(path) === queued) queuedMutations.delete(path);
    }
  }

  async function mutate(input: {
    ownerPublicKeyHex: string;
    seedHashHex: string;
    network: BsvNetwork;
    expectedRevision?: number;
    nowMs: number;
    change(current: BitfsFundingAccount): BitfsFundingAccount;
  }): Promise<BitfsFundingAccount> {
    const owner = assertOwner(input.ownerPublicKeyHex);
    const seed = assertHash(input.seedHashHex);
    const network = assertNetwork(input.network);
    const path = accountPath(seed, network);
    return serialize(path, async () => {
      const existing = await readAccount(path, owner, seed, network);
      const current = existing?.account ?? emptyAccount(owner, seed, network, input.nowMs);
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new BitfsFundingError("revision_conflict", "BitFS 专款账本已被另一个操作更新，请重新读取");
      }
      const candidate = input.change(current);
      const next = validateAccount({
        ...candidate,
        revision: current.revision + 1,
        updatedAt: iso(input.nowMs),
      }, owner, seed, network);
      const bytes = encodeAccount(next);
      const condition = existing
        ? (existing.etag === undefined ? {} : { ifMatch: existing.etag })
        : { ifNoneMatch: "*" as const };
      await store.put(path, bytes, condition);
      const committed = await readAccount(path, owner, seed, network);
      if (!committed || committed.account.revision !== next.revision || !equal(encodeAccount(committed.account), bytes)) {
        throw new BitfsFundingError("storage", "BitFS 专款账本写入后回读校验失败");
      }
      return committed.account;
    });
  }

  return {
    async getAccount(input) {
      const owner = assertOwner(input.ownerPublicKeyHex);
      const seed = assertHash(input.seedHashHex);
      const network = assertNetwork(input.network);
      const path = accountPath(seed, network);
      const current = await readAccount(path, owner, seed, network);
      if (current) return current.account;
      return mutate({ ...input, ownerPublicKeyHex: owner, seedHashHex: seed, network, change: (value) => value });
    },

    prepareSplit(input) {
      const txid = assertHash(input.txid);
      const p2pkhSubmissionId = assertSubmissionId(input.p2pkhSubmissionId);
      const inputs = uniqueOutpoints(input.inputs);
      const outputs = validateExpectedOutputs(txid, input.outputs);
      if (outputs.length === 0) throw new BitfsFundingError("integrity", "专款拆分交易必须包含回到当前 Key 的输出");
      return mutate({ ...input, change(current) {
        const prior = current.transactions.find((item) => item.txid === txid);
        if (prior) {
          if (prior.purpose !== "split" || prior.p2pkhSubmissionId !== p2pkhSubmissionId
            || !sameStrings(prior.inputOutpoints, inputs) || !sameOutputs(prior.expectedOutputs, outputs)) {
            throw new BitfsFundingError("integrity", "同一拆分 txid 已绑定不同专款计划");
          }
          return current;
        }
        const heldInputs = new Set(current.transactions
          .filter((transaction) => transaction.state !== "failed"
            && !(transaction.state === "observed" && transaction.inputsReconciled === true))
          .flatMap((transaction) => transaction.inputOutpoints));
        const heldInput = inputs.find((outpoint) => heldInputs.has(outpoint));
        if (heldInput) throw new BitfsFundingError("input_unavailable", `专款账本已占用输入 ${heldInput}`);
        assertNewOutpoints(current, outputs);
        return {
          ...current,
          transactions: [...current.transactions, { txid, purpose: "split", state: "prepared", p2pkhSubmissionId, inputOutpoints: inputs, expectedOutputs: outputs }],
          utxos: [...current.utxos, ...outputs.map((output) => ({ ...output, state: "split-pending" as const, splitTxid: txid }))],
        };
      } });
    },

    observeSplit(input) {
      const txid = assertHash(input.txid);
      const actualOutputs = validateExpectedOutputs(txid, input.actualOutputs);
      return mutate({ ...input, change(current) {
        const transaction = requireTransaction(current, txid, "split");
        if (!sameOutputs(transaction.expectedOutputs, actualOutputs)) throw new BitfsFundingError("integrity", "拆分交易实际输出与持久化计划不一致");
        if (transaction.state === "observed") return current;
        return {
          ...current,
          transactions: replaceTransaction(current.transactions, { ...transaction, state: "observed" }),
          utxos: current.utxos.map((utxo) => utxo.splitTxid === txid && utxo.state === "split-pending" ? { ...utxo, state: "available" } : utxo),
        };
      } });
    },

    markTransactionUnknown(input) {
      const txid = assertHash(input.txid);
      return mutate({ ...input, change(current) {
        const index = current.transactions.findIndex((item) => item.txid === txid);
        if (index < 0) throw new BitfsFundingError("integrity", "待对账的 BitFS 专款交易不存在");
        const transaction = current.transactions[index]!;
        if (transaction.state === "observed") return current;
        return { ...current, transactions: replaceTransaction(current.transactions, { ...transaction, state: "result-unknown" }) };
      } });
    },

    releaseDefinitelyUndispatchedTransaction(input) {
      const txid = assertHash(input.txid);
      return mutate({ ...input, change(current) {
        const transaction = requireTransaction(current, txid);
        if (transaction.state === "observed") throw new BitfsFundingError("invalid_transition", "已观察到的 BitFS 交易不能按未派发释放");
        if (transaction.state === "failed") return current;
        const expectedOutputKeys = new Set(transaction.expectedOutputs.map(outpointKey));
        const nextUtxos = current.utxos.map((utxo) => {
          const key = outpointKey(utxo);
          if (transaction.purpose === "split" && utxo.splitTxid === txid && utxo.state === "split-pending") {
            return { ...utxo, state: "released" as const };
          }
          if (transaction.purpose === "opening" && utxo.spendingTxid === txid) {
            return { ...utxo, state: "available" as const, poolId: undefined, spendingTxid: undefined };
          }
          if (expectedOutputKeys.has(key) && utxo.txid === txid) return { ...utxo, state: "released" as const, poolId: undefined, spendingTxid: undefined };
          if ((transaction.purpose === "close" || transaction.purpose === "refund") && utxo.spendingTxid === txid) {
            return { ...utxo, state: "pool-occupied" as const, spendingTxid: undefined };
          }
          return utxo;
        });
        const nextPools = transaction.poolId === undefined
          ? current.pools
          : current.pools.map((pool) => pool.poolId !== transaction.poolId
            ? pool
            : transaction.purpose === "opening"
              ? { ...pool, state: "funding-failed" as const }
              : { ...pool, state: "open" as const, recoveryTxid: undefined });
        return {
          ...current,
          transactions: replaceTransaction(current.transactions, { ...transaction, state: "failed" }),
          utxos: nextUtxos,
          pools: nextPools,
        };
      } });
    },

    reservePoolFunding(input) {
      const txid = assertHash(input.txid);
      const p2pkhSubmissionId = assertSubmissionId(input.p2pkhSubmissionId);
      const poolId = assertPoolId(input.poolId);
      const inputs = uniqueOutpoints(input.inputs);
      const openingOutput = validateExpectedOutputs(txid, [input.openingOutput])[0]!;
      if (openingOutput.vout !== 0) throw new BitfsFundingError("integrity", "BitFS 开池资金输出必须固定在第 0 个位置");
      const maxFeeSatoshis = assertSatoshiString(input.maxFeeSatoshis, false);
      const changeSatoshis = assertSatoshiString(input.changeSatoshis, true);
      const changeScriptHex = assertScript(input.changeScriptHex);
      const changeOutput = input.changeOutput === undefined
        ? undefined
        : validateExpectedOutputs(txid, [input.changeOutput])[0]!;
      if (changeSatoshis === "0") {
        if (changeOutput) throw new BitfsFundingError("integrity", "FundingTx 声明无找零却包含找零输出");
      } else if (!changeOutput
        || changeOutput.vout !== 1
        || changeOutput.valueSatoshis !== changeSatoshis
        || changeOutput.scriptHex !== changeScriptHex) {
        throw new BitfsFundingError("integrity", "FundingTx 找零输出与金额或当前 Key 脚本不一致");
      }
      const expectedOutputs = changeOutput ? [openingOutput, changeOutput] : [openingOutput];
      return mutate({ ...input, change(current) {
        const priorPool = current.pools.find((pool) => pool.poolId === poolId);
        if (priorPool && priorPool.state !== "funding-failed") {
          const priorTransaction = current.transactions.find((transaction) => transaction.txid === txid && transaction.purpose === "opening");
          if (priorPool.fundingTxid !== txid
            || !sameStrings(priorPool.inputOutpoints, inputs)
            || priorPool.openingOutpoint !== outpointKey(openingOutput)
            || !priorTransaction
            || !sameOutputs(priorTransaction.expectedOutputs, expectedOutputs)
            || priorTransaction.maxFeeSatoshis !== maxFeeSatoshis
            || priorTransaction.p2pkhSubmissionId !== p2pkhSubmissionId
            || priorTransaction.changeSatoshis !== changeSatoshis
            || priorTransaction.changeScriptHex !== changeScriptHex) {
            throw new BitfsFundingError("integrity", "同一 BitFS 池编号已绑定不同开池交易");
          }
          return current;
        }
        if (priorPool?.state === "funding-failed") {
          const priorTransaction = current.transactions.find((transaction) => transaction.txid === priorPool.fundingTxid && transaction.purpose === "opening");
          if (!priorTransaction || priorTransaction.state !== "failed") {
            throw new BitfsFundingError("integrity", "失败开池池编号未完成确定未派发释放，不能复用");
          }
        }
        const selected = inputs.map((key) => {
          const utxo = current.utxos.find((item) => outpointKey(item) === key);
          if (!utxo || utxo.state !== "available") throw new BitfsFundingError("input_unavailable", `专款输入 ${key} 不可用于开池`);
          return utxo;
        });
        if (current.utxos.some((item) => outpointKey(item) === outpointKey(openingOutput))) throw new BitfsFundingError("integrity", "开池输出已存在于专款账本");
        const transaction: BitfsFundingTransaction = {
          txid,
          purpose: "opening",
          state: "prepared",
          p2pkhSubmissionId,
          inputOutpoints: inputs,
          expectedOutputs,
          poolId,
          maxFeeSatoshis,
          changeSatoshis,
          changeScriptHex,
        };
        assertNewOutpoints(current, expectedOutputs);
        return {
          ...current,
          transactions: [...current.transactions, transaction],
          utxos: [
            ...current.utxos.map((utxo) => selected.some((item) => outpointKey(item) === outpointKey(utxo))
              ? { ...utxo, state: "pool-occupied" as const, poolId, spendingTxid: txid }
              : utxo),
            { ...openingOutput, state: "pool-occupied", poolId },
            ...(changeOutput ? [{ ...changeOutput, state: "split-pending" as const, splitTxid: txid }] : []),
          ],
          pools: priorPool ? replacePool(current.pools, {
            poolId,
            fundingTxid: txid,
            openingOutpoint: outpointKey(openingOutput),
            inputOutpoints: inputs,
            state: "funding-pending",
          }) : [...current.pools, {
            poolId,
            fundingTxid: txid,
            openingOutpoint: outpointKey(openingOutput),
            inputOutpoints: inputs,
            state: "funding-pending",
          }],
        };
      } });
    },

    observePoolFunding(input) {
      const poolId = assertPoolId(input.poolId);
      const actualInputs = uniqueOutpoints(input.actualInputs);
      return mutate({ ...input, change(current) {
        const pool = requirePool(current, poolId);
        const transaction = requireTransaction(current, pool.fundingTxid, "opening");
        const actualOutputs = validateExpectedOutputs(transaction.txid, input.actualOutputs);
        if (!sameStrings(transaction.inputOutpoints, actualInputs) || !sameOutputs(transaction.expectedOutputs, actualOutputs)) {
          throw new BitfsFundingError("integrity", "开池交易实际输入或输出与持久化计划不一致");
        }
        if (pool.state === "open") return current;
        if (pool.state !== "funding-pending") throw new BitfsFundingError("invalid_transition", "BitFS 池当前阶段不能确认开池");
        return {
          ...current,
          transactions: replaceTransaction(current.transactions, { ...transaction, state: "observed" }),
          utxos: current.utxos.map((utxo) => {
            if (pool.inputOutpoints.includes(outpointKey(utxo)) && utxo.spendingTxid === pool.fundingTxid) {
              return { ...utxo, state: "released", poolId: undefined, spendingTxid: undefined };
            }
            if (utxo.txid === transaction.txid && utxo.state === "split-pending" && utxo.splitTxid === transaction.txid) {
              return { ...utxo, state: "available" };
            }
            return utxo;
          }),
          pools: replacePool(current.pools, { ...pool, state: "open" }),
        };
      } });
    },

    preparePoolRecovery(input) {
      const poolId = assertPoolId(input.poolId);
      const txid = assertHash(input.txid);
      const spendingOutpoint = assertOutpoint(input.spendingOutpoint);
      const outputs = validateExpectedOutputs(txid, input.outputs);
      return mutate({ ...input, change(current) {
        const pool = requirePool(current, poolId);
        if (pool.state === "recovery-pending") {
          if (pool.recoveryTxid !== txid) throw new BitfsFundingError("integrity", "同一池的待恢复交易哈希发生变化");
          const transaction = requireTransaction(current, txid);
          if (transaction.purpose !== input.purpose
            || !sameStrings(transaction.inputOutpoints, [spendingOutpoint])
            || !sameOutputs(transaction.expectedOutputs, outputs)) {
            throw new BitfsFundingError("integrity", "同一待恢复交易的输入或找回输出发生变化");
          }
          return current;
        }
        if (pool.state !== "open") throw new BitfsFundingError("invalid_transition", "BitFS 池尚未开立或已经关闭");
        assertNewOutpoints(current, outputs);
        return {
          ...current,
          transactions: [...current.transactions, {
            txid,
            purpose: input.purpose,
            state: "prepared",
            inputOutpoints: [spendingOutpoint],
            expectedOutputs: outputs,
            poolId,
          }],
          utxos: current.utxos.map((utxo) => outpointKey(utxo) === pool.openingOutpoint
            ? { ...utxo, state: "recovery-pending" as const, spendingTxid: txid }
            : utxo).concat(outputs.map((output) => ({ ...output, state: "recovery-pending" as const, poolId, spendingTxid: txid }))),
          pools: replacePool(current.pools, { ...pool, state: "recovery-pending", recoveryTxid: txid }),
        };
      } });
    },

    observePoolRecovery(input) {
      const poolId = assertPoolId(input.poolId);
      const actualInputs = uniqueOutpoints(input.actualInputs);
      return mutate({ ...input, change(current) {
        const pool = requirePool(current, poolId);
        if (pool.state === "closed") return current;
        if (pool.state !== "recovery-pending" || !pool.recoveryTxid) throw new BitfsFundingError("invalid_transition", "BitFS 池没有待观察的关池或退款交易");
        const transaction = requireTransaction(current, pool.recoveryTxid);
        const actualOutputs = validateExpectedOutputs(transaction.txid, input.actualOutputs);
        if (!sameStrings(transaction.inputOutpoints, actualInputs) || !sameOutputs(transaction.expectedOutputs, actualOutputs)) {
          throw new BitfsFundingError("integrity", "回收交易实际输入或输出与持久化计划不一致");
        }
        return {
          ...current,
          transactions: replaceTransaction(current.transactions, { ...transaction, state: "observed" }),
          utxos: current.utxos.map((utxo) => {
            if (outpointKey(utxo) === pool.openingOutpoint) return { ...utxo, state: "released", spendingTxid: undefined };
            if (utxo.spendingTxid === pool.recoveryTxid && utxo.poolId === poolId) {
              return { ...utxo, state: "available", poolId: undefined, spendingTxid: undefined };
            }
            return utxo;
          }),
          pools: replacePool(current.pools, { ...pool, state: "closed" }),
        };
      } });
    },

    releaseAvailable(input) {
      const outpoints = uniqueOutpoints(input.outpoints);
      return mutate({ ...input, change(current) {
        const requested = new Set(outpoints);
        for (const key of requested) {
          const utxo = current.utxos.find((item) => outpointKey(item) === key);
          if (!utxo || utxo.state !== "available") throw new BitfsFundingError("input_unavailable", `不能解除非空闲专款 ${key}`);
        }
        return {
          ...current,
          utxos: current.utxos.map((utxo) => requested.has(outpointKey(utxo)) ? { ...utxo, state: "released" } : utxo),
        };
      } });
    },

    async reconcileObservedTransactionInputs(input) {
      const owner = assertOwner(input.ownerPublicKeyHex);
      const network = assertNetwork(input.network);
      const unspent = new Set(input.unspentOutpoints.map(assertOutpoint));
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: `funding/accounts/${network}/`, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        for (const file of page.files) {
          const match = new RegExp(`^funding/accounts/${network}/([0-9a-f]{64})\\.json$`, "u").exec(file.path);
          if (!match) continue;
          const loaded = await readAccount(file.path, owner, match[1]!, network);
          if (!loaded) continue;
          for (const transaction of loaded.account.transactions) {
            if (transaction.state !== "observed" || transaction.inputsReconciled === true) continue;
            if (transaction.inputOutpoints.some((outpoint) => unspent.has(outpoint))) continue;
            await mutate({
              ownerPublicKeyHex: owner,
              seedHashHex: loaded.account.seedHashHex,
              network,
              expectedRevision: loaded.account.revision,
              nowMs: input.nowMs,
              change(current) {
                const latest = current.transactions.find((item) => item.txid === transaction.txid);
                if (!latest || latest.state !== "observed" || latest.inputsReconciled === true) return current;
                return { ...current, transactions: replaceTransaction(current.transactions, { ...latest, inputsReconciled: true }) };
              },
            });
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    },

    async listProtectedOutpoints(filter) {
      const ownerFilter = filter?.ownerPublicKeyHex === undefined ? undefined : assertOwner(filter.ownerPublicKeyHex);
      const networkFilter = filter?.network === undefined ? undefined : assertNetwork(filter.network);
      const protectedItems: ProtectedOutpoint[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: "funding/accounts/", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        for (const file of page.files) {
          const match = /^funding\/accounts\/(main|test)\/([0-9a-f]{64})\.json$/u.exec(file.path);
          if (!match) continue;
          const object = await store.get(file.path);
          if (!object) continue;
          let value: unknown;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
          catch { throw new BitfsFundingError("integrity", `BitFS 专款账本损坏：${file.path}`); }
          const row = value as Partial<BitfsFundingAccount>;
          const owner = assertOwner(String(row.ownerPublicKeyHex ?? ""));
          const seed = assertHash(match[2]!);
          const network = assertNetwork(match[1]);
          const account = parseAccount(value, owner, seed, network);
          if (ownerFilter && account.ownerPublicKeyHex !== ownerFilter) continue;
          if (networkFilter && account.network !== networkFilter) continue;
          for (const utxo of account.utxos) {
            if (utxo.state === "released") continue;
            protectedItems.push({
              txid: utxo.txid,
              vout: utxo.vout,
              network: account.network,
              ownerPluginId: "msfile",
              publicKeyHex: account.ownerPublicKeyHex,
              kind: "bitfs-dedicated-funds",
              reason: `BitFS 专款 ${utxo.state}`,
            });
          }
          // 资金交易的原输入先保护到确定未派发，或链上观察后被新鲜 P2PKH
          // 快照确认已不可花；避免普通余额继续选择旧 outpoint。
          for (const transaction of account.transactions) {
            if (transaction.state === "failed" || transaction.inputsReconciled === true) continue;
            for (const inputOutpoint of transaction.inputOutpoints) {
              const [txid, voutText] = inputOutpoint.split(":");
              protectedItems.push({
                txid: txid!,
                vout: Number(voutText),
                network: account.network,
                ownerPluginId: "msfile",
                publicKeyHex: account.ownerPublicKeyHex,
                kind: `bitfs-${transaction.purpose}-input`,
                reason: `BitFS ${transaction.purpose} 交易 ${transaction.state}`,
              });
            }
          }
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return protectedItems;
    },
  };
}

/** 根据下一段预估采购额补足 120%；全部运算使用整数聪。 */
export function calculateBitfsTopUp(requiredSatoshis: bigint): { targetSatoshis: bigint; reserveSatoshis: bigint } {
  if (requiredSatoshis <= 0n) throw new BitfsFundingError("invalid_amount", "下一段预估采购金额必须大于 0 聪");
  const targetSatoshis = (requiredSatoshis * 120n + 99n) / 100n;
  return { targetSatoshis, reserveSatoshis: targetSatoshis - requiredSatoshis };
}

/** 已被 Coordinator P2PKH 快照序号门禁占用的输入集合。 */
export interface BitfsFundingInputReservation {
  /** 只有确定未派发且 ledger/outbox 均未留存时才回滚快照占用。 */
  rollback(): void;
}

/** 单文件专款拆分准备器的 Worker 依赖。 */
export interface BitfsFundingSplitPrepareDeps {
  /** P2PKH 受限签名端口；此处只调用 prepare，不调用 submit。 */
  protocolSpend: ProtocolSpendService;
  /** 读取当前 Key 的新鲜普通余额快照；返回值必须已经过滤 BitFS 专款。 */
  getAvailableSnapshot(input: { ownerPublicKeyHex: string; network: BsvNetwork }): Promise<P2pkhUtxoSnapshotResult>;
  /** 解析当前 Key 地址与其锁定脚本；调用方不能传任意收款脚本。 */
  resolveOwnerAddress(input: { ownerPublicKeyHex: string; network: BsvNetwork }): Promise<{ address: string; scriptHex: string }>;
  /** 在签名完成后原子消费普通 P2PKH 快照序号，防止普通转账抢用相同输入。 */
  reserveP2pkhInputs(input: { ownerPublicKeyHex: string; network: BsvNetwork; preview: ProtocolSpendPreview; inputOutpoints: string[] }): BitfsFundingInputReservation | Promise<BitfsFundingInputReservation>;
  /** 从共识解析器取得交易输入、输出和 canonical txid。 */
  parseTransaction(rawTransactionHex: string, expectedTxid?: string): BitfsFundingTransactionView;
  /** 交易 exact bytes 的持久 outbox。 */
  transactions: BitfsTransactionJournal;
  /** 当前 Key + Seed 的专款账本。 */
  ledger: BitfsFundingLedger;
  /** 检查当前 Key、网络和 Worker generation。 */
  assertCurrentContext(input: { ownerPublicKeyHex: string; network: BsvNetwork; generation: number }): void;
  /** 确定未进入 BitFS outbox 时释放 P2PKH 侧的输入 claim。 */
  releasePrepared(preview: ProtocolSpendPreview): Promise<void>;
  /** Worker 提供的 UTC 毫秒。 */
  nowMs(): number;
}

/** 已准备且持久化的单文件专款拆分交易；调用者仍须经 BitFS outbox 广播。 */
export interface PreparedBitfsFundingSplit {
  /** 对应的当前 Key。 */
  ownerPublicKeyHex: string;
  /** 本次采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 拆分交易 canonical txid。 */
  txid: string;
  /** 必须原样提交给 BitFS 广播器的交易字节。 */
  rawTransaction: Uint8Array;
  /** 本交易占用的普通 P2PKH 输入 outpoint。 */
  inputOutpoints: string[];
  /** 等待节点观察后才可用于开池的专款输出。 */
  dedicatedOutpoints: string[];
  /** 下一段预计采购金额，单位聪。 */
  requiredSatoshis: string;
  /** 含 20% 余量的专款目标金额，单位聪。 */
  targetSatoshis: string;
  /** 目标中未分配给预计采购额的余量，单位聪。 */
  reserveSatoshis: string;
  /** 从输入总额扣除全部輸出后得到的实际手续费，单位聪。 */
  feeSatoshis: string;
}

/**
 * 聚合当前 Key 的普通余额并拆为本文件专款。
 *
 * 输出策略固定为“下一段预计金额 + 20% 余量”两笔回到当前 Key 的输出；
 * 余量小于网络尘额门槛时合并为一笔。输入先由 P2PKH 快照序号占用，再写
 * 专款 ledger，最后写 exact outbox；此函数不广播，也不接收页面脚本。
 */
export async function prepareBitfsFundingSplit(input: {
  /** 当前 Vault Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 当前采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 当前账户的公链网络。 */
  network: BsvNetwork;
  /** 当前 Worker generation。 */
  generation: number;
  /** 下一段预计采购总额，十进制聪字符串。 */
  requiredSatoshis: string;
  /** 网络及钱包策略要求的最小普通输出金额，十进制聪字符串。 */
  minimumOutputSatoshis: string;
  /** 交易费率，单位聪/千字节。 */
  feeRateSatoshisPerKb: number;
  /** 本次交易允许的最高手续费，单位聪。 */
  maxFeeSatoshis: number;
}, deps: BitfsFundingSplitPrepareDeps): Promise<PreparedBitfsFundingSplit> {
  const owner = assertOwner(input.ownerPublicKeyHex);
  const seed = assertHash(input.seedHashHex);
  const network = assertNetwork(input.network);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new BitfsFundingError("stale_session", "BitFS 会话世代无效");
  const requiredSatoshis = BigInt(assertSatoshiString(input.requiredSatoshis, false));
  const minimumOutputSatoshis = BigInt(assertSatoshiString(input.minimumOutputSatoshis, false));
  if (!Number.isSafeInteger(input.feeRateSatoshisPerKb) || input.feeRateSatoshisPerKb < 1
    || !Number.isSafeInteger(input.maxFeeSatoshis) || input.maxFeeSatoshis < 1) {
    throw new BitfsFundingError("invalid_amount", "BitFS 拆分交易费率或手续费上限无效");
  }
  const topUp = calculateBitfsTopUp(requiredSatoshis);
  if (topUp.targetSatoshis < minimumOutputSatoshis) throw new BitfsFundingError("invalid_amount", "专款目标金额低于网络最小输出金额");
  deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });

  const snapshot = await deps.getAvailableSnapshot({ ownerPublicKeyHex: owner, network });
  deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
  if (!snapshot.available || snapshot.state !== "fresh") throw new BitfsFundingError("insufficient_funds", "普通 P2PKH 余额快照尚未就绪，请刷新余额后重试");
  const spendableItems = snapshot.items.filter((item) => !item.isSpentInMempoolTx);
  if (spendableItems.length === 0) throw new BitfsFundingError("insufficient_funds", "普通 P2PKH 余额没有可花费输入，请刷新余额后重试");

  const ownerAddress = await deps.resolveOwnerAddress({ ownerPublicKeyHex: owner, network });
  const ownerScript = assertScript(ownerAddress.scriptHex);
  const candidates = spendableItems.map((item) => {
    if (!Number.isSafeInteger(item.value) || item.value <= 0 || !Number.isSafeInteger(item.vout) || item.vout < 0) {
      throw new BitfsFundingError("integrity", "P2PKH 普通余额快照包含无效 UTXO");
    }
    return {
      txid: assertHash(item.txid),
      vout: item.vout,
      valueSatoshis: String(item.value),
      address: ownerAddress.address,
    };
  });
  if (new Set(candidates.map(outpointKey)).size !== candidates.length) throw new BitfsFundingError("integrity", "P2PKH 普通余额快照包含重复 outpoint");
  const targetPlusFee = topUp.targetSatoshis + BigInt(input.maxFeeSatoshis);
  const selected = selectWalletInputs(candidates, targetPlusFee);
  const selectedTotal = selected.reduce((total, item) => total + BigInt(item.valueSatoshis), 0n);
  const explicitOutputValues = topUp.reserveSatoshis >= minimumOutputSatoshis
    ? [requiredSatoshis, topUp.reserveSatoshis]
    : [topUp.targetSatoshis];
  const outputs = explicitOutputValues.map((value, index) => ({
    value: safeSatoshiNumber(value.toString(10)),
    scriptHex: ownerScript,
    label: index === 0 ? "BitFS 文件采购专款" : "BitFS 20% 余量专款",
  }));

  let preview: ProtocolSpendPreview | undefined;
  let inputReservation: BitfsFundingInputReservation | undefined;
  let txid: string | undefined;
  try {
    preview = await deps.protocolSpend.prepare({
      ownerPublicKeyHex: owner,
      requestingPluginId: "msfile",
      network,
      inputs: selected.map((item) => ({ txid: item.txid, vout: item.vout, value: safeSatoshiNumber(item.valueSatoshis), address: item.address })),
      outputs,
      feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
      changeAddress: ownerAddress.address,
    });
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    const parsed = deps.parseTransaction(preview.rawTxHex, preview.txid);
    const canonicalTxid = assertHash(parsed.canonicalTxid);
    txid = canonicalTxid;
    const expectedInputs = selected.map(outpointKey).sort();
    const actualInputs = parsed.inputs.map(normalizeOutpoint).sort();
    if (txid !== preview.txid || !sameStrings(expectedInputs, actualInputs)) throw new BitfsFundingError("integrity", "拆分交易原文与选中输入或 canonical txid 不一致");
    if (preview.ownerPublicKeyHex !== owner || preview.network !== network || preview.inputs.length !== selected.length
      || preview.inputs.some((item) => {
        const source = selected.find((candidate) => candidate.txid === item.txid && candidate.vout === item.vout);
        return !source || item.value !== Number(source.valueSatoshis) || item.address !== ownerAddress.address;
      })) throw new BitfsFundingError("integrity", "P2PKH 拆分预览输入与普通余额快照不一致");
    if (preview.outputs.length !== outputs.length || preview.outputs.some((item, index) =>
      item.value !== outputs[index]!.value || assertScript(item.scriptHex) !== ownerScript)) {
      throw new BitfsFundingError("integrity", "P2PKH 拆分预览改写了当前 Key 的专款输出");
    }
    const expectedOutputCount = outputs.length + (preview.changeSatoshis > 0 ? 1 : 0);
    if (parsed.outputs.length !== expectedOutputCount) throw new BitfsFundingError("integrity", "拆分交易包含未声明的额外输出");
    const expectedValues = [...outputs.map((item) => BigInt(item.value)), ...(preview.changeSatoshis > 0 ? [BigInt(preview.changeSatoshis)] : [])];
    const expectedOutputRecords = parsed.outputs.map((item, index) => {
      if (item.vout !== index || BigInt(item.valueSatoshis) !== expectedValues[index] || assertScript(item.scriptHex) !== ownerScript) {
        throw new BitfsFundingError("integrity", "拆分交易的专款或找零输出不属于当前 Key");
      }
      return { txid: canonicalTxid, vout: item.vout, valueSatoshis: String(item.valueSatoshis), scriptHex: ownerScript };
    });
    const actualFee = selectedTotal - parsed.outputs.reduce((total, item) => total + BigInt(item.valueSatoshis), 0n);
    if (actualFee < 0n || actualFee !== BigInt(preview.estimatedFeeSatoshis) || actualFee > BigInt(input.maxFeeSatoshis)) {
      throw new BitfsFundingError("invalid_amount", "拆分交易手续费超出上限或与 P2PKH 预览不一致");
    }
    if (!preview.utxoBinding) throw new BitfsFundingError("input_unavailable", "P2PKH 拆分缺少新鲜余额快照序号绑定");
    inputReservation = await deps.reserveP2pkhInputs({ ownerPublicKeyHex: owner, network, preview, inputOutpoints: expectedInputs });

    const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    if (!preview.submissionId) throw new BitfsFundingError("input_unavailable", "P2PKH 拆分预签缺少持久化提交编号");
    await deps.ledger.prepareSplit({
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      network,
      expectedRevision: account.revision,
      txid,
      p2pkhSubmissionId: preview.submissionId,
      inputs: expectedInputs,
      outputs: expectedOutputRecords,
      nowMs: deps.nowMs(),
    });
    const rawTransaction = fromHex(preview.rawTxHex);
    await deps.transactions.putTransaction(txid, rawTransaction, deps.nowMs());
    const saved = await deps.transactions.getTransaction(txid);
    if (!saved || !equal(saved, rawTransaction)) throw new BitfsFundingError("storage", "拆分交易 exact bytes 写入 outbox 后回读失败");
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    return {
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      txid,
      rawTransaction: rawTransaction.slice(),
      inputOutpoints: expectedInputs,
      dedicatedOutpoints: expectedOutputRecords.map(outpointKey),
      requiredSatoshis: requiredSatoshis.toString(10),
      targetSatoshis: topUp.targetSatoshis.toString(10),
      reserveSatoshis: topUp.reserveSatoshis.toString(10),
      feeSatoshis: actualFee.toString(10),
    };
  } catch (error) {
    let outboxRead = false;
    let saved: Uint8Array | undefined;
    if (txid) {
      try { saved = await deps.transactions.getTransaction(txid); outboxRead = true; }
      catch { /* outbox 读取失败时保留快照与专款占用，避免错误释放 */ }
    }
    let safeToRelease = !txid;
    if (txid && outboxRead && !saved) {
      try {
        let account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const transaction = account.transactions.find((item) => item.txid === txid && item.purpose === "split");
        if (!transaction) {
          safeToRelease = true;
        } else if (transaction.state === "prepared") {
          account = await deps.ledger.releaseDefinitelyUndispatchedTransaction({
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            network,
            expectedRevision: account.revision,
            txid,
            nowMs: deps.nowMs(),
          });
          safeToRelease = account.transactions.some((item) => item.txid === txid && item.state === "failed");
        }
      } catch { /* 无法证明 ledger 已释放时继续保持输入占用 */ }
    }
    if (safeToRelease) {
      inputReservation?.rollback();
      if (preview) await deps.releasePrepared(preview).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * 重启后核对本 Seed 的拆分计划与 exact outbox。
 *
 * ledger 有计划但 outbox 完全没有记录时，广播器不可能派发该交易，故可安全
 * 释放其普通余额输入；其它不完整或未知状态一律保留保护并报错。
 */
export async function recoverBitfsFundingSplits(input: {
  /** 当前 Vault Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 本次采购文件的 Seed Hash。 */
  seedHashHex: string;
  /** 当前公链网络。 */
  network: BsvNetwork;
}, deps: Pick<BitfsFundingSplitPrepareDeps, "ledger" | "transactions" | "parseTransaction" | "nowMs"> & {
  /** ledger 确认交易无 outbox 时，释放对应 P2PKH 预签 claim。 */
  releasePreparedSubmission(input: { ownerPublicKeyHex: string; network: BsvNetwork; txid: string; submissionId: string }): Promise<void>;
}): Promise<BitfsFundingAccount> {
  const owner = assertOwner(input.ownerPublicKeyHex);
  const seed = assertHash(input.seedHashHex);
  const network = assertNetwork(input.network);
  let account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
  for (const planned of account.transactions.filter((item) => item.purpose === "split" && item.state !== "failed")) {
    const rawTransaction = await deps.transactions.getTransaction(planned.txid);
    const outboxRecord = await deps.transactions.getTransactionRecord(planned.txid);
    if (!rawTransaction) {
      if (outboxRecord || planned.state !== "prepared") throw new BitfsFundingError("integrity", `拆分交易 ${planned.txid} 缺少 outbox 原文，输入继续受保护`);
      const submissionId = planned.p2pkhSubmissionId;
      if (submissionId) {
        await deps.releasePreparedSubmission({ ownerPublicKeyHex: owner, network, txid: planned.txid, submissionId });
      } else {
        throw new BitfsFundingError("integrity", "未派发拆分交易缺少 P2PKH 提交编号，继续保护输入");
      }
      account = await deps.ledger.releaseDefinitelyUndispatchedTransaction({
        ownerPublicKeyHex: owner,
        seedHashHex: seed,
        network,
        expectedRevision: account.revision,
        txid: planned.txid,
        nowMs: deps.nowMs(),
      });
      continue;
    }
    const parsed = deps.parseTransaction(toHex(rawTransaction), planned.txid);
    const actualOutputs = parsed.outputs.map((output) => ({
      txid: parsed.canonicalTxid,
      vout: output.vout,
      valueSatoshis: String(output.valueSatoshis),
      scriptHex: assertScript(output.scriptHex),
    }));
    if (parsed.canonicalTxid !== planned.txid
      || !sameStrings(planned.inputOutpoints, parsed.inputs.map(normalizeOutpoint))
      || !sameOutputs(planned.expectedOutputs, actualOutputs)) {
      throw new BitfsFundingError("integrity", `拆分交易 ${planned.txid} 与 ledger 计划不一致，输入继续受保护`);
    }
    if (!outboxRecord) await deps.transactions.putTransaction(planned.txid, rawTransaction, deps.nowMs());
    if (outboxRecord?.state === "result-unknown" && planned.state === "prepared") {
      account = await deps.ledger.markTransactionUnknown({ ownerPublicKeyHex: owner, seedHashHex: seed, network, txid: planned.txid, nowMs: deps.nowMs() });
    } else if (outboxRecord?.state === "confirmed" && planned.state !== "observed") {
      account = await deps.ledger.observeSplit({ ownerPublicKeyHex: owner, seedHashHex: seed, network, txid: planned.txid, actualOutputs, nowMs: deps.nowMs() });
    }
  }
  return deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
}

/** 交易原文解析结果；Worker 使用 P2PKH 共识字节解析器实现此端口。 */
export interface BitfsFundingTransactionView {
  /** 从交易原文重新计算得到的 canonical txid。 */
  canonicalTxid: string;
  /** 原文中的全部输入 outpoint。 */
  inputs: string[];
  /** 原文中的输出序号、金额与锁定脚本。 */
  outputs: Array<{ vout: number; valueSatoshis: number; scriptHex: string }>;
}

/** 已经签名并持久化的开池交易；该结果不包含广播动作。 */
export interface PreparedBitfsFunding {
  /** BitFS 买卖会话编号。 */
  sessionId: string;
  /** 当前 Seed 资金池对应的交易哈希。 */
  txid: string;
  /** 需要交给 Worker 广播器的 exact 交易原文。 */
  rawTransaction: Uint8Array;
  /** 固定在第 0 个输出的开池 outpoint。 */
  openingOutpoint: { txid: string; vout: 0; valueSatoshis: string; scriptHex: string };
  /** 被本交易占用的专款输入。 */
  inputOutpoints: string[];
  /** 找零回当前 Key 的金额；无找零时为 0。 */
  changeSatoshis: string;
  /** 找零输出脚本；无找零时省略。 */
  changeScriptHex?: string;
  /** 原文输入金额减去输出金额得到的实际手续费。 */
  feeSatoshis: string;
}

/** Funding 准备器依赖的 Worker 端口。 */
export interface BitfsFundingPrepareDeps {
  /** 每次都必须提供已绑定当前 Key 的受限协议交易准备器。 */
  protocolSpend: ProtocolSpendService;
  /** 当前 Key 与网络对应的唯一找零地址和锁定脚本。 */
  resolveOwnerAddress(input: { ownerPublicKeyHex: string; network: BsvNetwork }): Promise<{ address: string; scriptHex: string }>;
  /** 签名后消费 P2PKH 快照序号，阻止普通转账选中相同专款输入。 */
  reserveP2pkhInputs(input: { ownerPublicKeyHex: string; network: BsvNetwork; preview: ProtocolSpendPreview; inputOutpoints: string[] }): BitfsFundingInputReservation | Promise<BitfsFundingInputReservation>;
  /** 共识交易解析器；必须从 raw transaction 计算 txid 与 outputs。 */
  parseTransaction(rawTransactionHex: string, expectedTxid?: string): BitfsFundingTransactionView;
  /** 原样保存 exact bytes 和 txid 的专用 BitFS outbox。 */
  transactions: BitfsTransactionJournal;
  /** 买卖状态与 exact 证据存储。 */
  sessions: BitfsSessionJournal;
  /** 当前 owner 的专款账本。 */
  ledger: BitfsFundingLedger;
  /** 每个持久化边界前核验当前 Key、网络和 Worker generation 仍匹配。 */
  assertCurrentContext(input: { ownerPublicKeyHex: string; network: BsvNetwork; generation: number }): void;
  /** 放弃尚未进入 BitFS outbox 的预签名时，释放 P2PKH 输入 claim。 */
  releasePrepared(preview: ProtocolSpendPreview): Promise<void>;
  /** 当前 UTC 毫秒，由 Worker 显式提供。 */
  nowMs(): number;
}

/**
 * 只用当前 Seed 的专款构造 FundingTx。
 *
 * 中文说明：此函数不会调用 protocolSpend.submit、广播器或节点；成功返回前，
 * exact raw、outbox 索引、专款占用和会话证据均已先写入并回读校验。
 */
export async function prepareBitfsFunding(input: {
  /** 买卖会话编号。 */
  sessionId: string;
  /** 当前 Vault Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 买卖对应的 Seed Hash。 */
  seedHashHex: string;
  /** 当前账户使用的公链网络。 */
  network: BsvNetwork;
  /** Worker 当前 generation；迟到请求必须被拒绝。 */
  generation: number;
  /** 从已验证报价和参与者公钥推导的池输出金额与锁定脚本。 */
  openingOutput: { valueSatoshis: string; scriptHex: string };
  /** 单个 P2PKH 签名输入的手续费率，单位聪/千字节。 */
  feeRateSatoshisPerKb: number;
  /** 允许的最高交易手续费，单位聪。 */
  maxFeeSatoshis: number;
}, deps: BitfsFundingPrepareDeps): Promise<PreparedBitfsFunding> {
  const owner = assertOwner(input.ownerPublicKeyHex);
  const seed = assertHash(input.seedHashHex);
  const network = assertNetwork(input.network);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new BitfsFundingError("stale_session", "BitFS 会话世代无效");
  if (!Number.isSafeInteger(input.feeRateSatoshisPerKb) || input.feeRateSatoshisPerKb < 1) throw new BitfsFundingError("invalid_amount", "BitFS 交易手续费率不合法");
  if (!Number.isSafeInteger(input.maxFeeSatoshis) || input.maxFeeSatoshis < 1) throw new BitfsFundingError("invalid_amount", "BitFS 最高交易手续费不合法");
  const outputAmount = assertSatoshiString(input.openingOutput.valueSatoshis, false);
  const outputScript = assertScript(input.openingOutput.scriptHex);
  const outputAmountNumber = safeSatoshiNumber(outputAmount);
  deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });

  const session = await deps.sessions.get(input.sessionId);
  if (!session || session.role !== "buyer" || session.ownerPublicKeyHex !== owner || session.seedHashHex !== seed) {
    throw new BitfsFundingError("stale_session", "BitFS 买方会话身份已变化");
  }
  const priorEvidence = await deps.sessions.getEvidence(input.sessionId, "funding-transaction");
  if (priorEvidence) {
    // Worker 可能在保存 exact bytes 后、更新阶段或资金账本前重启；
    // 从 evidence 原文重新求 txid，再补齐 outbox 与账本，绝不重新签名。
    const recoveredView = deps.parseTransaction(toHex(priorEvidence));
    const txid = assertHash(recoveredView.canonicalTxid);
    if (session.pendingTxid !== undefined && session.pendingTxid !== txid) throw new BitfsFundingError("integrity", "会话待对账 txid 与已保存 FundingTx 不一致");
    const stored = await deps.transactions.getTransaction(txid);
    if (stored && !equal(stored, priorEvidence)) throw new BitfsFundingError("integrity", "会话证据与交易 outbox 的 exact bytes 不一致");
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    if (!stored) await deps.transactions.putTransaction(txid, priorEvidence, deps.nowMs());
    const expectedOutput = {
      txid,
      vout: 0,
      valueSatoshis: outputAmount,
      scriptHex: outputScript,
    } as const;
    const parsedOpening = recoveredView.outputs[0];
    if (!parsedOpening || parsedOpening.vout !== 0 || String(parsedOpening.valueSatoshis) !== expectedOutput.valueSatoshis || assertScript(parsedOpening.scriptHex) !== expectedOutput.scriptHex) {
      throw new BitfsFundingError("integrity", "恢复的 FundingTx 第 0 个输出与开池证据不一致");
    }
    let account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
    const ownerAddress = await deps.resolveOwnerAddress({ ownerPublicKeyHex: owner, network });
    const ownerChangeScript = assertScript(ownerAddress.scriptHex);
    if (recoveredView.outputs.length < 1 || recoveredView.outputs.length > 2) throw new BitfsFundingError("integrity", "恢复的 FundingTx 输出数量无效");
    const recoveredChange = recoveredView.outputs[1];
    if (recoveredChange && assertScript(recoveredChange.scriptHex) !== ownerChangeScript) throw new BitfsFundingError("integrity", "恢复的 FundingTx 找零没有回到当前 Key");
    const inputOutpoints = uniqueOutpoints(recoveredView.inputs);
    const inputTotal = inputOutpoints.reduce((sum, key) => {
      const utxo = account.utxos.find((item) => outpointKey(item) === key);
      if (!utxo) throw new BitfsFundingError("integrity", `恢复的 FundingTx 输入 ${key} 不在专款账本中`);
      return sum + BigInt(utxo.valueSatoshis);
    }, 0n);
    const outputTotal = recoveredView.outputs.reduce((sum, item) => sum + BigInt(item.valueSatoshis), 0n);
    const recoveredFee = inputTotal - outputTotal;
    if (recoveredFee < 0n || recoveredFee > BigInt(input.maxFeeSatoshis)) throw new BitfsFundingError("integrity", "恢复的 FundingTx 手续费超过当前允许上限");
    if (!account.pools.some((pool) => pool.poolId === input.sessionId && pool.fundingTxid === txid)) {
      const priorPlan = account.transactions.find((transaction) => transaction.txid === txid && transaction.purpose === "opening");
      if (!priorPlan?.p2pkhSubmissionId) {
        throw new BitfsFundingError("integrity", "FundingTx 恢复账本缺少 P2PKH 提交编号，不能重建输入 claim");
      }
      deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
      await deps.ledger.reservePoolFunding({
        ownerPublicKeyHex: owner,
        seedHashHex: seed,
        network,
        expectedRevision: account.revision,
        poolId: input.sessionId,
        txid,
        p2pkhSubmissionId: priorPlan.p2pkhSubmissionId,
        inputs: inputOutpoints,
        openingOutput: expectedOutput,
        ...(recoveredChange ? {
          changeOutput: {
            txid,
            vout: recoveredChange.vout,
            valueSatoshis: String(recoveredChange.valueSatoshis),
            scriptHex: assertScript(recoveredChange.scriptHex),
          },
        } : {}),
        maxFeeSatoshis: String(input.maxFeeSatoshis),
        changeSatoshis: String(recoveredChange?.valueSatoshis ?? 0),
        changeScriptHex: ownerChangeScript,
        nowMs: deps.nowMs(),
      });
      account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
    }
    const recoveredExpectedOutputs = recoveredView.outputs.map((output) => ({
      txid,
      vout: output.vout,
      valueSatoshis: String(output.valueSatoshis),
      scriptHex: assertScript(output.scriptHex),
    }));
    const recoveredPlan = account.transactions.find((transaction) => transaction.txid === txid && transaction.purpose === "opening");
    const recoveredPool = account.pools.find((pool) => pool.poolId === input.sessionId && pool.fundingTxid === txid);
    if (!recoveredPlan
      || !recoveredPlan.p2pkhSubmissionId
      || !recoveredPool
      || !sameStrings(recoveredPlan.inputOutpoints, inputOutpoints)
      || !sameOutputs(recoveredPlan.expectedOutputs, recoveredExpectedOutputs)
      || recoveredPlan.changeSatoshis !== String(recoveredChange?.valueSatoshis ?? 0)
      || recoveredPlan.changeScriptHex !== ownerChangeScript) {
      throw new BitfsFundingError("integrity", "FundingTx 恢复账本缺少完整开池或找零保护记录");
    }
    if (recoveredChange && !account.utxos.some((utxo) => outpointKey(utxo) === `${txid}:${recoveredChange.vout}` && utxo.state !== "released")) {
      throw new BitfsFundingError("integrity", "FundingTx 恢复账本未保护当前 Key 找零输出");
    }
    if (session.phase === "quote-selected") {
      deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
      await deps.sessions.update(input.sessionId, session.revision, { phase: "funding-prepared", pendingTxid: txid }, deps.nowMs());
    } else if (session.pendingTxid !== undefined && session.pendingTxid !== txid) {
      throw new BitfsFundingError("integrity", "买方会话待对账 txid 与 FundingTx 不一致");
    }
    return reconstructPreparedFunding(input.sessionId, txid, priorEvidence, recoveredView, account);
  }
  if (session.phase !== "quote-selected") throw new BitfsFundingError("invalid_transition", "只能在报价固定后、Kind 2 签署前准备 FundingTx");
  const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
  const candidates = account.utxos.filter((utxo) => utxo.state === "available");
  const selected = selectDedicatedFunds(candidates, BigInt(outputAmount) + BigInt(input.maxFeeSatoshis));
  const change = await deps.resolveOwnerAddress({ ownerPublicKeyHex: owner, network });
  const changeScript = assertScript(change.scriptHex);
  const selectedInputs = selected.map((utxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    value: safeSatoshiNumber(utxo.valueSatoshis),
    address: change.address,
  }));

  let preview: ProtocolSpendPreview | undefined;
  let inputReservation: BitfsFundingInputReservation | undefined;
  let outboxDurable = false;
  try {
    preview = await deps.protocolSpend.prepare({
      ownerPublicKeyHex: owner,
      requestingPluginId: "msfile",
      network,
      inputs: selectedInputs,
      outputs: [{ value: outputAmountNumber, scriptHex: outputScript, label: "BitFS 开池资金" }],
      feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
      changeAddress: change.address,
    });
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    const rawTransaction = fromHex(preview.rawTxHex);
    const parsed = deps.parseTransaction(preview.rawTxHex, preview.txid);
    const inputOutpoints = selected.map(outpointKey).sort();
    const actualInputOutpoints = parsed.inputs.map(normalizeOutpoint).sort();
    const actualFee = selected.reduce((sum, utxo) => sum + BigInt(utxo.valueSatoshis), 0n)
      - parsed.outputs.reduce((sum, item) => sum + BigInt(item.valueSatoshis), 0n);
    validatePreparedTransaction({
      preview,
      parsed,
      expectedTxid: preview.txid,
      owner,
      network,
      inputOutpoints,
      actualInputOutpoints,
      expectedInputs: selectedInputs,
      openingOutput: { valueSatoshis: outputAmount, scriptHex: outputScript },
      ownerChangeAddress: change.address,
      ownerChangeScriptHex: changeScript,
      actualFee,
      maxFeeSatoshis: BigInt(input.maxFeeSatoshis),
    });
    if (!preview.utxoBinding) throw new BitfsFundingError("input_unavailable", "FundingTx 缺少新鲜 P2PKH 快照序号绑定");
    if (!preview.submissionId) throw new BitfsFundingError("input_unavailable", "FundingTx 预签缺少 P2PKH 持久化提交编号");
    inputReservation = await deps.reserveP2pkhInputs({
      ownerPublicKeyHex: owner,
      network,
      preview,
      inputOutpoints,
    });
    const opening = { txid: preview.txid, vout: 0, valueSatoshis: outputAmount, scriptHex: outputScript } as const;
    const poolId = input.sessionId;

    // 先在专款账本原子保护输入和预期输出，再保存交易证据。
    // Worker 若在后续写盘期间重启，普通余额视图仍会过滤这些 outpoint。
    const freshAccount = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
    await deps.ledger.reservePoolFunding({
      ownerPublicKeyHex: owner,
      seedHashHex: seed,
      network,
      expectedRevision: freshAccount.revision,
      poolId,
      txid: preview.txid,
      p2pkhSubmissionId: preview.submissionId,
      inputs: inputOutpoints,
      openingOutput: opening,
      ...(parsed.outputs[1] ? {
        changeOutput: {
          txid: preview.txid,
          vout: parsed.outputs[1].vout,
          valueSatoshis: String(parsed.outputs[1].valueSatoshis),
          scriptHex: assertScript(parsed.outputs[1].scriptHex),
        },
      } : {}),
      maxFeeSatoshis: String(input.maxFeeSatoshis),
      changeSatoshis: String(preview.changeSatoshis),
      changeScriptHex: changeScript,
      nowMs: deps.nowMs(),
    });

    // exact bytes 先锚定到会话；随后进入独立交易 outbox，不会重新签名。
    const latestSession = await deps.sessions.get(input.sessionId);
    if (!latestSession || latestSession.revision !== session.revision) throw new BitfsFundingError("revision_conflict", "BitFS 会话在准备交易期间已变化");
    deps.assertCurrentContext({ ownerPublicKeyHex: owner, network, generation: input.generation });
    const withEvidence = await deps.sessions.putEvidence(input.sessionId, latestSession.revision, "funding-transaction", rawTransaction, deps.nowMs());

    // exact 交易进入独立 outbox；putTransaction 会回读并比较全部交易字节。
    await deps.transactions.putTransaction(preview.txid, rawTransaction, deps.nowMs());
    outboxDurable = true;
    const committed = await deps.sessions.update(input.sessionId, withEvidence.revision, { phase: "funding-prepared", pendingTxid: preview.txid }, deps.nowMs());
    if (committed.pendingTxid !== preview.txid || committed.phase !== "funding-prepared") throw new BitfsFundingError("storage", "FundingTx 会话状态回读校验失败");

    return {
      sessionId: input.sessionId,
      txid: preview.txid,
      rawTransaction: rawTransaction.slice(),
      openingOutpoint: opening,
      inputOutpoints,
      changeSatoshis: String(preview.changeSatoshis),
      ...(preview.changeSatoshis > 0 ? { changeScriptHex: changeScript } : {}),
      feeSatoshis: actualFee.toString(10),
    };
  } catch (error) {
    // exact bytes 进入 evidence/outbox 后输入必须保留占用；尚未持久化时才可以
    // 释放 P2PKH claim、专款计划与余额快照序号。
    let evidenceSaved = false;
    try { evidenceSaved = (await deps.sessions.getEvidence(input.sessionId, "funding-transaction")) !== undefined; }
    catch { evidenceSaved = true; }
    if (preview && !outboxDurable && !evidenceSaved) {
      let safeToRelease = false;
      try {
        const account = await deps.ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: deps.nowMs() });
        const plan = account.transactions.find((transaction) => transaction.txid === preview!.txid && transaction.purpose === "opening");
        if (plan && plan.state !== "failed" && plan.state !== "observed") {
          if (preview.submissionId && deps.protocolSpend.releasePreparedSubmission) {
            await deps.protocolSpend.releasePreparedSubmission({ ownerPublicKeyHex: owner, network, txid: preview.txid, submissionId: preview.submissionId });
          } else {
            await deps.releasePrepared(preview);
          }
          await deps.ledger.releaseDefinitelyUndispatchedTransaction({
            ownerPublicKeyHex: owner,
            seedHashHex: seed,
            network,
            expectedRevision: account.revision,
            txid: preview.txid,
            nowMs: deps.nowMs(),
          });
          safeToRelease = true;
        } else if (!plan) {
          await deps.releasePrepared(preview);
          safeToRelease = true;
        }
      } catch { /* 无法证明 claim、ledger 与 outbox 可一起释放时继续保持保护 */ }
      if (safeToRelease) inputReservation?.rollback();
    }
    throw error;
  }
}

/** Funding 准备期间产生的稳定错误；message 使用中文供本地诊断和界面映射。 */
export class BitfsFundingError extends Error {
  /** 可供 Coordinator 与界面映射的稳定错误分类。 */
  readonly code: BitfsFundingErrorCode;

  constructor(code: BitfsFundingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "BitfsFundingError";
  }
}

/** BitFS 资金准备的稳定错误分类。 */
export type BitfsFundingErrorCode =
  | "invalid_amount"
  | "invalid_identity"
  | "network_mismatch"
  | "insufficient_funds"
  | "input_unavailable"
  | "revision_conflict"
  | "integrity"
  | "storage"
  | "stale_session"
  | "invalid_transition";

function emptyAccount(owner: string, seed: string, network: BsvNetwork, nowMs: number): BitfsFundingAccount {
  return { ownerPublicKeyHex: owner, seedHashHex: seed, network, version: 1, revision: 0, updatedAt: iso(nowMs), utxos: [], transactions: [], pools: [] };
}

function parseAccount(value: unknown, owner: string, seed: string, network: BsvNetwork): BitfsFundingAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BitfsFundingError("integrity", "BitFS 专款账本不是对象");
  const row = value as Record<string, unknown>;
  if (row.format !== ACCOUNT_FORMAT || row.version !== ACCOUNT_VERSION) throw new BitfsFundingError("integrity", "BitFS 专款账本版本不支持");
  const account = validateAccount({
    ownerPublicKeyHex: row.ownerPublicKeyHex as string,
    seedHashHex: row.seedHashHex as string,
    network: row.network as BsvNetwork,
    version: row.version as 1,
    revision: row.revision as number,
    updatedAt: row.updatedAt as string,
    utxos: row.utxos as BitfsDedicatedUtxo[],
    transactions: row.transactions as BitfsFundingTransaction[],
    pools: row.pools as BitfsFundingPool[],
  }, owner, seed, network);
  return account;
}

function validateAccount(account: BitfsFundingAccount, owner: string, seed: string, network: BsvNetwork): BitfsFundingAccount {
  if (account.ownerPublicKeyHex !== owner || account.seedHashHex !== seed || account.network !== network) {
    throw new BitfsFundingError("network_mismatch", "BitFS 专款账本与当前 Key、Seed 或网络不一致");
  }
  if (account.version !== 1 || !Number.isSafeInteger(account.revision) || account.revision < 0) throw new BitfsFundingError("integrity", "BitFS 专款账本版本或修订号无效");
  if (!Array.isArray(account.utxos) || !Array.isArray(account.transactions) || !Array.isArray(account.pools)) throw new BitfsFundingError("integrity", "BitFS 专款账本列表字段损坏");
  const updatedAt = new Date(account.updatedAt);
  if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== account.updatedAt) throw new BitfsFundingError("integrity", "BitFS 专款账本时间无效");
  const utxos = account.utxos.map(validateUtxo);
  const txs = account.transactions.map(validateFundingTransaction);
  const pools = account.pools.map(validatePool);
  if (new Set(utxos.map(outpointKey)).size !== utxos.length) throw new BitfsFundingError("integrity", "BitFS 专款账本包含重复 outpoint");
  if (new Set(txs.map((item) => item.txid)).size !== txs.length) throw new BitfsFundingError("integrity", "BitFS 专款账本包含重复交易哈希");
  if (new Set(pools.map((item) => item.poolId)).size !== pools.length) throw new BitfsFundingError("integrity", "BitFS 专款账本包含重复池编号");
  return { ...account, utxos, transactions: txs, pools };
}

function validateUtxo(value: BitfsDedicatedUtxo): BitfsDedicatedUtxo {
  const txid = assertHash(value.txid);
  if (!Number.isSafeInteger(value.vout) || value.vout < 0 || value.vout > 0xffffffff) throw new BitfsFundingError("integrity", "BitFS 专款输出序号无效");
  const state = value.state;
  if (!["split-pending", "available", "pool-occupied", "recovery-pending", "released"].includes(state)) throw new BitfsFundingError("integrity", "BitFS 专款输出状态无效");
  return {
    txid,
    vout: value.vout,
    valueSatoshis: assertSatoshiString(value.valueSatoshis, false),
    scriptHex: assertScript(value.scriptHex),
    state,
    ...(value.splitTxid === undefined ? {} : { splitTxid: assertHash(value.splitTxid) }),
    ...(value.poolId === undefined ? {} : { poolId: assertPoolId(value.poolId) }),
    ...(value.spendingTxid === undefined ? {} : { spendingTxid: assertHash(value.spendingTxid) }),
  };
}

function validateFundingTransaction(value: BitfsFundingTransaction): BitfsFundingTransaction {
  if (!["split", "opening", "close", "refund"].includes(value.purpose)) throw new BitfsFundingError("integrity", "BitFS 专款交易用途无效");
  if (!["prepared", "result-unknown", "observed", "failed"].includes(value.state)) throw new BitfsFundingError("integrity", "BitFS 专款交易状态无效");
  if (value.purpose === "opening" && (value.maxFeeSatoshis === undefined || value.changeSatoshis === undefined || value.changeScriptHex === undefined)) {
    throw new BitfsFundingError("integrity", "开池交易账本缺少手续费或找零校验字段");
  }
  return {
    txid: assertHash(value.txid),
    purpose: value.purpose,
    state: value.state,
    ...(value.p2pkhSubmissionId === undefined ? {} : { p2pkhSubmissionId: assertSubmissionId(value.p2pkhSubmissionId) }),
    inputOutpoints: uniqueOutpoints(value.inputOutpoints),
    expectedOutputs: validateExpectedOutputs(value.txid, value.expectedOutputs),
    ...(value.poolId === undefined ? {} : { poolId: assertPoolId(value.poolId) }),
    ...(value.maxFeeSatoshis === undefined ? {} : { maxFeeSatoshis: assertSatoshiString(value.maxFeeSatoshis, false) }),
    ...(value.changeSatoshis === undefined ? {} : { changeSatoshis: assertSatoshiString(value.changeSatoshis, true) }),
    ...(value.changeScriptHex === undefined ? {} : { changeScriptHex: assertScript(value.changeScriptHex) }),
    ...(value.inputsReconciled === undefined ? {} : { inputsReconciled: value.inputsReconciled === true }),
  };
}

function validatePool(value: BitfsFundingPool): BitfsFundingPool {
  if (!["funding-pending", "funding-failed", "open", "recovery-pending", "closed"].includes(value.state)) throw new BitfsFundingError("integrity", "BitFS 池状态无效");
  return {
    poolId: assertPoolId(value.poolId),
    fundingTxid: assertHash(value.fundingTxid),
    openingOutpoint: assertOutpoint(value.openingOutpoint),
    inputOutpoints: uniqueOutpoints(value.inputOutpoints),
    state: value.state,
    ...(value.recoveryTxid === undefined ? {} : { recoveryTxid: assertHash(value.recoveryTxid) }),
  };
}

function encodeAccount(account: BitfsFundingAccount): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ format: ACCOUNT_FORMAT, ...account }, null, 2)}\n`);
}

function validatePreparedTransaction(input: {
  preview: ProtocolSpendPreview;
  parsed: BitfsFundingTransactionView;
  expectedTxid: string;
  owner: string;
  network: BsvNetwork;
  inputOutpoints: string[];
  actualInputOutpoints: string[];
  expectedInputs: Array<{ txid: string; vout: number; value: number; address: string }>;
  openingOutput: { valueSatoshis: string; scriptHex: string };
  ownerChangeAddress: string;
  ownerChangeScriptHex: string;
  actualFee: bigint;
  maxFeeSatoshis: bigint;
}): void {
  if (input.preview.ownerPublicKeyHex !== input.owner || input.preview.network !== input.network) throw new BitfsFundingError("network_mismatch", "FundingTx 的当前 Key 或网络与请求不一致");
  if (input.parsed.canonicalTxid !== input.expectedTxid || input.parsed.canonicalTxid !== input.preview.txid) throw new BitfsFundingError("integrity", "FundingTx 原文与 canonical txid 不一致");
  if (!sameStrings(input.inputOutpoints, input.actualInputOutpoints)) throw new BitfsFundingError("integrity", "FundingTx 原文包含账本以外的输入");
  const previewInputs = input.preview.inputs.map((item) => `${item.txid}:${item.vout}`).sort();
  const expectedPreviewInputs = input.expectedInputs.map((item) => `${item.txid}:${item.vout}`).sort();
  if (!sameStrings(previewInputs, expectedPreviewInputs)
    || input.preview.inputs.some((item, index) => {
      const expected = input.expectedInputs.find((candidate) => candidate.txid === item.txid && candidate.vout === item.vout);
      return !expected || expected.value !== item.value || expected.address !== item.address;
    })) throw new BitfsFundingError("integrity", "P2PKH 预览输入与本文件专款选择不一致");
  if (input.preview.outputs.length !== 1
    || input.preview.outputs[0]?.value !== Number(input.openingOutput.valueSatoshis)
    || assertScript(input.preview.outputs[0]?.scriptHex ?? "") !== input.openingOutput.scriptHex
    || input.preview.changeAddress !== input.ownerChangeAddress) {
    throw new BitfsFundingError("integrity", "P2PKH 预览输出或找零地址与开池计划不一致");
  }
  if (input.parsed.outputs.length < 1 || input.parsed.outputs.length > 2) throw new BitfsFundingError("integrity", "FundingTx 只能包含固定开池输出与找零输出");
  const opening = input.parsed.outputs[0]!;
  if (opening.vout !== 0 || String(opening.valueSatoshis) !== input.openingOutput.valueSatoshis || assertScript(opening.scriptHex) !== input.openingOutput.scriptHex) {
    throw new BitfsFundingError("integrity", "FundingTx 的第 0 个输出与开池证据不一致");
  }
  const parsedChange = input.parsed.outputs[1];
  if (input.preview.changeSatoshis > 0) {
    if (!parsedChange || parsedChange.vout !== 1 || parsedChange.valueSatoshis !== input.preview.changeSatoshis || assertScript(parsedChange.scriptHex) !== input.ownerChangeScriptHex) {
      throw new BitfsFundingError("integrity", "FundingTx 找零没有完整返回当前 Key");
    }
  } else if (parsedChange) {
    throw new BitfsFundingError("integrity", "FundingTx 出现未声明的额外输出");
  }
  if (input.actualFee < 0n || input.actualFee !== BigInt(input.preview.estimatedFeeSatoshis) || input.actualFee > input.maxFeeSatoshis) {
    throw new BitfsFundingError("invalid_amount", "FundingTx 手续费超出上限或与 P2PKH 交易预览不一致");
  }
}

function reconstructPreparedFunding(
  sessionId: string,
  txid: string,
  rawTransaction: Uint8Array,
  view: BitfsFundingTransactionView,
  account: BitfsFundingAccount,
): PreparedBitfsFunding {
  const pool = account.pools.find((item) => item.poolId === sessionId && item.fundingTxid === txid);
  const opening = pool && account.utxos.find((item) => outpointKey(item) === pool.openingOutpoint);
  const transaction = account.transactions.find((item) => item.txid === txid && item.purpose === "opening");
  if (!pool || !opening || !transaction || view.canonicalTxid !== txid) throw new BitfsFundingError("integrity", "FundingTx 恢复索引不完整");
  const inputTotal = transaction.inputOutpoints.reduce((sum, key) => {
    const utxo = account.utxos.find((item) => outpointKey(item) === key);
    if (!utxo) throw new BitfsFundingError("integrity", `FundingTx 输入 ${key} 不在专款账本中`);
    return sum + BigInt(utxo.valueSatoshis);
  }, 0n);
  const outputTotal = view.outputs.reduce((sum, item) => sum + BigInt(item.valueSatoshis), 0n);
  const changeOutput = view.outputs[1];
  return {
    sessionId,
    txid,
    rawTransaction: rawTransaction.slice(),
    openingOutpoint: { txid: opening.txid, vout: 0, valueSatoshis: opening.valueSatoshis, scriptHex: opening.scriptHex },
    inputOutpoints: [...transaction.inputOutpoints],
    changeSatoshis: changeOutput ? String(changeOutput.valueSatoshis) : "0",
    ...(changeOutput ? { changeScriptHex: changeOutput.scriptHex } : {}),
    feeSatoshis: (inputTotal - outputTotal).toString(10),
  };
}

function selectDedicatedFunds(utxos: BitfsDedicatedUtxo[], target: bigint): BitfsDedicatedUtxo[] {
  const sorted = [...utxos].sort((left, right) => {
    const a = BigInt(left.valueSatoshis);
    const b = BigInt(right.valueSatoshis);
    return a === b ? outpointKey(left).localeCompare(outpointKey(right)) : a > b ? -1 : 1;
  });
  const selected: BitfsDedicatedUtxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += BigInt(utxo.valueSatoshis);
    if (total >= target) return selected;
  }
  throw new BitfsFundingError("insufficient_funds", "本文件的专款余额不足以覆盖开池金额和最高手续费");
}

function selectWalletInputs<T extends { txid: string; vout: number; valueSatoshis: string; address: string }>(utxos: T[], target: bigint): T[] {
  const sorted = [...utxos].sort((left, right) => {
    const a = BigInt(left.valueSatoshis);
    const b = BigInt(right.valueSatoshis);
    return a === b ? outpointKey(left).localeCompare(outpointKey(right)) : a > b ? -1 : 1;
  });
  const selected: T[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += BigInt(utxo.valueSatoshis);
    if (total >= target) return selected;
  }
  throw new BitfsFundingError("insufficient_funds", "普通 P2PKH 可用余额不足以覆盖本段采购金额、20% 余量和手续费");
}

function requireTransaction(account: BitfsFundingAccount, txid: string, purpose?: BitfsFundingTransactionPurpose): BitfsFundingTransaction {
  const transaction = account.transactions.find((item) => item.txid === txid && (purpose === undefined || item.purpose === purpose));
  if (!transaction) throw new BitfsFundingError("integrity", `BitFS 专款交易 ${txid} 不存在`);
  return transaction;
}

function requirePool(account: BitfsFundingAccount, poolId: string): BitfsFundingPool {
  const pool = account.pools.find((item) => item.poolId === poolId);
  if (!pool) throw new BitfsFundingError("integrity", `BitFS 资金池 ${poolId} 不存在`);
  return pool;
}

function replaceTransaction(items: BitfsFundingTransaction[], next: BitfsFundingTransaction): BitfsFundingTransaction[] {
  return items.map((item) => item.txid === next.txid ? next : item);
}

function replacePool(items: BitfsFundingPool[], next: BitfsFundingPool): BitfsFundingPool[] {
  return items.map((item) => item.poolId === next.poolId ? next : item);
}

function assertNewOutpoints(account: BitfsFundingAccount, outputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout">>): void {
  const existing = new Set(account.utxos.map(outpointKey));
  for (const output of outputs) {
    if (existing.has(outpointKey(output))) throw new BitfsFundingError("integrity", `专款 outpoint ${outpointKey(output)} 已存在`);
  }
}

function validateExpectedOutputs(txid: string, outputs: Array<Pick<BitfsDedicatedUtxo, "txid" | "vout" | "valueSatoshis" | "scriptHex">>): BitfsFundingTransaction["expectedOutputs"] {
  if (!Array.isArray(outputs)) throw new BitfsFundingError("integrity", "BitFS 专款交易输出列表无效");
  const result = outputs.map((output) => {
    const normalized = validateUtxo({ ...output, state: "available" });
    if (normalized.txid !== txid) throw new BitfsFundingError("integrity", "专款预期输出 txid 与当前交易不一致");
    return { txid: normalized.txid, vout: normalized.vout, valueSatoshis: normalized.valueSatoshis, scriptHex: normalized.scriptHex };
  }).sort((left, right) => left.vout - right.vout);
  if (new Set(result.map((item) => item.vout)).size !== result.length) throw new BitfsFundingError("integrity", "BitFS 专款交易包含重复输出序号");
  return result;
}

function sameOutputs(left: BitfsFundingTransaction["expectedOutputs"], right: BitfsFundingTransaction["expectedOutputs"]): boolean {
  const a = [...left].sort((x, y) => x.vout - y.vout);
  const b = [...right].sort((x, y) => x.vout - y.vout);
  return a.length === b.length && a.every((item, index) => item.txid === b[index]!.txid && item.vout === b[index]!.vout
    && item.valueSatoshis === b[index]!.valueSatoshis && item.scriptHex === b[index]!.scriptHex);
}

function uniqueOutpoints(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new BitfsFundingError("integrity", "BitFS 资金交易必须绑定至少一个输入 outpoint");
  const result = values.map(assertOutpoint);
  if (new Set(result).size !== result.length) throw new BitfsFundingError("integrity", "BitFS 资金交易包含重复输入 outpoint");
  return result.sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function outpointKey(value: Pick<BitfsDedicatedUtxo, "txid" | "vout">): string { return `${value.txid}:${value.vout}`; }

function normalizeOutpoint(value: string): string { return assertOutpoint(value); }

function assertOutpoint(value: string): string {
  if (typeof value !== "string") throw new BitfsFundingError("integrity", "BitFS outpoint 格式无效");
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/u.exec(value);
  if (!match || Number(match[2]) > 0xffffffff) throw new BitfsFundingError("integrity", "BitFS outpoint 格式无效");
  return `${match[1]}:${Number(match[2])}`;
}

function assertOwner(value: string): string {
  if (typeof value !== "string" || !OWNER_KEY_HEX.test(value)) throw new BitfsFundingError("invalid_identity", "BitFS 资金账本需要 33 字节压缩公钥");
  return value;
}

function assertHash(value: string): string {
  if (typeof value !== "string" || !HASH_HEX.test(value)) throw new BitfsFundingError("integrity", "BitFS 资金记录中的 Hash 格式无效");
  return value;
}

function assertPoolId(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-z][0-9a-z._-]{0,127}$/u.test(value)) throw new BitfsFundingError("integrity", "BitFS 资金池编号格式无效");
  return value;
}

function assertSubmissionId(value: string): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z._-]{1,128}$/u.test(value)) throw new BitfsFundingError("integrity", "P2PKH 持久化提交编号无效");
  return value;
}

function assertNetwork(value: unknown): BsvNetwork {
  if (value !== "main" && value !== "test") throw new BitfsFundingError("network_mismatch", "BitFS 资金网络无效");
  return value;
}

function assertScript(value: string): string {
  if (typeof value !== "string" || !SCRIPT_HEX.test(value) || value !== value.toLowerCase()) throw new BitfsFundingError("integrity", "BitFS 交易脚本必须是非空小写十六进制");
  return value;
}

function assertSatoshiString(value: string, allowZero: boolean): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || (!allowZero && value === "0")) throw new BitfsFundingError("invalid_amount", "聪金额必须是规范的十进制整数字符串");
  return value;
}

function safeSatoshiNumber(value: string): number {
  const amount = BigInt(value);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new BitfsFundingError("invalid_amount", "当前 P2PKH 交易端口无法安全表示该聪金额");
  return Number(amount);
}

function iso(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new BitfsFundingError("integrity", "BitFS 资金时间必须是非负毫秒整数");
  return new Date(nowMs).toISOString();
}

function fromHex(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) throw new BitfsFundingError("integrity", "FundingTx 原文不是有效十六进制");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }

function equal(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
