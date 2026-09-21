import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { SecretString } from "../../support/secretString.js";
import { assertSafeIdentifier } from "../../support/ids.js";

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
      /** 实际转入目标输出的金额；用于调用方对账，不是页面文案。 */
      readonly outputSatoshis: number;
      /** 该笔交易实际消耗的矿工费；用于预算审计。 */
      readonly feeSatoshis: number;
    }
  | { readonly status: "uncertain" };

/** App 侧回款的链上原始交易摘要；只包含公开 txid、输入 outpoint 和目标地址输出合计。 */
export interface TestnetTransactionOutputs {
  readonly txid: string;
  /** 每个输入的 `${prevTxid}:${prevVout}`，用于证明它确实消费了被资助的输出。 */
  readonly inputOutpointKeys: readonly string[];
  /** 匹配目标地址锁脚本的输出金额合计，单位 satoshis。 */
  readonly outputSatoshis: number;
}

export interface TestnetChainAdapter {
  inspectNetwork(): Promise<TestnetChainIdentity>;
  inspectAddress(address: string): Promise<TestnetAddressObservation>;
  /** 适配器内部必须用正式交易构造器和 testnet 广播端点。 */
  fundFromSeed(input: { readonly seedPrivateKeyHex: string; readonly targetAddress: string; readonly satoshis: number }): Promise<BroadcastResult>;
  /**
   * 归集钱包全部余额。
   *
   * `feeRateSatoshisPerKb` 让小额钱包也能按用户实际使用的低费率归集；
   * 缺省保持适配器的高费率预算语义。矿工费由适配器按签名后的真实大小
   * 自动计算并扣除，调用方不需要猜。
   */
  returnFunds(input: { readonly walletPrivateKeyHex: string; readonly targetAddress: string; readonly feeRateSatoshisPerKb?: number }): Promise<BroadcastResult>;
  /**
   * 读取 testnet 原始交易并汇总目标地址的输出。页面自己广播的交易没有
   * Resource 私钥可签名，只能按 canonical txid 和原始交易字节对账；
   * 这里不接受供应商 JSON 里的金额推断。
   */
  inspectTransactionOutputs(txid: string, targetAddress: string): Promise<TestnetTransactionOutputs>;
}

/** 需要资助的目标；只登记公开地址 + run/scenario 身份，不携带私钥。 */
export interface FundingTarget {
  readonly runId: string;
  readonly scenarioId: string;
  readonly address: string;
}

/** 不把私钥放在普通对象字段中时，测试结果仍可保留的公开钱包投影。 */
export interface OneTimeWallet extends FundingTarget {
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

/** 一次链上转账的公开回执；金额来自签名后的真实交易，不是页面文案。 */
export interface FundingReceipt {
  readonly txid: string;
  readonly outputSatoshis: number;
  readonly feeSatoshis: number;
}

/**
 * testnet 资金 Resource。
 *
 * 长期 seed 只在这里读取；一次性私钥只在调用栈中短暂存在，不写入任何状态
 * 文件或报告。这里不再维护跨轮账本：固定 key01 钱包 + 每轮开始的可花费输出
 * 门禁 + 手工归集脚本已经覆盖恢复场景，链上事实是唯一真值。
 */
export class TestnetFundingResource {
  readonly #seed: SecretString;
  readonly #chain: TestnetChainAdapter;

  constructor(seed: SecretString, chain: TestnetChainAdapter) {
    this.#seed = seed;
    this.#chain = chain;
  }

  async prepare(minimumReserveSatoshis: number): Promise<{ readonly seedAddress: string; readonly testnetBalance: number; readonly spendableUtxoCount: number; readonly tipHeight: number }> {
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
    return { seedAddress, testnetBalance: observation.testnetBalance, spendableUtxoCount: observation.spendableUtxoCount, tipHeight: identity.tipHeight };
  }

