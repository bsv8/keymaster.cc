import { type Value } from "./cbor.js";
import { RecordCipher } from "./crypto.js";
export interface Generations {
    walletGeneration: number;
    backendGeneration: number;
    hostRunGeneration: number;
}
export interface Hello extends Generations {
    hostEph: Uint8Array;
    hostNonce: Uint8Array;
    protocolVersion: number;
    capabilities: number[];
}
export interface Ack {
    deviceEph: Uint8Array;
    deviceNonce: Uint8Array;
    publicKey: Uint8Array;
    deviceRunId: number;
    connectionId: number;
    protocolVersion: number;
    capabilities: number[];
}
export interface PairedKeys {
    send: RecordCipher;
    receive: RecordCipher;
    pairingCode: string;
    transcript: Uint8Array;
}
export declare function parseHello(v: Value): Hello;
export declare function parseAck(v: Value): Ack;
/** 配对码必须由两端用户核对。acceptAck 仅派生材料，不代表实体配对或身份验证已经完成。 */
export declare class HostHandshake {
    private priv;
    private hello;
    private consumed;
    begin(g: Generations, capabilities: number[]): Promise<Hello>;
    acceptAck(value: Value, expectedPublicKey: Uint8Array): Promise<PairedKeys>;
}
export declare class DeviceHandshake {
    private started;
    acceptHello(value: Value, publicKey: Uint8Array, deviceRunId: number, connectionId: number, capabilities: number[]): Promise<{
        ack: Ack;
        keys: PairedKeys;
    }>;
}
export declare function possessionDigest(t: Uint8Array, publicKey: Uint8Array, sessionId: number, challenge: Uint8Array): Promise<Uint8Array>;
export interface IdentityVerifier {
    verify(digest: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
}
/** 只验证受限持有权声明；不存在通用业务 SIGN_HASH 出口。 */
export declare function verifyPossession(verifier: IdentityVerifier, t: Uint8Array, expected: Uint8Array, sessionId: number, challenge: Uint8Array, signature: Uint8Array): Promise<void>;
export declare const handshakeEncoding: (value: Hello | Ack) => Uint8Array;
