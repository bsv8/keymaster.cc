// packages/plugin-protocol/src/feepoolSdk.ts
// MultisigPool SDK 接入层（plugin-protocol 内**唯一**直接 import SDK 的文件）。
//
// 设计缘由（V4 收口）：feepool 真实模型是"两笔 tx + 持续协商的 B-Tx 草稿"。
//   - A-Tx（base tx，建池时定）：client P2PKH UTXO → 2-of-2 multisig output，
//     池大小 = multisig output 总额 = `feePoolDefaultFundSatoshis`。
//   - B-Tx（spend 草稿）：multisig output → server + client change。
//     每次 transfer 不再独立发一笔新 spend tx，而是在同一个 B-Tx 草稿上
//     更新 `serverAmount` 字段；只有 close 时把草稿切到 FINAL_LOCKTIME
//     最终版本，broadcast 后真正生效。
//   - 草稿有"初始版"（create / close_and_recreate 的新池分支）vs
//     "更新版"（spend / close_and_recreate 的 close 之前的 spend）。
//     两种版本用不同 SDK 签名方法（spend sig vs update sig）。
//
//   - `keymaster-multisig-pool` 是 npm 包，提供 BSV multisig pool 的纯密码学
//     函数；本文件负责把它压成 protocol service 直接可调的小型适配层。
//   - `@bsv/sdk` 是 SDK 的底层依赖；本文件**不**直接 import 它——只透传
//     SDK 内部已经处理好的 `Transaction` / `PublicKey` / `PrivateKey`。
//   - 边界检查（`scripts/check-boundaries.mjs`）禁止 plugin-protocol 直接
//     import plugin-p2pkh；本文件也遵守这一约束（feepoolSdk 只依赖 SDK
//     包，**不**依赖任何 plugin）。
//   - V1 只用 dual（2-of-2）路径；triple / HTTP client 类都不引入。

import {
  buildDualFeePoolBaseTx,
  clientDualFeePoolSpendTXUpdateSign,
  clientVerifyServerSpendSig,
  clientVerifyServerUpdateSig,
  FINAL_LOCKTIME,
  loadDualFeePoolTx,
  spendTXDualFeePoolClientSign,
  subBuildDualFeePoolSpendTX
} from "keymaster-multisig-pool";

/**
 * 暴露 SDK 的 `FINAL_LOCKTIME` 常量。close_and_recreate 的 close 部分把
 * 草稿切到"最终可立即生效版本"时使用（locktime + sequence 同时设置）。
 */
export { FINAL_LOCKTIME };

/** 适配 SDK 内部 UTXO 形状。 */
export interface FeepoolSdkUtxo {
  txid: string;
  vout: number;
  satoshis: number;
}

/** `buildDualFeePoolBaseTx` 返回值（trim 自 SDK 内部类型）。 */
export interface FeepoolSdkBaseTxResponse {
  /** A-Tx（base tx）hex。 */
  txHex: string;
  /** A-Tx 的 txid（service 用来构造下游 B-Tx 草稿的 prevTxId）。 */
  txid: string;
  /** 2-of-2 multisig output 在 tx 里的 vout index。 */
  outputIndex: number;
  /** multisig output 金额（satoshis）= 池大小 = `totalAmount`。 */
  amount: number;
}

/** 通用"B-Tx 草稿"返回形状。 */
export interface FeepoolSdkDraftTxResponse {
  /** B-Tx 草稿 hex。 */
  txHex: string;
}

/**
 * 建池 A-Tx（client P2PKH UTXO → 2-of-2 multisig output）。
 * client 签名（funding 输入）；**不需要** server sig。
 *
 * @param clientUtxos 当前 active key 的可用 P2PKH UTXO（已排除已被 claim 的）。
 * @param clientPrivateKeyHex 32-byte secp256k1 私钥 hex（66 字符）。
 * @param serverPublicKeyHex 33-byte compressed 公钥 hex（66 字符）。
 * @param feepoolAmount multisig output 金额（satoshis）= 池大小。
 * @param feeRate fee rate（sat/kB）。V1 用保守值 1。
 */
