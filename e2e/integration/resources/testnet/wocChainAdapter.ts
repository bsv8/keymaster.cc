import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { signAsync } from "@noble/secp256k1";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { P2pkhUtxo, UtxoAllocation } from "../../../../packages/plugin-p2pkh/src/p2pkhContracts.js";
import {
  buildP2pkhTx,
  calcTxidFromRawTxHex,
  rawTxHexByteLength,
  signP2pkhTx,
} from "../../../../packages/plugin-p2pkh/src/p2pkhSigner.js";
import { allocateUtxos } from "../../../../packages/plugin-p2pkh/src/utxoAllocator.js";
import type {
  BroadcastResult,
  TestnetAddressObservation,
  TestnetChainAdapter,
  TestnetChainIdentity,
} from "./fundingResource.js";
import { deriveTestnetP2pkhAddress } from "./fundingResource.js";

const TESTNET_NETWORK = "test" as const;
const MAINNET_NETWORK = "main" as const;
const TESTNET_FEE_RESERVE = 1_000;
const DEFAULT_FEE_RATE_SATOSHIS_PER_KB = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const TXID_RE = /^[0-9a-f]{64}$/iu;

interface WocUtxoRow {
  readonly tx_hash?: unknown;
  readonly tx_pos?: unknown;
  readonly value?: unknown;
  readonly height?: unknown;
  readonly script?: unknown;
  readonly isSpentInMempoolTx?: unknown;
}

interface OperationJournalEntry {
  readonly version: 1;
  readonly operationId: string;
  readonly txid: string;
  readonly network: "test";
  readonly sourceAddress: string;
  readonly targetAddress: string;
  readonly kind: "fund" | "return";
  readonly satoshis: number;
  /** 目标输出金额；用于 Resource 收尾账本核算。 */
  readonly outputSatoshis: number;
  /** 实际交易费；不能由页面显示值推断。 */
  readonly feeSatoshis: number;
  readonly createdAt: string;
}

type ObservedTransaction = "confirmed" | "unconfirmed" | "not-found";

function assertOperationId(value: string): string {
  const normalized = value.trim();
  // operation_id 允许用冒号连接 run/scenario/动作，但仍必须能安全进入
  // 账本、日志和恢复文件；不能把任意 URL 或配置原文带进资源层。
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(normalized)) throw new Error("testnet operationId is invalid");
  return normalized;
}

function assertTxid(value: unknown, label: string): string {
  if (typeof value !== "string" || !TXID_RE.test(value)) throw new Error(`testnet ${label} is not a valid txid`);
  return value.toLowerCase();
}

function assertSatoshis(value: unknown, label: string, allowZero = false, allowNegative = false): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`testnet ${label} is invalid`);
  // 未确认余额是相对已确认的增量：内存池里已有花费（例如本轮之前广播、尚未进块
  // 的充值）时会为负数，这是链上事实，必须接受；确认余额永远不能为负。
  if (number < 0 && !allowNegative) throw new Error(`testnet ${label} is invalid`);
  if (number === 0 && !allowZero) throw new Error(`testnet ${label} is invalid`);
  return number;
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/iu, "");
  if (!/^[0-9a-f]+$/iu.test(normalized) || normalized.length % 2 !== 0) throw new Error("testnet private key is invalid");
  return Uint8Array.from({ length: normalized.length / 2 }, (_, index) => Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeDerInteger(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let bytes = hexToBytes(hex);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] ?? 0) < 0x80) bytes = bytes.slice(1);
  if ((bytes[0] ?? 0) >= 0x80) bytes = new Uint8Array([0, ...bytes]);
  return new Uint8Array([0x02, bytes.length, ...bytes]);
}

function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const first = encodeDerInteger(r);
  const second = encodeDerInteger(s);
  return new Uint8Array([0x30, first.length + second.length, ...first, ...second]);
}

function assertHttpsBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("testnet API base URL is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("testnet API base URL must be a credential-free HTTPS URL");
  return parsed.toString().replace(/\/$/u, "");
}

