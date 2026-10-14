import { type Value } from "./cbor.js";
import type { DeviceIdentityKey } from "./bsv.js";
import type { OperationHandler } from "./device.js";
export type ConnectEnvelopeKind = "identity" | "intent";
export interface ConnectEnvelopeReview {
    kind: ConnectEnvelopeKind;
    bsvNetwork: "main" | "test";
    requestId: string;
    audience: string;
    issuedAt: number;
    expiresAt: number;
    claimNames: string[];
    contentType?: string;
    contentLength?: number;
    digest: Uint8Array;
    contentDigest?: Uint8Array;
}
/** Parse the exact Connect object, never a caller's digest or display summary. */
export declare function inspectConnectEnvelope(kind: ConnectEnvelopeKind, body: Value, ownPublicKey: Uint8Array, ownNetwork?: "main" | "test"): Promise<ConnectEnvelopeReview>;
/** Verify strict low-S DER before adapting to Connect's r||s encoding. */
export declare function connectCompactSignature(signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): Uint8Array;
/** DeviceServer adapter for the same semantic operation used by the C++ device. */
export declare class ConnectEnvelopeOperation implements OperationHandler {
    private key;
    private kind;
    private confirm;
    private network;
    readonly profile: string;
    readonly version = 1;
    constructor(key: DeviceIdentityKey, kind: ConnectEnvelopeKind, confirm: (review: ConnectEnvelopeReview, signal: AbortSignal) => Promise<boolean>, network?: "main" | "test");
    verify(body: Value): Promise<Value>;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
/** Encrypted-channel identity discovery uses the already possession-proved key. */
export declare class NetworkIdentityOperation implements OperationHandler {
    private key;
    private network;
    readonly profile = "identity-network";
    readonly version = 1;
    constructor(key: DeviceIdentityKey, network: "main" | "test");
    verify(body: Value): Promise<Value>;
    authorize(_core: Value, signal: AbortSignal): Promise<boolean>;
    execute(_core: Value, signal: AbortSignal): Promise<Value>;
}
