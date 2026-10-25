import {publisherPaymentOwner, publisherPaymentChannelId} from "./app-payment-channel.js";
import { ProtocolExecutionJournal, type ProtocolExecutionIdentity } from "./protocol-execution-journal.js";
import {signatureFailure,signatureOwner,type SignatureRecorder,type SignatureTicket} from "./signature-history.js";
import {
  inspectConnectEnvelope,
  connectCompactSignature,
  inspectBitfsWire,
  unhex,
  type Value,
  type SigningChannel,
  type SigningMode,
  automaticSigningOperation,
  signingOperations,
  commitment,
  inspectP2pkh,
  inspectFeePool,
  inspectBitfsAuthorization,
  inspectBitfsOpening,
  inspectStandard,
  parseTransaction,
  serializeTransaction,
  p2pkhSighash,
  p2pkhOutputAddress,
  p2pkhScript,
  type PolicyStore,
} from "@vaultlink/sdk";
import {
  SoftwarePaymentGate,
  type ChannelConfig,
  type PaymentInspection,
  type Quote,
} from "./payment.js";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { P2pkhConnectPaymentPreview } from "@keymaster/contracts";
import {
  parseStoredPaymentPolicy,
  serializeStoredPaymentPolicy,
} from "./policy-storage.js";
export interface PaymentFileStore {
  get(
    path: string,
  ): Promise<{ bytes: Uint8Array; revision: string } | undefined>;
  put(
    path: string,
    bytes: Uint8Array,
    condition: { ifRevision?: string; ifNoneMatch?: true },
  ): Promise<{ revision: string }>;
}
export interface PaymentChannelDTO {
  id: string;
  owner: string;
  kind: "plugin" | "app";
  network: string;
  paymentType: string;
  singleLimit: string;
  defaultSessionLimit: string;
  enabled: boolean;
  revision: number;
}
export type WalletPaymentCommand =
  | {action:"signature-history"}
  | { action: "signing-list" }
  | {
      action: "signing-configure";
      id: string;
      mode: SigningMode;
      revision: number;
    }
  | { action: "backend" }
  | { action: "list" | "pending" | "spend-notices" }
  | { action: "notice-dismiss"; id: string }
  | { action: "connect-payment-recovery" }
  | { action: "connect-payment-recovery-ack"; paymentIds: string[] }
  | { action: "connect-payment-signed-recovery" }
  | { action: "protocol-payment-recovery" }
  | { action: "protocol-payment-status"; executionId: string }
  | { action: "protocol-payment-ack"; executionIds: string[] }
  | { action: "protocol-payment-prepare"; paymentId: string; rawTxHex: string; prevTransactionHexes: string[]; protocolExecution: ProtocolExecutionIdentity }
  | {
      action: "register";
      id: string;
      owner: string;
      kind: "plugin" | "app";
      network: string;
      paymentType: string;
    }
  | { action: "configure"; channel: PaymentChannelDTO }
  | { action: "session-open"; id: string; owner: string }
  | { action: "session-close" | "session-cancel"; id: string }
  | { action: "answer"; id: string; allow: boolean; raiseSessionLimit?: string }
  | {
      action: "sign-p2pkh" | "sign-standard";
      rawTxHex: string;
      prevTransactionHexes: string[];
      channelId: string;
      paymentId: string;
      sessionId: string | null;
      connectPaymentReview?: P2pkhConnectPaymentPreview;
      protocolExecution?: ProtocolExecutionIdentity;
    }
  | {
      action: "sign-feepool";
      protocolExecution?: ProtocolExecutionIdentity;
      authorization?: { documentHex: string; refundTemplateHex: string };
      openingRequestHex?: string;
      family: "connect" | "bitfs";
      role?: "payer" | "cosigner";
      stage: "fund" | "state";
      rawTxHex: string;
      prevTransactionHexes: string[];
      channelId: string;
      paymentId: string;
      sessionId: string | null;
    };
export function buildSignedP2pkhExact(raw: Uint8Array, tx: ReturnType<typeof parseTransaction>, signatures: string[], publicKey: Uint8Array): string {
  if (signatures.length !== tx.inputs.length) throw Error("invalid-signature-count");
  const signed = {
    ...tx,
    inputs: tx.inputs.map((input, index) => {
      const signature = unhex(signatures[index]!);
      const script = new Uint8Array(1 + signature.length + 1 + publicKey.length);
      script[0] = signature.length;
      script.set(signature, 1);
      script[1 + signature.length] = publicKey.length;
      script.set(publicKey, 2 + signature.length);
      return { ...input, script };
    }),
  };
  return hex(serializeTransaction(signed));
}

function dsha256(bytesValue: Uint8Array): Uint8Array {
  return sha256(sha256(bytesValue));
}

/** Recovered disk material is not a signing authority. Verify every input and
 * bind the exact bytes to the original unsigned template before handing off. */
export async function verifyRecoveredP2pkhExact(unsignedTxHex: string, previousHexes: string[], signedTxHex: string, publicKeyHex: string): Promise<string[]> {
  const unsigned = unhex(unsignedTxHex), tx = parseTransaction(unsigned);
  const exact = parseTransaction(unhex(signedTxHex)), pub = unhex(publicKeyHex), own = p2pkhScript(pub);
  if (!tx.inputs.length || tx.inputs.length > 16 || previousHexes.length !== tx.inputs.length || exact.inputs.length !== tx.inputs.length || tx.inputs.some(input => input.script.length !== 0)) throw Error('invalid-recovered-exact');
  const signatures = exact.inputs.map(input => {
    const script = input.script, size = script[0] ?? 0;
    if (size < 9 || size > 73 || script.length !== size + pub.length + 2 || script[size + 1] !== pub.length || hex(script.slice(size + 2)) !== hex(pub)) throw Error('invalid-recovered-signature');
    const signature = script.slice(1, size + 1);
    if (signature.at(-1) !== 0x41) throw Error('invalid-recovered-signature');
    return hex(signature);
  });
  if (buildSignedP2pkhExact(unsigned, tx, signatures, pub) !== signedTxHex.toLowerCase()) throw Error('invalid-recovered-exact');
  for (let index = 0; index < tx.inputs.length; index++) {
    const input = tx.inputs[index]!, previous = unhex(previousHexes[index]!), prior = parseTransaction(previous), output = prior.outputs[input.vout];
    if (hex(dsha256(previous)) !== hex(input.txid) || !output || hex(output.script) !== hex(own)) throw Error('invalid-recovered-prevout');
    const signature = unhex(signatures[index]!).slice(0, -1);
    if (!secp256k1.verify(signature, await p2pkhSighash(tx, index, output), pub, { prehash: false, lowS: true, format: 'der' })) throw Error('invalid-recovered-signature');
  }
  return signatures;
}