function decodeBase58Check(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!value || !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) throw new Error("testnet address is invalid");
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("testnet address is invalid");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function assertTestnetP2pkhAddress(value: string): string {
  const bytes = decodeBase58Check(value);
  if (bytes.length !== 25 || bytes[0] !== 0x6f) throw new Error("testnet operation requires a testnet P2PKH address");
  // Base58Check checksum is verified here instead of trusting the first byte;
  // a malformed target must never receive funds.
  const payload = bytes.slice(0, 21);
  const checksum = bytes.slice(21);
  const expected = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  for (let index = 0; index < 4; index += 1) if (checksum[index] !== expected[index]) throw new Error("testnet operation target checksum is invalid");
  return value;
}

/**
 * WOC-compatible Node testnet adapter.
 *
 * This is deliberately not used by the browser. It queries `/test` and
 * `/main` independently, builds/signs P2PKH transactions with the production
 * serializer, records the predicted txid before broadcast, and only returns
 * from an uncertain operation after txid observation.
 */
export class WocTestnetChainAdapter implements TestnetChainAdapter {
  readonly #baseUrl: string;
  readonly #authorization?: string;
  readonly #operationJournalPath?: string;
  readonly #journal = new Map<string, OperationJournalEntry>();
  #journalLoaded = false;
  #lastRequestAt = 0;
  #requestGate: Promise<void> = Promise.resolve();

  constructor(options: { readonly baseUrl: string; readonly authorization?: string; readonly operationJournalPath?: string }) {
    this.#baseUrl = assertHttpsBaseUrl(options.baseUrl);
    this.#authorization = options.authorization;
    this.#operationJournalPath = options.operationJournalPath;
  }

  async inspectNetwork(): Promise<TestnetChainIdentity> {
    const value = await this.#getJson("test", "/chain/info");
    if (!value || typeof value !== "object") throw new Error("testnet chain info is invalid");
    const item = value as { chain?: unknown; blocks?: unknown };
    if (item.chain !== "test") throw new Error("testnet API returned a non-test chain identity");
    return { network: "testnet", tipHeight: assertSatoshis(item.blocks, "chain tip", true) };
  }

  async inspectAddress(address: string): Promise<TestnetAddressObservation> {
    const normalized = assertTestnetP2pkhAddress(address);
    const [testConfirmed, testUnconfirmed, testConfirmedUtxos, testUnconfirmedUtxos, mainConfirmed, mainUnconfirmed] = await Promise.all([
      this.#balance("test", normalized, "confirmed"),
      this.#balance("test", normalized, "unconfirmed"),
      this.#listUtxos("test", normalized, "confirmed"),
      this.#listUtxos("test", normalized, "unconfirmed"),
      this.#balance("main", this.#mainnetAddressForTestnetAddress(normalized), "confirmed"),
      this.#balance("main", this.#mainnetAddressForTestnetAddress(normalized), "unconfirmed"),
    ]);
    const spendable = [...testConfirmedUtxos, ...testUnconfirmedUtxos].filter((item) => !item.isSpentInMempoolTx);
    return {
      testnetBalance: testConfirmed + testUnconfirmed,
      mainnetBalance: mainConfirmed + mainUnconfirmed,
      spendableUtxoCount: new Set(spendable.map((item) => `${item.txid}:${item.vout}`)).size,
    };
  }

