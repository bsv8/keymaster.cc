import {
  commitment,
  inspectP2pkh,
  inspectFeePool,
  inspectBitfsAuthorization, inspectBitfsOpening,
  inspectStandard,
  parseTransaction,
  p2pkhSighash,
  p2pkhOutputAddress,
  type PolicyStore,
} from "@vaultlink/sdk";
import {
  SoftwarePaymentGate,
  type ChannelConfig,
  type PaymentInspection,
  type Quote,
} from "./payment.js";
import { parseStoredPaymentPolicy, serializeStoredPaymentPolicy } from "./policy-storage.js";
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
  | { action: "list" | "pending" }
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
    }
  | {
      action: "sign-feepool";
      authorization?: {documentHex:string;refundTemplateHex:string};
      openingRequestHex?:string;
      family: "connect" | "bitfs"; role?: "payer" | "cosigner";
      stage: "fund" | "state";
      rawTxHex: string;
      prevTransactionHexes: string[];
      channelId: string;
      paymentId: string;
      sessionId: string | null;
    };
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
/** 仅 Coordinator 的唯一钱包实例拥有此对象；读写使用绑定钱包世代的真实文件句柄。 */
export class WalletPayments {
  private sessionRequests = new Map<string, {revoked: boolean}>();
  private pending = new Map<
    string,
    {
      view: Record<string, unknown>;
      resolve: (answer: { allow: boolean; raiseSessionLimit?: bigint }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(
    private gate: SoftwarePaymentGate,
    private publicKeyHex: string,
    private assertActive: () => void,
    private signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
    private network: "main" | "test",
  ) {}
  static async open(
    files: PaymentFileStore,
    publicKeyHex: string,
    assertActive: () => void,
    signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
    network: "main" | "test",
  ): Promise<WalletPayments> {
    if(network!=="main"&&network!=="test")throw Error("network-identity-required");
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
        if(snapshot.channels.some(channel=>channel.network!==network))throw Error("network-identity-mismatch");
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
    );
  }
  close() {
    this.gate.lock();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ allow: false });
    }
    this.pending.clear();
    for(const token of this.sessionRequests.values()) token.revoked=true;
    this.sessionRequests.clear();
  }
  private confirm(
    request: PaymentInspection,
    quote: Quote,
    recipients: string[],
    facts: {
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
    for (const [id,p] of this.pending) {
      if (p.view.sessionId !== sessionId) continue;
      this.pending.delete(id); clearTimeout(p.timer); p.resolve({allow:false});
    }
  }
  private mutations: Promise<unknown> = Promise.resolve();
  handle(command: WalletPaymentCommand): Promise<unknown> {
    // 配置和建会话按单钱包串行；业务签名等待批准不占据设置队列。
    const frozen = structuredClone(command);
    // 撤权立即生效，不等待配置队列或 snapshot 的异步完成。
    if (frozen.action === "session-close" || frozen.action === "session-cancel")
      this.cancelRequests(frozen.id);
    if (["register", "configure", "session-open", "session-close"].includes(frozen.action)) {
      const result = this.mutations.then(() => this.execute(frozen));
      this.mutations = result.catch(() => {});
      return result;
    }
    return this.execute(frozen);
  }
  private async execute(command: WalletPaymentCommand): Promise<unknown> {
    this.assertActive();
    if (command.action === "pending")
      return [...this.pending.values()].map((p) => structuredClone(p.view));
    if (command.action === "answer") {
      const p = this.pending.get(command.id);
      if (!p) throw Error("stale-approval");
      const raised =
        command.raiseSessionLimit === undefined
          ? undefined
          : money(command.raiseSessionLimit);
      this.pending.delete(command.id);
      clearTimeout(p.timer);
      p.resolve({
        allow: command.allow,
        ...(raised === undefined ? {} : { raiseSessionLimit: raised }),
      });
      return true;
    }
    let requestToken: {revoked: boolean} | undefined;
    if ("sessionId" in command && command.sessionId !== null) {
      requestToken=this.sessionRequests.get(command.sessionId);
      if(!requestToken || requestToken.revoked){
        if(!requestToken && this.sessionRequests.size>=16)throw Error("capacity");
        requestToken={revoked:false};this.sessionRequests.set(command.sessionId,requestToken);
      }
    }
    const assertRequest=()=>{this.assertActive();if(requestToken?.revoked)throw Error("payment-cancelled");};
    const snapshot = await this.gate.snapshot();
    if(snapshot.channels.some(channel=>channel.network!==this.network))throw Error("network-identity-mismatch");
    this.assertActive();
    if (requestToken && "sessionId" in command) {
      const session = snapshot.sessions.find(s => s.id === command.sessionId && s.active);
      if (!session) {
        if (this.sessionRequests.get(command.sessionId!) === requestToken)
          this.sessionRequests.delete(command.sessionId!);
        throw Error("invalid-session");
      }
    }
    if (command.action === "list") return snapshot.channels.map(dto);
    if (command.action === "register") {
      if(command.network!==this.network)throw Error("network-identity-mismatch");
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
        enabled: true,
        singleLimit: 0n,
        defaultSessionLimit: inherited,
        revision: 1,
      };
      // 注册只建立零额度渠道，不替调用方授予免确认额度。
      const { action: _action, ...config } = c;
      await this.gate.configure(config, async () => true);
      return dto(config);
    }
    if (command.action === "configure") {
      if(command.channel.network!==this.network)throw Error("network-identity-mismatch");
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
    if (command.action === "session-close" || command.action === "session-cancel") {
      this.cancelRequests(command.id);
      // popup 关闭只取消未签申请。Connect resume 沿用连接预算，不允许清 used。
      if (command.action === "session-cancel") return true;
      await this.gate.closeSession(command.id);
      return true;
    }
    if (command.action !== "sign-p2pkh" && command.action !== "sign-standard" && command.action !== "sign-feepool")
      throw Error("unsupported");
    assertRequest();
    const c = snapshot.channels.find((c) => c.id === command.channelId);
    if (!c) throw Error("invalid-channel");
    const isPool = command.action === "sign-feepool";
    if(isPool&&command.authorization&&(command.family!=="bitfs"||command.stage!=="state"||(command.role&&command.role!=="payer")))throw Error("invalid-authorization");
    if(isPool&&command.openingRequestHex&&(command.family!=="bitfs"||command.stage!=="state"||command.role!=="cosigner"||command.authorization||command.prevTransactionHexes.length))throw Error("invalid-opening");
    const isStandard = command.action === "sign-standard";
    if (c.paymentType !== (isPool ? `feepool.${command.family}${command.role === "cosigner" ? ".cosigner" : ""}` : isStandard ? "bsv.standard" : "p2pkh"))
      throw Error("unsupported");
    if (c.network !== this.network)
      throw Error("unsupported-network");
    const raw = bytes(command.rawTxHex),
      previous = command.prevTransactionHexes.map(bytes),
      pub = bytes(this.publicKeyHex);
    const review = isPool
      ? command.openingRequestHex ? await inspectBitfsOpening(raw,bytes(command.openingRequestHex),pub) : command.authorization ? await inspectBitfsAuthorization(raw,previous,pub,{document:bytes(command.authorization.documentHex),refundTemplate:bytes(command.authorization.refundTemplateHex)}) : await inspectFeePool(raw, previous, pub, command.family, command.stage, command.role)
      : isStandard ? await inspectStandard(raw, previous, pub) : await inspectP2pkh(
          raw,
          previous.map((transaction) => ({ transaction })),
          pub,
          0,
        );
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
    const amount =
      delta?.amount ??
      (poolReview
        ? 0n
        : (review as Awaited<ReturnType<typeof inspectP2pkh>>).amount);
    const body = {
      rawTx: raw,
      prevTransactions: previous,
      channelId: c.id,
      paymentId: command.paymentId,
      sessionId: command.sessionId,
      ...(isPool ? { stage: command.stage, ...(command.role ? {role:command.role} : {}) } : {}),
      ...(isPool && command.authorization ? {authorization:{document:bytes(command.authorization.documentHex),refundTemplate:bytes(command.authorization.refundTemplateHex)}} : {}),
      ...(isPool && command.openingRequestHex ? {openingRequest:bytes(command.openingRequestHex)} : {}),
      amount,
    };
    const inspection: PaymentInspection = {
      requestId: command.paymentId,
      channelId: c.id,
      owner: c.owner,
      kind: c.kind,
      sessionId: command.sessionId,
      network: c.network,
      paymentType: c.paymentType,
      amount,
      ...(delta ? { pool: delta.pool } : {}),
      commitment: await commitment(
        isPool ? command.openingRequestHex ? "bsv-feepool-bitfs-opening" : command.authorization ? "bsv-feepool-bitfs-authorization" : `bsv-feepool-${command.family}` : isStandard ? "bsv-standard-payment" : "bsv-payment-context",
        1,
        body,
      ),
    };
    const tx = parseTransaction(raw);
    const digests = poolReview ? poolReview.digests
      : isStandard ? (review as Awaited<ReturnType<typeof inspectStandard>>).digests
      : await Promise.all(tx.inputs.map((input,i) => p2pkhSighash(tx,i,
          parseTransaction(previous[i]!).outputs[input.vout]!)));
    const recipients = await Promise.all(
      tx.outputs.map(async (o) =>
        o.script.length === 25
          ? `${o.satoshis} sat · ${await p2pkhOutputAddress(o.script, c.network as "main" | "test")}`
          : `${o.satoshis} sat · ${poolReview?.stage === "fund" ? `feepool.${poolReview.family}` : `script ${hex(o.script)}`}`,
      ),
    );

    assertRequest();
    return this.gate.execute(
      inspection,
      (request, quote) =>
        this.confirm(request, quote, recipients, {
          fee: String(review.fee),
          change: String(review.change),
          ...(poolReview
            ? {
                pool: {
                  family: poolReview.family,
                  stage: poolReview.stage,
                  paid: String(poolReview.paid),
                  locked: String(poolReview.locked),
                },
              }
            : {}),
        }),
      async () => {
        const signatures: string[] = [];
        for (let i = 0; i < tx.inputs.length; i++) {
          assertRequest();
          const digest = digests[i]!;
          const signature = await this.signDigest(digest);
          assertRequest();
          signatures.push(hex(signature) + (isPool && command.authorization ? "" : "41"));
        }
        return { signatures, amount: String(amount), fee: String(review.fee) };
      },
      assertRequest,
    );
  }
}
