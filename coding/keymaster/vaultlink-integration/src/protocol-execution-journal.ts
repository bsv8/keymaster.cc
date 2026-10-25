import { hex, unhex, parseTransaction, serializeTransaction, standardUnlockKind, p2pkhSighash, sha256d } from "@vaultlink/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { PaymentFileStore } from "./wallet-payments.js";

export interface ProtocolExecutionIdentity { executionId: string; allocationId: string; submissionId: string; }
export interface ProtocolExecutionProof extends ProtocolExecutionIdentity {
  owner: string; network: "main" | "test"; unsignedTxHex: string;
  state: "authorized" | "signing_started" | "signed_partial" | "signed_complete" | "cancelled_before_sign";
  version: number; signedTxHex?: string;
}
interface RecordValue extends ProtocolExecutionProof { previous: string[]; signatures: string[]; acknowledged?: boolean; }
type Preparation = { paymentId: string; rawTxHex: string; prevTransactionHexes: string[]; protocolExecution: ProtocolExecutionIdentity };
const path = "protocol-payment-executions.json";
const validId = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9:._-]{1,128}$/.test(v);
/** Signature execution evidence, NOT a balance/approval/UTXO ledger. */
export class ProtocolExecutionJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Set<string>();
  constructor(private files: PaymentFileStore, private owner: string, private network: "main" | "test") {}
  private run<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn); this.tail = next.catch(() => undefined); return next; }
  private async read() {
    const file = await this.files.get(path);
    if (!file) return { records: {} as Record<string, RecordValue>, revision: undefined as string | undefined };
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (value.schema !== 1 || value.owner !== this.owner || value.network !== this.network || !value.records || typeof value.records !== "object" || Array.isArray(value.records)) throw Error("protocol-execution-journal-corrupt");
    for (const [id, row] of Object.entries(value.records) as [string, RecordValue][]) {
      if (!row || !validId(id) || id !== row.executionId || !validId(row.allocationId) || !validId(row.submissionId) || row.owner !== this.owner || row.network !== this.network || !Number.isSafeInteger(row.version) || row.version < 1 || !["authorized", "signing_started", "signed_partial", "signed_complete", "cancelled_before_sign"].includes(row.state) || !Array.isArray(row.previous) || !Array.isArray(row.signatures) || typeof row.unsignedTxHex !== "string" || (row.acknowledged !== undefined && typeof row.acknowledged !== "boolean")) throw Error("protocol-execution-journal-corrupt");
      parseTransaction(unhex(row.unsignedTxHex)); row.previous.forEach(raw => parseTransaction(unhex(raw)));
      if ((row.state === "authorized" || row.state === "cancelled_before_sign") && (row.signatures.length || row.signedTxHex)) throw Error("protocol-execution-journal-corrupt");
      if (row.state === "signed_complete" && !row.signedTxHex) throw Error("protocol-execution-journal-corrupt");
    }
    return { records: value.records as Record<string, RecordValue>, revision: file.revision };
  }
  private async save(records: Record<string, RecordValue>, revision?: string) { await this.files.put(path, new TextEncoder().encode(JSON.stringify({ schema: 1, owner: this.owner, network: this.network, records })), revision === undefined ? { ifNoneMatch: true } : { ifRevision: revision }); }
  async prepare(input: Preparation) {
    return this.run(async () => {
      const identity = input.protocolExecution;
      if (![identity.executionId, identity.allocationId, identity.submissionId].every(validId) || input.paymentId !== identity.executionId) throw Error("invalid-protocol-execution");
      const raw = input.rawTxHex.toLowerCase(), previous = input.prevTransactionHexes.map(v => v.toLowerCase());
      const tx = parseTransaction(unhex(raw)); if (!tx.inputs.length || previous.length !== tx.inputs.length) throw Error("invalid-protocol-execution-template");
      previous.forEach(v => parseTransaction(unhex(v)));
      const state = await this.read(), existing = state.records[identity.executionId];
      if (existing) {
        if (existing.allocationId !== identity.allocationId || existing.submissionId !== identity.submissionId || existing.unsignedTxHex !== raw || JSON.stringify(existing.previous) !== JSON.stringify(previous)) throw Error("protocol-execution-identity-conflict");
        return;
      }
      if (Object.keys(state.records).length >= 4096) throw Error("protocol-execution-capacity");
      state.records[identity.executionId] = { ...identity, owner: this.owner, network: this.network, unsignedTxHex: raw, previous, signatures: [], state: "authorized", version: 1 };
      await this.save(state.records, state.revision);
    });
  }
  async execute<T>(input: Preparation, operation: () => Promise<T>): Promise<T> {
    const id = input.protocolExecution.executionId;
    if (this.active.has(id)) throw Error("protocol-execution-in-progress");
    this.active.add(id);
    try {
      await this.prepare(input);
      const row = await this.run(async () => (await this.read()).records[id]!);
      // An execution identity can never acquire a second signature attempt.
      if (row.state !== "authorized") throw Error("protocol-execution-already-started");
      try { return await operation(); }
      catch (error) { await this.cancel(id).catch(() => undefined); throw error; }
    } finally { this.active.delete(id); }
  }
  async start(id: string) { await this.run(async () => { const s = await this.read(), row = s.records[id]; if (!row || row.state !== "authorized") throw Error("protocol-execution-not-authorized"); row.state = "signing_started"; row.version++; await this.save(s.records, s.revision); }); }
  async cancel(id: string, deviceNotSigned = false) { await this.run(async () => { const s = await this.read(), row = s.records[id]; if (!row) return; if (row.state !== "authorized" && !(deviceNotSigned && row.state === "signing_started" && !row.signatures.length)) return; row.state = "cancelled_before_sign"; row.version++; await this.save(s.records, s.revision); }); }
  private async exact(row: RecordValue, signatures: string[], verifiedPrefix = 0): Promise<string | undefined> {
    const tx = parseTransaction(unhex(row.unsignedTxHex)), publicKey = unhex(this.owner);
    if (signatures.length > tx.inputs.length || row.previous.length !== tx.inputs.length) throw Error("invalid-protocol-signature-count");
    // Verify newly appended material during partial progress; verify the full
    // set once before declaring completion and on every recovery read.
    for (let i = signatures.length === tx.inputs.length ? 0 : verifiedPrefix; i < signatures.length; i++) {
      const sig = unhex(signatures[i]!), previousRaw = unhex(row.previous[i]!);
      if (hex(await sha256d(previousRaw)) !== hex(tx.inputs[i]!.txid)) throw Error("invalid-protocol-previous-transaction");
      const previous = parseTransaction(previousRaw), output = previous.outputs[tx.inputs[i]!.vout]!;
      if (!output || sig.at(-1) !== 0x41 || !standardUnlockKind(output.script, publicKey) || !secp256k1.verify(sig.slice(0, -1), await p2pkhSighash(tx, i, output), publicKey, { prehash: false, lowS: true, format: "der" })) throw Error("invalid-protocol-signature");
    }
    if (signatures.length !== tx.inputs.length) return undefined;
    tx.inputs.forEach((input, i) => { const sig = unhex(signatures[i]!); const kind = standardUnlockKind(parseTransaction(unhex(row.previous[i]!)).outputs[input.vout]!.script, publicKey); input.script = kind === "p2pkh" ? Uint8Array.from([sig.length, ...sig, 33, ...publicKey]) : Uint8Array.from([sig.length, ...sig]); });
    return hex(serializeTransaction(tx));
  }
  async material(id: string, signatures: string[]) {
    await this.run(async () => {
      const s = await this.read(), row = s.records[id];
      if (!row || !["signing_started", "signed_partial"].includes(row.state) || signatures.length < row.signatures.length || row.signatures.some((v, i) => v !== signatures[i])) throw Error("invalid-protocol-signature-progress");
      const exact = await this.exact(row, signatures, row.signatures.length);
      row.signatures = [...signatures]; row.state = "signed_partial"; row.version++;
      if (exact) { row.signedTxHex = exact; row.state = "signed_complete"; }
      await this.save(s.records, s.revision);
    });
  }
  async status(id: string): Promise<ProtocolExecutionProof | null> {
    return this.run(async () => { const s = await this.read(), row = s.records[id]; if (!row) return null;
      // Cancel-before-start is durable and prevents a delayed sign command.
      if (row.state === "authorized" && !this.active.has(id)) { row.state = "cancelled_before_sign"; row.version++; await this.save(s.records, s.revision); }
      if (row.signatures.length || row.state === "signed_complete") {
        const exact = await this.exact(row, row.signatures);
        if ((row.state === "signed_complete") !== !!exact || (exact && exact !== row.signedTxHex)) throw Error("protocol-execution-journal-corrupt");
      }
      const { previous: _, signatures: __, acknowledged: ___, ...proof } = row; return structuredClone(proof);
    });
  }
  async recovery(): Promise<ProtocolExecutionProof[]> {
    const ids = await this.run(async () => Object.values((await this.read()).records).filter(row => !row.acknowledged).map(row => row.executionId));
    const rows = await Promise.all(ids.map(id => this.status(id))); return rows.filter((row): row is ProtocolExecutionProof => row !== null);
  }
  async ack(ids: string[]) { await this.run(async () => { const s = await this.read(); for (const id of ids) { const row = s.records[id]; if (!row || !["cancelled_before_sign", "signed_complete"].includes(row.state)) throw Error("protocol-execution-not-terminal"); row.acknowledged = true; } await this.save(s.records, s.revision); }); }
}