  async fundFromSeed(input: { readonly seedPrivateKeyHex: string; readonly targetAddress: string; readonly satoshis: number; readonly operationId: string }): Promise<BroadcastResult> {
    const operationId = assertOperationId(input.operationId);
    const targetAddress = assertTestnetP2pkhAddress(input.targetAddress);
    const keyBytes = hexToBytes(input.seedPrivateKeyHex);
    try {
      const sourcePublicKeyHex = bytesToHex(secp256k1.getPublicKey(keyBytes, true));
      const sourceAddress = deriveTestnetP2pkhAddress(sourcePublicKeyHex);
      const existing = await this.#existingOperation(operationId);
      if (existing) return this.#reconcileKnown(existing);
      const utxos = await this.#spendableUtxos(sourceAddress);
      const allocation = this.#allocate(utxos, input.satoshis, TESTNET_FEE_RESERVE);
      const signed = await this.#signTransfer({ allocation, sourceAddress, targetAddress, privateKey: keyBytes, publicKeyHex: sourcePublicKeyHex });
      const txid = calcTxidFromRawTxHex(signed.rawTxHex);
      await this.#remember({ version: 1, operationId, txid, network: "test", sourceAddress, targetAddress, kind: "fund", satoshis: input.satoshis, outputSatoshis: input.satoshis, feeSatoshis: signed.feeSatoshis, createdAt: new Date().toISOString() });
      return await this.#broadcastOrUnknown(signed.rawTxHex, txid, operationId, { outputSatoshis: input.satoshis, feeSatoshis: signed.feeSatoshis });
    } finally {
      keyBytes.fill(0);
    }
  }

  async reconcile(operationId: string): Promise<{ readonly status: "broadcast" | "not-found" | "uncertain"; readonly txid?: string }> {
    const entry = await this.#existingOperation(assertOperationId(operationId));
    if (!entry) throw new Error("testnet operation is not present in the recovery journal");
    const observed = await this.observeTransaction(entry.txid);
    if (observed === "not-found") return { status: "not-found" };
    return { status: "broadcast", txid: entry.txid };
  }

  async returnFunds(input: { readonly walletPrivateKeyHex: string; readonly targetAddress: string; readonly operationId: string }): Promise<BroadcastResult> {
    const operationId = assertOperationId(input.operationId);
    const targetAddress = assertTestnetP2pkhAddress(input.targetAddress);
    const keyBytes = hexToBytes(input.walletPrivateKeyHex);
    try {
      const sourcePublicKeyHex = bytesToHex(secp256k1.getPublicKey(keyBytes, true));
      const sourceAddress = deriveTestnetP2pkhAddress(sourcePublicKeyHex);
      const existing = await this.#existingOperation(operationId);
      if (existing) return this.#reconcileKnown(existing);
      const utxos = await this.#spendableUtxos(sourceAddress);
      const total = utxos.reduce((sum, item) => sum + item.value, 0);
      if (total <= TESTNET_FEE_RESERVE) throw new Error("testnet wallet has no safe balance to return");
      const allocation: UtxoAllocation = {
        requestedSatoshis: total - TESTNET_FEE_RESERVE,
        feeReserveSatoshis: TESTNET_FEE_RESERVE,
        selected: utxos,
        totalInputSatoshis: total,
        changeSatoshis: 0,
      };
      const signed = await this.#signTransfer({ allocation, sourceAddress, targetAddress, privateKey: keyBytes, publicKeyHex: sourcePublicKeyHex });
      const txid = calcTxidFromRawTxHex(signed.rawTxHex);
      await this.#remember({ version: 1, operationId, txid, network: "test", sourceAddress, targetAddress, kind: "return", satoshis: allocation.requestedSatoshis, outputSatoshis: allocation.requestedSatoshis, feeSatoshis: signed.feeSatoshis, createdAt: new Date().toISOString() });
      return await this.#broadcastOrUnknown(signed.rawTxHex, txid, operationId, { outputSatoshis: allocation.requestedSatoshis, feeSatoshis: signed.feeSatoshis });
    } finally {
      keyBytes.fill(0);
    }
  }

