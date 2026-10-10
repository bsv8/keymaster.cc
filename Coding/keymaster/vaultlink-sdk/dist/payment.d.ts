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
    version: 2 | 3;
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
    /** 只允许执行权威在确定未执行时释放；App/普通插件不得调用此内部方法。 */
    releaseUnexecuted(requestId: string): Promise<void>;
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
/** owned 必须来自实际脚本与当前 Key 的核验，不使用主机 change 标记。矿工费不占额度。 */
export declare function externalOutputAmount(outputs: readonly Output[]): bigint;
/** 费用池累计更新仅按核验后的对外付款增量；同池连续状态验证由 Profile 负责。 */
export declare function poolPaymentDelta(previous: bigint, next: bigint): bigint;
export declare const paymentCommitmentId: (b: Uint8Array) => string;
export {};
