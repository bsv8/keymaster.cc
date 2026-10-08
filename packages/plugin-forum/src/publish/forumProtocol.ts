// Forum 发布：报价验证、费用确认、无找零交易构建与最终 raw 自检。
//
// 顺序（需求 §9）：
//   冻结正文 → MSFile 保存与可达性准备 → 获取父节点 → operatorSig → quote_reply
//   → 验响应与 indexSig → 确认费用 → 专用资金准备 → 报价复核 → 无找零交易
//   → 广播 → 索引跟踪
//
// 三条不能违反的规则：
//   - indexSig 是服务端对报价的承诺，广播前必须由客户端自己重建并验签；它覆盖的
//     字段就是将要上链的字段，所以重建用的是交易输出而不是请求参数；
//   - reply 无普通找零输出，最多三个输出；资金差额只在用户确认的预算内成为矿工费，
//     不追加找零、不提高索引费消化余款；
//   - 固定输出位置不因金额为零而改变：索引费为零仍保留 vout 0。

import type {
  ForumBudgetConfirmation,
  ForumFeeBreakdownItem,
  ForumPublishKind,
  ForumQuoteSnapshot,
} from "@keymaster/contracts";
import { forumAmountToBigInt, isSafeForumWalletAmount } from "@keymaster/contracts";

import { bytesToHex, hexToBytes } from "../protocol/bytes.js";
import { sha256Digest, verifyDerSignature } from "../protocol/crypto.js";
import {
  buildChangeTipOutputs,
  buildReplyOutputs,
  parseChangeTipTransaction,
  parseReplyTransaction,
} from "../protocol/layout.js";
import {
  encodeChangeTipIndexObject,
  encodeReplyIndexObject,
  encodeReplyOperatorObject,
  type ChangeTipIndexObject,
  type ReplyIndexObject,
} from "../protocol/signatureObjects.js";
import { parseTransaction, type RawTransaction, type TxInput, type TxOutput } from "../protocol/transaction.js";

export class ForumProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForumProtocolError";
    this.code = code;
  }
}

/** 报价相关字段；全部来自本次 quote 响应。 */
export interface ForumQuoteFields {
  readonly payToPublicKeyHex: string;
  readonly indexPrice: string;
  readonly lastBlockHeight: string;
  /** 只有 quote_reply 有；changetip 没有这个字段。 */
  readonly parentTipPrice?: string;
  readonly indexSigHex: string;
}

/**
 * 用**将要上链的输出**重建 indexSig 对象并验签。
 *
 * 刻意不用请求参数：服务端索引器也是从数据输出恢复字段再重建对象的，如果客户端
 * 用另一组参数验签，两边就会在「交易实际写了什么」上产生分歧。
 */
export function verifyReplyQuote(input: {
  forumPublicKeyHex: string;
  parentTxid: string;
  parentPublicKeyHex: string;
  replyMasterSeedHash: string;
  tipPrice: string;
  operatorSigHex: string;
  clientPublicKeyHex: string;
  quote: ForumQuoteFields;
}): ReplyIndexObject {
  const operatorSig = hexToBytes(requireLowerHex(input.operatorSigHex, "operatorSig"));
  const object: ReplyIndexObject = {
    kind: "bsv8.reply.1",
    parentTxid: hexToBytes(requireHash(input.parentTxid, "parent_txid")),
    parentPublicKey: hexToBytes(requirePublicKey(input.parentPublicKeyHex, "parent_publickey")),
    replyMasterSeedHash: hexToBytes(requireHash(input.replyMasterSeedHash, "reply_masterseedhash")),
    tipPrice: requireAmount(input.tipPrice, "tip_price"),
    operatorSig,
    payToPublicKey: hexToBytes(requirePublicKey(input.quote.payToPublicKeyHex, "payto_publickey")),
    indexPrice: requireAmount(input.quote.indexPrice, "index_price"),
    lastBlockHeight: requireAmount(input.quote.lastBlockHeight, "last_block_height"),
  };
  assertSignature(object.operatorSig, "operatorSig");
  // operatorSig 的对象正是 indexSig 对象的前五项；同一个编码器避免两份实现漂移。
  if (!verifyDerSignature(hexToBytes(input.clientPublicKeyHex), sha256Digest(encodeReplyOperatorOperator(object)), operatorSig)) {
    throw new ForumProtocolError("operator-sig", "operatorSig 无法用 clientpublickey 验证");
  }
  assertIndexSig(input.forumPublicKeyHex, encodeReplyIndexObject(object), input.quote.indexSigHex);
  return object;
}