  /**
   * 用仓库外固定测试私钥建立可追踪钱包。
   *
   * 页面通过正式导入入口把它作为 active Key，因此 seed 打款地址在跨轮之间
   * 稳定可查；失败时 Node 仍持有同一私钥，可以走 `returnRemaining` 把资金
   * 归集回 seed，而不是像随机一次性 Key 那样只能留下无法取回的余额。
   */
  createImportedWallet(runId: string, scenarioId: string, privateKeyHex: string): OneTimeWallet {
    const safeRunId = assertSafeIdentifier(runId, "run_id");
    const safeScenarioId = assertSafeIdentifier(scenarioId, "scenario_id");
    const normalized = privateKeyHex.trim().toLowerCase();
    assertScalar(normalized);
    const publicKeyHex = Buffer.from(secp256k1.getPublicKey(Buffer.from(normalized, "hex"), true)).toString("hex");
    const privateKey = this.#makeSecret(normalized);
    return { runId: safeRunId, scenarioId: safeScenarioId, address: deriveTestnetP2pkhAddress(publicKeyHex), publicKeyHex, privateKey, clear: () => privateKey.clear() };
  }

  async fund(target: FundingTarget, amount: number, budget: FundingBudget): Promise<FundingReceipt> {
    assertSafeIdentifier(target.runId, "run_id");
    assertSafeIdentifier(target.scenarioId, "scenario_id");
    if (!Number.isSafeInteger(budget.maxFundingSatoshis) || budget.maxFundingSatoshis <= 0 || !Number.isSafeInteger(budget.maxLossSatoshis) || budget.maxLossSatoshis < 0 || !Number.isSafeInteger(budget.feeReserveSatoshis) || budget.feeReserveSatoshis < 0) throw new Error("testnet funding budget is invalid");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > budget.maxFundingSatoshis) throw new Error("testnet funding amount exceeds the declared budget");
    const result = await this.#chain.fundFromSeed({ seedPrivateKeyHex: this.#seed.read(), targetAddress: target.address, satoshis: amount });
    if (result.status === "uncertain") throw new Error("testnet funding result is uncertain; observe the chain before retrying");
    if (result.outputSatoshis !== amount) throw new Error("testnet funding receipt amount does not match the declared budget");
    return { txid: result.txid, outputSatoshis: result.outputSatoshis, feeSatoshis: result.feeSatoshis };
  }

  /**
   * 把钱包剩余资金归集回目标地址。
   *
   * 矿工费由适配器按真实签名大小自动计算并扣除；调用方只核对链上回执。
   */
  async returnRemaining(
    wallet: OneTimeWallet,
    targetAddress: string,
    options: { readonly feeRateSatoshisPerKb?: number } = {},
  ): Promise<FundingReceipt> {
    assertSafeIdentifier(wallet.runId, "run_id");
    assertSafeIdentifier(wallet.scenarioId, "scenario_id");
    if (options.feeRateSatoshisPerKb !== undefined && (!Number.isSafeInteger(options.feeRateSatoshisPerKb) || options.feeRateSatoshisPerKb <= 0)) throw new Error("testnet return fee rate is invalid");
    const result = await this.#chain.returnFunds({
      walletPrivateKeyHex: wallet.privateKey.read(),
      targetAddress,
      ...(options.feeRateSatoshisPerKb === undefined ? {} : { feeRateSatoshisPerKb: options.feeRateSatoshisPerKb }),
    });
    if (result.status === "uncertain") throw new Error("testnet return result is uncertain; observe the chain before retrying");
    if (result.outputSatoshis <= 0) throw new Error("testnet return receipt amount is invalid");
    return { txid: result.txid, outputSatoshis: result.outputSatoshis, feeSatoshis: result.feeSatoshis };
  }

  #makeSecret(value: string): SecretString {
    // 延迟 import 会让类型/运行环境更复杂；这里只通过构造函数的原型获取同一安全容器。
    // 调用者传入的 seed 已是同一个 Resource 约定的 SecretString 实例。
    const constructor = this.#seed.constructor as new (input: string) => SecretString;
    return new constructor(value);
  }
}
