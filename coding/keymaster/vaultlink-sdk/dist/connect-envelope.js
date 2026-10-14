import { secp256k1 } from "@noble/curves/secp256k1";
import { equal, fail, utf8 } from "./bytes.js";
import { decode, encode, object } from "./cbor.js";
import { sha256 } from "./crypto.js";
function text(value, minimum, maximum) {
    if (typeof value !== "string" || utf8(value).length < minimum || utf8(value).length > maximum)
        fail("invalid-envelope");
    return value;
}
/** Parse the exact Connect object, never a caller's digest or display summary. */
export async function inspectConnectEnvelope(kind, body, ownPublicKey, ownNetwork = "main") {
    if (kind !== "identity" && kind !== "intent")
        fail("unsupported");
    const b = object(body, kind === "identity" ? ["envelope"] : ["envelope", "content"]);
    if (!(b.envelope instanceof Uint8Array) || b.envelope.length > 8192)
        fail("invalid-envelope");
    const e = decode(b.envelope, 8192, 256);
    if (!Array.isArray(e) || e.length !== (kind === "identity" ? 9 : 10) || e[0] !== 2 || !equal(encode(e, 8192), b.envelope))
        fail("invalid-envelope");
    const bsvNetwork = e[e.length - 1];
    if (bsvNetwork !== ownNetwork)
        fail("network-identity-mismatch");
    const publicKey = e[kind === "identity" ? 6 : 8];
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33 || !equal(publicKey, ownPublicKey))
        fail("wrong-key");
    const issuedAt = e[3], expiresAt = e[4];
    if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt)
        fail("invalid-envelope");
    text(e[5], 0, 2048);
    const review = { kind, bsvNetwork: ownNetwork, requestId: text(e[1], 1, 128), audience: text(e[2], 1, 512), issuedAt, expiresAt, claimNames: [], digest: await sha256(b.envelope) };
    if (kind === "identity") {
        const claims = e[7];
        if (!Array.isArray(claims) || claims.length > 32)
            fail("invalid-envelope");
        let previous;
        for (const pair of claims) {
            if (!Array.isArray(pair) || pair.length !== 2)
                fail("invalid-envelope");
            const name = text(pair[0], 1, 128), bytes = utf8(name);
            if (previous) {
                let i = 0;
                while (i < previous.length && i < bytes.length && previous[i] === bytes[i])
                    i++;
                if (i === bytes.length || (i < previous.length && previous[i] >= bytes[i]))
                    fail("invalid-envelope");
            }
            previous = bytes;
            review.claimNames.push(name);
        }
    }
    else {
        if (!(b.content instanceof Uint8Array) || b.content.length > 16384 || !(e[7] instanceof Uint8Array) || e[7].length !== 32)
            fail("invalid-envelope");
        const digest = await sha256(b.content);
        if (!equal(e[7], digest))
            fail("invalid-content");
        review.contentType = text(e[6], 1, 127);
        review.contentLength = b.content.length;
        review.contentDigest = digest;
    }
    return review;
}
/** Verify strict low-S DER before adapting to Connect's r||s encoding. */
export function connectCompactSignature(signature, digest, publicKey) {
    const parsed = secp256k1.Signature.fromDER(signature);
    if (parsed.hasHighS() || !equal(parsed.toDERRawBytes(), signature) || !secp256k1.verify(signature, digest, publicKey, { prehash: false, lowS: true }))
        fail("invalid-signature");
    return parsed.toCompactRawBytes();
}
/** DeviceServer adapter for the same semantic operation used by the C++ device. */
export class ConnectEnvelopeOperation {
    key;
    kind;
    confirm;
    network;
    profile;
    version = 1;
    constructor(key, kind, confirm, network = "main") {
        this.key = key;
        this.kind = kind;
        this.confirm = confirm;
        this.network = network;
        this.profile = `connect-${kind}-envelope`;
    }
    async verify(body) {
        const frozen = structuredClone(body);
        await inspectConnectEnvelope(this.kind, frozen, this.key.publicKey(), this.network);
        return frozen;
    }
    async authorize(core, signal) {
        return this.confirm(await inspectConnectEnvelope(this.kind, core, this.key.publicKey(), this.network), signal);
    }
    async execute(core, signal) {
        const signature = await this.key.signConnectEnvelope(this.kind, core, signal, async () => true, this.network);
        return { publicKey: this.key.publicKey(), signature };
    }
}
/** Encrypted-channel identity discovery uses the already possession-proved key. */
export class NetworkIdentityOperation {
    key;
    network;
    profile = "identity-network";
    version = 1;
    constructor(key, network) {
        this.key = key;
        this.network = network;
        if (network !== "main" && network !== "test")
            fail("network-identity-required");
    }
    async verify(body) { object(body, []); return {}; }
    async authorize(_core, signal) { return !signal.aborted; }
    async execute(_core, signal) {
        if (signal.aborted)
            fail("revoked");
        return { bsvNetwork: this.network, publicKey: this.key.publicKey() };
    }
}
