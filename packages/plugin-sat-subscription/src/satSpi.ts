// SPI trusted service。
//
// SPI wire、request_id 与字段校验全部交给上游 satoshi-payment-interface。
// 本文件只负责 Keymaster 的 owner 绑定、状态持久化、P2PKH 充值编排以及
// Collect 的未知结果恢复；不保存私钥，也不把 SPI 内部对象暴露给 Connect。

import { newCollectRequest, newInformationRequest, parseResponse } from "satoshi-payment-interface/wallet";
import { parse } from "satoshi-payment-interface/wire";
import type { Information, Response } from "satoshi-payment-interface/protocol";
import { WireKind } from "satoshi-payment-interface/protocol";
import {
  assertCompressedPublicKeyHex,
  assertSupplierId,
  bytesToHex
} from "./satValidation.js";
import {
  SatSubscriptionError,
  SatTransportError,
  satErrorCodeFromFailure,
  type SatSubscriptionSpiRuntime
} from "./satProvider.js";
import type { SatSubscriptionStateStore } from "./satState.js";
import type {
  SatCollectResult,
  SatErrorCode,
  SatSpiInformation,
  SatTopUpPreview,
  SatTopUpResult,
  SatSupplierConfigV1,
  SupportedSpiBsvNetwork,
  SatSubscriptionSpiService
} from "@keymaster/contracts";

/** plugin-p2pkh 由 capability 动态注入；这里仅声明本插件使用的最小子集。 */
export interface SatP2pkhService {
  /** 读取当前产品费率；没有该方法时使用中档默认值。 */
  getGlobalSettings?(): {
    /** 是否允许使用 P2PKH 测试网资产、地址和交易。 */
    includeTestnet?: boolean;
    feeRateSatoshisPerKb?: Partial<Record<"low" | "medium" | "high", number>>;
  };
  /** 创建 owner 绑定的 P2PKH 交易预览。 */
  prepareTransfer(input: {
    assetId: "bsv" | "bsvtest";
    ownerPublicKeyHex: string;
    recipientAddress: string;
    amountSatoshis: number;
    feeRateSatoshisPerKb?: number;
  }): Promise<unknown>;
  /** 广播已经确认过的 P2PKH 预览。 */
  submitTransfer(preview: unknown): Promise<{ status: string; txid?: string; error?: string; rawTxHex?: string }>;
}

export interface SatSpiServiceConfig {
  /** 当前 provider 已 bind 时返回其连接/状态运行时。 */
  getRuntime(): SatSubscriptionSpiRuntime | null;
  /** 未 bind 时读取当前 active owner；不得从调用方入参取得。 */
  getOwnerPublicKeyHex(): string | null;
  /** 打开指定 owner 的 key-scoped 状态。 */
  stateForOwner(ownerPublicKeyHex: string): Promise<SatSubscriptionStateStore>;
  /** 当前 P2PKH capability；充值流程第一次使用时才懒加载，插件未启用时返回 null。 */
  getP2pkh(): SatP2pkhService | null | Promise<SatP2pkhService | null>;
  /** 由 SharedWorker 按 P2PKH 网络派生当前 owner 的地址。 */
  deriveP2pkhAddress(ownerPublicKeyHex: string, network: "main" | "test"): Promise<string>;
  /** 当前 owner 会话世代；锁定/切换 key 后递增。 */
  getOwnerGeneration?: () => number | null;
  /** 当前时间，测试可注入。 */
  now?: () => number;
}