export async function sdkBuildBaseTx(params: {
  clientUtxos: FeepoolSdkUtxo[];
  clientPrivateKeyHex: string;
  serverPublicKeyHex: string;
  feepoolAmount: number;
  feeRate: number;
}): Promise<FeepoolSdkBaseTxResponse> {
  const { PrivateKey, PublicKey } = await import("@bsv/sdk");
  const clientPrivKey = PrivateKey.fromHex(params.clientPrivateKeyHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const resp = await buildDualFeePoolBaseTx(
    params.clientUtxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      satoshis: u.satoshis
    })),
    clientPrivKey,
    serverPubKey,
    params.feepoolAmount,
    params.feeRate
  );
  return {
    txHex: resp.tx.toHex(),
    txid: resp.tx.id("hex"),
    outputIndex: resp.index,
    amount: resp.amount
  };
}

/**
 * 构造**初始** B-Tx 草稿（V4 关键入口）。
 *
 * V4 收口：这个函数返回的**不是**"最终主 transfer tx"；是"持续协商的初始
 * B-Tx 草稿"。后续 spend 操作会用 `sdkLoadDraftSpendTx` 在此基础上
 * 更新 `serverAmount` 字段，**不**会构造新的独立 spend tx。
 *
 * 用在：
 *   - `create`：建池后的第一版草稿；`serverAmount = amountSatoshis`。
 *   - `close_and_recreate`：建新池后的第一版草稿（同上）。
 *
 * @param prevTxId 当前池 base tx（A-Tx）txid。
 * @param totalAmount multisig output 总额（= 池大小）。
 * @param serverAmount 草稿初始 `serverAmount` = site 想转给 server 的金额。
 * @param endHeight V1 固定 0。
 */