export function verifyChangeTipQuote(input: {
  forumPublicKeyHex: string;
  parentTxid: string;
  tipPrice: string;
  operatorSigHex: string;
  clientPublicKeyHex: string;
  quote: ForumQuoteFields;
}): ChangeTipIndexObject {
  const object: ChangeTipIndexObject = {
    kind: "bsv8.changetip.1",
    parentTxid: hexToBytes(requireHash(input.parentTxid, "parent_txid")),
    tipPrice: requireAmount(input.tipPrice, "tip_price"),
    payToPublicKey: hexToBytes(requirePublicKey(input.quote.payToPublicKeyHex, "payto_publickey")),
    indexPrice: requireAmount(input.quote.indexPrice, "index_price"),
    lastBlockHeight: requireAmount(input.quote.lastBlockHeight, "last_block_height"),
  };
  assertIndexSig(input.forumPublicKeyHex, encodeChangeTipIndexObject(object), input.quote.indexSigHex);
  return object;
}

function assertIndexSig(forumPublicKeyHex: string, encoded: Uint8Array, indexSigHex: string): void {
  const indexSig = hexToBytes(requireLowerHex(indexSigHex, "indexSig"));
  assertSignature(indexSig, "indexSig");
  if (!verifyDerSignature(hexToBytes(requirePublicKey(forumPublicKeyHex, "论坛服务公钥")), sha256Digest(encoded), indexSig)) {
    throw new ForumProtocolError("index-sig", "indexSig 无法用配置的论坛服务公钥验证");
  }
}

function encodeReplyOperatorOperator(object: ReplyIndexObject): Uint8Array {
  return encodeReplyOperatorObject({
    kind: "bsv8.reply.1",
    parentTxid: object.parentTxid,
    parentPublicKey: object.parentPublicKey,
    replyMasterSeedHash: object.replyMasterSeedHash,
    tipPrice: object.tipPrice,
  });
}

/** 构造费用确认项。每一项都必须能被用户读懂来源。 */
export function buildFeeBreakdown(input: {
  kind: ForumPublishKind;
  indexPrice: string;
  parentTipPrice?: string;
  fundingMinerFee?: string;
  protocolMinerFee: string;
  contentAcquisition?: string;
  contentPublication?: string;
}): ForumFeeBreakdownItem[] {
  const items: ForumFeeBreakdownItem[] = [];
  if (input.contentAcquisition !== undefined) {
    items.push({ label: "content-acquisition", amountSatoshis: input.contentAcquisition, detail: "正文经 MSFile 获取的费用" });
  }
  if (input.contentPublication !== undefined) {
    items.push({ label: "content-publication", amountSatoshis: input.contentPublication, detail: "正文发布到 MSFile 的费用" });
  }
  if (input.fundingMinerFee !== undefined) {
    items.push({ label: "funding-miner-fee", amountSatoshis: input.fundingMinerFee, detail: "专用资金准备交易的矿工费" });
  }
  items.push({
    label: "index-price",
    amountSatoshis: input.indexPrice,
    detail: "论坛索引费，付给本次报价的 payto_publickey",
  });
  if (input.parentTipPrice !== undefined && forumAmountToBigInt(input.parentTipPrice) !== 0n) {
    items.push({
      label: "parent-author-tip",
      amountSatoshis: input.parentTipPrice,
      detail: "父节点作者的回复价；为零时省略 vout 2，不生成零值打赏",
    });
  }
  items.push({
    label: "protocol-miner-fee",
    amountSatoshis: input.protocolMinerFee,
    detail: `本次协议交易的矿工费预算（${input.kind}）；差额只在确认的预算内成为矿工费`,
  });
  return items;
}

/** 费用确认项求和；任何非规范金额都拒绝，不做隐式转换。 */
export function totalFeeSatoshis(items: readonly ForumFeeBreakdownItem[]): string {
  let total = 0n;
  for (const item of items) {
    const value = forumAmountToBigInt(item.amountSatoshis);
    if (value === undefined) {
      throw new ForumProtocolError("amount", `费用项 ${item.label} 的金额不是规范十进制 uint64`);
    }
    total += value;
  }
  return total.toString();
}