  async observeTransaction(txid: string): Promise<ObservedTransaction> {
    const normalized = assertTxid(txid, "transaction");
    try {
      await this.#getJson("test", `/tx/hash/${encodeURIComponent(normalized)}`);
      return "confirmed";
    } catch (error) {
      if (!this.#isNotFound(error)) throw error;
    }
    try {
      await this.#getJson("test", `/tx/hash/${encodeURIComponent(normalized)}/propagation`);
      return "unconfirmed";
    } catch (error) {
      if (this.#isNotFound(error)) return "not-found";
      throw error;
    }
  }

  async waitForTransaction(txid: string, options: { readonly timeoutMs?: number; readonly pollMs?: number } = {}): Promise<Exclude<ObservedTransaction, "not-found">> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    let last: ObservedTransaction = "not-found";
    while (Date.now() < deadline) {
      last = await this.observeTransaction(txid);
      if (last !== "not-found") return last;
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
    }
    throw new Error(`testnet transaction was not observed before timeout (${last})`);
  }

  /**
   * 生产 P2PKH confirmed-sync 只会把已进块交易写入 owned projection，
   * 所以一次性钱包在交给浏览器前必须等充值交易成为 confirmed；仅看到
   * mempool propagation 不能证明页面已有可选的 testnet UTXO。
   */
  async waitForConfirmedTransaction(txid: string, options: { readonly timeoutMs?: number; readonly pollMs?: number } = {}): Promise<void> {
    const normalized = assertTxid(txid, "transaction");
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    let last: ObservedTransaction = "not-found";
    while (Date.now() < deadline) {
      last = await this.observeTransaction(normalized);
      if (last === "confirmed") return;
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
    }
    throw new Error(`testnet transaction was not confirmed before timeout (${last})`);
  }

  async waitForSpendable(address: string, options: { readonly timeoutMs?: number; readonly pollMs?: number } = {}): Promise<number> {
    const normalized = assertTestnetP2pkhAddress(address);
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const utxos = await this.#spendableUtxos(normalized);
      const total = utxos.reduce((sum, item) => sum + item.value, 0);
      if (total > 0) return total;
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
    }
    throw new Error("testnet wallet did not become spendable before timeout");
  }

