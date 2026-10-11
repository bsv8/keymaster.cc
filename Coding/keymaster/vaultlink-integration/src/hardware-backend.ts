import {
  commitment, DeviceIdentityKey, assertDeviceMigrationBinding,
  inspectConnectEnvelope, connectCompactSignature, type ConnectEnvelopeKind,
  inspectChannel, inspectSignedChannel, inspectInboxEnvelope, verifyChannelSignature,
  parseCanonicalJson, unhex, type ChannelKind, type ChannelOperationKind,
  sha256, decodePaymentPolicy, encodePaymentPolicy,
  inspectDeviceMigration, type DeviceMigrationRecord,
  inspectBitfsWire, inspectNetworkIdentity, type NetworkIdentityKind,
  inspectBitfsAuthorization, inspectBitfsOpening,
  validateLocalScope, validateLocalSecret, type LocalSecretV3,
  connectHost, enrollHost,
  inspectP2pkh,
  inspectFeePool,
  inspectStandard,
  equal,
  object,
  parseTransaction,
  p2pkhSighash,
  secpIdentityVerifier,
  WebSerialTransport,
  type Binding,
  type Generations,
  type ProtocolClient,
  type SerialPortLike,
  type Transport,
  type Value,
  type ChannelConfig,
} from "@vaultlink/sdk";