/** 资金准备预算：由固定输出总额与保守矿工费预算组成。 */
export interface ForumFundingRequest {
  /** 专用资金 UTXO 的金额。 */
  readonly availableSatoshis: bigint;
  /** 固定输出总额（索引费 + 1 sat 数据输出 [+ 父价打赏]）。 */
  readonly fixedOutputsSatoshis: bigint;
  /** 用户确认的矿工费预算上限。 */
  readonly maxMinerFeeSatoshis: bigint;
  /** 费率（sat/KB），用于按输入签名长度上界估算。 */
  readonly feeRateSatoshisPerKb: number;
}

/** 每个输入签名（DER + 公钥 + SIGHASH 字节）的最大序列化长度上界。 */
export const FORUM_MAX_INPUT_SIGNATURE_BYTES = 1 + 73 + 1 + 33;
/** 扣除输入签名后，交易剩余部分（version/inputs 头/outputs/locktime）的上界。 */
export const FORUM_MAX_TRANSACTION_OVERHEAD_BYTES = 1024;

/**
 * 按输入数量计算矿工费预算上界。
 *
 * 用长度上界而不是实测长度来估算是有意的：预算是**承诺**，完成签名后如果实测
 * 费用低于预算，差额归矿工；如果预算不足，钱不够付矿工费，交易根本进不了池。
 * 所以宁可高估也不能低估。
 */
export function estimateMinerFeeBudget(input: {
  inputCount: number;
  outputCount: number;
  feeRateSatoshisPerKb: number;
}): bigint {
  if (input.inputCount < 1) throw new ForumProtocolError("fee", "至少需要一个输入");
  if (input.inputCount > 100) throw new ForumProtocolError("fee", "专用资金设计为单输入消费");
  if (!Number.isFinite(input.feeRateSatoshisPerKb) || input.feeRateSatoshisPerKb < 1) {
    throw new ForumProtocolError("fee-rate", "矿工费率必须是正数");
  }
  const size = input.inputCount * (36 + 4 + FORUM_MAX_INPUT_SIGNATURE_BYTES) + input.outputCount * (8 + 10 + 128) + FORUM_MAX_TRANSACTION_OVERHEAD_BYTES;
  return (BigInt(Math.ceil(size)) * BigInt(Math.ceil(input.feeRateSatoshisPerKb)) + 999n) / 1000n;
}

/** 决定专用资金金额；不足时要求重新准备。 */
export function planForumFunding(request: ForumFundingRequest): {
  readonly requiredSatoshis: bigint;
  readonly minerFeeBudgetSatoshis: bigint;
  readonly surplusSatoshis: bigint;
} {
  // 专用资金 UTXO 是单输入；输出数按协议上限三个估。
  const budgetSize = estimateMinerFeeBudget({
    inputCount: 1,
    outputCount: 3,
    feeRateSatoshisPerKb: request.feeRateSatoshisPerKb,
  });
  const budget = request.maxMinerFeeSatoshis > 0n ? request.maxMinerFeeSatoshis : budgetSize;
  const required = request.fixedOutputsSatoshis + budget;
  if (request.availableSatoshis < required) {
    throw new ForumProtocolError(
      "funding-insufficient",
      `专用资金 ${request.availableSatoshis} sat 不足：需要固定输出 ${request.fixedOutputsSatoshis} + 矿工费预算 ${budget}`,
    );
  }
  return { requiredSatoshis: required, minerFeeBudgetSatoshis: budget, surplusSatoshis: request.availableSatoshis - required };
}

