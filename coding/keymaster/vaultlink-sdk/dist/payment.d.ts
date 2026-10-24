import { type SigningChannel, type SigningMode } from "./signing-channel.js";
export type OwnerKind = "app" | "plugin";
export interface ChannelConfig {
    id: string;
    owner: string;
    kind: OwnerKind;
    network: string;
    paymentType: string;
    enabled: boolean;
    singleLimit: bigint;
    defaultSessionLimit: bigint;
    revision: number;
}
interface Session {
    id: string;
    owner: string;
    limit: bigint;
    used: bigint;
    revision: number;
    active: boolean;
    archivedUsed?: bigint;
}
interface Pending {
    id: string;
    sessionId: string | null;
    channelId: string;
    amount: bigint;
    commitment: Uint8Array;
    configRevision: number;
    sessionRevision: number;
    state: "reserved" | "signed" | "unknown" | "released";
    pool?: PoolInspection;
}
export interface PoolInspection {
    id: string;
    binding: Uint8Array;
    previousPaid: bigint;
    paid: bigint;
}
interface PoolState {
    archivedPaid?: bigint;
    id: string;
    binding: Uint8Array;
    paid: bigint;
}
export interface PaymentInspection {
    requestId: string;
    channelId: string;
    owner: string;
    kind: OwnerKind;
    sessionId: string | null;
    network: string;
    paymentType: string;
    amount: bigint;
    commitment: Uint8Array;
    pool?: PoolInspection;
    /** Trusted typed verifier only: funded pool state, never wallet funding. */
    operation?: "internal-pool-state";
}
export interface Quote {
    reasons: readonly ("disabled" | "single-limit" | "session-limit")[];
    amount: bigint;
    used: bigint;
    singleLimit: bigint;
    sessionLimit: bigint | null;
    configRevision: number;
    sessionRevision: number;
}
export interface Approval {
    requestCommitment: Uint8Array;
    configRevision: number;
    sessionRevision: number;
    raiseSessionLimit?: bigint;
}
export interface PolicySnapshot {
    version: 2 | 3 | 4;
    network?: "main" | "test";
    signing?: SigningChannel[];
    archive?: {
        payments: ArchiveEntry[];
        sessions: ArchiveSessionEntry[];
    };
    key: string;
    channels: ChannelConfig[];
    sessions: Session[];
    pending: Pending[];
    pools: PoolState[];
}
export interface ArchiveSessionEntry extends ArchiveEntry {
    record: Session;
}
export interface ArchiveEntry {
    idHash: Uint8Array;
    recordHash: Uint8Array;
}
export declare function policyArchiveId(id: string): Uint8Array;
export declare function policyArchiveRecord(value: unknown): Uint8Array;
/** 宿主必须保证原子持久替换成功才返回；失败/未知必须 throw，禁止降级到内存。 */
export interface PolicyStore {
    load(): Promise<PolicySnapshot | null>;
    save(snapshot: PolicySnapshot): Promise<void>;
}
/** 单实例执行权威。所有 read/check/reserve/commit 串行；存储失败后永久失效，防止不确定落盘后重用额度。 */
export declare class PaymentPolicy {
    private store;
    private state;
    private alive;
    private tail;
    private constructor();
    static open(store: PolicyStore, key: string): Promise<PaymentPolicy>;
    private run;
    private persist;
    /** Compact only terminal records. Exact hash tombstones retain replay
     * exclusion and source-bank continuation; unknown outcomes never disappear.
     * Active session and pool totals remain unchanged, with accounted archived
     * subtotals used by startup validation. Capacity remains fail closed. */
    private compact;
    configure(c: ChannelConfig, confirmed: boolean): Promise<void>;
    startSession(sessionId: string, owner: string, confirmed: boolean): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    quote(p: PaymentInspection): Promise<Quote>;
    inspectPool(poolId: string, binding: Uint8Array, paid: bigint): Promise<{
        amount: bigint;
        pool: PoolInspection;
    }>;
    reserve(p: PaymentInspection, approval?: Approval): Promise<Quote>;
    /** 在不可逆签名之前调用；配置/会话过期则拒绝，不能靠提前 quote 放行。 */
    assertExecutable(requestId: string): Promise<void>;
    markSigned(requestId: string): Promise<void>;
    markUnknown(requestId: string): Promise<void>;
    private setState;
    /**
     * 只允许受信执行权威在持有绑定该 request 的未签终止证明时，释放
     * 重启后已变为 unknown 的预占。普通 App/插件不可到达此方法。
     * 已签/部分签名的 request 必须拒绝。
     */
    releaseUnknownProven(requestId: string): Promise<void>;
    /** 只允许执行权威在确定未执行时释放；App/普通插件不得调用此内部方法。 */
    releaseUnexecuted(requestId: string): Promise<void>;
    /** 与支付账本原子存储；已知操作自动注册，重复注册不能替换身份。 */
    registerSigning(channels: SigningChannel[], network: "main" | "test", confirmed: boolean): Promise<SigningChannel[]>;
    /** 调用者只能是钱包设置入口；主机协议不能转发这个能力给硬件。 */
    configureSigning(id: string, mode: SigningMode, expectedRevision: number): Promise<void>;
    signingChannel(channelId: string, operation: string, network: "main" | "test"): Promise<SigningChannel>;
    snapshot(): Promise<PolicySnapshot>;
    lock(): void;
    private session;
    private pending;
    private inspectCopy;
    private evaluate;
    /** Migration codecs use the same ledger invariants as normal startup; no
     * importing an empty replacement to recover from malformed state. */
    static inspectSnapshot(snapshot: PolicySnapshot, key: string): PolicySnapshot;
    private static validate;
}
export interface Output {
    amount: bigint;
    owned: boolean;
}
/** Output-only net business value. NOT wallet spend or an approval amount:
 * it cannot account for fees without verified inputs. Inspectors compute spend
 * as owned inputs minus all own P2PKH outputs instead. */
export declare function externalOutputAmount(outputs: readonly Output[]): bigint;
/** 费用池累计更新仅按核验后的对外付款增量；同池连续状态验证由 Profile 负责。 */
export declare function poolPaymentDelta(previous: bigint, next: bigint): bigint;
export declare const paymentCommitmentId: (b: Uint8Array) => string;
export {};