export async function sdkBuildInitialDraftSpendTx(params: {
  prevTxId: string;
  totalAmount: number;
  serverAmount: number;
  endHeight: number;
  clientPrivateKeyHex: string;
  serverPublicKeyHex: string;
  feeRate: number;
}): Promise<FeepoolSdkDraftTxResponse> {
  const { PrivateKey, PublicKey } = await import("@bsv/sdk");
  const clientPrivKey = PrivateKey.fromHex(params.clientPrivateKeyHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const resp = await subBuildDualFeePoolSpendTX(
    params.prevTxId,
    params.totalAmount,
    params.serverAmount,
    params.endHeight,
    clientPrivKey,
    serverPubKey,
    params.feeRate
  );
  return { txHex: resp.tx.toHex() };
}

/**
 * 在 B-Tx 草稿上做 client **初始** 签名。
 *
 * 用在 `create` / `close_and_recreate` 的新池分支：草稿是 SDK `subBuild*`
 * 构造的初始版，签名方法走 `spendTXDualFeePoolClientSign`（不是 update sign）。
 *
 * @param txHex B-Tx 草稿 hex。
 * @param totalAmount multisig output 总额（验签需要）。
 */
export async function sdkClientSignInitialSpendTx(params: {
  txHex: string;
  totalAmount: number;
  clientPrivateKeyHex: string;
  serverPublicKeyHex: string;
}): Promise<Uint8Array> {
  const { PrivateKey, PublicKey, Transaction } = await import("@bsv/sdk");
  const clientPrivKey = PrivateKey.fromHex(params.clientPrivateKeyHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const tx = Transaction.fromHex(params.txHex);
  const sig = await spendTXDualFeePoolClientSign(
    tx,
    params.totalAmount,
    clientPrivKey,
    serverPubKey
  );
  return Uint8Array.from(sig);
}

/**
 * 载入现有 B-Tx 草稿（V4 关键入口）。
 *
 * 用 SDK `loadTx` 改 `locktime` / `sequence` / `serverAmount` / `targetAmount`
 * 后返回新 Transaction 对象。**这是 spend 操作的核心**：不构造新 spend tx，
 * 而是在已有草稿上改字段。
 *
 * 用在：
 *   - `spend`：在旧草稿上把 `serverAmount` 改成 `prior.serverAmount + amountSatoshis`；
 *     locktime/sequence 保持未来生效值。
 *   - `close_and_recreate` 的 close 之前的 spend：同上（累加 `amountSatoshis`）。
 *   - `close_and_recreate` 的 close 部分：把 `serverAmount` 改成
 *     `prior.serverAmount + amountSatoshis`，**同时**把 `locktime = FINAL_LOCKTIME`、
 *     `sequence = 0xFFFFFFFF`，让草稿变成"最终可立即生效版本"。
 */
export async function sdkLoadDraftSpendTx(params: {
  prevDraftHex: string;
  /** `undefined` 表示保持原 locktime；`FINAL_LOCKTIME` 表示 final close。 */
  locktime: number | undefined;
  /** `0xFFFFFFFF` 表示 final close（立即生效）；保持未来生效则用较小值。 */
  sequenceNumber: number;
  /** 新的 `serverAmount` 字段值。 */
  serverAmount: number;
  /** 当前池 server 公钥。 */
  serverPublicKeyHex: string;
  /** 当前池 client 公钥。 */
  clientPublicKeyHex: string;
  /** 池大小（multisig output 总额）。SDK 用它做 sighash 计算。 */
  targetAmount: number;
}): Promise<FeepoolSdkDraftTxResponse> {
  const { PublicKey, Transaction } = await import("@bsv/sdk");
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const clientPubKey = PublicKey.fromString(params.clientPublicKeyHex);
  const updated = loadDualFeePoolTx(
    params.prevDraftHex,
    params.locktime,
    params.sequenceNumber,
    params.serverAmount,
    serverPubKey,
    clientPubKey,
    params.targetAmount
  );
  return { txHex: updated.toHex() };
}

/**
 * 在**更新后**的 B-Tx 草稿上做 client 重签。
 *
 * 用在 `spend`（在旧草稿上 `loadTx` 改 serverAmount 后重签）和
 * `close_and_recreate` 的 close 部分（同上重签）。注意：这是**初始签名
 * 的替换**——`clientDualFeePoolSpendTXUpdateSign` 会重写 inputs[0] 的
 * unlock script（清掉旧 client 签名，加新 client 签名）。
 */
export async function sdkClientSignUpdatedSpendTx(params: {
  txHex: string;
  clientPrivateKeyHex: string;
  serverPublicKeyHex: string;
}): Promise<Uint8Array> {
  const { PrivateKey, PublicKey, Transaction } = await import("@bsv/sdk");
  const clientPrivKey = PrivateKey.fromHex(params.clientPrivateKeyHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const tx = Transaction.fromHex(params.txHex);
  const sig = clientDualFeePoolSpendTXUpdateSign(tx, clientPrivKey, serverPubKey);
  return Uint8Array.from(sig);
}

/**
 * 验签 server 在**初始 B-Tx 草稿**上的部分签名。
 *
 * 用在 commit 阶段 action=`create` / close_and_recreate 的新池分支。
 * `totalAmount` 是必需的：base tx 还没广播，sighash 必须显式给 satoshi 数。
 */
export async function sdkVerifyServerInitialSpendSig(params: {
  txHex: string;
  totalAmount: number;
  serverPublicKeyHex: string;
  clientPublicKeyHex: string;
  serverSignBytes: Uint8Array;
}): Promise<boolean> {
  const { PublicKey, Transaction } = await import("@bsv/sdk");
  const tx = Transaction.fromHex(params.txHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const clientPubKey = PublicKey.fromString(params.clientPublicKeyHex);
  return clientVerifyServerSpendSig(
    tx,
    params.totalAmount,
    serverPubKey,
    clientPubKey,
    Array.from(params.serverSignBytes)
  );
}

/**
 * 验签 server 在**更新后 B-Tx 草稿**上的部分签名。
 *
 * 用在 commit 阶段 action=`spend` / close_and_recreate 的 close 部分。
 * 与 `clientVerifyServerSpendSig` 不同：update sig 的 sighash 计算方式不同，
 * SDK 因此分成两个独立函数。
 */
export async function sdkVerifyServerUpdateSig(params: {
  txHex: string;
  serverPublicKeyHex: string;
  clientPublicKeyHex: string;
  serverSignBytes: Uint8Array;
}): Promise<boolean> {
  const { PublicKey, Transaction } = await import("@bsv/sdk");
  const tx = Transaction.fromHex(params.txHex);
  const serverPubKey = PublicKey.fromString(params.serverPublicKeyHex);
  const clientPubKey = PublicKey.fromString(params.clientPublicKeyHex);
  return clientVerifyServerUpdateSig(
    tx,
    serverPubKey,
    clientPubKey,
    Array.from(params.serverSignBytes)
  );
}

/** 33-byte compressed 公钥 hex 合法性检查（在 commit 验签前再一次过滤）。 */
export function isValidCompressedPubkeyHex(hex: string): boolean {
  if (hex.length !== 66) return false;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  // prefix 必须是 02 或 03（compressed secp256k1）
  return hex.startsWith("02") || hex.startsWith("03");
}