/** 无找零协议交易的固定输出；索引费为零仍保留 vout 0。 */
export function buildForumProtocolOutputs(input: {
  kind: ForumPublishKind;
  parentTxidHex: string;
  parentPublicKeyHex: string;
  replyMasterSeedHashHex?: string;
  tipPrice: bigint;
  operatorSig: Uint8Array;
  lastBlockHeight: bigint;
  indexSig: Uint8Array;
  clientPublicKeyHex: string;
  quote: ForumQuoteFields;
  /**
   * 父节点本次报价的付款金额。
   *
   * 必须取自本次 quote 响应的 `parent_tip_price`，不能用列表缓存里的初始价：
   * 缓存里的价格没有经过报价确认，把它当作应付金额就是少付或付错人。
   */
  parentTipPriceSatoshis?: bigint;
}): readonly TxOutput[] {
  const quote = {
    payToPublicKey: hexToBytes(requirePublicKey(input.quote.payToPublicKeyHex, "payto_publickey")),
    indexPrice: requireAmount(input.quote.indexPrice, "index_price"),
    lastBlockHeight: requireAmount(input.quote.lastBlockHeight, "last_block_height"),
    parentTipPrice: input.parentTipPriceSatoshis ?? 0n,
  };
  if (input.kind === "changetip") {
    return buildChangeTipOutputs({
      parentTxid: hexToBytes(requireHash(input.parentTxidHex, "parent_txid")),
      tipPrice: input.tipPrice,
      operatorSig: input.operatorSig,
      lastBlockHeight: input.lastBlockHeight,
      indexSig: input.indexSig,
      clientPublicKey: hexToBytes(requirePublicKey(input.clientPublicKeyHex, "clientpublickey")),
      payToPublicKey: quote.payToPublicKey,
      indexPrice: quote.indexPrice,
    });
  }
  const replyMasterSeedHashHex = input.replyMasterSeedHashHex;
  if (replyMasterSeedHashHex === undefined) {
    throw new ForumProtocolError("seed-hash", "reply 必须带已冻结正文的 seed hash");
  }
  return buildReplyOutputs({
    parentTxid: hexToBytes(requireHash(input.parentTxidHex, "parent_txid")),
    parentPublicKey: hexToBytes(requirePublicKey(input.parentPublicKeyHex, "parent_publickey")),
    replyMasterSeedHash: hexToBytes(requireHash(replyMasterSeedHashHex, "reply_masterseedhash")),
    tipPrice: input.tipPrice,
    operatorSig: input.operatorSig,
    lastBlockHeight: input.lastBlockHeight,
    indexSig: input.indexSig,
    clientPublicKey: hexToBytes(requirePublicKey(input.clientPublicKeyHex, "clientpublickey")),
    payToPublicKey: quote.payToPublicKey,
    indexPrice: quote.indexPrice,
    parentTipPrice: quote.parentTipPrice,
  });
}

/**
 * 从最终 raw 重建并验证：签名对象与全部输出。
 *
 * 这一步是「TS raw 能被 Go parser 解析」的客户端侧对应物：raw 自己就是真值，
 * 请求参数不再是证据。任何不一致都拒绝广播。
 */
export function verifyFinalRaw(input: {
  forumPublicKeyHex: string;
  kind: ForumPublishKind;
  rawTxBytes: Uint8Array;
  expectedTxid: string;
}): { readonly txid: string; readonly indexPrice: bigint; readonly parentTipPrice: bigint } {
  const tx = parseTransaction(input.rawTxBytes, sha256Digest);
  const txid = bytesToHex(tx.txid);
  if (txid !== input.expectedTxid) {
    throw new ForumProtocolError("txid-mismatch", `raw 的 txid 是 ${txid}，与记录的 ${input.expectedTxid} 不一致`);
  }
  if (input.kind === "reply") {
    const fields = parseReplyTransaction(tx);
    // 固定输出位置：索引费是 vout 0，数据输出是 vout 1，vout 2 只在父价非零时存在。
    if (tx.outputs.length !== (fields.tip === undefined ? 2 : 3)) {
      throw new ForumProtocolError("output-count", `reply 必须是 2 或 3 个输出，实际 ${tx.outputs.length} 个`);
    }
    if (fields.tip !== undefined) {
      if (fields.tip.parentTxid.length !== 32 || bytesToHex(fields.tip.parentTxid) !== bytesToHex(fields.parentTxid)) {
        throw new ForumProtocolError("tip-parent", "tip 输出与数据输出指向不同父节点");
      }
      if (bytesToHex(fields.tip.parentPublicKey) !== bytesToHex(fields.parentPublicKey)) {
        throw new ForumProtocolError("tip-key", "tip 输出的收款公钥与父节点作者不一致");
      }
      if (fields.tip.amount <= 0n) {
        throw new ForumProtocolError("tip-zero", "第一版不生成零值打赏");
      }
    }
    assertIndexSig(
      input.forumPublicKeyHex,
      encodeReplyIndexObject({
        kind: "bsv8.reply.1",
        parentTxid: fields.parentTxid,
        parentPublicKey: fields.parentPublicKey,
        replyMasterSeedHash: fields.replyMasterSeedHash,
        tipPrice: fields.tipPrice,
        operatorSig: fields.operatorSig,
        payToPublicKey: fields.payToPublicKey,
        indexPrice: fields.indexPrice,
        lastBlockHeight: fields.lastBlockHeight,
      }),
      bytesToHex(fields.indexSig),
    );
    if (!verifyDerSignature(
      hexToBytes(bytesToHex(fields.clientPublicKey)),
      sha256Digest(encodeReplyOperatorObjectFrom(fields)),
      fields.operatorSig,
    )) {
      throw new ForumProtocolError("operator-sig", "raw 中的 operatorSig 无法用 clientpublickey 验证");
    }
    return { txid, indexPrice: fields.indexPrice, parentTipPrice: fields.tip?.amount ?? 0n };
  }
  const fields = parseChangeTipTransaction(tx);
  assertIndexSig(
    input.forumPublicKeyHex,
    encodeChangeTipIndexObject({
      kind: "bsv8.changetip.1",
      parentTxid: fields.parentTxid,
      tipPrice: fields.tipPrice,
      payToPublicKey: fields.payToPublicKey,
      indexPrice: fields.indexPrice,
      lastBlockHeight: fields.lastBlockHeight,
    }),
    bytesToHex(fields.indexSig),
  );
  return { txid, indexPrice: fields.indexPrice, parentTipPrice: 0n };
}