function isP2pkhScript(script: Uint8Array): boolean {
  return script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14
    && script[23] === 0x88 && script[24] === 0xac;
}

function isP2pkScript(script: Uint8Array): boolean {
  if (script.length !== 35 || script[0] !== 0x21 || script[34] !== 0xac
    || (script[1] !== 0x02 && script[1] !== 0x03)) return false;
  try {
    secp256k1.Point.fromHex(hex(script.slice(1, 34)));
    return true;
  } catch {
    return false;
  }
}

function publisherMatchesScript(script: Uint8Array, publisher: Uint8Array): boolean {
  if (isP2pkhScript(script)) {
    const own = p2pkhScript(publisher);
    return script.length === own.length && script.every((byte, index) => byte === own[index]);
  }
  if (isP2pkScript(script)) {
    return script.length === 35 && publisher.length === 33 && script.slice(1, 34).every((byte, index) => byte === publisher[index]);
  }
  return false;
}

interface ConnectPaymentReviewResult {
  /** Actual wallet spend, including fee, minus ALL own P2PKH outputs. */
  amount: bigint;
  businessAmount: bigint;
  ownReturn: bigint;
  ownOutputs: Array<{ vout: number; valueSats: string; scriptHex: string }>;
  change: bigint;
  fee: bigint;
  digests: Uint8Array[];
  ownership: "app-publisher" | "third-party";
  forceConfirm: boolean;
  businessKind: string;
  appId: string;
  appName: string;
  origin: string;
  publisherPublicKeyHex: string;
  paymentType: "p2pkh" | "p2pk";
  recipientLabel: string;
}

/** Vault-side independent recheck of the frozen Connect payment role map. */
export async function inspectConnectPayment(
  raw: Uint8Array,
  previous: Uint8Array[],
  publicKey: Uint8Array,
  review: P2pkhConnectPaymentPreview,
): Promise<ConnectPaymentReviewResult> {
  const tx = parseTransaction(raw, 640);
  if (tx.inputs.length === 0 || tx.inputs.length > 16 || previous.length !== tx.inputs.length || tx.outputs.length !== review.outputs.length) {
    throw Error("invalid-connect-payment-template");
  }
  const own = p2pkhScript(publicKey);
  const seen = new Set<string>();
  let inputTotal = 0n;
  const digests: Uint8Array[] = [];
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const input = tx.inputs[index]!;
    if (input.script.length !== 0) throw Error("already-signed");
    const priorRaw = previous[index];
    if (!priorRaw) throw Error("missing-prevout");
    const prior = parseTransaction(priorRaw, 640);
    if (input.vout >= prior.outputs.length) throw Error("invalid-prevout");
    const priorTxid = dsha256(priorRaw);
    if (priorTxid.length !== input.txid.length || !priorTxid.every((byte, i) => byte === input.txid[i])) throw Error("invalid-prevout");
    const ref = Array.from(input.txid).join(",") + ":" + input.vout;
    if (seen.has(ref)) throw Error("duplicate-input");
    seen.add(ref);
    const prevout = prior.outputs[input.vout]!;
    if (!isP2pkhScript(prevout.script) || !prevout.script.every((byte, i) => byte === own[i])) throw Error("wrong-key");
    inputTotal += prevout.satoshis;
    if (inputTotal > 0xffffffffffffffffn) throw Error("invalid-amount");
    digests.push(await p2pkhSighash(tx, index, prevout));
  }
  const expectedByVout = new Map(review.outputs.map((row) => [row.vout, row]));
  if (expectedByVout.size !== review.outputs.length) throw Error("invalid-connect-payment-template");
  let business = 0n;
  let change = 0n;
  let outputTotal = 0n;
  let ownReturn = 0n;
  const ownOutputs: ConnectPaymentReviewResult["ownOutputs"] = [];
  for (let vout = 0; vout < tx.outputs.length; vout += 1) {
    const actual = tx.outputs[vout]!;
    const expected = expectedByVout.get(vout);
    if (!expected) throw Error("invalid-connect-payment-template");
    const actualHex = hex(actual.script);
    if (actualHex !== expected.scriptHex || actual.satoshis !== money(expected.valueSats)) {
      throw Error("invalid-connect-payment-template");
    }
    outputTotal += actual.satoshis;
    if (outputTotal > 0xffffffffffffffffn) throw Error("invalid-amount");
    // Ownership is derived from the current public key, never from the App's role label.
    if (isP2pkhScript(actual.script) && actual.script.every((byte, i) => byte === own[i])) {
      ownReturn += actual.satoshis;
      ownOutputs.push({ vout, valueSats: String(actual.satoshis), scriptHex: actualHex });
    }
    if (expected.role === "business") {
      if (!isP2pkhScript(actual.script) && !isP2pkScript(actual.script)) throw Error("invalid-connect-payment-template");
      business += actual.satoshis;
    } else if (expected.role === "change") {
      if (!isP2pkhScript(actual.script) || !actual.script.every((byte, i) => byte === own[i])) throw Error("invalid-connect-payment-template");
      change += actual.satoshis;
    } else throw Error("invalid-connect-payment-template");
  }
  const fee = inputTotal - outputTotal;
  if (fee < 0n || fee !== money(review.feeSats)) throw Error("invalid-connect-payment-template");
  if (business !== money(review.businessAmountSats) || change !== money(review.changeAmountSats)) {
    throw Error("invalid-connect-payment-template");
  }
  const changeRows = review.outputs.filter((row) => row.role === "change");
  if (changeRows.length > 1 || (changeRows.length === 1 && (review.changeScriptHex === null || changeRows[0]!.scriptHex !== review.changeScriptHex))) {
    throw Error("invalid-connect-payment-template");
  }
  const businessRows = review.outputs.filter((row) => row.role === "business");
  if (businessRows.length !== 1 || businessRows[0]!.scriptHex !== review.businessScriptHex) throw Error("invalid-connect-payment-template");
  const businessKind = isP2pkhScript(unhex(review.businessScriptHex)) ? "p2pkh" : isP2pkScript(unhex(review.businessScriptHex)) ? "p2pk" : null;
  if (businessKind !== review.paymentType) throw Error("invalid-connect-payment-template");
  const publisher = unhex(review.publisherPublicKeyHex);
  try { secp256k1.Point.fromHex(review.publisherPublicKeyHex); } catch { throw Error("invalid-connect-payment-template"); }
  const ownership = publisherMatchesScript(unhex(review.businessScriptHex), publisher) ? "app-publisher" : "third-party";
  if (ownership !== review.recipientOwnership) throw Error("invalid-connect-payment-template");
  return {
    amount: inputTotal - ownReturn,
    businessAmount: business,
    ownReturn,
    ownOutputs,
    change,
    fee,
    digests,
    ownership,
    // Ownership affects the displayed warning, not the single allowance.
    forceConfirm: false,
    businessKind: review.businessKind,
    appId: review.appId,
    appName: review.appName,
    origin: review.origin,
    publisherPublicKeyHex: review.publisherPublicKeyHex,
    paymentType: review.paymentType,
    recipientLabel: review.recipientLabel,
  };
}

