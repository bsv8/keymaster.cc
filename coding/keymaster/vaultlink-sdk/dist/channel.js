import { secp256k1 } from '@noble/curves/secp256k1';
import { equal, fail, hex, unhex, utf8 } from './bytes.js';
import { sha256, hkdf } from './crypto.js';
import { parseCanonicalJson, canonicalJson } from './jcs.js';
import { object } from './cbor.js';
export function base64Url(bytes) { let raw = ''; for (const b of bytes)
    raw += String.fromCharCode(b); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function decodeBase64Url(text, length) {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
        fail('invalid-base64');
    let bytes;
    try {
        bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    }
    catch {
        fail('invalid-base64');
    }
    if ((length !== undefined && bytes.length !== length) || base64Url(bytes) !== text)
        fail('invalid-base64');
    return bytes;
}
export function jsonObject(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k)))
        fail('invalid-fields');
    return value;
}
function key(text) {
    if (typeof text !== 'string' || !/^0[23][0-9a-f]{64}$/.test(text))
        fail('invalid-key');
    try {
        secp256k1.ProjectivePoint.fromHex(unhex(text));
    }
    catch {
        fail('invalid-key');
    }
    return text;
}
function exactChannel(v) {
    if (typeof v !== 'string' || !v || v === '*' || utf8(v).length > 256 || /[\u0000-\u001f\u007f]/u.test(v))
        fail('invalid-channel');
    return v;
}
function times(message, lifetime) {
    const issuedAt = message.issued_at_ms, expiresAt = message.expires_at_ms, messageId = message.message_id;
    if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > lifetime)
        fail('invalid-time');
    if (typeof messageId !== 'string')
        fail('invalid-message-id');
    decodeBase64Url(messageId, 32);
    return { issuedAt, expiresAt, messageId };
}
export function privateLifetime(protocol) {
    if (protocol === 'bsv8.message.v1')
        return 86400000;
    if (protocol === 'bsv8.ping.v1')
        return 60000;
    if (protocol === 'bsv8.webrtc.signal.v1')
        return 120000;
    fail('unsupported-protocol');
}
function privateBody(protocol, value) {
    if (protocol === 'bsv8.webrtc.signal.v1') {
        const body = jsonObject(value, ['request_message_id', 'session_id', 'signal']);
        for (const field of ['request_message_id', 'session_id']) {
            if (typeof body[field] !== 'string')
                fail('invalid-body');
            decodeBase64Url(body[field], 32);
        }
        const signal = body.signal;
        if (!signal || typeof signal !== 'object' || Array.isArray(signal))
            fail('invalid-body');
        if (signal.type === 'offer' || signal.type === 'answer') {
            const v = jsonObject(signal, ['type', 'sdp']);
            if (typeof v.sdp !== 'string' || !v.sdp)
                fail('invalid-body');
        }
        else if (signal.type === 'end-of-candidates')
            jsonObject(signal, ['type']);
        else if (signal.type === 'ice-candidate') {
            const v = jsonObject(signal, ['type', 'candidate']), candidate = jsonObject(v.candidate, ['candidate', 'sdp_mid', 'sdp_m_line_index']);
            if (typeof candidate.candidate !== 'string' || (candidate.sdp_mid !== null && typeof candidate.sdp_mid !== 'string') || (candidate.sdp_m_line_index !== null && (typeof candidate.sdp_m_line_index !== 'number' || !Number.isSafeInteger(candidate.sdp_m_line_index) || candidate.sdp_m_line_index < 0)))
                fail('invalid-body');
        }
        else
            fail('invalid-body');
        return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('invalid-body');
    if (protocol === 'bsv8.ping.v1' && value.type === 'ping') {
        jsonObject(value, ['type']);
        return;
    }
    if (protocol === 'bsv8.message.v1' && value.type === 'deliver') {
        jsonObject(value, ['type', 'content']);
        return;
    }
    const field = protocol === 'bsv8.ping.v1' && value.type === 'pong' ? 'ping_message_id' : protocol === 'bsv8.message.v1' && value.type === 'ack' ? 'acknowledged_message_id' : null;
    if (!field)
        fail('invalid-body');
    const body = jsonObject(value, ['type', field]);
    if (typeof body[field] !== 'string')
        fail('invalid-body');
    decodeBase64Url(body[field], 32);
}
export async function inspectChannel(kind, raw, ownPublicKey) {
    const root = jsonObject(parseCanonicalJson(raw), ['scope', 'channel', 'from_public_key', 'message']);
    const privateMessage = kind === 'private';
    if (kind !== 'public' && kind !== 'hash' && !privateMessage)
        fail('unsupported');
    if (root.scope !== (privateMessage ? 'bsv8.private-message.v1' : 'bsv8.public-message.v1'))
        fail('invalid-scope');
    if (key(root.from_public_key) !== hex(ownPublicKey))
        fail('wrong-key');
    const channel = exactChannel(root.channel);
    if (kind === 'hash' && channel !== 'bsv8.hash.request.v1')
        fail('invalid-channel');
    const message = jsonObject(root.message, privateMessage ? ['protocol', 'message_id', 'issued_at_ms', 'expires_at_ms', 'body'] : ['message_id', 'issued_at_ms', 'expires_at_ms', 'body']);
    let protocol, peer;
    if (privateMessage) {
        if (typeof message.protocol !== 'string')
            fail('unsupported-protocol');
        protocol = message.protocol;
        privateLifetime(protocol);
        if (!channel.startsWith('bsv8.inbox.'))
            fail('invalid-channel');
        peer = key(channel.slice(11));
        privateBody(protocol, message.body);
    }
    if (kind === 'hash') {
        const body = jsonObject(message.body, ['hash', 'locators']);
        if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash) || !Array.isArray(body.locators) || !body.locators.length)
            fail('invalid-body');
        for (const locator of body.locators) {
            if (locator && typeof locator === 'object' && !Array.isArray(locator) && locator.kind === 'webrtc-sdp')
                jsonObject(locator, ['kind']);
            else {
                const entry = jsonObject(locator, ['kind', 'address']);
                if (entry.kind !== 'multiaddr' || typeof entry.address !== 'string' || !entry.address.startsWith('/'))
                    fail('invalid-body');
            }
        }
    }
    const timing = times(message, protocol ? privateLifetime(protocol) : 600000);
    return { channel, ...timing, ...(peer ? { peer } : {}), ...(protocol ? { protocol } : {}), digest: await sha256(raw) };
}
export function verifyChannelSignature(signature, digest, pub) {
    try {
        const parsed = secp256k1.Signature.fromDER(signature);
        if (parsed.hasHighS() || !equal(parsed.toDERRawBytes(), signature) || !secp256k1.verify(signature, digest, pub, { prehash: false, lowS: true }))
            fail('invalid-signature');
    }
    catch {
        fail('invalid-signature');
    }
}
/** The exact SDK signing object; serialization follows its fixed 0.6.0 domains. */
export function channelSigningObject(message, kind) {
    return canonicalJson({ scope: kind === 'private' ? 'bsv8.private-message.v1' : 'bsv8.public-message.v1', channel: message.channel, from_public_key: message.from_public_key,
        message: { message_id: message.message_id, issued_at_ms: message.issued_at_ms, expires_at_ms: message.expires_at_ms, body: message.body, ...(kind === 'private' ? { protocol: message.protocol } : {}) } });
}
export async function inspectSignedChannel(raw, pub) {
    const message = jsonObject(parseCanonicalJson(raw), ['channel', 'from_public_key', 'protocol', 'message_id', 'issued_at_ms', 'expires_at_ms', 'body', 'signature']);
    const review = await inspectChannel('private', channelSigningObject(message, 'private'), pub);
    if (typeof message.signature !== 'string')
        fail('invalid-signature');
    verifyChannelSignature(decodeBase64Url(message.signature), review.digest, pub);
    return review;
}
export function inspectInboxEnvelope(raw, pub) {
    const envelope = jsonObject(parseCanonicalJson(raw), ['channel', 'envelope_version', 'from_public_key', 'kdf_salt', 'nonce', 'ciphertext']);
    if (envelope.channel !== 'bsv8.inbox.' + hex(pub) || envelope.envelope_version !== 1)
        fail('invalid-envelope');
    key(envelope.from_public_key);
    for (const [field, length] of [['kdf_salt', 32], ['nonce', 12], ['ciphertext', undefined]]) {
        if (typeof envelope[field] !== 'string')
            fail('invalid-envelope');
        const bytes = decodeBase64Url(envelope[field], length);
        if (field === 'ciphertext' && bytes.length < 16)
            fail('invalid-envelope');
    }
    return envelope;
}
async function inboxAes(mode, derived, nonce, aad, input) {
    const k = await crypto.subtle.importKey('raw', new Uint8Array(derived).buffer, 'AES-GCM', false, [mode]);
    try {
        return new Uint8Array(await crypto.subtle[mode]({ name: 'AES-GCM', iv: new Uint8Array(nonce).buffer, additionalData: new Uint8Array(aad).buffer, tagLength: 128 }, k, new Uint8Array(input).buffer));
    }
    catch {
        fail(mode === 'decrypt' ? 'open-failed' : 'crypto-failed');
    }
}
export async function sealChannelSigned(raw, pub, shared) {
    const review = await inspectSignedChannel(raw, pub);
    const message = jsonObject(parseCanonicalJson(raw), ['channel', 'from_public_key', 'protocol', 'message_id', 'issued_at_ms', 'expires_at_ms', 'body', 'signature']);
    const { channel, from_public_key, ...plain } = message;
    const salt = crypto.getRandomValues(new Uint8Array(32)), nonce = crypto.getRandomValues(new Uint8Array(12));
    const meta = { channel: channel, envelope_version: 1, from_public_key: from_public_key, kdf_salt: base64Url(salt), nonce: base64Url(nonce) };
    const secret = shared(unhex(review.peer));
    let derived, plaintext;
    try {
        derived = await hkdf(secret, salt, canonicalJson({ scope: 'bsv8.inbox.envelope.v1', channel: channel, from_public_key: from_public_key }), 32);
        plaintext = canonicalJson(plain);
        const cipher = await inboxAes('encrypt', derived, nonce, canonicalJson(meta), plaintext);
        return canonicalJson({ ...meta, ciphertext: base64Url(cipher) });
    }
    finally {
        secret.fill(0);
        derived?.fill(0);
        plaintext?.fill(0);
    }
}
export async function openChannelEnvelope(raw, pub, shared) {
    const envelope = inspectInboxEnvelope(raw, pub);
    const { ciphertext, ...meta } = envelope, sender = envelope.from_public_key;
    const secret = shared(unhex(sender));
    let derived, plaintext;
    try {
        derived = await hkdf(secret, decodeBase64Url(envelope.kdf_salt, 32), canonicalJson({ scope: 'bsv8.inbox.envelope.v1', channel: envelope.channel, from_public_key: sender }), 32);
        plaintext = await inboxAes('decrypt', derived, decodeBase64Url(envelope.nonce, 12), canonicalJson(meta), decodeBase64Url(ciphertext));
        const payload = jsonObject(parseCanonicalJson(plaintext), ['protocol', 'message_id', 'issued_at_ms', 'expires_at_ms', 'body', 'signature']);
        const message = canonicalJson({ ...payload, channel: envelope.channel, from_public_key: sender });
        try {
            const review = await inspectSignedChannel(message, unhex(sender));
            return { message, review: { ...review, peer: sender } };
        }
        catch (error) {
            message.fill(0);
            throw error;
        }
    }
    finally {
        secret.fill(0);
        derived?.fill(0);
        plaintext?.fill(0);
    }
}
export class ChannelOperation {
    key;
    kind;
    confirm;
    profile;
    version = 1;
    constructor(key, kind, confirm) {
        this.key = key;
        this.kind = kind;
        this.confirm = confirm;
        this.profile = `bsv8-channel-${kind}`;
    }
    message(body) { const b = object(body, ['message']); if (!(b.message instanceof Uint8Array))
        fail('invalid-request'); return b.message; }
    async verify(body) { const frozen = structuredClone(body); await this.key.reviewChannel(this.kind, this.message(frozen)); return frozen; }
    async authorize(core, signal) { return this.confirm(await this.key.reviewChannel(this.kind, this.message(core)), signal); }
    async execute(core, signal) {
        const message = this.message(core);
        if (this.kind === 'seal')
            return { message: await this.key.sealChannel(message, signal, async () => true) };
        if (this.kind === 'open')
            return { message: await this.key.openChannel(message, signal, async () => true) };
        return { publicKey: this.key.publicKey(), signature: await this.key.signChannel(this.kind, message, signal, async () => true) };
    }
}
