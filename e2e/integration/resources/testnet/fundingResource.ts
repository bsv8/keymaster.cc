import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { SecretString } from "../../support/secretString.js";
import { assertSafeIdentifier } from "../../support/ids.js";

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TXID_RE = /^[0-9a-f]{64}$/iu;

function sha256(bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

function ripemd160(bytes: Uint8Array): Uint8Array {
  return createHash("ripemd160").update(bytes).digest();
}

function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

/** 从公钥推导 testnet P2PKH 地址；只接收公开公钥，不接收私钥。 */
export function deriveTestnetP2pkhAddress(publicKeyHex: string): string {
  if (!/^0[23][0-9a-f]{64}$/iu.test(publicKeyHex)) throw new Error("testnet public key is invalid");
  const publicKey = Buffer.from(publicKeyHex, "hex");
  const hash160 = ripemd160(sha256(publicKey));
  const payload = Buffer.concat([Buffer.from([0x6f]), hash160]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58(Buffer.concat([payload, checksum]));
}

/** 从私钥只在 Node Resource 内派生公开 testnet 地址；调用者不得把私钥放入状态文件。 */
export function deriveTestnetP2pkhAddressFromPrivateKey(privateKeyHex: string): string {
  assertScalar(privateKeyHex);
  const publicKeyHex = Buffer.from(secp256k1.getPublicKey(Buffer.from(privateKeyHex, "hex"), true)).toString("hex");
  return deriveTestnetP2pkhAddress(publicKeyHex);
}

function assertScalar(privateKeyHex: string): void {
  if (!/^[0-9a-f]{64}$/iu.test(privateKeyHex)) throw new Error("testnet private key is not 32-byte hex");
  const scalar = BigInt(`0x${privateKeyHex}`);
  if (scalar <= 0n || scalar >= SECP256K1_ORDER) throw new Error("testnet private key scalar is invalid");
}

function assertTxid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TXID_RE.test(normalized)) throw new Error("testnet business transaction id is invalid");
  return normalized;
}

function assertLedgerRecord(value: unknown): FundingLedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("testnet recovery ledger record is invalid");
  const record = value as Partial<FundingLedgerRecord> & Record<string, unknown>;
  // 恢复账本本身不应出现秘密字段。即使文件是人工修改的，也宁可停止资源
  // 流程，不能把一份可能泄漏私钥的账本继续当成安全状态读取。
  if (Object.keys(record).some((key) => /private|secret|password|seed/iu.test(key))) throw new Error("testnet recovery ledger contains a secret-shaped field");
  assertSafeIdentifier(record.runId ?? "", "ledger run_id");
  assertSafeIdentifier(record.scenarioId ?? "", "ledger scenario_id");
  if (typeof record.walletAddress !== "string" || record.walletAddress.trim() === "") throw new Error("testnet recovery ledger wallet address is invalid");
  const fundedSatoshis = record.fundedSatoshis;
  if (typeof fundedSatoshis !== "number" || !Number.isSafeInteger(fundedSatoshis) || fundedSatoshis <= 0) throw new Error("testnet recovery ledger funded amount is invalid");
  if (!Array.isArray(record.businessTxids) || record.businessTxids.some((txid) => typeof txid !== "string" || !TXID_RE.test(txid))) throw new Error("testnet recovery ledger business txids are invalid");
  if (new Set(record.businessTxids).size !== record.businessTxids.length) throw new Error("testnet recovery ledger business txids are duplicated");
  const businessSatoshis = record.businessSatoshis;
  const maxLossSatoshis = record.maxLossSatoshis;
  if (typeof businessSatoshis !== "number" || !Number.isSafeInteger(businessSatoshis) || businessSatoshis < 0 || typeof maxLossSatoshis !== "number" || !Number.isSafeInteger(maxLossSatoshis) || maxLossSatoshis < 0) throw new Error("testnet recovery ledger accounting budget is invalid");
  if (!["prepared", "funded", "returning", "returned", "uncertain"].includes(record.status ?? "")) throw new Error("testnet recovery ledger status is invalid");
  if (typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))) throw new Error("testnet recovery ledger timestamp is invalid");
  for (const [field, allowNegative] of [["returnedSatoshis", false], ["returnFeeSatoshis", false], ["lossSatoshis", true]] as const) {
    const item = record[field];
    if (item !== undefined && (!Number.isSafeInteger(item) || (!allowNegative && item < 0))) throw new Error(`testnet recovery ledger ${field} is invalid`);
  }
  if (record.fundingTxid !== undefined) assertTxid(record.fundingTxid);
  if (record.returnTxid !== undefined) assertTxid(record.returnTxid);
  return record as FundingLedgerRecord;
}

