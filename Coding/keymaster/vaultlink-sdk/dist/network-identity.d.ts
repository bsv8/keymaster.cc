import type { OperationHandler } from "./device.js";
import { type Value } from "./cbor.js";
export type NetworkIdentityKind = "noise" | "peer-record";
export interface NetworkIdentityReview {
    kind: NetworkIdentityKind;
    digest: Uint8Array;
    payload: Uint8Array;
    sequence?: string;
}
/** Reconstruct only the existing address-free libp2p identity record from our own key. */
export declare function inspectNetworkIdentity(kind: NetworkIdentityKind, body: Value, ownPublicKey: Uint8Array): Promise<NetworkIdentityReview>;
/** Semantic adapter for SDK DeviceServer; authorization stays in the device. */
export declare class NetworkIdentityOperation implements OperationHandler {
    private key;
    private kind;
    private confirm;
    readonly profile: string;
    readonly version = 1;
    constructor(key: import("./bsv.js").DeviceIdentityKey, kind: NetworkIdentityKind, confirm: (review: NetworkIdentityReview, signal: AbortSignal) => Promise<boolean>);
    verify(body: Value): Promise<Value>;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