  /**
   * 等待一次性钱包的上一笔充值输出确实被消费，并出现可归集的找零。
   * 只等待“地址仍有余额”不够：在 mempool 状态尚未同步的短窗口内，
   * 旧充值 UTXO 可能仍被误认为可花费，归集就会和用户刚发出的交易竞争。
   */
  async waitForSpendableChange(
    address: string,
    spentFundingTxid: string,
    options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
  ): Promise<number> {
    const normalized = assertTestnetP2pkhAddress(address);
    const spentTxid = assertTxid(spentFundingTxid, "funding transaction");
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const utxos = await this.#spendableUtxos(normalized);
      const total = utxos.reduce((sum, item) => sum + item.value, 0);
      if (total > 0 && !utxos.some((item) => item.txid === spentTxid)) return total;
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
    }
    throw new Error("testnet wallet change did not become safely spendable");
  }

  async #broadcastOrUnknown(rawTxHex: string, txid: string, operationId: string, accounting: { readonly outputSatoshis: number; readonly feeSatoshis: number }): Promise<BroadcastResult> {
    try {
      const response = await this.#postJson("test", "/tx/raw", { txhex: rawTxHex });
      if (!response.ok) throw new Error(`testnet broadcast HTTP ${response.status}`);
      // WOC normally returns the txid as a JSON string. The local canonical
      // txid remains authoritative; a mismatching provider receipt is an
      // integrity failure, never a reason to invent a second txid.
      const body = await response.text();
      if (body.trim()) {
        let providerTxid: unknown = body.trim();
        try { providerTxid = JSON.parse(body) as unknown; } catch { /* bare text */ }
        if (typeof providerTxid === "object" && providerTxid !== null) providerTxid = (providerTxid as { txid?: unknown }).txid;
        if (providerTxid !== undefined && providerTxid !== "" && assertTxid(providerTxid, "broadcast receipt") !== txid) throw new Error("testnet broadcast receipt txid mismatch");
      }
      return { status: "broadcast", txid, ...accounting };
    } catch {
      // The operation journal was written before the request. The caller must
      // reconcile this txid; no retry is performed here.
      return { status: "uncertain", operationId };
    }
  }

  async #signTransfer(input: { readonly allocation: UtxoAllocation; readonly sourceAddress: string; readonly targetAddress: string; readonly privateKey: Uint8Array; readonly publicKeyHex: string }): Promise<{ readonly rawTxHex: string; readonly feeSatoshis: number }> {
    const unsigned = buildP2pkhTx({ allocation: input.allocation, recipientAddress: input.targetAddress, changeAddress: input.sourceAddress });
    const raw = await signP2pkhTx(unsigned, input.allocation.selected, async (digest) => {
      const signature = await signAsync(digest, input.privateKey, { lowS: true });
      return encodeDerSignature(signature.r, signature.s);
    }, input.publicKeyHex);
    const size = rawTxHexByteLength(raw);
    const minimumFee = Math.max(1, Math.ceil(size * DEFAULT_FEE_RATE_SATOSHIS_PER_KB / 1_000));
    const actualFee = input.allocation.totalInputSatoshis - unsigned.outputs.reduce((sum, output) => sum + output.value, 0);
    if (actualFee < minimumFee) throw new Error("testnet transaction fee is below the current minimum");
    return { rawTxHex: raw, feeSatoshis: actualFee };
  }

  #allocate(utxos: P2pkhUtxo[], amount: number, feeReserve: number): UtxoAllocation {
    const result = allocateUtxos(utxos, { amountSatoshis: assertSatoshis(amount, "funding amount"), feeReserveSatoshis: feeReserve, strategy: "largest-first", assetId: "bsvtest" });
    if (!result.ok) throw new Error(`testnet funding cannot select inputs (${result.error.reason})`);
    // A tiny change output would be dust. Treat it as extra fee while keeping
    // the transaction valid, instead of sending a dust output to the seed.
    if (result.allocation.changeSatoshis > 0 && result.allocation.changeSatoshis < 546) {
      return { ...result.allocation, feeReserveSatoshis: result.allocation.feeReserveSatoshis + result.allocation.changeSatoshis, changeSatoshis: 0 };
    }
    return result.allocation;
  }

  async #spendableUtxos(address: string): Promise<P2pkhUtxo[]> {
    const [confirmed, unconfirmed] = await Promise.all([
      this.#listUtxos("test", address, "confirmed"),
      this.#listUtxos("test", address, "unconfirmed"),
    ]);
    const byOutpoint = new Map<string, P2pkhUtxo>();
    for (const item of [...confirmed, ...unconfirmed]) {
      if (!item.isSpentInMempoolTx) byOutpoint.set(`${item.txid}:${item.vout}`, item);
    }
    return [...byOutpoint.values()];
  }

  async #balance(network: "test" | "main", address: string, kind: "confirmed" | "unconfirmed"): Promise<number> {
    const value = await this.#getJson(network, `/address/${encodeURIComponent(address)}/${kind}/balance`);
    if (!value || typeof value !== "object") throw new Error(`testnet ${network} ${kind} balance is invalid`);
    return assertSatoshis((value as { confirmed?: unknown; unconfirmed?: unknown })[kind], `${network} ${kind} balance`, true, kind === "unconfirmed");
  }

  async #listUtxos(network: "test" | "main", address: string, kind: "confirmed" | "unconfirmed"): Promise<P2pkhUtxo[]> {
    try {
      const value = await this.#getJson(network, `/address/${encodeURIComponent(address)}/${kind}/unspent`);
      if (!value || typeof value !== "object" || !Array.isArray((value as { result?: unknown }).result)) throw new Error(`testnet ${network} ${kind} UTXO response is invalid`);
      return (value as { result: WocUtxoRow[] }).result.map((row) => {
        const txid = assertTxid(row.tx_hash, "UTXO txid");
        const vout = assertSatoshis(row.tx_pos, "UTXO index", true);
        const item = {
          id: `e2e:test:${txid}:${vout}`,
          resourceId: "e2e:testnet",
          publicKeyHex: "",
          network: TESTNET_NETWORK,
          address,
          txid,
          vout,
          value: assertSatoshis(row.value, "UTXO value"),
          ...(Number.isSafeInteger(row.height) && Number(row.height) >= 0 ? { height: Number(row.height) } : {}),
          ...(typeof row.script === "string" ? { script: row.script } : {}),
          status: kind === "confirmed" ? "confirmed" as const : "unconfirmed" as const,
          isSpentInMempoolTx: row.isSpentInMempoolTx === true,
          syncedAt: new Date().toISOString(),
        } satisfies P2pkhUtxo;
        return item;
      });
    } catch (error) {
      if (this.#isNotFound(error)) return [];
      throw error;
    }
  }

  #mainnetAddressForTestnetAddress(address: string): string {
    // The same HASH160 with version 0x00 is the corresponding mainnet P2PKH
    // address. This is only a safety observation; it is never used for spend.
    const bytes = decodeBase58Check(address);
    const payload = new Uint8Array([0x00, ...bytes.slice(1, 21)]);
    const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
    return encodeBase58(new Uint8Array([...payload, ...checksum]));
  }

  async #existingOperation(operationId: string): Promise<OperationJournalEntry | undefined> {
    await this.#loadJournal();
    return this.#journal.get(operationId);
  }

  async #reconcileKnown(entry: OperationJournalEntry): Promise<BroadcastResult> {
    const observed = await this.observeTransaction(entry.txid);
    if (observed === "not-found" || entry.outputSatoshis === undefined || entry.feeSatoshis === undefined) {
      return { status: "uncertain", operationId: entry.operationId };
    }
    return { status: "broadcast", txid: entry.txid, outputSatoshis: entry.outputSatoshis, feeSatoshis: entry.feeSatoshis };
  }

  async #loadJournal(): Promise<void> {
    if (this.#journalLoaded) return;
    this.#journalLoaded = true;
    if (!this.#operationJournalPath) return;
    try {
      const value: unknown = JSON.parse(await readFile(this.#operationJournalPath, "utf8"));
      if (!Array.isArray(value)) throw new Error("journal is not an array");
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as { operationId?: unknown }).operationId === "string") this.#journal.set((item as OperationJournalEntry).operationId, item as OperationJournalEntry);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return;
      throw new Error("testnet operation journal is unreadable");
    }
  }

  async #remember(entry: OperationJournalEntry): Promise<void> {
    await this.#loadJournal();
    const existing = this.#journal.get(entry.operationId);
    if (existing && existing.txid !== entry.txid) throw new Error("testnet operation id was reused for a different transaction");
    if (existing) return;
    this.#journal.set(entry.operationId, entry);
    if (!this.#operationJournalPath) return;
    const file = this.#operationJournalPath;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.#journal.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  }

  async #getJson(network: "test" | "main", endpoint: string): Promise<unknown> {
    const response = await this.#request(network, endpoint, { method: "GET" });
    const text = await response.text();
    if (!response.ok) throw new Error(`testnet API HTTP ${response.status}`);
    try { return JSON.parse(text) as unknown; } catch { throw new Error("testnet API returned invalid JSON"); }
  }

  async #postJson(network: "test" | "main", endpoint: string, body: unknown): Promise<Response> {
    return this.#request(network, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async #request(network: "test" | "main", endpoint: string, init: RequestInit): Promise<Response> {
    // WOC 免费端点有请求频率限制。Promise.all 在调用方同时启动多个
    // 请求时会让“上次请求时间”竞争，实际仍可能同一时刻发出多请求；用
    // 链式 gate 串行安排请求开始时间，避免真实资源测试偶发 429。
    const previous = this.#requestGate;
    let release!: () => void;
    this.#requestGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const elapsed = Date.now() - this.#lastRequestAt;
    if (elapsed < 350) await new Promise<void>((resolve) => setTimeout(resolve, 350 - elapsed));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("testnet API timeout")), DEFAULT_TIMEOUT_MS);
    this.#lastRequestAt = Date.now();
    try {
      return await fetch(`${this.#baseUrl}/${network}${endpoint}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new Error("testnet API request failed");
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  #isNotFound(error: unknown): boolean {
    return error instanceof Error && /HTTP 404/iu.test(error.message);
  }
}

export function createWocTestnetChainAdapter(options: { readonly baseUrl: string; readonly authorization?: string; readonly operationJournalPath?: string }): WocTestnetChainAdapter {
  return new WocTestnetChainAdapter(options);
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${bytesToHex(bytes)}`);
  let output = "";
  while (number > 0n) {
    const digit = Number(number % 58n);
    output = alphabet[digit] + output;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || "1";
}