/** SPI BSV 网络到 P2PKH 网络/资产的唯一映射；拒绝别名、大小写变体和猜测。 */
export function mapSpiBsvNetwork(network: string): {
  spiNetwork: SupportedSpiBsvNetwork;
  p2pkhNetwork: "main" | "test";
  assetId: "bsv" | "bsvtest";
} {
  if (network === "mainnet") return { spiNetwork: "mainnet", p2pkhNetwork: "main", assetId: "bsv" };
  if (network === "testnet") return { spiNetwork: "testnet", p2pkhNetwork: "test", assetId: "bsvtest" };
  throw new SatSubscriptionError("unavailable", `供应商 BSV 网络不受支持：${network}`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SatSubscriptionError("validation", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function assertSpiText(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SatSubscriptionError("validation", `${field} is invalid`);
  }
}

function assertPositiveAmount(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== "bigint" || value <= 0n || value > 0xffffffffffffffffn) {
    throw new SatSubscriptionError("validation", `${field} must be a positive uint64 bigint`);
  }
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new SatSubscriptionError("validation", `${field} exceeds JS safe integer range`);
  return Number(value);
}

function errorCodeFromSpi(code: unknown): SatErrorCode {
  switch (code) {
    case "INSUFFICIENT_BALANCE": return "balance";
    case "REQUEST_ID_CONFLICT": return "conflict";
    case "UNSUPPORTED_CURRENCY": return "unavailable";
    case "INVALID_PAYMENT_ADDRESS":
    case "INVALID_AMOUNT": return "validation";
    default: return "protocol";
  }
}

function errorCodeFromFailure(error: unknown): SatErrorCode {
  if (error instanceof SatSubscriptionError || error instanceof SatTransportError || isExternalSatTransportError(error) || (error && typeof error === "object" && (error as { domain?: unknown }).domain === "window-p2p")) {
    return satErrorCodeFromFailure(error);
  }
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return errorCodeFromSpi(code);
}

/** 独立 transport package 的 Error 原型不同，按稳定字段跨 package 识别。 */
function isExternalSatTransportError(error: unknown): error is {
  code: "ERR_SAT_TRANSPORT";
  sentBoundary: "not-sent" | "unknown";
} {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; sentBoundary?: unknown };
  return value.code === "ERR_SAT_TRANSPORT" && (value.sentBoundary === "not-sent" || value.sentBoundary === "unknown");
}

function messageFromFailure(error: unknown): string {
  if (error instanceof SatSubscriptionError || error instanceof SatTransportError || isExternalSatTransportError(error)) {
    return error instanceof Error ? error.message : "SPI transport failed";
  }
  return "SPI request failed";
}

