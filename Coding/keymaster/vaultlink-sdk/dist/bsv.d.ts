import { type Value } from './cbor.js';
/** 地址只从已核验的实际 P2PKH 输出生成，不采用主机给出的收款方标签。 */
export declare function p2pkhOutputAddress(script: Uint8Array, network: "main" | "test"): Promise<string>;
export interface TxInput {
    txid: Uint8Array;
    vout: number;
    script: Uint8Array;
    sequence: number;
}
export interface TxOutput {
    satoshis: bigint;
    script: Uint8Array;
}
export interface Transaction {
    version: number;
    inputs: TxInput[];
    outputs: TxOutput[];
    locktime: number;
}
export interface PrevoutEvidence {
    transaction: Uint8Array;
}
export interface BsvReview {
    publicKey: Uint8Array;
    externalOutputs: TxOutput[];
    change: bigint;
    fee: bigint;
    amount: bigint;
    digest: Uint8Array;
    inputIndex: number;
}
export declare function p2pkhScript(pub: Uint8Array): Uint8Array;
/** 不接受 witness/非最短 CompactSize、超大前序或未知脚本；前序真实性靠 txid/outpoint 字节绑定，不声称链上状态。 */
export declare function parseTransaction(raw: Uint8Array, maxBytes?: number): Transaction;
export declare function serializeTransaction(tx: Transaction): Uint8Array;
/** 仅计算规范交易摘要；不产生签名，也不代替完整前序输出核验。 */
export declare function forkIdAllSighash(tx: Transaction, inputIndex: number, prev: TxOutput): Promise<Uint8Array>;
export declare function p2pkhSighash(tx: Transaction, inputIndex: number, prev: TxOutput): Promise<Uint8Array>;
export declare function inspectP2pkh(raw: Uint8Array, evidence: PrevoutEvidence[], publicKey: Uint8Array, inputIndex: number): Promise<BsvReview>;
/** 设备内部 KeyProvider：只签已经重新解析的 P2PKH 或域隔离持有权，普通 SDK 无 signHash/getPrivateKey。 */
export declare class DeviceIdentityKey {
    private key;
    private closed;
    constructor(privateKey: Uint8Array);
    publicKey(): Uint8Array;
    signP2pkh(raw: Uint8Array, evidence: PrevoutEvidence[], inputIndex: number, authorize: (review: BsvReview) => Promise<boolean>, signal?: AbortSignal): Promise<{
        review: BsvReview;
        signature: Uint8Array;
    }>;
    signAllP2pkh(raw: Uint8Array, evidence: PrevoutEvidence[], signal: AbortSignal, beforeSign: () => Promise<void>): Promise<Uint8Array[]>;
    /** 费用池签名仍从完整交易证据计算，绝不开放任意摘要签名接口。 */
    signAllFeePool(raw: Uint8Array, previous: Uint8Array[], family: import("./feepool.js").FeePoolFamily, stage: import("./feepool.js").FeePoolStage, signal: AbortSignal, beforeSign: () => Promise<void>): Promise<Uint8Array[]>;
    provePossession(transcript: Uint8Array, sessionId: number, challenge: Uint8Array): Promise<Uint8Array>;
    signConnectEnvelope(kind: import("./connect-envelope.js").ConnectEnvelopeKind, body: import("./cbor.js").Value, signal: AbortSignal, authorize: (review: import("./connect-envelope.js").ConnectEnvelopeReview) => Promise<boolean>): Promise<Uint8Array>;
    reviewChannel(kind: import('./channel.js').ChannelOperationKind, raw: Uint8Array): Promise<import('./channel.js').ChannelReview>;
    signChannel(kind: import('./channel.js').ChannelKind, raw: Uint8Array, signal: AbortSignal, authorize: (review: import('./channel.js').ChannelReview) => Promise<boolean>): Promise<Uint8Array>;
    sealChannel(raw: Uint8Array, signal: AbortSignal, authorize: (review: import('./channel.js').ChannelReview) => Promise<boolean>): Promise<Uint8Array>;
    openChannel(raw: Uint8Array, signal: AbortSignal, authorize: (review: import('./channel.js').ChannelReview) => Promise<boolean>): Promise<Uint8Array>;
    signNetworkIdentity(kind: import('./network-identity.js').NetworkIdentityKind, body: Value, signal: AbortSignal, authorize: (review: import('./network-identity.js').NetworkIdentityReview) => Promise<boolean>): Promise<Uint8Array>;
    signBitfsWire(body: Value, signal: AbortSignal, authorize: (review: import('./bitfs-wire.js').BitfsWireReview) => Promise<boolean>): Promise<Uint8Array>;
    close(): void;
}
export declare const secpIdentityVerifier: {
    verify: (digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
};
