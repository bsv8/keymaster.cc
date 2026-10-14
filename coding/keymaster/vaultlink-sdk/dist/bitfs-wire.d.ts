import { type Value } from './cbor.js';
import { type FeePoolReview } from './feepool.js';
import type { DeviceIdentityKey } from './bsv.js';
import type { OperationHandler } from './device.js';
export interface BitfsWireReview {
    kind: number;
    digest: Uint8Array;
    facts: {
        name: string;
        value: string;
    }[];
}
export declare function bitfsWireDigest(kind: number, document: Uint8Array): Promise<Uint8Array>;
export declare function inspectBitfsWire(body: Value, own: Uint8Array): Promise<BitfsWireReview>;
/** A Kind 5 signature can authorize arbitration settlement. Account its actual
 * pool delta here, before signing, using complete funding evidence. Kind 7
 * subsequently signs the same paid baseline and incurs no second charge. */
export declare function inspectBitfsAuthorization(raw: Uint8Array, previous: Uint8Array[], own: Uint8Array, auth: Value): Promise<FeePoolReview>;
export declare class BitfsWireOperation implements OperationHandler {
    private key;
    private confirm;
    readonly profile = "bitfs-wire-document";
    readonly version = 1;
    constructor(key: DeviceIdentityKey, confirm: (review: BitfsWireReview, signal: AbortSignal) => Promise<boolean>);
    verify(body: Value): Promise<Value>;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
/** Kind 2 precedes funding delivery. Derive the source amount from the exact
 * canonical v4 refund and fee rule, then authenticate the buyer's signature.
 * This never manufactures a previous transaction or trusts a source amount. */
export declare function inspectBitfsOpening(raw: Uint8Array, request: Uint8Array, own: Uint8Array): Promise<FeePoolReview>;
