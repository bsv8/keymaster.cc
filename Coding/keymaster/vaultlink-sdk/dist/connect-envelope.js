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
export async function inspectConnectEnvelope(kind, body, ownPublicKey) {
    if (kind !== "identity" && kind !== "intent")
        fail("unsupported");
    const b = object(body, kind === "identity" ? ["envelope"] : ["envelope", "content"]);
    if (!(b.envelope instanceof Uint8Array) || b.envelope.length > 8192)
        fail("invalid-envelope");
    const e = decode(b.envelope, 8192, 256);
    if (!Array.isArray(e) || e.length !== (kind === "identity" ? 8 : 9) || e[0] !== 1 || !equal(encode(e, 8192), b.envelope))
        fail("invalid-envelope");
    const publicKey = e[kind === "identity" ? 6 : 8];
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 33 || !equal(publicKey, ownPublicKey))
        fail("wrong-key");
    const issuedAt = e[3], expiresAt = e[4];
    if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt)
        fail("invalid-envelope");
    text(e[5], 0, 2048);
    const review = { kind, requestId: text(e[1], 1, 128), audience: text(e[2], 1, 512), issuedAt, expiresAt, claimNames: [], digest: await sha256(b.envelope) };
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
    profile;
    version = 1;
    constructor(key, kind, confirm) {
        this.key = key;
        this.kind = kind;
        this.confirm = confirm;
        this.profile = `connect-${kind}-envelope`;
    }
    async verify(body) {
        const frozen = structuredClone(body);
        await inspectConnectEnvelope(this.kind, frozen, this.key.publicKey());
        return frozen;
    }
    async authorize(core, signal) {
        return this.confirm(await inspectConnectEnvelope(this.kind, core, this.key.publicKey()), signal);
    }
    async execute(core, signal) {
        const signature = await this.key.signConnectEnvelope(this.kind, core, signal, async () => true);
        return { publicKey: this.key.publicKey(), signature };
    }
}