function requestIdBytes(requestIdHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(requestIdHex)) throw new SatSubscriptionError("protocol", "Collect request_id is not canonical hex");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(requestIdHex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function assertGeneration(value: number | null | undefined, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new SatSubscriptionError("validation", `${field} is invalid`);
  return value;
}

function sameCollectContent(
  value: SatCollectResult,
  input: { supplierId: string; currency: string; network: string; amount: bigint; paymentAddress: string }
): boolean {
  return value.supplierId === input.supplierId
    && value.currency === input.currency
    && value.network === input.network
    && value.amount === input.amount
    && value.paymentAddress === input.paymentAddress;
}

function cloneInformation(value: Information): { currencies: SatSpiInformation["currencies"]; projectType: string; projectInfoCbor: Uint8Array } {
  return {
    currencies: value.currencies.map((item) => ({
      currency: item.currency,
      network: item.network,
      paymentAddress: item.paymentAddress,
      balance: item.balance
    })),
    projectType: value.projectType,
    projectInfoCbor: value.projectInfoCbor.slice()
  };
}

type SatTopUpInput =
  | { supplierId: string; amountSatoshis: bigint }
  | { supplierId: string; currency: string; network: string; amountSatoshis: bigint };

function hasExplicitTopUpAccount(input: SatTopUpInput): input is Extract<SatTopUpInput, { currency: string; network: string }> {
  const hasCurrency = "currency" in input;
  const hasNetwork = "network" in input;
  if (hasCurrency !== hasNetwork) throw new SatSubscriptionError("validation", "充值账户必须同时指定 currency 和 network");
  return hasCurrency && hasNetwork;
}

function selectBsvAccount(
  currencies: readonly SatSpiInformation["currencies"][number][],
  target?: { currency: string; network: string }
): { account: SatSpiInformation["currencies"][number]; mapping: ReturnType<typeof mapSpiBsvNetwork> } {
  if (target && target.currency !== "BSV") {
    throw new SatSubscriptionError("unavailable", "SatSubscription 充值和回收目前只支持 BSV SPI 账户");
  }
  const bsvAccounts = currencies.filter((item) => item.currency === "BSV");
  if (bsvAccounts.length === 0) throw new SatSubscriptionError("unavailable", "供应商没有 BSV SPI 账户");

  if (target) {
    const mapping = mapSpiBsvNetwork(target.network);
    const account = bsvAccounts.find((item) => item.network === mapping.spiNetwork);
    if (!account) throw new SatSubscriptionError("conflict", `供应商没有 BSV/${mapping.spiNetwork} SPI 账户`);
    return { account, mapping };
  }

  if (bsvAccounts.length !== 1) {
    throw new SatSubscriptionError("conflict", "供应商返回多个 BSV SPI 账户，必须明确指定 currency 和 network");
  }
  const account = bsvAccounts[0]!;
  return { account, mapping: mapSpiBsvNetwork(account.network) };
}

function assertP2pkhNetworkEnabled(p2pkh: SatP2pkhService, mapping: ReturnType<typeof mapSpiBsvNetwork>): void {
  if (mapping.p2pkhNetwork === "test" && p2pkh.getGlobalSettings?.().includeTestnet !== true) {
    throw new SatSubscriptionError("unavailable", "P2PKH 设置未启用测试网，请先在 P2PKH 设置中启用测试网");
  }
}

function validateP2pkhPreview(input: {
  preview: unknown;
  ownerPublicKeyHex: string;
  recipientAddress: string;
  amountSatoshis: bigint;
  expectedAssetId: "bsv" | "bsvtest";
  expectedNetwork: "main" | "test";
}): Record<string, unknown> {
  const value = asRecord(input.preview, "p2pkhPreview");
  if (value.assetId !== input.expectedAssetId || value.network !== input.expectedNetwork) {
    throw new SatSubscriptionError("validation", `P2PKH preview network/asset does not match ${input.expectedAssetId}/${input.expectedNetwork}`);
  }
  if (value.ownerPublicKeyHex !== input.ownerPublicKeyHex) throw new SatSubscriptionError("identity", "P2PKH preview owner does not match current owner");
  if (value.recipientAddress !== input.recipientAddress) throw new SatSubscriptionError("conflict", "P2PKH preview recipient no longer matches SPI payment address");
  if (value.amountSatoshis !== safeNumber(input.amountSatoshis, "amountSatoshis")) throw new SatSubscriptionError("conflict", "P2PKH preview amount no longer matches");
  if (!Number.isSafeInteger(value.feeRateSatoshisPerKb) || Number(value.feeRateSatoshisPerKb) <= 0) throw new SatSubscriptionError("validation", "P2PKH preview fee rate is invalid");
  if (typeof value.rawTxHex !== "string" || !/^[0-9a-f]+$/.test(value.rawTxHex) || value.rawTxHex.length % 2 !== 0) throw new SatSubscriptionError("validation", "P2PKH preview raw transaction is invalid");
  return value;
}

/** SPI trusted service 实现。 */
export class SatSpiService implements SatSubscriptionSpiService {
  private readonly now: () => number;

  constructor(private readonly cfg: SatSpiServiceConfig) {
    this.now = cfg.now ?? Date.now;
  }

  private async context(): Promise<{
    ownerPublicKeyHex: string;
    stateStore: SatSubscriptionStateStore;
    runtime: SatSubscriptionSpiRuntime | null;
    ownerGeneration?: number;
    supplierGeneration: number;
  }> {
    const runtime = this.cfg.getRuntime();
    const ownerPublicKeyHex = runtime?.ownerPublicKeyHex ?? this.cfg.getOwnerPublicKeyHex();
    if (!ownerPublicKeyHex) throw new SatSubscriptionError("identity", "SPI requires an active owner");
    assertCompressedPublicKeyHex(ownerPublicKeyHex, "ownerPublicKeyHex");
    if (runtime && runtime.ownerPublicKeyHex !== ownerPublicKeyHex) throw new SatSubscriptionError("identity", "SPI runtime owner changed");
    const stateStore = runtime?.stateStore ?? await this.cfg.stateForOwner(ownerPublicKeyHex);
    const ownerGeneration = assertGeneration(runtime?.ownerGeneration ?? this.cfg.getOwnerGeneration?.(), "ownerGeneration");
    const supplierGeneration = assertGeneration(runtime?.supplierGeneration ?? stateStore.supplierGeneration(), "supplierGeneration");
    if (supplierGeneration === undefined) throw new SatSubscriptionError("validation", "supplierGeneration is unavailable");
    return { ownerPublicKeyHex, stateStore, runtime, ...(ownerGeneration === undefined ? {} : { ownerGeneration }), supplierGeneration };
  }

  private supplier(stateStore: SatSubscriptionStateStore, supplierId: string): SatSupplierConfigV1 {
    assertSupplierId(supplierId);
    const supplier = stateStore.getSupplier(supplierId);
    if (!supplier) throw new SatSubscriptionError("config", "Supplier is not configured");
    if (!supplier.enabled) throw new SatSubscriptionError("config", "Supplier is disabled");
    return supplier;
  }

  private async deriveCollectAddress(
    context: Awaited<ReturnType<SatSpiService["context"]>>,
    spiNetwork: string,
    checkTestnetEnabled: boolean
  ): Promise<string> {
    const mapping = mapSpiBsvNetwork(spiNetwork);
    if (checkTestnetEnabled && mapping.p2pkhNetwork === "test") {
      const p2pkh = await this.cfg.getP2pkh();
      if (!p2pkh) throw new SatSubscriptionError("unavailable", "P2PKH service is unavailable");
      assertP2pkhNetworkEnabled(p2pkh, mapping);
    }
    const paymentAddress = await this.cfg.deriveP2pkhAddress(context.ownerPublicKeyHex, mapping.p2pkhNetwork);
    assertSpiText(paymentAddress, "paymentAddress", 128);
    return paymentAddress;
  }

  private async queryInformation(input: { ownerPublicKeyHex: string; stateStore: SatSubscriptionStateStore; runtime: SatSubscriptionSpiRuntime | null }, supplierId: string): Promise<SatSpiInformation> {
    this.supplier(input.stateStore, supplierId);
    if (!input.runtime) throw new SatSubscriptionError("unavailable", "SPI provider is not bound to a live connection");
    const request = newInformationRequest();
    let responseWire: Uint8Array;
    try {
      responseWire = await input.runtime.requestSpi(supplierId, request.wire);
    } catch (error) {
      const code = errorCodeFromFailure(error);
      throw new SatSubscriptionError(code, messageFromFailure(error));
    }
    let response: Response;
    try {
      response = parseResponse(responseWire, request.requestId);
    } catch (error) {
      throw new SatSubscriptionError("protocol", "SPI Information response is invalid");
    }
    if (!response.information) {
      const code = errorCodeFromSpi(response.error?.code);
      throw new SatSubscriptionError(code, `SPI Information rejected: ${String(response.error?.code ?? "UNKNOWN")}`);
    }
    const copied = cloneInformation(response.information);
    const result: SatSpiInformation = {
      supplierId,
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      currencies: copied.currencies,
      projectType: copied.projectType,
      projectInfoCbor: copied.projectInfoCbor,
      observedAtMs: this.now()
    };
    await input.stateStore.putSpiInformation(result);
    return result;
  }

  async getInformation(input: { supplierId: string }): Promise<SatSpiInformation> {
    const context = await this.context();
    return this.queryInformation(context, input.supplierId);
  }

  async prepareTopUp(input: SatTopUpInput): Promise<SatTopUpPreview> {
    assertPositiveAmount(input.amountSatoshis, "amountSatoshis");
    const explicitAccount = hasExplicitTopUpAccount(input);
    if (explicitAccount) {
      assertSpiText(input.currency, "currency", 32);
      assertSpiText(input.network, "network", 32);
      // 先映射请求值，未知网络不得进入 Information 后的交易创建路径。
      mapSpiBsvNetwork(input.network);
    }
    const context = await this.context();
    const information = await this.queryInformation(context, input.supplierId);
    const { account, mapping } = selectBsvAccount(
      information.currencies,
      explicitAccount ? { currency: input.currency, network: input.network } : undefined
    );
    assertSpiText(account.paymentAddress, "paymentAddress", 128);
    const p2pkh = await this.cfg.getP2pkh();
    if (!p2pkh) throw new SatSubscriptionError("unavailable", "P2PKH service is unavailable");
    assertP2pkhNetworkEnabled(p2pkh, mapping);
    const amountNumber = safeNumber(input.amountSatoshis, "amountSatoshis");
    const configuredFee = p2pkh.getGlobalSettings?.().feeRateSatoshisPerKb?.medium;
    const feeRate = Number.isSafeInteger(configuredFee) && Number(configuredFee) > 0 ? Number(configuredFee) : 1000;
    let p2pkhPreview: unknown;
    try {
      p2pkhPreview = await p2pkh.prepareTransfer({
        assetId: mapping.assetId,
        ownerPublicKeyHex: context.ownerPublicKeyHex,
        recipientAddress: account.paymentAddress,
        amountSatoshis: amountNumber,
        feeRateSatoshisPerKb: feeRate
      });
    } catch (error) {
      throw new SatSubscriptionError("balance", messageFromFailure(error));
    }
    validateP2pkhPreview({
      preview: p2pkhPreview,
      ownerPublicKeyHex: context.ownerPublicKeyHex,
      recipientAddress: account.paymentAddress,
      amountSatoshis: input.amountSatoshis,
      expectedAssetId: mapping.assetId,
      expectedNetwork: mapping.p2pkhNetwork
    });
    return {
      supplierId: input.supplierId,
      paymentAddress: account.paymentAddress,
      network: mapping.spiNetwork,
      amountSatoshis: input.amountSatoshis,
      p2pkhPreview
    };
  }

  async submitTopUp(preview: SatTopUpPreview): Promise<SatTopUpResult> {
    if (!preview) throw new SatSubscriptionError("validation", "充值预览不能为空");
    const mapping = mapSpiBsvNetwork(preview.network);
    assertPositiveAmount(preview.amountSatoshis, "amountSatoshis");
    assertSpiText(preview.paymentAddress, "paymentAddress", 128);
    const context = await this.context();
    const information = await this.queryInformation(context, preview.supplierId);
    const { account } = selectBsvAccount(information.currencies, { currency: "BSV", network: mapping.spiNetwork });
    if (!account || account.paymentAddress !== preview.paymentAddress) throw new SatSubscriptionError("conflict", "Top-up preview payment address is stale");
    const p2pkh = await this.cfg.getP2pkh();
    if (!p2pkh) throw new SatSubscriptionError("unavailable", "P2PKH service is unavailable");
    assertP2pkhNetworkEnabled(p2pkh, mapping);
    validateP2pkhPreview({
      preview: preview.p2pkhPreview,
      ownerPublicKeyHex: context.ownerPublicKeyHex,
      recipientAddress: preview.paymentAddress,
      amountSatoshis: preview.amountSatoshis,
      expectedAssetId: mapping.assetId,
      expectedNetwork: mapping.p2pkhNetwork
    });
    let result: { status: string; txid?: string; error?: string; rawTxHex?: string };
    try {
      result = await p2pkh.submitTransfer(preview.p2pkhPreview);
    } catch (error) {
      throw new SatSubscriptionError(errorCodeFromFailure(error), messageFromFailure(error));
    }
    if (!result || typeof result.status !== "string" || result.status.length === 0) throw new SatSubscriptionError("protocol", "P2PKH submit returned an invalid result");
    return { status: result.status, ...(result.txid ? { txid: result.txid } : {}) };
  }

  private async executeCollect(
    context: Awaited<ReturnType<SatSpiService["context"]>>,
    pending: SatCollectResult
  ): Promise<SatCollectResult> {
    if (!pending.requestWire) throw new SatSubscriptionError("unknown_result", "Collect request wire is missing");
    const requestWire = pending.requestWire.slice();
    const requestId = requestIdBytes(pending.requestIdHex);
    if (!context.runtime) {
      const failed = { ...pending, state: "failed" as const, errorCode: "unavailable" as const };
      await context.stateStore.putCollectResult(failed);
      return context.stateStore.getCollectResult(pending.requestIdHex) ?? failed;
    }
    let responseWire: Uint8Array;
    try {
      responseWire = await context.runtime.requestSpi(pending.supplierId, requestWire);
    } catch (error) {
      const code = errorCodeFromFailure(error);
      const state = code === "unknown_result" ? "unknown_result" : "failed";
      const result = { ...pending, state: state as SatCollectResult["state"], errorCode: code };
      await context.stateStore.putCollectResult(result);
      return context.stateStore.getCollectResult(pending.requestIdHex) ?? result;
    }
    try {
      const response = parseResponse(responseWire, requestId);
      if (response.information) {
        const copied = cloneInformation(response.information);
        await context.stateStore.putSpiInformation({ supplierId: pending.supplierId, ownerPublicKeyHex: context.ownerPublicKeyHex, currencies: copied.currencies, projectType: copied.projectType, projectInfoCbor: copied.projectInfoCbor, observedAtMs: this.now() });
        const result = { ...pending, state: "succeeded" as const, errorCode: undefined };
        await context.stateStore.putCollectResult(result);
        return context.stateStore.getCollectResult(pending.requestIdHex) ?? result;
      }
      const result = { ...pending, state: "failed" as const, errorCode: errorCodeFromSpi(response.error?.code) };
      await context.stateStore.putCollectResult(result);
      return context.stateStore.getCollectResult(pending.requestIdHex) ?? result;
    } catch (error) {
      const result = { ...pending, state: "unknown_result" as const, errorCode: errorCodeFromFailure(error) };
      await context.stateStore.putCollectResult(result);
      return context.stateStore.getCollectResult(pending.requestIdHex) ?? result;
    }
  }

  private validateStoredCollectWire(input: {
    result: SatCollectResult;
    requestWire: Uint8Array;
  }): void {
    let request: ReturnType<typeof parse>;
    try {
      request = parse(input.requestWire);
    } catch {
      throw new SatSubscriptionError("protocol", "Stored Collect request wire is invalid");
    }
    if (request.kind !== WireKind.CollectRequest) throw new SatSubscriptionError("protocol", "Stored wire is not a CollectRequest");
    if (!equalBytes(request.requestId, requestIdBytes(input.result.requestIdHex))) throw new SatSubscriptionError("conflict", "Collect request_id does not match the stored result");
    if (request.items.length !== 1) throw new SatSubscriptionError("conflict", "Collect retry must contain exactly one item");
    const item = request.items[0];
    if (!item || item.currency !== input.result.currency || item.paymentAddress !== input.result.paymentAddress || item.amount !== input.result.amount) {
      throw new SatSubscriptionError("conflict", "Collect retry content does not match the stored request");
    }
  }

  async collectNew(input: { supplierId: string; currency: string; network: string; amount: bigint }): Promise<SatCollectResult> {
    assertSpiText(input.currency, "currency", 32);
    assertSpiText(input.network, "network", 32);
    assertPositiveAmount(input.amount, "amount");
    // 当前 P2PKH 资金能力只支持 BSV；网络值必须先通过 SPI 正式契约映射。
    if (input.currency !== "BSV") throw new SatSubscriptionError("unavailable", "SatSubscription 回收目前只支持 BSV SPI 账户");
    const requestedMapping = mapSpiBsvNetwork(input.network);
    const context = await this.context();
    if (context.ownerGeneration === undefined) throw new SatSubscriptionError("unavailable", "Collect requires an owner session generation");
    this.supplier(context.stateStore, input.supplierId);
    const information = await this.queryInformation(context, input.supplierId);
    const account = information.currencies.find((item) => item.currency === "BSV" && item.network === requestedMapping.spiNetwork);
    if (!information.currencies.some((item) => item.currency === "BSV")) throw new SatSubscriptionError("unavailable", "供应商没有 BSV SPI 账户");
    if (!account) throw new SatSubscriptionError("balance", "Supplier has no matching SPI account");
    // 以 Information 中命中的网络为真值派生 owner 地址，不能根据地址前缀猜测。
    const actualMapping = mapSpiBsvNetwork(account.network);
    if (actualMapping.spiNetwork !== requestedMapping.spiNetwork) throw new SatSubscriptionError("conflict", "Collect SPI network changed while selecting the account");
    const paymentAddress = await this.deriveCollectAddress(context, account.network, true);
    if (input.amount > account.balance) throw new SatSubscriptionError("balance", "Collect amount exceeds the current SPI balance");
    const request = newCollectRequest([{ currency: input.currency, paymentAddress, amount: input.amount }]);
    const pending: SatCollectResult = {
      requestIdHex: bytesToHex(request.requestId),
      ownerPublicKeyHex: context.ownerPublicKeyHex,
      ...(context.ownerGeneration === undefined ? {} : { ownerGeneration: context.ownerGeneration }),
      supplierGeneration: context.supplierGeneration,
      supplierId: input.supplierId,
      currency: input.currency,
      network: input.network,
      amount: input.amount,
      paymentAddress,
      requestWire: request.wire.slice(),
      state: "pending"
    };
    await context.stateStore.putCollectResult(pending);
    return this.executeCollect(context, pending);
  }

  async retryCollect(input: { requestIdHex: string; requestWire?: Uint8Array }): Promise<SatCollectResult> {
    if (!/^[0-9a-f]{64}$/.test(input.requestIdHex)) throw new SatSubscriptionError("validation", "Collect request_id is not canonical hex");
    const context = await this.context();
    const saved = context.stateStore.getCollectResult(input.requestIdHex);
    if (!saved) throw new SatSubscriptionError("validation", "Collect request is not stored");
    if (saved.state === "succeeded" || saved.state === "failed") throw new SatSubscriptionError("conflict", "Collect request is already terminal");
    this.supplier(context.stateStore, saved.supplierId);
    const savedOwnerPublicKeyHex = saved.ownerPublicKeyHex;
    const savedOwnerGeneration = saved.ownerGeneration;
    const savedSupplierGeneration = saved.supplierGeneration;
    const savedRequestWire = saved.requestWire;
    if (saved.recoveryBlocked === true || savedOwnerPublicKeyHex === undefined || savedOwnerGeneration === undefined || savedSupplierGeneration === undefined || savedRequestWire === undefined) {
      // 旧记录即使后来拿到了当前会话信息，也不能回填并重发；只能保持未知结果，
      // 由用户/运维根据供应商侧账本人工核对。
      const blocked = { ...saved, state: "unknown_result" as const, recoveryBlocked: true, errorCode: "unknown_result" as const };
      if (saved.state !== blocked.state || saved.recoveryBlocked !== true || saved.errorCode !== blocked.errorCode) await context.stateStore.putCollectResult(blocked);
      throw new SatSubscriptionError("unknown_result", "Collect request lacks recovery metadata and cannot be retried");
    }
    if (savedOwnerPublicKeyHex !== context.ownerPublicKeyHex) throw new SatSubscriptionError("identity", "Collect owner does not match the current owner");
    if (savedOwnerGeneration !== context.ownerGeneration) throw new SatSubscriptionError("conflict", "Collect owner session has changed");
    if (savedSupplierGeneration !== context.supplierGeneration) throw new SatSubscriptionError("conflict", "Supplier configuration has changed");
    if (saved.currency === "BSV") {
      // 既有 Wire 原样重发；这里只验证持久化 network 与 owner 地址仍一致，
      // 不根据当前网络重建请求，也不把 testnet 请求改发到主网。
      const expectedPaymentAddress = await this.deriveCollectAddress(context, saved.network, false);
      if (expectedPaymentAddress !== saved.paymentAddress) throw new SatSubscriptionError("conflict", "Collect network does not match the stored owner payment address");
    }
    const storedWire = savedRequestWire.slice();
    if (input.requestWire && !equalBytes(input.requestWire, storedWire)) throw new SatSubscriptionError("conflict", "Retry wire differs from the stored Collect wire");
    this.validateStoredCollectWire({ result: saved, requestWire: storedWire });
    const pending: SatCollectResult = {
      ...saved,
      ownerPublicKeyHex: savedOwnerPublicKeyHex,
      ownerGeneration: savedOwnerGeneration,
      supplierGeneration: savedSupplierGeneration,
      requestWire: storedWire,
      state: "pending",
      errorCode: undefined
    };
    await context.stateStore.putCollectResult(pending);
    return this.executeCollect(context, pending);
  }

  async collect(input: { supplierId: string; currency: string; network: string; amount: bigint }): Promise<SatCollectResult> {
    // 兼容旧调用方：只有未决内容才进入 retry；已完成内容必须走 collectNew，
    // 这样同金额的第二次主动回收仍会得到新的 request_id。
    assertSpiText(input.currency, "currency", 32);
    assertSpiText(input.network, "network", 32);
    assertPositiveAmount(input.amount, "amount");
    const context = await this.context();
    this.supplier(context.stateStore, input.supplierId);
    if (input.currency !== "BSV") throw new SatSubscriptionError("unavailable", "SatSubscription 回收目前只支持 BSV SPI 账户");
    const paymentAddress = await this.deriveCollectAddress(context, input.network, true);
    const content = { supplierId: input.supplierId, currency: input.currency, network: input.network, amount: input.amount, paymentAddress };
    const unresolved = context.stateStore.snapshot().collectResults.filter((value) => value.state === "pending" || value.state === "unknown_result");
    const same = unresolved.find((value) => sameCollectContent(value, content));
    if (same) return this.retryCollect({ requestIdHex: same.requestIdHex });
    if (unresolved.some((value) => value.supplierId === input.supplierId && value.currency === input.currency && value.network === input.network)) {
      throw new SatSubscriptionError("conflict", "An unresolved Collect request has different content");
    }
    return this.collectNew(input);
  }
}

export function createSatSpiService(cfg: SatSpiServiceConfig): SatSubscriptionSpiService {
  return new SatSpiService(cfg);
}
