import { type JsonValue } from './jcs.js';
import { type Value } from './cbor.js';
import type { DeviceIdentityKey } from './bsv.js';
import type { OperationHandler } from './device.js';
export type ChannelKind = 'public' | 'hash' | 'private';
export interface ChannelReview {
    channel: string;
    peer?: string;
    protocol?: string;
    messageId: string;
    issuedAt: number;
    expiresAt: number;
    digest: Uint8Array;
}
export declare function base64Url(bytes: Uint8Array): string;
export declare function decodeBase64Url(text: string, length?: number): Uint8Array;
export declare function jsonObject(value: JsonValue, fields: string[]): {
    [key: string]: JsonValue;
};
export declare function privateLifetime(protocol: string): number;
export declare function inspectChannel(kind: ChannelKind, raw: Uint8Array, ownPublicKey: Uint8Array): Promise<ChannelReview>;
export declare function verifyChannelSignature(signature: Uint8Array, digest: Uint8Array, pub: Uint8Array): void;
/** The exact SDK signing object; serialization follows its fixed 0.6.0 domains. */
export declare function channelSigningObject(message: {
    [key: string]: JsonValue;
}, kind: ChannelKind): Uint8Array;
export declare function inspectSignedChannel(raw: Uint8Array, pub: Uint8Array): Promise<ChannelReview>;
export declare function inspectInboxEnvelope(raw: Uint8Array, pub: Uint8Array): {
    [key: string]: JsonValue;
};
type SharedSecret = (peer: Uint8Array) => Uint8Array;
export declare function sealChannelSigned(raw: Uint8Array, pub: Uint8Array, shared: SharedSecret): Promise<Uint8Array>;
export declare function openChannelEnvelope(raw: Uint8Array, pub: Uint8Array, shared: SharedSecret): Promise<{
    message: Uint8Array;
    review: ChannelReview;
}>;
export type ChannelOperationKind = ChannelKind | 'seal' | 'open';
export declare class ChannelOperation implements OperationHandler {
    private key;
    private kind;
    private confirm;
    readonly profile: string;
    readonly version = 1;
    constructor(key: DeviceIdentityKey, kind: ChannelOperationKind, confirm: (review: ChannelReview, signal: AbortSignal) => Promise<boolean>);
    private message;
    verify(body: Value): Promise<Value>;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
export {};
