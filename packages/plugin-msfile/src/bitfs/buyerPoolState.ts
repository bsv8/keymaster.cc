import {
  inspectBuyerPool,
  parsePaymentState,
  verifyAcceptedPayment,
  type BuyerPoolEvidence,
} from "go-bitfs";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";

const FINAL_POOL_SEQUENCE = 0xffff_ffff;
const BINDING_FORMAT = "keymaster.bitfs-close-binding" as const;

export interface BitfsBuyerLocalPaymentState {
  pool: BuyerPoolEvidence;
  paymentSequence: number;
  sellerAmountSatoshis: bigint;
  authorizationIdHex?: string;
  source: "initial" | "local" | "legacy";
}

export interface BitfsBuyerCloseBinding {
  format: typeof BINDING_FORMAT;
  version: 1;
  authorizationIdHex: string | null;
  paymentSequence: number;
  sellerAmountSatoshis: string;
}

export async function readBitfsBuyerLocalPaymentState(input: {
  sessions: BitfsSessionJournal;
  session: BitfsSessionRecord;
  completedOpening: BuyerPoolEvidence;
  excludeAuthorizationId?: string;
  includeLegacyPaymentEvidence?: boolean;
}): Promise<BitfsBuyerLocalPaymentState> {
  const initial = await inspectBuyerPool(input.completedOpening);
  const states: Array<{
    sequence: number;
    amount: bigint;
    authorizationIdHex: string;
    payment: NonNullable<BuyerPoolEvidence["latestBuyerPayment"]>;
  }> = [];
  for (const name of input.session.evidence.filter((item) => item.startsWith("kind7-payment-update-"))) {
    const authorizationIdHex = name.slice("kind7-payment-update-".length);
    if (authorizationIdHex === input.excludeAuthorizationId) continue;
    assertAuthorizationId(authorizationIdHex);
    const rawKind5 = await requiredEvidence(input.sessions, input.session.sessionId, `kind5-content-request-${authorizationIdHex}`);
    const rawKind7 = await requiredEvidence(input.sessions, input.session.sessionId, name);
    const payment = { rawKind5, rawKind7 };
    const state = await inspectBuyerPool({ ...input.completedOpening, latestBuyerPayment: payment });
    states.push({ sequence: state.paymentSequence, amount: state.sellerAmountSatoshis, authorizationIdHex, payment });
  }
  states.sort((left, right) => left.sequence - right.sequence || left.authorizationIdHex.localeCompare(right.authorizationIdHex));
  let expectedSequence = initial.paymentSequence + 1;
  let previousAmount = initial.sellerAmountSatoshis;
  let latest: (typeof states)[number] | undefined;
  for (const state of states) {
    if (state.sequence !== expectedSequence || state.amount < previousAmount) {
      throw new Error("BitFS 买方付款日志序号不连续或累计金额倒退");
    }
    latest = state;
    expectedSequence += 1;
    previousAmount = state.amount;
  }

  if (input.includeLegacyPaymentEvidence === true) {
    const legacy: Array<{ sequence: number; amount: bigint; rawTransaction: Uint8Array }> = [];
    for (const name of input.session.evidence.filter((item) => item.startsWith("latest-payment-transaction-"))) {
      const rawTransaction = await requiredEvidence(input.sessions, input.session.sessionId, name);
      const state = await parsePaymentState(rawTransaction, input.completedOpening.opening);
      await verifyAcceptedPayment(state, input.completedOpening.opening);
      if (state.paymentSequence === FINAL_POOL_SEQUENCE) {
        throw new Error("BitFS 买方付款日志包含最终关池状态");
      }
      legacy.push({ sequence: state.paymentSequence, amount: state.sellerAmountSatoshis, rawTransaction });
    }
    legacy.sort((left, right) => left.sequence - right.sequence);
    let legacyExpected = initial.paymentSequence + 1;
    let legacyPrevious = initial.sellerAmountSatoshis;
    let latestLegacy: (typeof legacy)[number] | undefined;
    for (const state of legacy) {
      if (state.sequence !== legacyExpected || state.amount < legacyPrevious) {
        throw new Error("BitFS 买方旧付款日志序号不连续或累计金额倒退");
      }
      latestLegacy = state;
      legacyExpected += 1;
      legacyPrevious = state.amount;
    }
    if (latest !== undefined && latestLegacy !== undefined
      && (latestLegacy.sequence > latest.sequence || latestLegacy.amount > latest.amount)) {
      throw new Error("BitFS 买方本地付款证据落后于已保存付款状态");
    }
    if (latest === undefined && latestLegacy !== undefined) {
      return {
        pool: { ...input.completedOpening, latestPaymentRawTx: latestLegacy.rawTransaction },
        paymentSequence: latestLegacy.sequence,
        sellerAmountSatoshis: latestLegacy.amount,
        source: "legacy",
      };
    }
  }

  if (latest === undefined) {
    return {
      pool: input.completedOpening,
      paymentSequence: initial.paymentSequence,
      sellerAmountSatoshis: initial.sellerAmountSatoshis,
      source: "initial",
    };
  }
  return {
    pool: { ...input.completedOpening, latestBuyerPayment: latest.payment },
    paymentSequence: latest.sequence,
    sellerAmountSatoshis: latest.amount,
    authorizationIdHex: latest.authorizationIdHex,
    source: "local",
  };
}