export interface TestnetChainIdentity {
  /** 由链服务运行时返回的网络身份，不能由文件名推断。 */
  readonly network: "testnet" | "mainnet" | "unknown";
  /** 当前链高度，用于审计资金观察时的时间边界。 */
  readonly tipHeight: number;
}

export interface TestnetAddressObservation {
  readonly testnetBalance: number;
  /** 如果同一派生地址在 mainnet 有余额，必须停止而不是继续。 */
  readonly mainnetBalance: number;
  readonly spendableUtxoCount: number;
}

export type BroadcastResult =
  | {
      readonly status: "broadcast";
      readonly txid: string;
      /** 实际转入目标输出的金额；用于收尾账本核算，不是页面文案。 */
      readonly outputSatoshis: number;
      /** 该笔交易实际消耗的矿工费；用于预算审计。 */
      readonly feeSatoshis: number;
    }
  | { readonly status: "uncertain"; readonly operationId: string };

export interface TestnetChainAdapter {
  inspectNetwork(): Promise<TestnetChainIdentity>;
  inspectAddress(address: string): Promise<TestnetAddressObservation>;
  /** 适配器内部必须用正式交易构造器和 testnet 广播端点。 */
  fundFromSeed(input: { readonly seedPrivateKeyHex: string; readonly targetAddress: string; readonly satoshis: number; readonly operationId: string }): Promise<BroadcastResult>;
  reconcile(operationId: string): Promise<{ readonly status: "broadcast" | "not-found" | "uncertain"; readonly txid?: string }>;
  returnFunds(input: { readonly walletPrivateKeyHex: string; readonly targetAddress: string; readonly operationId: string }): Promise<BroadcastResult>;
}

/** 不把私钥放在普通对象字段中时，测试结果仍可保留的公开一次性钱包投影。 */
export interface OneTimeWallet {
  readonly runId: string;
  readonly scenarioId: string;
  readonly address: string;
  readonly publicKeyHex: string;
  readonly privateKey: SecretString;
  clear(): void;
}

export interface FundingBudget {
  /** 充值上限，单位 satoshis。 */
  readonly maxFundingSatoshis: number;
  /** 场景允许的最大损失，单位 satoshis。 */
  readonly maxLossSatoshis: number;
  /** 预留手续费，单位 satoshis。 */
  readonly feeReserveSatoshis: number;
}

export interface FundingLedgerRecord {
  readonly runId: string;
  readonly scenarioId: string;
  readonly walletAddress: string;
  readonly fundingTxid?: string;
  readonly fundedSatoshis: number;
  readonly businessTxids: readonly string[];
  /** 已登记的业务转出金额；业务结果本身不计入“资源损失”。 */
  readonly businessSatoshis: number;
  /** 本次 Journey 允许的最大未归集损失，单位 satoshis。 */
  readonly maxLossSatoshis: number;
  /** 归集后实际回到 seed 地址的金额和账本核算结果。 */
  readonly returnedSatoshis?: number;
  readonly returnFeeSatoshis?: number;
  readonly lossSatoshis?: number;
  readonly returnTxid?: string;
  readonly status: "prepared" | "funded" | "returning" | "returned" | "uncertain";
  readonly updatedAt: string;
}

/** 只保存公开地址、txid、金额和状态；不存在私钥字段。 */
export class RecoveryLedger {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async read(): Promise<FundingLedgerRecord[]> {
    try {
      const text = await readFile(this.#file, "utf8");
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("ledger is not an array");
      const records = value.map((item) => assertLedgerRecord(item));
      const identities = new Set(records.map((item) => `${item.runId}:${item.scenarioId}`));
      if (identities.size !== records.length) throw new Error("testnet recovery ledger contains duplicate scenario records");
      return records;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return [];
      throw new Error("testnet recovery ledger is unreadable");
    }
  }