function encodeReplyOperatorObjectFrom(fields: {
  parentTxid: Uint8Array;
  parentPublicKey: Uint8Array;
  replyMasterSeedHash: Uint8Array;
  tipPrice: bigint;
}): Uint8Array {
  return encodeReplyOperatorObject({
    kind: "bsv8.reply.1",
    parentTxid: fields.parentTxid,
    parentPublicKey: fields.parentPublicKey,
    replyMasterSeedHash: fields.replyMasterSeedHash,
    tipPrice: fields.tipPrice,
  });
}

/**
 * 完成输入签名后的费用复核。
 *
 * 实际费率与总额都要核对：预算内就通过，超出预算就拒绝而不是照发。禁止通过追加
 * 找零或提高索引费来消化余额差。
 */
export function reconcileMinerFee(input: {
  totalInputSatoshis: bigint;
  outputs: readonly TxOutput[];
  serializedSizeBytes: number;
  feeRateSatoshisPerKb: number;
  maxMinerFeeSatoshis: bigint;
}): { readonly actualMinerFeeSatoshis: bigint; readonly actualFeeRatePerKb: number } {
  const outputTotal = input.outputs.reduce((total, output) => total + output.value, 0n);
  if (outputTotal > input.totalInputSatoshis) {
    throw new ForumProtocolError("inputs-exhausted", "输入总额小于输出总额，无法构造交易");
  }
  const actual = input.totalInputSatoshis - outputTotal;
  if (actual > input.maxMinerFeeSatoshis) {
    throw new ForumProtocolError("fee-over-budget", `实际矿工费 ${actual} sat 超过确认的预算 ${input.maxMinerFeeSatoshis} sat`);
  }
  const actualRate = (actual * 1000n) / BigInt(Math.max(1, input.serializedSizeBytes));
  return { actualMinerFeeSatoshis: actual, actualFeeRatePerKb: Number(actualRate) };
}

/* ============== 校验助手 ============== */

function assertSignature(signature: Uint8Array, name: string): void {
  if (signature.length < 8 || signature.length > 72) {
    throw new ForumProtocolError("signature-length", `${name} 的 DER 长度不在 8..72 字节`);
  }
}

function requireHash(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ForumProtocolError("hash", `${label} 必须是 64 字符小写 hex`);
  return value;
}

function requirePublicKey(value: string, label: string): string {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(value)) throw new ForumProtocolError("public-key", `${label} 必须是 33 字节压缩公钥`);
  return value;
}

function requireLowerHex(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw new ForumProtocolError("hex", `${label} 必须是偶数长度的小写 hex`);
  }
  return value;
}

function requireAmount(value: string, label: string): bigint {
  const parsed = forumAmountToBigInt(value);
  if (parsed === undefined) throw new ForumProtocolError("amount", `${label} 必须是规范十进制 uint64`);
  return parsed;
}

export { isSafeForumWalletAmount };
export type { ForumQuoteSnapshot, ForumBudgetConfirmation, TxInput, RawTransaction };