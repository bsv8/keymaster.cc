import { type Value } from "./cbor.js";
import { type Frame } from "./frame.js";
export declare const sha256: (b: Uint8Array) => Promise<Uint8Array>;
export declare const sha256d: (b: Uint8Array) => Promise<Uint8Array>;
export declare function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;
export declare function ephemeral(): Promise<{
    privateKey: CryptoKey;
    publicKey: Uint8Array;
}>;
export declare function sharedSecret(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array>;
/** v2 绑定完整 HELLO/ACK，包含连接 ID、所有能力/限额与公开状态，不延用旧未完整绑定的 transcript。 */
export declare function transcript(hello: Value, ack: Value): Promise<Uint8Array>;
export declare function pairingCode(t: Uint8Array): Promise<string>;
export interface DirectionKeys {
    c2sKey: Uint8Array;
    c2sBaseNonce: Uint8Array;
    s2cKey: Uint8Array;
    s2cBaseNonce: Uint8Array;
}
export declare function deriveKeys(shared: Uint8Array, t: Uint8Array): Promise<DirectionKeys>;
export declare function nonce(base: Uint8Array, count: bigint): Uint8Array;
export declare function commitment(profile: string, version: number, core: Value): Promise<Uint8Array>;
export interface RecordContext {
    deviceRunId: number;
    connectionId: number;
}
/** 每个方向独立对象。所有异步运算串行化；并行调用不能复用 nonce。失败即销毁连接材料。 */
export declare class RecordCipher {
    private ctx;
    private key;
    private base;
    private counter;
    private seq;
    private closed;
    private tail;
    private constructor();
    static create(key: Uint8Array, base: Uint8Array, ctx: RecordContext): Promise<RecordCipher>;
    close(): void;
    private serial;
    private aad;
    seal(type: number, plain: Uint8Array): Promise<Frame>;
    open(f: Frame): Promise<Uint8Array>;
}
export declare function verifyCommitment(expected: Uint8Array, profile: string, version: number, core: Value): Promise<void>;