/** 公开元数据只标明实际已接通的支持集；不得以签任意摘要补齐未实现 Profile。 */
export const vaultLinkSupport = Object.freeze({
  sdkVersion: "0.2.0-draft.1",
  wireVersion: 2,
  operations: Object.freeze([
    "local-secret.seal",
    "local-secret.open",
    "connect.identity-sign",
    "connect.intent-sign",
    "bitfs.wire-sign", "tx.feepool-bitfs-authorize", "tx.feepool-bitfs-opening",
    "identity.noise-proof", "identity.peer-record",
    "channel.public-message", "channel.hash-request", "channel.private-message", "channel.seal", "channel.open",
    "tx.p2pkh-payment",
    "tx.standard-payment",
    "payment.configure",
    "payment.session-open",
    "payment.session-close",
    "payment.channel-read",
    "payment.channel-list",
    "payment.session-read",
    "payment.pool-read", "payment.policy-export", "migration.status",
    "migration.export", "migration.host-commit", "migration.erase",
    "tx.feepool-connect",
    "tx.feepool-bitfs",
  ]),
  unsupported: Object.freeze([]),
  provisionOperations:Object.freeze(["migration.status","migration.import-begin","migration.import-stage-status","migration.import-stage","migration.import-key","migration.import-proof","migration.import-commit"]),
  /** Separate receipt-only runtime; never ordinary wallet capabilities. */
  recoveryOperations:Object.freeze(["migration.status","migration.recover-erased","migration.complete"]),
});
export interface HardwareOperationActivity {
  operation: string;
  state: "awaiting-user" | "executing" | "completed" | "denied" | "cancelled" | "unknown" | "failed";
}
export interface WalletContext {
  publicKeyHex: string;
  bsvNetwork: "main" | "test";
  generations: Generations;
  /** 生命周期真值来自 Coordinator，方法捕获的 UI 状态不可作为检查依据。 */
  assertActive(): void;
}
export interface PaymentInput {
  rawTx: Uint8Array;
  prevTransactions: Uint8Array[];
  channelId: string;
  paymentId: string;
  /** 插件填 null，Connect App 填该次连接的钱包会话编号。 */
  sessionId: string | null;
  network: "main" | "test";
}
export interface HardwarePaymentResult {
  signatures: Uint8Array[];
  amount: bigint;
  fee: bigint;
}
function publicKey(hex: string): Uint8Array {
  if (!/^0[23][0-9a-f]{64}$/i.test(hex)) throw new Error("invalid-key");
  return Uint8Array.from(hex.match(/../g)!, (b) => Number.parseInt(b, 16));
}
/** 绑定一个已核验持有权的连接；主机排队，控制请求独立；未知支付从不自动重试。 */
export class VaultLinkHardwareBackend {
  readonly disconnected: Promise<void>;
  private closed = false;
  private migrationOwned = false;
  /** Business operations stay frozen through errors and until this connection
   * is closed. A new connection must reconcile the durable migration journal. */
  isMigrating():boolean{return this.migrationOwned;}
  async withMigration<T>(run:()=>Promise<T>):Promise<T>{
    this.assert();if(this.migrationOwned)throw Error("migration-pending");
    this.migrationOwned=true;await this.tail;this.assert();return run();
  }
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly pub: Uint8Array;
  private sessions = new Map<string, {revoked: boolean}>();
  private paymentGuard?: () => void;
  private activeOperation?: {operation: string; requestId: number; commitment: Uint8Array};
  private lastOperation?: HardwareOperationActivity;
  private activePayment?: {sessionId: string | null; requestId: number; commitment: Uint8Array};
  private constructor(
    private client: ProtocolClient,
    private context: WalletContext,
    reader?: Promise<void>,
  ) {
    this.pub = publicKey(context.publicKeyHex);
    // run 内部会关闭并拒绝所有 pending；关闭后不保留一个看似可用的代理。
    this.disconnected = (reader ?? client.run()).then(
      () => { this.closed = true; },
      () => { this.closed = true; },
    );
  }
  static async connect(
    transport: Transport,
    context: WalletContext,
    confirmPairing: (code: string) => Promise<boolean>,
  ): Promise<VaultLinkHardwareBackend> {
    context.assertActive();
    const frozen = { ...context, generations: { ...context.generations } };
    const client = await connectHost(
      transport,
      frozen.generations,
      publicKey(frozen.publicKeyHex),
      secpIdentityVerifier,
      async (code) => {
        frozen.assertActive();
        const allow = await confirmPairing(code);
        frozen.assertActive();
        return allow;
      },
      [0x22e],
    );
    const backend = new VaultLinkHardwareBackend(client, frozen);
    try {
      frozen.assertActive();
      const identity=object(await client.execute("identity.network",{},await commitment("identity-network",1,{})),["bsvNetwork","publicKey"]);
      if(identity.bsvNetwork!==frozen.bsvNetwork || !(identity.publicKey instanceof Uint8Array) || !equal(identity.publicKey,publicKey(frozen.publicKeyHex)))throw Error("network-identity-mismatch");
      frozen.assertActive();
      return backend;
    } catch (error) {
      await client.close(error);
      throw error;
    }
  }
  /** 首次绑定只发布经过实体配对与新鲜持有权证明的公钥。 */
  static async enroll(transport: Transport, context: Omit<WalletContext, "publicKeyHex" | "bsvNetwork">,
    confirmPairing: (code: string) => Promise<boolean>): Promise<{backend: VaultLinkHardwareBackend; publicKeyHex: string; bsvNetwork: "main" | "test"}> {
    context.assertActive();
    const frozen = {...context, generations: {...context.generations}};
    const verified = await enrollHost(transport, frozen.generations, secpIdentityVerifier, async code => {
      frozen.assertActive(); const allow = await confirmPairing(code); frozen.assertActive(); return allow;
    }, [0x22e]);
    const reader = verified.client.run();
    void reader.catch(() => undefined);
    try {
      frozen.assertActive();
      const publicKeyHex = Array.from(verified.publicKey, byte => byte.toString(16).padStart(2, "0")).join("");
      const identity=object(await verified.client.execute("identity.network",{},await commitment("identity-network",1,{})),["bsvNetwork","publicKey"]);
      if((identity.bsvNetwork!=="main"&&identity.bsvNetwork!=="test") || !(identity.publicKey instanceof Uint8Array) || !equal(identity.publicKey,verified.publicKey))throw Error("network-identity-mismatch");
      const bsvNetwork=identity.bsvNetwork;frozen.assertActive();
      return {publicKeyHex, bsvNetwork, backend: new VaultLinkHardwareBackend(verified.client, {...frozen, publicKeyHex,bsvNetwork}, reader)};
    } catch (error) { await verified.client.close(error); throw error; }
  }
  static async openSerial(
    port: SerialPortLike,
    context: WalletContext,
    confirmPairing: (code: string) => Promise<boolean>,
  ): Promise<VaultLinkHardwareBackend> {
    context.assertActive();
    return this.connect(
      await WebSerialTransport.open(port),
      context,
      confirmPairing,
    );
  }
  get binding(): Binding {
    this.assert();
    return this.client.sessionBinding;
  }
  private assert(): void {
    this.context.assertActive();
    if (this.closed) throw new Error("disconnected");
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const token of this.sessions.values()) token.revoked = true;
    await this.client.close();
  }
  /** 控制消息不能被等待实体确认的支付挡住。 */
  async control(
    op: "system.query" | "system.cancel",
    requestId: number,
    requestCommitment: Uint8Array,
  ): Promise<Value> {
    this.assert();
    const body = { requestId, commitment: requestCommitment.slice() };
    const result = await this.client.execute(
      op,
      body,
      await commitment("system", 1, { op, ...body }),
    );
    this.assert();
    return result;
  }
  /** 状态查询走独立控制消息；awaiting-user 来自设备，不能由主机猜测。 */
  async activity(): Promise<HardwareOperationActivity | undefined> {
    this.assert();
    const active = this.activeOperation;
    if (!active) return this.lastOperation ? {...this.lastOperation} : undefined;
    const result = object(await this.control("system.query", active.requestId, active.commitment), ["state", "payload"]);
    this.assert();
    if (this.activeOperation !== active) return this.lastOperation ? {...this.lastOperation} : undefined;
    const state = result.state;
    if (state !== "awaiting-user" && state !== "executing" && state !== "completed" && state !== "denied" && state !== "cancelled" && state !== "unknown") throw Error("invalid-request-state");
    return {operation: active.operation, state};
  }
  private async submitOperation(op: string, body: Value, hash: Uint8Array,
    allocated?: (requestId: number) => void): Promise<Value> {
    this.assert();
    const request = this.client.submit(op, body, hash);
    const active = {operation: op, requestId: request.requestId, commitment: hash.slice()};
    this.activeOperation = active;
    try {
      allocated?.(request.requestId);
      const result = await request.result;
      let state: HardwareOperationActivity["state"] = "completed";
      if (result && typeof result === "object" && !Array.isArray(result) && !(result instanceof Uint8Array) && "error" in result) {
        state = result.error === "denied" ? "denied" : result.error === "cancelled" ? "cancelled" : "failed";
      }
      this.lastOperation = {operation: op, state}; return result;
    } catch (error) { this.lastOperation = {operation: op, state: "unknown"}; throw error; }
    finally { if (this.activeOperation === active) this.activeOperation = undefined; }
  }
  signP2pkh(input: PaymentInput): Promise<HardwarePaymentResult> {
    this.assert();
    // 先冻结再排队，禁止业务页面在等待期间修改输出或前序证据。
    const frozen = structuredClone(input);
    return this.enqueuePayment(frozen.sessionId, () => this.executePayment(frozen));
  }
  signFeePool(
    input: PaymentInput & {
      family: "connect" | "bitfs";
      stage: "fund" | "state";
      role?: "payer" | "cosigner";
      authorization?: {document:Uint8Array;refundTemplate:Uint8Array};
      openingRequest?:Uint8Array;
    },
  ): Promise<HardwarePaymentResult> {
    const frozen = structuredClone(input);
    return this.enqueuePayment(frozen.sessionId, async () => {
      if (frozen.network !== this.context.bsvNetwork) throw Error("unsupported-network");
      if(frozen.authorization&&(frozen.family!=="bitfs"||frozen.stage!=="state"||(frozen.role&&frozen.role!=="payer")))throw Error("invalid-authorization");
      if(frozen.openingRequest&&(frozen.family!=="bitfs"||frozen.stage!=="state"||frozen.role!=="cosigner"||frozen.authorization||frozen.prevTransactions.length))throw Error("invalid-opening");
      const review = frozen.openingRequest ? await inspectBitfsOpening(frozen.rawTx,frozen.openingRequest,this.pub) : frozen.authorization ? await inspectBitfsAuthorization(frozen.rawTx,frozen.prevTransactions,this.pub,frozen.authorization) : await inspectFeePool(
        frozen.rawTx,
        frozen.prevTransactions,
        this.pub,
        frozen.family,
        frozen.stage,
        frozen.role,
      );
      let amount = 0n;
      if (review.pool) {
        const old = object(
          await this.request("payment.pool-read", "payment-pool-read", {
            poolId: review.pool.id,
          }),
          ["poolId", "paid", "binding"],
        );
        if (
          old.poolId !== review.pool.id ||
          (old.binding !== null &&
            (!(old.binding instanceof Uint8Array) ||
              !equal(old.binding, review.pool.binding)))
        )
          throw Error("pool-conflict");
        const previous =
          typeof old.paid === "bigint"
            ? old.paid
            : typeof old.paid === "number" &&
                Number.isSafeInteger(old.paid) &&
                old.paid >= 0
              ? BigInt(old.paid)
              : undefined;
        if (previous === undefined || previous < 0n || previous > review.paid || (old.binding === null && previous !== 0n))
          throw Error("payment-rollback");
        amount = review.paid - previous;
      }
      const body = {
        rawTx: frozen.rawTx,
        prevTransactions: frozen.prevTransactions,
        channelId: frozen.channelId,
        paymentId: frozen.paymentId,
        sessionId: frozen.sessionId,
        stage: frozen.stage,
        ...(frozen.role ? {role: frozen.role} : {}),
        ...(frozen.authorization ? {authorization:frozen.authorization} : {}),
        ...(frozen.openingRequest ? {openingRequest:frozen.openingRequest} : {}),
      };
      const profile = frozen.openingRequest ? "bsv-feepool-bitfs-opening" : frozen.authorization ? "bsv-feepool-bitfs-authorization" : `bsv-feepool-${frozen.family}`,
        hash = await commitment(profile, 1, { ...body, amount });
      const result = await this.submitPayment(frozen.openingRequest ? "tx.feepool-bitfs-opening" : frozen.authorization ? "tx.feepool-bitfs-authorize" : `tx.feepool-${frozen.family}`, body, hash, frozen.sessionId);
      this.assert();
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        !(result instanceof Uint8Array) &&
        "error" in result
      )
        throw Error(String(result.error));
      const response = object(result, ["signatures", "amount"]);
      if (
        (typeof response.amount !== "bigint" &&
          (typeof response.amount !== "number" || !Number.isSafeInteger(response.amount) || response.amount < 0)) ||
        BigInt(response.amount as bigint | number) !== amount ||
        !Array.isArray(response.signatures) ||
        response.signatures.length !== review.digests.length
      )
        throw Error("invalid-response");
      const signatures = response.signatures.map((sig, i) => {
        if (
          !(sig instanceof Uint8Array) ||
          (!frozen.authorization && sig.at(-1) !== 0x41) ||
          !secpIdentityVerifier.verify(
            review.digests[i]!,
            frozen.authorization ? sig : sig.subarray(0, -1),
            this.pub,
          )
        )
          throw Error("invalid-signature");
        return sig.slice();
      });
      return { signatures, amount, fee: review.fee };
    });
  }
  signStandard(input: PaymentInput): Promise<HardwarePaymentResult> {
    const frozen = structuredClone(input);
    return this.enqueuePayment(frozen.sessionId, async () => {
      if (frozen.network !== this.context.bsvNetwork) throw Error("unsupported-network");
      const review = await inspectStandard(frozen.rawTx, frozen.prevTransactions, this.pub);
      const body = {rawTx: frozen.rawTx, prevTransactions: frozen.prevTransactions, channelId: frozen.channelId, paymentId: frozen.paymentId, sessionId: frozen.sessionId};
      const value = await this.submitPayment("tx.standard-payment", body, await commitment("bsv-standard-payment", 1, {...body, amount: review.amount}), frozen.sessionId);
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && "error" in value) throw Error(String(value.error));
      const result = object(value, ["signatures", "amount"]);
      this.assert();
      if ((typeof result.amount !== "bigint" && (typeof result.amount !== "number" || !Number.isSafeInteger(result.amount) || result.amount < 0)) || BigInt(result.amount as bigint | number) !== review.amount || !Array.isArray(result.signatures) || result.signatures.length !== review.digests.length) throw Error("invalid-response");
      const signatures = result.signatures.map((sig, i) => {
        if (!(sig instanceof Uint8Array) || sig.at(-1) !== 0x41 || !secpIdentityVerifier.verify(review.digests[i]!, sig.subarray(0, -1), this.pub)) throw Error("invalid-signature");
        return sig.slice();
      });
      return {signatures, amount: review.amount, fee: review.fee};
    });
  }
  sealLocalSecret(scope: string, plaintext: Uint8Array): Promise<LocalSecretV3> {
    validateLocalScope(scope);
    if (!(plaintext instanceof Uint8Array) || !plaintext.length || plaintext.length>512) throw Error("invalid-secret");
    const copy=plaintext.slice();
    try {return this.enqueue(async()=>{
      try{return validateLocalSecret(await this.request("local-secret.seal","local-secret-v3",{scope,plaintext:copy}));}
      finally{copy.fill(0);}
    }).finally(()=>copy.fill(0));}catch(error){copy.fill(0);throw error;}
  }
  openLocalSecret(scope: string, sealed: LocalSecretV3): Promise<Uint8Array> {
    validateLocalScope(scope);const frozen=validateLocalSecret(sealed);
    return this.enqueue(async()=>{
      const result=object(await this.request("local-secret.open","local-secret-v3",{scope,sealed:frozen as unknown as Value}),["plaintext"]);
      if(!(result.plaintext instanceof Uint8Array)||!result.plaintext.length||result.plaintext.length>512)throw Error("invalid-secret");
      return result.plaintext;
    });
  }
  /** Public ledger snapshot for migration. The whole transfer owns the queue;
   * verify every chunk's full-bank hash before returning any policy data. */
  exportPaymentPolicy():Promise<Uint8Array> {
    this.assert();return this.enqueue(async()=>{
      let offset=0,size:number|undefined,hash:Uint8Array|undefined,output:Uint8Array|undefined;
      while(size===undefined||offset<size){
        this.assert();const r=object(await this.request("payment.policy-export","payment-policy-export",{offset,length:8192}),["offset","size","sha256","chunk"]);this.assert();
        const integer=(v:Value|undefined)=>{if((typeof v!=="number"&&typeof v!=="bigint")||!Number.isSafeInteger(Number(v))||Number(v)<0)throw Error("invalid-policy-result");return Number(v);};
        const receivedSize=integer(r.size);
        if(integer(r.offset)!==offset||receivedSize<1||receivedSize>65536||!(r.sha256 instanceof Uint8Array)||r.sha256.length!==32||!(r.chunk instanceof Uint8Array)||r.chunk.length<1||r.chunk.length>8192||offset+r.chunk.length>receivedSize)throw Error("invalid-policy-result");
        if(size===undefined){size=receivedSize;hash=new Uint8Array(r.sha256);output=new Uint8Array(size);}
        if(size!==receivedSize||!equal(hash!,r.sha256))throw Error("policy-changed");
        output!.set(r.chunk,offset);offset+=r.chunk.length;
      }
      if(!equal(await sha256(output!),hash!))throw Error("invalid-policy-result");this.assert();
      // Decode validates identity, every accounting invariant and known fields.
      return encodePaymentPolicy(decodePaymentPolicy(output!,this.context.publicKeyHex),this.context.publicKeyHex);
    },true);
  }
  /** Public progress only. A status reply must subsequently be matched to the
   * host's durable journal; it neither authorizes nor finishes a migration. */
  migrationStatus():Promise<DeviceMigrationRecord|null> {
    this.assert();return this.enqueue(async()=>{
      const result=object(await this.request("migration.status","key-migration-status",{}),["migration"]);
      this.assert();
      if(result.migration===null)return null;
      const state=inspectDeviceMigration(result.migration);
      if(!equal(state.publicKey,this.pub))throw Error("migration-conflict");
      return state;
    },true);
  }
  /** Coordinator Worker only. The caller owns the returned secret and MUST wipe
   * it after creating/verifying the new password-encrypted KeyHold. Never expose
   * this result on Window/plugin RPC. Device export must be armed locally first. */
  exportMigrationKey(binding: Omit<DeviceMigrationRecord,"version"|"phase"|"targetHash">):Promise<{privateKey:Uint8Array;migration:DeviceMigrationRecord}> {
    const expected=inspectDeviceMigration({...binding,version:1,phase:"staged",targetHash:null});
    if(expected.direction!=="to-software"||!equal(expected.publicKey,this.pub))throw Error("migration-conflict");
    return this.enqueue(async()=>{
      let secret:Uint8Array|undefined,identity:DeviceIdentityKey|undefined;
      try {
        const raw=await this.request("migration.export","key-migration-export",{
          id:expected.id,walletGeneration:expected.walletGeneration,sourceHash:expected.sourceHash,policyHash:expected.policyHash});
        // Capture before field validation so extra/missing fields cannot retain a secret.
        if(raw&&typeof raw==="object"&&!Array.isArray(raw)&&!(raw instanceof Uint8Array)&&raw.privateKey instanceof Uint8Array)secret=raw.privateKey;
        const result=object(raw,["privateKey","migration"]);
        if(!secret||secret.length!==32)throw Error("invalid-key");
        const state=inspectDeviceMigration(result.migration);assertDeviceMigrationBinding(state,expected);
        if(state.phase!=="device-committed")throw Error("migration-conflict");
        identity=new DeviceIdentityKey(secret);
        if(!equal(identity.publicKey(),this.pub))throw Error("migration-conflict");
        this.assert();const output={privateKey:secret,migration:state};secret=undefined;return output;
      } finally {identity?.close();secret?.fill(0);}
    },true);
  }
  /** Send only after the real IndexedDB transaction has committed key, policy
   * and journal. A public acknowledgement never authorizes device erasure. */
  acknowledgeMigration(binding:DeviceMigrationRecord,targetHash:Uint8Array):Promise<DeviceMigrationRecord> {
    return this.migrationTransition("migration.host-commit","key-migration-host-commit",binding,targetHash,"host-committed");
  }
  /** Separate device PIN + once-only physical approval; no browser confirmation
   * or previous export approval can substitute for this step. */
  eraseMigrationSource(binding:DeviceMigrationRecord,targetHash:Uint8Array):Promise<DeviceMigrationRecord> {
    return this.migrationTransition("migration.erase","key-migration-erase",binding,targetHash,"erased");
  }
  private migrationTransition(op:string,profile:string,binding:DeviceMigrationRecord,targetHash:Uint8Array,phase:DeviceMigrationRecord["phase"]):Promise<DeviceMigrationRecord> {
    const expected=inspectDeviceMigration(binding),target=new Uint8Array(targetHash);
    if(target.length!==32||expected.direction!=="to-software"||!equal(expected.publicKey,this.pub)
      ||(expected.targetHash!==null&&!equal(expected.targetHash,target)))throw Error("migration-conflict");
    return this.enqueue(async()=>{
      const result=object(await this.request(op,profile,{id:expected.id,targetHash:target}),["migration"]);
      const state=inspectDeviceMigration(result.migration);assertDeviceMigrationBinding(state,expected);
      if(state.phase!==phase||state.targetHash===null||!equal(state.targetHash,target))throw Error("migration-conflict");
      this.assert();return state;
    },true);
  }
  signConnectEnvelope(kind: ConnectEnvelopeKind, envelope: Uint8Array, content: Uint8Array | undefined, appSessionId: string): Promise<Uint8Array> {
    this.assert();
    const body: Value = kind === "identity" ? {envelope:envelope.slice()} : {envelope:envelope.slice(),content:content?.slice() ?? new Uint8Array()};
    return this.enqueuePayment(appSessionId,async()=>{
      const review=await inspectConnectEnvelope(kind,body,this.pub,this.context.bsvNetwork);
      this.assert();this.paymentGuard?.();
      const hash=await commitment(`connect-${kind}-envelope`,1,body);
      const result=object(await this.submitPayment(`connect.${kind}-sign`,body,hash,appSessionId),["publicKey","signature"]);
      this.assert();this.paymentGuard?.();
      if(!(result.publicKey instanceof Uint8Array)||!equal(result.publicKey,this.pub)||!(result.signature instanceof Uint8Array))throw Error("invalid-signature");
      return connectCompactSignature(result.signature,review.digest,this.pub);
    });
  }
  /** Complete semantic objects only; no digest or shared-secret escape hatch. */
  channelOperation(kind: ChannelOperationKind, message: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    this.assert();const frozen=new Uint8Array(message);
    return this.enqueue(async()=>{
      const guard=()=>{this.assert();if(signal?.aborted)throw Error("channel-cancelled");};guard();
      const review=kind==="seal"?await inspectSignedChannel(frozen,this.pub):kind==="open"?undefined:await inspectChannel(kind as ChannelKind,frozen,this.pub);
      const envelope=kind==="open"?inspectInboxEnvelope(frozen,this.pub):undefined;
      guard();const body:Value={message:frozen};const hash=await commitment(`bsv8-channel-${kind}`,1,body);
      const operation=kind==="public"?"channel.public-message":kind==="hash"?"channel.hash-request":kind==="private"?"channel.private-message":`channel.${kind}`;
      let requestId:number|undefined;
      const cancel=()=>{if(requestId!==undefined)void this.control("system.cancel",requestId,hash).catch(()=>{});};
      signal?.addEventListener("abort",cancel,{once:true});
      let output:Uint8Array|undefined;
      try {
        guard();const result=await this.submitOperation(operation,body,hash,id=>{requestId=id;if(signal?.aborted)cancel();});
        if(result&&typeof result==="object"&&!Array.isArray(result)&&!(result instanceof Uint8Array)&&result.message instanceof Uint8Array)output=result.message;
        guard();
        if(result&&typeof result==="object"&&!Array.isArray(result)&&!(result instanceof Uint8Array)&&"error" in result)throw Error(String(result.error));
        if(kind==="seal"||kind==="open") {
          const value=object(result,["message"]);if(!(value.message instanceof Uint8Array))throw Error("invalid-channel-result");output=value.message;
          if(kind==="seal") {
            const encoded=parseCanonicalJson(output);
            if(!encoded||typeof encoded!=="object"||Array.isArray(encoded)||encoded.from_public_key!==this.context.publicKeyHex||encoded.channel!==review?.channel)throw Error("invalid-channel-result");
            // Validate the envelope with its recipient, not with our sender key.
            inspectInboxEnvelope(output,unhex(review!.peer!));
          }else {await inspectSignedChannel(output,unhex(String(envelope!.from_public_key)));const opened=parseCanonicalJson(output);
            if(!opened||typeof opened!=="object"||Array.isArray(opened)||opened.channel!==envelope!.channel)throw Error("invalid-channel-result");}
        }else {
          const value=object(result,["publicKey","signature"]);
          if(!(value.publicKey instanceof Uint8Array)||!equal(value.publicKey,this.pub)||!(value.signature instanceof Uint8Array))throw Error("invalid-signature");
          verifyChannelSignature(value.signature,review!.digest,this.pub);output=value.signature;
        }
        guard();return output;
      }catch(error){output?.fill(0);throw error;}
      finally{signal?.removeEventListener("abort",cancel);}
    });
  }
  signNetworkIdentity(kind:NetworkIdentityKind,body:Value,signal?:AbortSignal):Promise<Uint8Array> {
    this.assert();const frozen=structuredClone(body);
    return this.enqueue(async()=>{
      const guard=()=>{this.assert();if(signal?.aborted)throw Error("identity-cancelled");};guard();
      const review=await inspectNetworkIdentity(kind,frozen,this.pub);guard();const hash=await commitment(`libp2p-identity-${kind}`,1,frozen);guard();
      let requestId:number|undefined;const cancel=()=>{if(requestId!==undefined)void this.control("system.cancel",requestId,hash).catch(()=>{});};
      signal?.addEventListener("abort",cancel,{once:true});
      try {
        guard();const payload=await this.submitOperation(kind==="noise"?"identity.noise-proof":"identity.peer-record",frozen,hash,id=>{requestId=id;if(signal?.aborted)cancel();});guard();
        if(payload&&typeof payload==="object"&&!Array.isArray(payload)&&!(payload instanceof Uint8Array)&&"error" in payload)throw Error(String(payload.error));
        const result=object(payload,["publicKey","signature"]);
        if(!(result.publicKey instanceof Uint8Array)||!equal(result.publicKey,this.pub)||!(result.signature instanceof Uint8Array))throw Error("invalid-signature");
        verifyChannelSignature(result.signature,review.digest,this.pub);return result.signature;
      }finally{signal?.removeEventListener("abort",cancel);}
    });
  }
  signBitfsWire(kind:number, document:Uint8Array, signal?:AbortSignal):Promise<Uint8Array> {
    this.assert();const body:Value={kind,document:new Uint8Array(document)};
    return this.enqueue(async()=>{
      const guard=()=>{this.assert();if(signal?.aborted)throw Error("bitfs-cancelled");};guard();
      const review=await inspectBitfsWire(body,this.pub);guard();const hash=await commitment("bitfs-wire-document",1,body);guard();
      if(review.kind===5)throw Error("payment-context-required");
      let requestId:number|undefined;const cancel=()=>{if(requestId!==undefined)void this.control("system.cancel",requestId,hash).catch(()=>{});};
      signal?.addEventListener("abort",cancel,{once:true});
      try {
        guard();const payload=await this.submitOperation("bitfs.wire-sign",body,hash,id=>{requestId=id;if(signal?.aborted)cancel();});guard();
        if(payload&&typeof payload==="object"&&!Array.isArray(payload)&&!(payload instanceof Uint8Array)&&"error" in payload)throw Error(String(payload.error));
        const result=object(payload,["publicKey","signature"]);
        if(!(result.publicKey instanceof Uint8Array)||!equal(result.publicKey,this.pub)||!(result.signature instanceof Uint8Array))throw Error("invalid-signature");
        verifyChannelSignature(result.signature,review.digest,this.pub);return result.signature;
      }finally{signal?.removeEventListener("abort",cancel);}
    });
  }
  /** 取消未签请求，不关闭 App 预算；不能等待支付 FIFO，否则会被设备确认阻塞。 */
  async cancelAppRequests(sessionId: string): Promise<void> {
    this.assert();
    const token = this.sessions.get(sessionId);
    if (token) token.revoked = true;
    const active = this.activePayment;
    if (active?.sessionId === sessionId) {
      // 使用 submit 实际分配的 ID 和原承诺，不能猜心跳占用的请求编号。
      await this.control("system.cancel", active.requestId, active.commitment);
      this.assert();
    }
  }
  private enqueuePayment<T>(sessionId: string | null, execute: () => Promise<T>): Promise<T> {
    let token: {revoked: boolean} | undefined;
    if (sessionId !== null) {
      token = this.sessions.get(sessionId);
      if (!token || token.revoked) {
        if (!token && this.sessions.size >= 16) throw Error("capacity");
        token = {revoked: false}; this.sessions.set(sessionId, token);
      }
    }
    const guard = () => { this.assert(); if (token?.revoked) throw Error("payment-cancelled"); };
    return this.enqueue(async () => {
      guard(); this.paymentGuard = guard;
      try { const result = await execute(); guard(); return result; }
      finally { this.paymentGuard = undefined; }
    });
  }
  private async submitPayment(op: string, body: Value, hash: Uint8Array, sessionId: string | null): Promise<Value> {
    this.paymentGuard?.();
    let active: NonNullable<typeof this.activePayment> | undefined;
    try {
      const result = await this.submitOperation(op, body, hash, requestId => {
        active = {sessionId, requestId, commitment: hash.slice()}; this.activePayment = active;
      });
      this.paymentGuard?.(); return result;
    } finally { if (this.activePayment === active) this.activePayment = undefined; }
  }

  private enqueue<T>(execute: () => Promise<T>, migration = false): Promise<T> {
    this.assert();
    if(this.migrationOwned&&!migration)throw Error("migration-pending");
    if (this.queued >= 16) throw new Error("busy");
    this.queued++;
    const task = this.tail.then(() => {
      this.assert();
      if(this.migrationOwned&&!migration)throw Error("migration-pending");
      return execute();
    });
    this.tail = task.catch(() => {});
    return task.finally(() => {
      this.queued--;
    });
  }
  private async request(
    op: string,
    profile: string,
    body: Value,
  ): Promise<Value> {
    this.assert();
    const hash = await commitment(profile, 1, body);
    this.assert();
    const observable = op === "payment.configure" || op === "payment.session-open" || op.startsWith("local-secret.") || op === "migration.export" || op === "migration.erase";
    const value = await (observable ? this.submitOperation(op, body, hash) : this.client.execute(op, body, hash));
    try{this.assert();}catch(error){
      if((op==="local-secret.open"||op==="migration.export") && value && typeof value==="object" && !(value instanceof Uint8Array) && !Array.isArray(value) && (value.plaintext instanceof Uint8Array||value.privateKey instanceof Uint8Array)){if(value.plaintext instanceof Uint8Array)value.plaintext.fill(0);if(value.privateKey instanceof Uint8Array)value.privateKey.fill(0);}
      throw error;
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array) &&
      "error" in value
    )
      throw new Error(String(value.error));
    return value;
  }
  configureChannel(config: ChannelConfig): Promise<void> {
    const frozen = structuredClone(config);
    if(frozen.network!==this.context.bsvNetwork)throw Error("network-identity-mismatch");
    return this.enqueue(async () => {
      const result = object(
        await this.request(
          "payment.configure",
          "payment-config",
          frozen as unknown as Value,
        ),
        ["configured", "revision"],
      );
      if (result.configured !== true || result.revision !== frozen.revision)
        throw new Error("invalid-config-response");
    });
  }
  startAppSession(sessionId: string, owner: string): Promise<Value> {
    return this.enqueue(() =>
      this.request("payment.session-open", "payment-session", {
        sessionId,
        owner,
      }),
    );
  }
  async closeAppSession(sessionId: string): Promise<void> {
    await this.cancelAppRequests(sessionId);
    return this.enqueue(async () => {
      const result = object(await this.request("payment.session-close", "payment-session-close", {sessionId}), ["closed"]);
      if (result.closed !== true) throw new Error("invalid-session-response");
    });
  }
  listChannels(): Promise<Value> {
    return this.enqueue(() => this.request("payment.channel-list", "payment-channel-list", {}));
  }
  readChannel(channelId: string): Promise<Value> {
    return this.enqueue(() =>
      this.request("payment.channel-read", "payment-channel-read", {
        channelId,
      }),
    );
  }
  readAppSession(sessionId: string): Promise<Value> {
    return this.enqueue(() =>
      this.request("payment.session-read", "payment-session-read", {
        sessionId,
      }),
    );
  }
  private async executePayment(
    input: PaymentInput,
  ): Promise<HardwarePaymentResult> {
    this.assert();
    if (input.network !== this.context.bsvNetwork) throw new Error("unsupported-network");
    if (!input.channelId || !input.paymentId)
      throw new Error("channel-required");
    const review = await inspectP2pkh(
      input.rawTx,
      input.prevTransactions.map((transaction) => ({ transaction })),
      this.pub,
      0,
    );
    const body = {
      rawTx: input.rawTx,
      prevTransactions: input.prevTransactions,
      channelId: input.channelId,
      paymentId: input.paymentId,
      sessionId: input.sessionId,
    };
    const hash = await commitment("bsv-payment-context", 1, {
      ...body,
      amount: review.amount,
    });
    this.assert();
    const result = await this.submitPayment("tx.p2pkh-payment", body, hash, input.sessionId);
    this.assert();
    if (
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      !(result instanceof Uint8Array) &&
      "error" in result
    ) {
      throw new Error(String(result.error));
    }
    const response = object(result, ["signatures", "amount"]);
    const returnedAmount =
      typeof response.amount === "bigint"
        ? response.amount
        : typeof response.amount === "number" &&
            Number.isSafeInteger(response.amount) &&
            response.amount >= 0
          ? BigInt(response.amount)
          : undefined;
    if (returnedAmount !== review.amount) throw new Error("invalid-amount");
    const tx = parseTransaction(input.rawTx);
    if (
      !Array.isArray(response.signatures) ||
      response.signatures.length !== tx.inputs.length
    )
      throw new Error("invalid-signatures");
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
      const sig = response.signatures[i];
      if (!(sig instanceof Uint8Array)) throw new Error("invalid-signatures");
      const prior = parseTransaction(input.prevTransactions[i]!);
      const digest = await p2pkhSighash(
        tx,
        i,
        prior.outputs[tx.inputs[i]!.vout]!,
      );
      // 严格验证实际对象的 DER 签名；设备响应不是可直接广播的可信布尔值。
      if (
        sig.length < 9 ||
        sig[sig.length - 1] !== 0x41 ||
        !secpIdentityVerifier.verify(digest, sig.subarray(0, -1), this.pub)
      )
        throw new Error("invalid-signature");
      signatures.push(sig.slice());
    }
    this.assert();
    return { signatures, amount: review.amount, fee: review.fee };
  }
}
