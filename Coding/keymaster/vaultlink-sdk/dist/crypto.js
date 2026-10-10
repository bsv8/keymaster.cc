import { be32, concat, equal, fail, fixed, MAX_U64, utf8 } from "./bytes.js";
import { encode } from "./cbor.js";
import { MAX_FRAME_PAYLOAD, VERSION } from "./frame.js";
// Buffer.slice() is a view into a Node slab; WebCrypto must see exactly these bytes.
const raw = (b) => new Uint8Array(b).buffer;
export const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", raw(b)));
export const sha256d = async (b) => sha256(await sha256(b));
export async function hkdf(ikm, salt, info, length) {
    const key = await crypto.subtle.importKey("raw", raw(ikm), "HKDF", false, [
        "deriveBits",
    ]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: raw(salt), info: raw(info) }, key, length * 8));
}
export async function ephemeral() {
    const keys = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
    ]));
    return {
        privateKey: keys.privateKey,
        publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    };
}
export async function sharedSecret(privateKey, publicKey) {
    const peer = await crypto.subtle.importKey("raw", raw(fixed(publicKey, 32)), { name: "X25519" }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
    if (secret.every((x) => x === 0))
        fail("invalid-peer");
    return secret;
}
/** v2 绑定完整 HELLO/ACK，包含连接 ID、所有能力/限额与公开状态，不延用旧未完整绑定的 transcript。 */
export async function transcript(hello, ack) {
    return sha256(concat(utf8("vlp:handshake:v2\0"), encode({ hello, ack }, 2048)));
}
export async function pairingCode(t) {
    const h = await sha256(concat(utf8("vlp:link:pairing:v2"), fixed(t, 32)));
    return (((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000)
        .toString()
        .padStart(6, "0");
}
export async function deriveKeys(shared, t) {
    fixed(shared, 32);
    fixed(t, 32);
    return {
        c2sKey: await hkdf(shared, t, utf8("vlp:link:c2s:key:v2"), 32),
        c2sBaseNonce: await hkdf(shared, t, utf8("vlp:link:c2s:nonce:v2"), 12),
        s2cKey: await hkdf(shared, t, utf8("vlp:link:s2c:key:v2"), 32),
        s2cBaseNonce: await hkdf(shared, t, utf8("vlp:link:s2c:nonce:v2"), 12),
    };
}
export function nonce(base, count) {
    fixed(base, 12);
    if (count < 0n || count >= MAX_U64)
        fail("counter-exhausted");
    const b = base.slice();
    let c = count;
    for (let i = 11; i >= 0; i--) {
        c += BigInt(b[i]);
        b[i] = Number(c & 255n);
        c >>= 8n;
    }
    return b;
}
export async function commitment(profile, version, core) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(profile) ||
        !Number.isInteger(version) ||
        version < 1 ||
        version > 255)
        fail("invalid-profile");
    const encoded = encode(core, 32768);
    let bytes;
    try {
        bytes = concat(utf8("vlp:commit:v2\0" + profile + "\0"), Uint8Array.of(version), encoded);
        return await sha256d(bytes);
    }
    finally {
        encoded.fill(0);
        bytes?.fill(0);
    }
}
/** 每个方向独立对象。所有异步运算串行化；并行调用不能复用 nonce。失败即销毁连接材料。 */
export class RecordCipher {
    ctx;
    key;
    base;
    counter = 0n;
    seq = 0;
    closed = false;
    tail = Promise.resolve();
    constructor(key, base, ctx) {
        this.ctx = ctx;
        this.key = key;
        this.base = base.slice();
    }
    static async create(key, base, ctx) {
        fixed(key, 32);
        fixed(base, 12);
        be32(ctx.deviceRunId);
        be32(ctx.connectionId);
        return new RecordCipher(await crypto.subtle.importKey("raw", raw(key), "AES-GCM", false, [
            "encrypt",
            "decrypt",
        ]), base, ctx);
    }
    close() {
        this.closed = true;
        this.key = undefined;
        this.base.fill(0);
    }
    serial(f) {
        const p = this.tail.then(f);
        this.tail = p.catch(() => { });
        return p;
    }
    aad(type, seq) {
        return concat(Uint8Array.of(VERSION, type, 0), be32(seq), be32(this.ctx.deviceRunId), be32(this.ctx.connectionId));
    }
    seal(type, plain) {
        const copy = plain.slice();
        return this.serial(async () => {
            try {
                if (this.closed || !this.key)
                    fail("disconnected");
                if (type < 3 ||
                    ![3, 4, 5, 6, 16, 17, 18].includes(type) ||
                    copy.length > 896 ||
                    this.seq === 0xffffffff)
                    fail("invalid-record");
                const seq = this.seq + 1;
                const payload = new Uint8Array(await crypto.subtle.encrypt({
                    name: "AES-GCM",
                    iv: raw(nonce(this.base, this.counter)),
                    additionalData: raw(this.aad(type, seq)),
                    tagLength: 128,
                }, this.key, raw(copy)));
                this.seq = seq;
                this.counter++;
                return { type, seq, payload };
            }
            catch (e) {
                this.close();
                throw e;
            }
            finally {
                copy.fill(0);
            }
        });
    }
    open(f) {
        const payload = f.payload.slice();
        return this.serial(async () => {
            try {
                if (this.closed || !this.key)
                    fail("disconnected");
                if (![3, 4, 5, 6, 16, 17, 18].includes(f.type) ||
                    f.seq !== this.seq + 1 ||
                    payload.length < 16 ||
                    payload.length > MAX_FRAME_PAYLOAD)
                    fail("replay-or-gap");
                const plain = new Uint8Array(await crypto.subtle.decrypt({
                    name: "AES-GCM",
                    iv: raw(nonce(this.base, this.counter)),
                    additionalData: raw(this.aad(f.type, f.seq)),
                    tagLength: 128,
                }, this.key, raw(payload)));
                if (plain.length > 896)
                    fail("message-too-large");
                this.seq = f.seq;
                this.counter++;
                return plain;
            }
            catch (e) {
                this.close();
                throw e;
            }
        });
    }
}
export async function verifyCommitment(expected, profile, version, core) {
    if (!equal(fixed(expected, 32), await commitment(profile, version, core)))
        fail("invalid-commitment");
}