  async append(record: FundingLedgerRecord): Promise<void> {
    assertLedgerRecord(record);
    const records = await this.read();
    const next = records.filter((item) => !(item.runId === record.runId && item.scenarioId === record.scenarioId));
    next.push(record);
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    // 先写临时文件再替换，避免进程在不可逆操作后崩溃时留下半截账本，
    // 下一轮无法判断是“未广播”还是“账本被截断”。
    const temporary = `${this.#file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async uncertain(): Promise<FundingLedgerRecord[]> {
    return (await this.read()).filter((record) => record.status === "uncertain");
  }
}

/**
 * testnet 资金 Resource：长期 seed 只在这里读取，所有不可逆操作都绑定预算和账本。
 */
export class TestnetFundingResource {
  readonly #seed: SecretString;
  readonly #chain: TestnetChainAdapter;
  readonly #ledger: RecoveryLedger;

  constructor(seed: SecretString, chain: TestnetChainAdapter, ledger: RecoveryLedger) {
    this.#seed = seed;
    this.#chain = chain;
    this.#ledger = ledger;
  }

  async prepare(runId: string, minimumReserveSatoshis: number): Promise<{ readonly seedAddress: string; readonly testnetBalance: number; readonly spendableUtxoCount: number; readonly tipHeight: number }> {
    assertSafeIdentifier(runId, "run_id");
    if (!Number.isSafeInteger(minimumReserveSatoshis) || minimumReserveSatoshis < 0) throw new Error("testnet minimum reserve is invalid");
    const privateKeyHex = this.#seed.read();
    assertScalar(privateKeyHex);
    const publicKeyHex = Buffer.from(secp256k1.getPublicKey(Buffer.from(privateKeyHex, "hex"), true)).toString("hex");
    const seedAddress = deriveTestnetP2pkhAddress(publicKeyHex);
    const identity = await this.#chain.inspectNetwork();
    if (identity.network !== "testnet") throw new Error(`testnet resource refused network ${identity.network}`);
    const observation = await this.#chain.inspectAddress(seedAddress);
    if (observation.mainnetBalance !== 0) throw new Error("derived funding identity has unexpected mainnet balance; manual review required");
    if (observation.testnetBalance < minimumReserveSatoshis) throw new Error("testnet funding reserve is below this run budget");
    const existing = await this.#ledger.uncertain();
    if (existing.length > 0) throw new Error("testnet recovery ledger contains unresolved uncertain operations");
    return { seedAddress, testnetBalance: observation.testnetBalance, spendableUtxoCount: observation.spendableUtxoCount, tipHeight: identity.tipHeight };
  }

  createOneTimeWallet(runId: string, scenarioId: string): OneTimeWallet {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    const safeScenarioId = assertSafeIdentifier(scenarioId, "scenario_id");
    let privateKeyHex = "";
    while (true) {
      privateKeyHex = randomBytes(32).toString("hex");
      try { assertScalar(privateKeyHex); break; } catch { /* negligible invalid scalar; generate another */ }
    }
    const publicKeyHex = Buffer.from(secp256k1.getPublicKey(Buffer.from(privateKeyHex, "hex"), true)).toString("hex");
    const privateKey = this.#makeSecret(privateKeyHex);
    return { runId: safeRunId, scenarioId: safeScenarioId, address: deriveTestnetP2pkhAddress(publicKeyHex), publicKeyHex, privateKey, clear: () => privateKey.clear() };
  }

  async fund(wallet: OneTimeWallet, amount: number, budget: FundingBudget): Promise<FundingLedgerRecord> {
    assertSafeIdentifier(wallet.runId, "run_id");
    assertSafeIdentifier(wallet.scenarioId, "scenario_id");
    if (!Number.isSafeInteger(budget.maxFundingSatoshis) || budget.maxFundingSatoshis <= 0 || !Number.isSafeInteger(budget.maxLossSatoshis) || budget.maxLossSatoshis < 0 || !Number.isSafeInteger(budget.feeReserveSatoshis) || budget.feeReserveSatoshis < 0) throw new Error("testnet funding budget is invalid");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > budget.maxFundingSatoshis) throw new Error("testnet funding amount exceeds the declared budget");
    const operationId = `${wallet.runId}:${wallet.scenarioId}:fund`;
    const current: FundingLedgerRecord = { runId: wallet.runId, scenarioId: wallet.scenarioId, walletAddress: wallet.address, fundedSatoshis: amount, businessTxids: [], businessSatoshis: 0, maxLossSatoshis: budget.maxLossSatoshis, status: "prepared", updatedAt: new Date().toISOString() };
    await this.#ledger.append(current);
    let result: BroadcastResult;
    try {
      result = await this.#chain.fundFromSeed({ seedPrivateKeyHex: this.#seed.read(), targetAddress: wallet.address, satoshis: amount, operationId });
    } catch {
      const uncertain = { ...current, status: "uncertain" as const, updatedAt: new Date().toISOString() };
      await this.#ledger.append(uncertain);
      throw new Error("testnet funding result is uncertain; reconcile by operationId before retrying");
    }
    if (result.status === "uncertain") {
      await this.#ledger.append({ ...current, status: "uncertain", updatedAt: new Date().toISOString() });
      throw new Error("testnet funding result is uncertain; blind retry is forbidden");
    }
    if (result.outputSatoshis !== amount) {
      await this.#ledger.append({ ...current, status: "uncertain", updatedAt: new Date().toISOString() });
      throw new Error("testnet funding receipt amount does not match the declared budget");
    }
    const funded = { ...current, fundingTxid: result.txid, status: "funded" as const, updatedAt: new Date().toISOString() };
    await this.#ledger.append(funded);
    return funded;
  }

  async reconcile(operationId: string): Promise<{ readonly status: "broadcast" | "not-found" | "uncertain"; readonly txid?: string }> {
    return this.#chain.reconcile(operationId);
  }

  /**
   * 页面返回 local-confirmed 只证明 Coordinator 接受了业务交易；在允许
   * 归集前仍要把 canonical txid 和业务金额登记到同一份公开账本，避免把
   * 用户有意转出的金额误报成资源损失，也避免“页面成功但账本缺一笔”。
   */
  async recordBusinessTransaction(wallet: OneTimeWallet, txid: string, amountSatoshis: number): Promise<FundingLedgerRecord> {
    assertSafeIdentifier(wallet.runId, "run_id");
    assertSafeIdentifier(wallet.scenarioId, "scenario_id");
    const normalizedTxid = assertTxid(txid);
    if (!Number.isSafeInteger(amountSatoshis) || amountSatoshis <= 0) throw new Error("testnet business amount is invalid");
    const records = await this.#ledger.read();
    const current = records.find((record) => record.runId === wallet.runId && record.scenarioId === wallet.scenarioId);
    if (!current || current.walletAddress !== wallet.address || current.status !== "funded") throw new Error("business transaction requires a reconciled funded ledger record");
    if (current.businessTxids.includes(normalizedTxid)) return current;
    const businessSatoshis = (current.businessSatoshis ?? 0) + amountSatoshis;
    if (businessSatoshis > current.fundedSatoshis) throw new Error("business transactions exceed the one-time wallet budget");
    const next = { ...current, businessTxids: [...current.businessTxids, normalizedTxid], businessSatoshis, updatedAt: new Date().toISOString() };
    await this.#ledger.append(next);
    return next;
  }

  async returnRemaining(wallet: OneTimeWallet, targetAddress: string): Promise<FundingLedgerRecord> {
    assertSafeIdentifier(wallet.runId, "run_id");
    assertSafeIdentifier(wallet.scenarioId, "scenario_id");
    const records = await this.#ledger.read();
    const current = records.find((record) => record.runId === wallet.runId && record.scenarioId === wallet.scenarioId);
    if (!current || current.walletAddress !== wallet.address || current.status !== "funded") throw new Error("testnet return requires a reconciled funded ledger record");
    const operationId = `${wallet.runId}:${wallet.scenarioId}:return`;
    await this.#ledger.append({ ...current, status: "returning", updatedAt: new Date().toISOString() });
    let result: BroadcastResult;
    try {
      result = await this.#chain.returnFunds({ walletPrivateKeyHex: wallet.privateKey.read(), targetAddress, operationId });
    } catch {
      await this.#ledger.append({ ...current, status: "uncertain", updatedAt: new Date().toISOString() });
      throw new Error("testnet return result is uncertain; manual reconciliation is required");
    }
    if (result.status === "uncertain") {
      await this.#ledger.append({ ...current, status: "uncertain", updatedAt: new Date().toISOString() });
      throw new Error("testnet return result is uncertain; manual reconciliation is required");
    }
    const businessSatoshis = current.businessSatoshis ?? 0;
    const lossSatoshis = current.fundedSatoshis - businessSatoshis - result.outputSatoshis;
    if (lossSatoshis < 0 || lossSatoshis > current.maxLossSatoshis) {
      await this.#ledger.append({ ...current, returnTxid: result.txid, returnedSatoshis: result.outputSatoshis, returnFeeSatoshis: result.feeSatoshis, lossSatoshis, status: "uncertain", updatedAt: new Date().toISOString() });
      throw new Error("testnet return exceeded the declared maximum loss; manual reconciliation is required");
    }
    const returned = { ...current, returnTxid: result.txid, returnedSatoshis: result.outputSatoshis, returnFeeSatoshis: result.feeSatoshis, lossSatoshis, status: "returned" as const, updatedAt: new Date().toISOString() };
    await this.#ledger.append(returned);
    return returned;
  }

  #makeSecret(value: string): SecretString {
    // 延迟 import 会让类型/运行环境更复杂；这里只通过构造函数的原型获取同一安全容器。
    // 调用者传入的 seed 已是同一个 Resource 约定的 SecretString 实例。
    const constructor = this.#seed.constructor as new (input: string) => SecretString;
    return new constructor(value);
  }
}