export function encodeBitfsBuyerCloseBinding(input: {
  authorizationIdHex?: string;
  paymentSequence: number;
  sellerAmountSatoshis: bigint;
}): Uint8Array {
  if (!Number.isSafeInteger(input.paymentSequence) || input.paymentSequence < 0
    || input.sellerAmountSatoshis < 0n) throw new Error("BitFS 关池绑定状态无效");
  if (input.authorizationIdHex !== undefined) assertAuthorizationId(input.authorizationIdHex);
  const value: BitfsBuyerCloseBinding = {
    format: BINDING_FORMAT,
    version: 1,
    authorizationIdHex: input.authorizationIdHex ?? null,
    paymentSequence: input.paymentSequence,
    sellerAmountSatoshis: input.sellerAmountSatoshis.toString(10),
  };
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

export function parseBitfsBuyerCloseBinding(bytes: Uint8Array): BitfsBuyerCloseBinding {
  if (bytes.byteLength < 2 || bytes.byteLength > 512) throw new Error("BitFS 关池绑定证据大小无效");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("BitFS 关池绑定证据损坏"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 关池绑定证据格式错误");
  const row = value as Record<string, unknown>;
  const authorizationIdHex = row.authorizationIdHex;
  if (Object.keys(row).sort().join(",") !== "authorizationIdHex,format,paymentSequence,sellerAmountSatoshis,version"
    || row.format !== BINDING_FORMAT || row.version !== 1
    || (authorizationIdHex !== null && typeof authorizationIdHex !== "string")
    || !Number.isSafeInteger(row.paymentSequence) || (row.paymentSequence as number) < 0
    || typeof row.sellerAmountSatoshis !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(row.sellerAmountSatoshis)) {
    throw new Error("BitFS 关池绑定证据字段无效");
  }
  if (authorizationIdHex !== null) assertAuthorizationId(authorizationIdHex);
  return {
    format: BINDING_FORMAT,
    version: 1,
    authorizationIdHex: authorizationIdHex as string | null,
    paymentSequence: row.paymentSequence as number,
    sellerAmountSatoshis: row.sellerAmountSatoshis,
  };
}

export async function assertBitfsBuyerCloseBinding(input: {
  pool: BuyerPoolEvidence;
  closeTransactionRaw: Uint8Array;
  paymentSequence: number;
  sellerAmountSatoshis: bigint;
}): Promise<void> {
  const current = await inspectBuyerPool(input.pool);
  if (current.paymentSequence !== input.paymentSequence
    || current.sellerAmountSatoshis !== input.sellerAmountSatoshis) {
    throw new Error("BitFS 关池绑定与当前 Kind 5/7 状态不一致");
  }
  const state = await parsePaymentState(input.closeTransactionRaw, input.pool.opening);
  if (state.paymentSequence !== FINAL_POOL_SEQUENCE
    || state.sellerAmountSatoshis !== input.sellerAmountSatoshis) {
    throw new Error("BitFS 关池交易未绑定当前 Kind 5/7 的序号和累计卖方金额");
  }
}

async function requiredEvidence(
  sessions: BitfsSessionJournal,
  sessionId: string,
  name: import("./sessionJournal.js").BitfsEvidenceName,
): Promise<Uint8Array> {
  const value = await sessions.getEvidence(sessionId, name);
  if (!value) throw new Error(`BitFS 买方会话证据缺失：${name}`);
  return value;
}

function assertAuthorizationId(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("BitFS 付款授权编号无效");
}
