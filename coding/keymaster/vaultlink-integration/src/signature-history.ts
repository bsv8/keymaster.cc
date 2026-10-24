import type { PaymentFileStore } from "./wallet-payments.js";
export type SignatureState =
  | "pending"
  | "completed"
  | "denied"
  | "cancelled"
  | "failed"
  | "unknown";
export type SignatureMode = "unknown" | "automatic" | "manual";
export interface SignatureMeta {
  operation: string;
  channelId: string;
  owner: string;
  backend: "software" | "hardware";
  amount?: string;
  /** Stable Connect payment identity; never contains transaction or signature bytes. */
  paymentId?: string;
}
export interface SignatureRecord extends SignatureMeta {
  id: string;
  network: "main" | "test";
  publicKeyHex: string;
  session: string;
  startedAt: string;
  finishedAt?: string;
  mode: SignatureMode;
  state: SignatureState;
}
export interface SignatureTicket {
  id?: string;
  update(
    state: SignatureState,
    mode?: SignatureMode,
    amount?: string,
  ): Promise<void>;
}
export type SignatureRecorder = (
  meta: SignatureMeta,
) => Promise<SignatureTicket>;
export class SignatureHistory {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private files: PaymentFileStore,
    private network: "main" | "test",
    private publicKeyHex: string,
    private session: string,
  ) {}
  private async read() {
    const f = await this.files.get("signatures.json");
    if (!f)
      return {
        rows: [] as SignatureRecord[],
        revision: undefined as string | undefined,
      };
    const v = JSON.parse(new TextDecoder().decode(f.bytes));
    if (
      v.version !== 1 ||
      v.network !== this.network ||
      v.publicKeyHex !== this.publicKeyHex ||
      !Array.isArray(v.rows) ||
      v.rows.length > 500
    )
      throw Error("invalid-signature-history");
    for (const r of v.rows) {
      if (
        !r ||
        typeof r !== "object" ||
        ![
          "pending",
          "completed",
          "denied",
          "cancelled",
          "failed",
          "unknown",
        ].includes(r.state) ||
        !["unknown", "automatic", "manual"].includes(r.mode) ||
        !["software", "hardware"].includes(r.backend) ||
        r.network !== this.network ||
        r.publicKeyHex !== this.publicKeyHex ||
        ["id", "session", "startedAt", "operation", "channelId", "owner"].some(
          (k) => typeof r[k] !== "string" || r[k].length > 256,
        ) ||
        !Number.isFinite(Date.parse(r.startedAt)) ||
        (r.finishedAt !== undefined &&
          (typeof r.finishedAt !== "string" ||
            !Number.isFinite(Date.parse(r.finishedAt)))) ||
        (r.amount !== undefined &&
          (typeof r.amount !== "string" || !/^\d{1,20}$/.test(r.amount))) ||
        (r.paymentId !== undefined &&
          (typeof r.paymentId !== "string" || r.paymentId.length > 96))
      )
        throw Error("invalid-signature-history");
    }
    return { rows: v.rows as SignatureRecord[], revision: f.revision };
  }
  private change(edit: (rows: SignatureRecord[]) => void) {
    const job = this.tail
      .catch(() => {})
      .then(async () => {
        const v = await this.read();
        edit(v.rows);
        await this.files.put(
          "signatures.json",
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              network: this.network,
              publicKeyHex: this.publicKeyHex,
              rows: v.rows.slice(-500),
            }),
          ),
          v.revision ? { ifRevision: v.revision } : { ifNoneMatch: true },
        );
      });
    this.tail = job;
    return job;
  }
  async list() {
    await this.tail.catch(() => {});
    const { rows } = await this.read();
    return rows
      .map((r) =>
        r.state === "pending" && r.session !== this.session
          ? { ...r, state: "unknown" as const }
          : r,
      )
      .reverse();
  }
  async start(meta: SignatureMeta): Promise<SignatureTicket> {
    // Explicit allowlist: never serialize the original signing request.
    const row: SignatureRecord = {
      id: crypto.randomUUID(),
      network: this.network,
      publicKeyHex: this.publicKeyHex,
      session: this.session,
      startedAt: new Date().toISOString(),
      state: "pending",
      mode: "unknown",
      operation: meta.operation,
      channelId: meta.channelId,
      owner: meta.owner,
      backend: meta.backend,
      ...(meta.amount === undefined ? {} : { amount: meta.amount }),
      ...(meta.paymentId === undefined ? {} : { paymentId: meta.paymentId }),
    };
    await this.change((rows) => rows.push(row));
    return {
      id: row.id,
      update: async (state, mode, amount) => {
        try {
          await this.change((rows) => {
            const r = rows.find((v) => v.id === row.id);
            if (!r || r.state !== "pending") return;
            r.state = state;
            if (mode) r.mode = mode;
            if (amount !== undefined) r.amount = amount;
            if (state !== "pending") r.finishedAt = new Date().toISOString();
          });
        } catch (error) {
          console.warn("Signature history result could not be saved");
        }
      },
    };
  }
}
export function signatureFailure(error: unknown): SignatureState {
  const s = error instanceof Error ? error.message : String(error);
  return /denied/.test(s)
    ? "denied"
    : /cancel/.test(s)
      ? "cancelled"
      : /disconnect|stale|revok|timeout|closed|locked/i.test(s)
        ? "unknown"
        : "failed";
}
export function signatureOwner(op: string) {
  return op.startsWith("identity.")
    ? "window-p2p"
    : op.startsWith("channel.")
      ? "channel"
      : op.startsWith("connect.")
        ? "connect"
        : op.startsWith("bitfs.")
          ? "bitfs"
          : "vault";
}