function money(s: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(s)) throw Error("invalid-amount");
  const n = BigInt(s);
  if (n > 0xffffffffffffffffn) throw Error("invalid-amount");
  return n;
}
function bytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw Error("invalid-hex");
  return Uint8Array.from(hex.match(/../g)!, (x) => Number.parseInt(x, 16));
}
function hex(b: Uint8Array) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function dto(c: ChannelConfig): PaymentChannelDTO {
  return {
    ...c,
    singleLimit: String(c.singleLimit),
    defaultSessionLimit: String(c.defaultSessionLimit),
  };
}
type ConnectExecutionState = "authorized" | "signing_started" | "signed_partial" | "signed_complete" | "cancelled_before_sign" | "signed" | "unknown";
interface ConnectExecutionRecord {
  paymentId: string;
  planDigest: string;
  sessionId: string | null;
  state: ConnectExecutionState;
  acknowledged?: boolean;
  unsignedTxHex?: string;
  prevTransactionHexes?: string[];
  signatures?: string[];
  signedTxHex?: string;
  version: number;
  updatedAt: number;
}
interface ConnectExecutionProof {
  paymentId: string;
  planDigest: string;
  version: number;
  state: "cancelled_before_sign";
}

/** 仅 Coordinator 的唯一钱包实例拥有此对象；读写使用绑定钱包世代的真实文件句柄。 */
export class WalletPayments {
  private sessionRequests = new Map<string, { revoked: boolean }>();
  private pending = new Map<
    string,
    {
      view: Record<string, unknown>;
      resolve: (answer: { allow: boolean; raiseSessionLimit?: bigint }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private spendNotices = new Map<string, Record<string, unknown>>();
  private signatureRecorder?:SignatureRecorder;
  setSignatureRecorder(recorder:SignatureRecorder){this.signatureRecorder=recorder;}
  private journalTail: Promise<unknown> = Promise.resolve();
  private protocolJournal?: ProtocolExecutionJournal;
  private protocolExecutions() { return this.protocolJournal ??= new ProtocolExecutionJournal(this.files, this.publicKeyHex, this.network); }
  private constructor(
    private gate: SoftwarePaymentGate,
    private publicKeyHex: string,
    private assertActive: () => void,
    private signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
    private network: "main" | "test",
    private files: PaymentFileStore,
  ) {}
  static async open(
    files: PaymentFileStore,
    publicKeyHex: string,
    assertActive: () => void,
    signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
    network: "main" | "test",
  ): Promise<WalletPayments> {
    if (network !== "main" && network !== "test")
      throw Error("network-identity-required");
    let revision: string | undefined;
    const store: PolicyStore = {
      async load() {
        assertActive();
        const file = await files.get("payments.json");
        assertActive();
        if (!file) return null;
        revision = file.revision;
        // 保留整数精度及承诺字节；损坏文件必须报错，不能当成初始空账本。
        const snapshot = parseStoredPaymentPolicy(file.bytes, publicKeyHex);
        if (
          (snapshot.network !== undefined && snapshot.network !== network) ||
          snapshot.channels.some((channel) => channel.network !== network)
        )
          throw Error("network-identity-mismatch");
        return snapshot;
      },
      async save(snapshot) {
        assertActive();
        const result = await files.put(
          "payments.json",
          serializeStoredPaymentPolicy(snapshot, publicKeyHex),
          revision === undefined
            ? { ifNoneMatch: true }
            : { ifRevision: revision },
        );
        assertActive();
        revision = result.revision;
      },
    };
    return new WalletPayments(
      await SoftwarePaymentGate.open(store, publicKeyHex, assertActive),
      publicKeyHex,
      assertActive,
      signDigest,
      network,
      files,
    );
  }
  close() {
    this.gate.lock();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ allow: false });
    }
    this.pending.clear();
    this.spendNotices.clear();
    for (const token of this.sessionRequests.values()) token.revoked = true;
    this.sessionRequests.clear();
  }
  /** 软件与硬件使用相同语义渠道；完整正文先由 VLP 重建摘要，不能降为通用摘要渠道。 */
  async signConnectEnvelope(
    kind: "identity" | "intent",
    envelope: Uint8Array,
    content: Uint8Array | undefined,
    appSessionId: string,
  ): Promise<Uint8Array> {
    const body: Value =
      kind === "identity"
        ? { envelope: envelope.slice() }
        : {
            envelope: envelope.slice(),
            content: content?.slice() ?? new Uint8Array(),
          };
    const own = unhex(this.publicKeyHex),
      review = await inspectConnectEnvelope(kind, body, own, this.network);
    let token = this.sessionRequests.get(appSessionId);
    if (!token) {
      if (this.sessionRequests.size >= 16) throw Error("capacity");
      token = { revoked: false };
      this.sessionRequests.set(appSessionId, token);
    }
    const guard = () => {
      this.assertActive();
      if (token.revoked) throw Error("payment-cancelled");
    };
    guard();
    const signature = await this.authorizeSignature(
      `connect.${kind}-sign`,
      () => {
        guard();
        return this.signDigest(review.digest);
      },
      undefined,
      {
        audience: review.audience,
        requestId: review.requestId,
        bsvNetwork: review.bsvNetwork,
        appSessionId,
      },
    );
    guard();
    return connectCompactSignature(signature, review.digest, own);
  }
  async signBitfsWire(
    kind: number,
    document: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (kind === 5) throw Error("payment-context-required"); // 涉金额授权必须由费用池支付核心处理。
    const review = await inspectBitfsWire(
      { kind, document: document.slice() },
      unhex(this.publicKeyHex),
    );
    return this.authorizeSignature(
      "bitfs.wire-sign",
      () => this.signDigest(review.digest),
      signal,
      Object.fromEntries(review.facts.map((f) => [f.name, f.value])),
    );
  }
  private async signatureConsent(
    channel: SigningChannel,
    purpose: "registration" | "signature",
    facts: Record<string, string>,
    signal?: AbortSignal,
    historyId?: string,
  ): Promise<boolean> {
    this.assertActive();
    if (signal?.aborted) throw Error("signature-cancelled");
    if (this.pending.size >= 16) throw Error("busy");
    const id = crypto.randomUUID();
    let abort = () => {};
    try {
      return await new Promise<boolean>((resolve) => {
        const done = (allow: boolean) => {
          this.pending.delete(id);
          resolve(allow);
        };
        const timer = setTimeout(() => done(false), 120000);
        abort = () => {
          clearTimeout(timer);
          done(false);
        };
        this.pending.set(id, {
          timer,
          resolve: (answer) => done(answer.allow),
          view: {
            id,
            channelId: channel.id,
            owner: channel.owner,
            kind: channel.kind,
            purpose,
            historyId,
            ...(facts.appSessionId ? { sessionId: facts.appSessionId } : {}),
            operation: channel.operation,
            mode: channel.mode,
            facts,
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
      });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  /** 支付签名仍走额度预占；其他签名在持久策略检查后才能进入密钥运算。 */
  async authorizeSignature<T>(
    operation: string,
    sign: () => Promise<T> | T,
    signal?: AbortSignal,
    facts: Record<string, string> = {},
  ): Promise<T> {
    this.assertActive();
    if (!signingOperations.includes(operation)) throw Error("unsupported-operation");
    if (signal?.aborted) throw Error("signature-cancelled");
    const ticket=await this.signatureRecorder?.({operation,channelId:operation,owner:signatureOwner(operation),backend:'software'});
    try {const result=await this.authorizeSignatureInner(operation,sign,signal,facts,ticket);await ticket?.update('completed');return result;}
    catch(error){await ticket?.update(signatureFailure(error));throw error;}
  }
  private async authorizeSignatureInner<T>(operation:string,sign:()=>Promise<T>|T,signal:AbortSignal|undefined,facts:Record<string,string>,ticket?:SignatureTicket):Promise<T>{
    const snapshot = await this.gate.snapshot();
    this.assertActive();
    let channel = snapshot.signing?.find((c) => c.id === operation);
    if (!channel) {
      channel = {
        id: operation,
        owner: operation.startsWith("identity.")
          ? "window-p2p"
          : operation.startsWith("channel.")
            ? "channel"
            : operation.startsWith("connect.")
              ? "connect"
              : operation.startsWith("bitfs.")
                ? "bitfs"
                : "vault",
        kind: "plugin",
        operation,
        mode: automaticSigningOperation(operation) ? "automatic" : "manual",
        revision: 1,
      };
      const registration = await this.signatureRecorder?.({operation: "signing.register", channelId: channel.id, owner: channel.owner, backend: "software"});
      const automatic = automaticSigningOperation(operation);
      await registration?.update("pending", automatic ? "automatic" : "manual");
      try {
        this.assertActive();
        if (signal?.aborted) throw Error("signature-cancelled");
        if (!automatic && !(await this.signatureConsent(channel, "registration", facts, signal, registration?.id))) throw Error("denied");
        [channel] = await this.gate.registerSigning([channel], this.network, !automatic);
        await registration?.update("completed");
      } catch (error) {
        await registration?.update(signatureFailure(error));
        throw error;
      }
    }
    if (!channel) throw Error("channel-required");
    const captured = await this.gate.signingChannel(
      channel.id,
      operation,
      this.network,
    );
    await ticket?.update('pending',captured.mode);
    if (
      captured.mode === "manual" &&
      !(await this.signatureConsent(captured, "signature", facts, signal, ticket?.id))
    )
      throw Error("denied");
    this.assertActive();
    if (signal?.aborted) throw Error("signature-cancelled");
    const current = await this.gate.signingChannel(
      channel.id,
      operation,
      this.network,
    );
    if (current.revision !== captured.revision)
      throw Error("permission-revoked");
    const result = await sign();
    this.assertActive();
    if (signal?.aborted) throw Error("signature-cancelled");
    return result;
  }
  private runJournal<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.journalTail.then(fn);
    this.journalTail = next.catch(() => undefined);
    return next;
  }

  private async readConnectJournal(): Promise<{ records: Record<string, ConnectExecutionRecord>; revision?: string }> {
    const file = await this.files.get("connect-payment-executions.json");
    if (!file) return { records: {} };
    try {
      const parsed = JSON.parse(new TextDecoder().decode(file.bytes)) as { version?: unknown; records?: unknown };
      if (parsed.version !== 1 || typeof parsed.records !== "object" || parsed.records === null || Array.isArray(parsed.records)) {
        throw Error("bad journal");
      }
      const entries = Object.entries(parsed.records);
      if (entries.length > 4096) throw Error('bad journal');
      for (const [id, value] of entries) {
        const row = value as ConnectExecutionRecord;
        if (!row || typeof row !== 'object' || Array.isArray(row) || row.paymentId !== id || typeof row.planDigest !== 'string' || !row.planDigest || !Number.isSafeInteger(row.version) || row.version < 1 || !(row.sessionId === null || typeof row.sessionId === 'string') || !['authorized', 'signing_started', 'signed_partial', 'signed_complete', 'cancelled_before_sign', 'signed', 'unknown'].includes(row.state) || (row.acknowledged !== undefined && typeof row.acknowledged !== 'boolean')) throw Error('bad journal');
        if (row.unsignedTxHex !== undefined) unhex(row.unsignedTxHex);
        if (row.prevTransactionHexes !== undefined) { if (!Array.isArray(row.prevTransactionHexes) || row.prevTransactionHexes.length > 16) throw Error('bad journal'); for (const previous of row.prevTransactionHexes) unhex(previous); }
        if (row.signatures !== undefined) { if (!Array.isArray(row.signatures) || row.signatures.length > 16) throw Error('bad journal'); for (const signature of row.signatures) unhex(signature); }
        if (row.signedTxHex !== undefined) unhex(row.signedTxHex);
        if ((row.state === 'authorized' || row.state === 'cancelled_before_sign') && (row.signatures !== undefined || row.signedTxHex !== undefined)) throw Error('bad journal');
      }
      return { records: parsed.records as Record<string, ConnectExecutionRecord>, revision: file.revision };
    } catch {
      throw Error("connect-payment-journal-corrupt");
    }
  }

  private async writeConnectJournal(records: Record<string, ConnectExecutionRecord>, revision?: string): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, records }));
    await this.files.put("connect-payment-executions.json", bytes, revision === undefined ? { ifNoneMatch: true } : { ifRevision: revision });
  }

  private notSignedError(proof: ConnectExecutionProof): Error {
    const error = new Error("payment-cancelled-before-sign");
    Object.assign(error, { connectPaymentNotSigned: proof });
    return error;
  }

  private async beginConnectExecution(review: P2pkhConnectPaymentPreview, sessionId: string | null, unsignedTxHex: string, prevTransactionHexes: string[]): Promise<void> {
    if (!review.planDigest) throw Error("connect-payment-plan-digest-required");
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const existing = records[review.paymentId];
      if (existing) {
        if (existing.planDigest !== review.planDigest) throw Error("connect-payment-plan-conflict");
        if (existing.state === "cancelled_before_sign") throw this.notSignedError({ paymentId: review.paymentId, planDigest: review.planDigest, version: existing.version, state: "cancelled_before_sign" });
        if (existing.state === "signing_started" || existing.state === "signed") throw Error("connect-payment-already-started");
        return;
      }
      records[review.paymentId] = {
        paymentId: review.paymentId, planDigest: review.planDigest, sessionId,
        unsignedTxHex, prevTransactionHexes: [...prevTransactionHexes],
        state: "authorized", version: 1, updatedAt: Date.now(),
      };
      await this.writeConnectJournal(records, revision);
    });
  }

  private async acknowledgeConnectRecovery(paymentIds: readonly string[]): Promise<void> {
    if (paymentIds.length === 0) return;
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      let changed = false;
      for (const paymentId of paymentIds) {
        const record = records[paymentId];
        if (!record || record.acknowledged) continue;
        if (record.state !== "cancelled_before_sign" && record.state !== "signed_complete" && record.state !== "signed") continue;
        record.acknowledged = true;
        record.updatedAt = Date.now();
        changed = true;
      }
      if (changed) await this.writeConnectJournal(records, revision);
    });
  }

  private async persistConnectSignedMaterial(paymentId: string, signatures: string[], signedTxHex?: string): Promise<void> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const record = records[paymentId];
      if (!record || record.state === "cancelled_before_sign") throw Error("connect-payment-cancelled");
      record.signatures = [...signatures];
      if (signedTxHex !== undefined) record.signedTxHex = signedTxHex;
      record.state = signedTxHex === undefined ? "signed_partial" : "signed_complete";
      record.version += 1;
      record.updatedAt = Date.now();
      await this.writeConnectJournal(records, revision);
    });
  }

  private async recoverSignedConnectExecutions(): Promise<Array<{ paymentId: string; planDigest: string; state: "signed_complete" | "quarantined"; signatures?: string[]; signedTxHex?: string; version: number }>> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      let changed = false;
      const recovered = [];
      for (const record of Object.values(records)) {
        if (record.state === 'authorized' || record.state === 'cancelled_before_sign') continue;
        // ACK does not erase the responsibility or make signed material vanish
        // when the manager store is later missing/corrupt.
        let exact = record.signedTxHex;
        // If the last exact write failed but every input signature is durable,
        // reconstruct the SAME exact from the persisted unsigned template.
        if (!exact && record.unsignedTxHex && record.signatures) {
          try {
            const tx = parseTransaction(unhex(record.unsignedTxHex));
            if (record.signatures.length === tx.inputs.length) {
              exact = buildSignedP2pkhExact(unhex(record.unsignedTxHex), tx, record.signatures, unhex(this.publicKeyHex));
            }
          } catch {
            // Incomplete/corrupt material stays quarantined; never re-sign.
          }
        }
        let valid = false;
        try {
          if (exact && record.unsignedTxHex && record.prevTransactionHexes) {
            const signatures = await verifyRecoveredP2pkhExact(record.unsignedTxHex, record.prevTransactionHexes, exact, this.publicKeyHex);
            valid = !record.signatures || JSON.stringify(record.signatures) === JSON.stringify(signatures);
          }
        } catch { /* retain corrupt/partial material and its original duty */ }
        if (!exact || !valid) {
          recovered.push({ paymentId: record.paymentId, planDigest: record.planDigest, version: record.version, state: 'quarantined' as const });
          continue;
        }
        if (!record.signedTxHex) {
          record.signedTxHex = exact; record.state = 'signed_complete'; record.version += 1; record.updatedAt = Date.now(); changed = true;
        }
        recovered.push({
          paymentId: record.paymentId, planDigest: record.planDigest, state: "signed_complete" as const,
          signatures: [...(record.signatures ?? [])], signedTxHex: exact, version: record.version,
        });
      }
      if (changed) await this.writeConnectJournal(records, revision);
      return recovered;
    });
  }

  private async markConnectSigningStarted(paymentId: string): Promise<void> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const record = records[paymentId];
      if (!record) throw Error("connect-payment-journal-missing");
      if (record.state === "cancelled_before_sign") throw this.notSignedError({ paymentId, planDigest: record.planDigest, version: record.version, state: "cancelled_before_sign" });
      if (record.state === "signing_started" || record.state === "signed") return;
      if (record.state !== "authorized") throw Error("connect-payment-journal-state");
      record.state = "signing_started";
      record.version += 1;
      record.updatedAt = Date.now();
      await this.writeConnectJournal(records, revision);
    });
  }

  private async cancelConnectExecution(paymentId: string): Promise<ConnectExecutionProof | null> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const record = records[paymentId];
      if (!record) return null;
      if (record.state === "cancelled_before_sign") {
        return record.acknowledged ? null : { paymentId, planDigest: record.planDigest, version: record.version, state: "cancelled_before_sign" };
      }
      if (record.state !== "authorized") return null;
      record.state = "cancelled_before_sign";
      record.acknowledged = false;
      record.version += 1;
      record.updatedAt = Date.now();
      await this.writeConnectJournal(records, revision);
      return { paymentId, planDigest: record.planDigest, version: record.version, state: "cancelled_before_sign" };
    });
  }

  private async cancelConnectExecutions(sessionId: string): Promise<void> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      let changed = false;
      for (const record of Object.values(records)) {
        if (record.sessionId !== sessionId || record.state !== "authorized") continue;
        record.state = "cancelled_before_sign";
        record.acknowledged = false;
        record.version += 1;
        record.updatedAt = Date.now();
        changed = true;
      }
      if (changed) await this.writeConnectJournal(records, revision);
    });
  }

  private async recoverAuthorizedConnectExecutions(): Promise<ConnectExecutionProof[]> {
    const candidates = await this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const proofs: ConnectExecutionProof[] = [];
      let changed = false;
      for (const record of Object.values(records)) {
        if (record.state === "authorized") {
          record.state = "cancelled_before_sign";
          record.acknowledged = false;
          record.version += 1;
          record.updatedAt = Date.now();
          changed = true;
        }
        if (record.state === "cancelled_before_sign" && !record.acknowledged) {
          proofs.push({ paymentId: record.paymentId, planDigest: record.planDigest, version: record.version, state: "cancelled_before_sign" });
        }
      }
      if (changed) await this.writeConnectJournal(records, revision);
      return proofs;
    });
    // Release policy BEFORE the manager, and only expose proofs whose policy
    // reservation is now safely released (or was already released). A policy
    // signed/partial state keeps the manager responsibility intact.
    const released: ConnectExecutionProof[] = [];
    for (const proof of candidates) {
      try {
        await this.gate.releaseUnknownProven(proof.paymentId);
        released.push(proof);
      } catch (error) {
        // No policy reservation exists yet (crash/denial before reserve):
        // there is no quota to refund, so the manager release proof is safe.
        // Any other policy state (signed/partial) keeps manager responsibility.
        if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "invalid-request") {
          released.push(proof);
        }
      }
    }
    return released;
  }

  private async finishConnectExecution(paymentId: string, state: "signed" | "unknown"): Promise<void> {
    return this.runJournal(async () => {
      const { records, revision } = await this.readConnectJournal();
      const record = records[paymentId];
      if (!record || record.state === "cancelled_before_sign") return;
      record.state = state === "signed" ? "signed_complete" : state;
      record.version += 1;
      record.updatedAt = Date.now();
      await this.writeConnectJournal(records, revision);
    });
  }

  private confirm(
    request: PaymentInspection,
    quote: Quote,
    recipients: string[],
    facts: {
      historyId?: string;
      fee: string;
      change: string;
      pool?: { family: string; stage: string; paid: string; locked: string };
    },
  ) {
    if (this.pending.size >= 16) throw Error("busy");
    const id = crypto.randomUUID();
    return new Promise<{ allow: boolean; raiseSessionLimit?: bigint }>(
      (resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ allow: false });
        }, 120000);
        this.pending.set(id, {
          resolve,
          timer,
          view: {
            id,
            channelId: request.channelId,
            sessionId: request.sessionId,
            owner: request.owner,
            wallet: this.publicKeyHex,
            network: request.network,
            paymentType: request.paymentType,
            kind: request.kind,
            amount: String(quote.amount),
            used: String(quote.used),
            singleLimit: String(quote.singleLimit),
            sessionLimit:
              quote.sessionLimit === null ? null : String(quote.sessionLimit),
            reasons: [...quote.reasons],
            recipients,
            ...facts,
          },
        });
      },
    );
  }
  private cancelRequests(sessionId: string) {
    const token = this.sessionRequests.get(sessionId);
    if (token) token.revoked = true;
    for (const [id, p] of this.pending) {
      if (p.view.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve({ allow: false });
    }
  }
  private mutations: Promise<unknown> = Promise.resolve();
  handle(command: WalletPaymentCommand): Promise<unknown> {
    // 配置和建会话按单钱包串行；业务签名等待批准不占据设置队列。
    const frozen = structuredClone(command);
    // 撤权立即生效，不等待配置队列或 snapshot 的异步完成。
    if (frozen.action === "session-close" || frozen.action === "session-cancel")
      this.cancelRequests(frozen.id);
    if (
      [
        "signing-configure",
        "register",
        "configure",
        "session-open",
        "session-close",
      ].includes(frozen.action)
    ) {
      const result = this.mutations.then(() => this.execute(frozen));
      this.mutations = result.catch(() => {});
      return result;
    }
    if ((frozen.action === "sign-standard" || frozen.action === "sign-feepool") && frozen.protocolExecution) {
      this.assertActive();
      return this.protocolExecutions().execute({ ...frozen, protocolExecution: frozen.protocolExecution }, () => this.execute(frozen));
    }
    return this.execute(frozen);
  }
  private async execute(command: WalletPaymentCommand): Promise<unknown> {
    this.assertActive();
    if (command.action === "connect-payment-recovery") return this.recoverAuthorizedConnectExecutions();
    if (command.action === "connect-payment-recovery-ack") return this.acknowledgeConnectRecovery(command.paymentIds);
    if (command.action === "connect-payment-signed-recovery") return this.recoverSignedConnectExecutions();
    if (command.action === "protocol-payment-recovery") return this.protocolExecutions().recovery();
    if (command.action === "protocol-payment-status") return this.protocolExecutions().status(command.executionId);
    if (command.action === "protocol-payment-ack") { await this.protocolExecutions().ack(command.executionIds); return true; }
    if (command.action === "protocol-payment-prepare") { await this.protocolExecutions().prepare(command); return true; }
    if (command.action === "backend") return "software";
    if (command.action === "signing-list")
      return (await this.gate.snapshot()).signing ?? [];
    if (command.action === "signing-configure") {
      await this.gate.configureSigning(
        command.id,
        command.mode,
        command.revision,
      );
      this.assertActive();
      return true;
    }
    if (command.action === "pending")
      return [...this.pending.values()].map((p) => structuredClone(p.view));
    if (command.action === "spend-notices") return [...this.spendNotices.values()].map(v => structuredClone(v));
    if (command.action === "notice-dismiss") return this.spendNotices.delete(command.id);
    if (command.action === "answer") {
      const p = this.pending.get(command.id);
      if (!p) throw Error("stale-approval");
      if(command.raiseSessionLimit !== undefined) throw Error("session-limits-removed");
      const raised = undefined;
      this.pending.delete(command.id);
      clearTimeout(p.timer);
      p.resolve({
        allow: command.allow,
        ...(raised === undefined ? {} : { raiseSessionLimit: raised }),
      });
      return true;
    }
    let requestToken: { revoked: boolean } | undefined;
    if ("sessionId" in command && command.sessionId !== null) {
      requestToken = this.sessionRequests.get(command.sessionId);
      if (!requestToken || requestToken.revoked) {
        if (!requestToken && this.sessionRequests.size >= 16)
          throw Error("capacity");
        requestToken = { revoked: false };
        this.sessionRequests.set(command.sessionId, requestToken);
      }
    }
    const assertRequest = () => {
      this.assertActive();
      if (requestToken?.revoked) throw Error("payment-cancelled");
    };
    const snapshot = await this.gate.snapshot();
    if (snapshot.channels.some((channel) => channel.network !== this.network))
      throw Error("network-identity-mismatch");
    this.assertActive();
    if (requestToken && "sessionId" in command) {
      const session = snapshot.sessions.find(
        (s) => s.id === command.sessionId && s.active,
      );
      if (!session) {
        if (this.sessionRequests.get(command.sessionId!) === requestToken)
          this.sessionRequests.delete(command.sessionId!);
        throw Error("invalid-session");
      }
    }
    if (command.action === "list") return snapshot.channels.map(dto);
    if (command.action === "register") {
      if (command.network !== this.network)
        throw Error("network-identity-mismatch");
      const existing = snapshot.channels.find((c) => c.id === command.id);
      if (existing) {
        if (
          existing.owner !== command.owner ||
          existing.kind !== command.kind ||
          existing.network !== command.network ||
          existing.paymentType !== command.paymentType
        )
          throw Error("channel-conflict");
        return dto(existing);
      }
      const inherited =
        command.kind === "app"
          ? (snapshot.channels.find(
              (c) => c.kind === "app" && c.owner === command.owner,
            )?.defaultSessionLimit ?? 0n)
          : 0n;
      const c = {
        ...command,
        enabled: false,
        singleLimit: 0n,
        defaultSessionLimit: inherited,
        revision: 1,
      };
      // 注册只建立零额度渠道，不替调用方授予免确认额度。
      const { action: _action, ...config } = c;
      const registration = await this.signatureRecorder?.({operation: "payment.register", channelId: config.id, owner: config.owner, backend: "software"});
      try {
        await this.gate.configure(config, async () => true);
        await registration?.update("completed", "automatic");
        return dto(config);
      } catch (error) {
        await registration?.update(signatureFailure(error));
        throw error;
      }
    }
    if (command.action === "configure") {
      if (command.channel.network !== this.network)
        throw Error("network-identity-mismatch");
      const c = {
        ...command.channel,
        singleLimit: money(command.channel.singleLimit),
        defaultSessionLimit: money(command.channel.defaultSessionLimit),
      };
      await this.gate.configure(c, async () => true);
      return true;
    }
    if (command.action === "session-open") {
      const existing = snapshot.sessions.find((s) => s.id === command.id);
      // 同一连接重复请求只能复用账本，不得重置已花金额。已关闭会话不能复活。
      if (existing) {
        if (!existing.active || existing.owner !== command.owner)
          throw Error("invalid-session");
        return true;
      }
      await this.gate.startSession(command.id, command.owner, async () => true);
      return true;
    }
    if (
      command.action === "session-close" ||
      command.action === "session-cancel"
    ) {
      this.cancelRequests(command.id);
      await this.cancelConnectExecutions(command.id);
      // popup 关闭只取消未签申请。Connect resume 沿用连接预算，不允许清 used。
      if (command.action === "session-cancel") return true;
      await this.gate.closeSession(command.id);
      return true;
    }
    if (
      command.action !== "sign-p2pkh" &&
      command.action !== "sign-standard" &&
      command.action !== "sign-feepool"
    )
      throw Error("unsupported");
    assertRequest();
    const c = snapshot.channels.find((c) => c.id === command.channelId);
    if (!c) throw Error("invalid-channel");
    const isPool = command.action === "sign-feepool";
    if (isPool && c.kind !== "plugin") throw Error("internal-pool-only");
    if (
      isPool &&
      command.authorization &&
      (command.family !== "bitfs" ||
        command.stage !== "state" ||
        (command.role && command.role !== "payer"))
    )
      throw Error("invalid-authorization");
    if (
      isPool &&
      command.openingRequestHex &&
      (command.family !== "bitfs" ||
        command.stage !== "state" ||
        command.role !== "cosigner" ||
        command.authorization ||
        command.prevTransactionHexes.length)
    )
      throw Error("invalid-opening");
    const isStandard = command.action === "sign-standard";
    if (
      c.paymentType !==
      (isPool
        ? `feepool.${command.family}${command.role === "cosigner" ? ".cosigner" : ""}`
        : isStandard
          ? "bsv.standard"
          : command.connectPaymentReview?.paymentType ?? "p2pkh")
    )
      throw Error("unsupported");
    if (c.network !== this.network) throw Error("unsupported-network");
    const raw = bytes(command.rawTxHex),
      previous = command.prevTransactionHexes.map(bytes),
      pub = bytes(this.publicKeyHex);
    const connectPaymentReview = command.action === "sign-p2pkh" ? command.connectPaymentReview : undefined;
    if (connectPaymentReview && connectPaymentReview.paymentId !== command.paymentId) throw Error("invalid-connect-payment-template");
    const review = isPool
      ? command.openingRequestHex
        ? await inspectBitfsOpening(raw, bytes(command.openingRequestHex), pub)
        : command.authorization
          ? await inspectBitfsAuthorization(raw, previous, pub, {
              document: bytes(command.authorization.documentHex),
              refundTemplate: bytes(command.authorization.refundTemplateHex),
            })
          : await inspectFeePool(
              raw,
              previous,
              pub,
              command.family,
              command.stage,
              command.role,
            )
      : isStandard
        ? await inspectStandard(raw, previous, pub)
        : connectPaymentReview
          ? await inspectConnectPayment(raw, previous, pub, connectPaymentReview)
          : await inspectP2pkh(
              raw,
              previous.map((transaction) => ({ transaction })),
              pub,
              0,
            );
    const connectReview = connectPaymentReview ? (review as ConnectPaymentReviewResult) : null;
    if (connectReview && (c.kind !== "app" || c.owner !== publisherPaymentOwner(connectReview.publisherPublicKeyHex)
      || c.id !== await publisherPaymentChannelId(connectReview.publisherPublicKeyHex,connectReview.paymentType,c.network))) throw Error("invalid-publisher-channel");
    // 钱包账本是累计付款基线；业务传来的 sourceAmount/previousAmount 不能决定额度。
    const poolReview = isPool
      ? (review as Awaited<ReturnType<typeof inspectFeePool>>)
      : null;
    const delta = poolReview?.pool
      ? await this.gate.inspectPool(
          poolReview.pool.id,
          poolReview.pool.binding,
          poolReview.paid,
        )
      : null;
    const poolOperation = poolReview?.stage === "state";
    const amount =
      (poolReview?.stage === "fund" ? poolReview.locked + poolReview.fee : undefined) ?? delta?.amount ??
      (poolReview
        ? 0n
        : connectReview
          ? connectReview.amount
          : (review as Awaited<ReturnType<typeof inspectP2pkh>>).amount);
    const body = {
      rawTx: raw,
      prevTransactions: previous,
      channelId: c.id,
      paymentId: command.paymentId,
      sessionId: command.sessionId,
      ...(isPool
        ? {
            stage: command.stage,
            ...(command.role ? { role: command.role } : {}),
          }
        : {}),
      ...(isPool && command.authorization
        ? {
            authorization: {
              document: bytes(command.authorization.documentHex),
              refundTemplate: bytes(command.authorization.refundTemplateHex),
            },
          }
        : {}),
      ...(isPool && command.openingRequestHex
        ? { openingRequest: bytes(command.openingRequestHex) }
        : {}),
      ...(connectReview
        ? {
            connectPayment: {
              paymentId: command.paymentId,
              clientRequestId: connectPaymentReview!.clientRequestId,
              paymentType: connectReview.paymentType,
              businessKind: connectReview.businessKind,
              appId: connectReview.appId,
              appName: connectReview.appName,
              origin: connectReview.origin,
              publisherPublicKeyHex: connectReview.publisherPublicKeyHex,
              recipientOwnership: connectReview.ownership,
              recipientLabel: connectReview.recipientLabel,
              businessAmountSats: String(connectReview.businessAmount),
              actualSpendSats: String(connectReview.amount),
              ownReturnSats: String(connectReview.ownReturn),
              ownOutputs: connectReview.ownOutputs,
              changeAmountSats: String(connectReview.change),
              feeSats: String(connectReview.fee),
              roleMap: connectPaymentReview!.outputs,
            },
          }
        : {}),
      amount,
    };
    const inspection: PaymentInspection & {
      forceConfirm?: boolean;
      connectPayment?: Record<string, unknown>;
    } = {
      requestId: command.paymentId,
      channelId: c.id,
      owner: c.owner,
      kind: c.kind,
      sessionId: command.sessionId,
      network: c.network,
      paymentType: c.paymentType,
      amount,
      ...(delta ? { pool: delta.pool } : {}),
      ...(poolOperation ? { operation: "internal-pool-state" as const } : {}),
      ...(connectReview ? { forceConfirm: connectReview.forceConfirm, connectPayment: body.connectPayment as Record<string, unknown> } : {}),
      commitment: await commitment(
        isPool
          ? command.openingRequestHex
            ? "bsv-feepool-bitfs-opening"
            : command.authorization
              ? "bsv-feepool-bitfs-authorization"
              : `bsv-feepool-${command.family}`
          : isStandard
            ? "bsv-standard-payment"
            : connectReview
              ? "bsv-connect-payment"
              : "bsv-payment-context",
        1,
        body,
      ),
    };
    const tx = parseTransaction(raw);
    const digests = poolReview
      ? poolReview.digests
      : connectReview
        ? connectReview.digests
        : isStandard
          ? (review as Awaited<ReturnType<typeof inspectStandard>>).digests
          : await Promise.all(
            tx.inputs.map((input, i) =>
              p2pkhSighash(
                tx,
                i,
                parseTransaction(previous[i]!).outputs[input.vout]!,
              ),
            ),
          );
    const recipients = connectPaymentReview
      ? connectPaymentReview.outputs.map((row) => `${row.valueSats} sat · ${row.role} · ${row.scriptHex}`)
      : await Promise.all(
        tx.outputs.map(async (o) =>
          o.script.length === 25
            ? `${o.satoshis} sat · ${await p2pkhOutputAddress(o.script, c.network as "main" | "test")}`
            : `${o.satoshis} sat · ${poolReview?.stage === "fund" ? `feepool.${poolReview.family}` : `script ${hex(o.script)}`}`,
        ),
      );

    assertRequest();
    if (connectPaymentReview) await this.beginConnectExecution(connectPaymentReview, command.sessionId, command.rawTxHex, command.prevTransactionHexes);
    const ticket=await this.signatureRecorder?.({operation:command.action,channelId:command.channelId,owner:c.owner,backend:'software',amount:String(amount),...(connectPaymentReview ? {paymentId:connectPaymentReview.paymentId} : {})});
    await ticket?.update('pending','automatic');
    const spendFacts = {
      historyId: ticket?.id, fee: String(review.fee),
      change: String(connectReview?.ownReturn ?? review.change),
      businessAmount: String(connectReview?.businessAmount ?? (poolReview ? poolReview.locked : amount - review.fee)),
      ...(connectReview ? {connectPayment: {
        appId: connectReview.appId, appName: connectReview.appName, origin: connectReview.origin,
        publisherPublicKeyHex: connectReview.publisherPublicKeyHex, recipientOwnership: connectReview.ownership,
        paymentType: connectReview.paymentType, businessKind: connectReview.businessKind, recipientLabel: connectReview.recipientLabel,
      }} : {}),
      ...(poolReview ? {pool: {family:poolReview.family,stage:poolReview.stage,paid:String(poolReview.paid),locked:String(poolReview.locked)}} : {}),
    };
    try {const result=await this.gate.execute(
      inspection,
      async (request, quote) => {
        await ticket?.update('pending','manual');
        return this.confirm(request, quote, recipients, spendFacts);},
      async () => {
        const signatures: string[] = [];
        for (let i = 0; i < tx.inputs.length; i++) {
          assertRequest();
          const digest = digests[i]!;
          const signature = await this.signDigest(digest);
          assertRequest();
          signatures.push(
            hex(signature) + (isPool && command.authorization ? "" : "41"),
          );
          if (connectPaymentReview) await this.persistConnectSignedMaterial(connectPaymentReview.paymentId, signatures);
          if (command.protocolExecution) await this.protocolExecutions().material(command.protocolExecution.executionId, signatures);
        }
        if (connectPaymentReview) {
          await this.persistConnectSignedMaterial(connectPaymentReview.paymentId, signatures, buildSignedP2pkhExact(raw, tx, signatures, pub));
        }
        return { signatures, amount: String(amount), fee: String(review.fee) };
      },
      async () => {
        assertRequest();
        if (connectPaymentReview) await this.markConnectSigningStarted(connectPaymentReview.paymentId);
        if (command.protocolExecution) await this.protocolExecutions().start(command.protocolExecution.executionId);
      },
      (request, quote) => {
        if (poolOperation || quote.reasons.length || connectReview?.forceConfirm) return;
        // Bounded queue, never silently discard an unseen spend notice.
        if (this.spendNotices.size >= 64) throw Error("spend-notice-capacity");
        const id = crypto.randomUUID();
        this.spendNotices.set(id, {id, automatic:true, channelId:request.channelId, sessionId:request.sessionId,
          owner:request.owner,wallet:this.publicKeyHex,network:request.network,paymentType:request.paymentType,kind:request.kind,
          amount:String(quote.amount),used:String(quote.used),singleLimit:String(quote.singleLimit),sessionLimit:null,reasons:[],recipients,...spendFacts});
      },
    );
      if (connectPaymentReview) await this.finishConnectExecution(connectPaymentReview.paymentId, "signed").catch(() => undefined);
      await ticket?.update('completed');
      return result;}
    catch(error){
      if (connectPaymentReview) {
        const proof = await this.cancelConnectExecution(connectPaymentReview.paymentId).catch(() => null);
        if (proof) Object.assign(error as object, { connectPaymentNotSigned: proof });
        else await this.finishConnectExecution(connectPaymentReview.paymentId, "unknown").catch(() => undefined);
      }
      await ticket?.update(signatureFailure(error));
      throw error;
    }
  }
}
