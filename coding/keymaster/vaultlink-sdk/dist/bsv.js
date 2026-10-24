import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 as hash256 } from "@noble/hashes/sha256";
import { addMoney, concat, equal, fail, fixed, money, u32 } from "./bytes.js";
import { sha256d } from "./crypto.js";
import { possessionDigest } from "./handshake.js";
import { decode, encode } from './cbor.js';
/** 地址只从已核验的实际 P2PKH 输出生成，不采用主机给出的收款方标签。 */
export async function p2pkhOutputAddress(script, network) {
    if (!p2pkh(script))
        fail("unsupported-script");
    const payload = concat(Uint8Array.of(network === "main" ? 0 : 111), script.slice(3, 23));
    const encoded = concat(payload, (await sha256d(payload)).slice(0, 4));
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n, result = "", zeros = 0;
    for (const byte of encoded)
        value = value * 256n + BigInt(byte);
    while (value) {
        result = alphabet[Number(value % 58n)] + result;
        value /= 58n;
    }
    while (zeros < encoded.length && encoded[zeros] === 0)
        zeros++;
    return "1".repeat(zeros) + result;
}
const le32 = (x) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, u32(x), true);
    return b;
};
const le64 = (x) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, money(x), true);
    return b;
};
function compact(n) {
    if (!Number.isInteger(n) || n < 0 || n > 65535)
        fail("transaction-limit");
    if (n < 253)
        return Uint8Array.of(n);
    return Uint8Array.of(253, n & 255, n >>> 8);
}
export function p2pkhScript(pub) {
    fixed(pub, 33);
    secp256k1.ProjectivePoint.fromHex(pub);
    return concat(Uint8Array.of(0x76, 0xa9, 0x14), ripemd160(hash256(pub)), Uint8Array.of(0x88, 0xac));
}
function p2pkh(script) {
    return (script.length === 25 &&
        script[0] === 0x76 &&
        script[1] === 0xa9 &&
        script[2] === 0x14 &&
        script[23] === 0x88 &&
        script[24] === 0xac);
}
/** 不接受 witness/非最短 CompactSize、超大前序或未知脚本；前序真实性靠 txid/outpoint 字节绑定，不声称链上状态。 */
export function parseTransaction(raw, maxBytes = 8192) {
    if (raw.length > maxBytes)
        fail("transaction-limit");
    let at = 0;
    const take = (n) => {
        if (n < 0 || at + n > raw.length)
            fail("truncated-transaction");
        const b = raw.slice(at, at + n);
        at += n;
        return b;
    };
    const read32 = () => new DataView(take(4).buffer).getUint32(0, true);
    const read64 = () => new DataView(take(8).buffer).getBigUint64(0, true);
    const count = () => {
        const n = take(1)[0];
        if (n < 253)
            return n;
        if (n !== 253)
            fail("transaction-limit");
        const b = take(2), x = b[0] | (b[1] << 8);
        if (x < 253)
            fail("non-shortest");
        return x;
    };
    const version = read32(), ni = count();
    if (ni < 1 || ni > 128)
        fail("transaction-limit");
    const inputs = [];
    for (let i = 0; i < ni; i++) {
        const txid = take(32), vout = read32(), len = count();
        if (len > 1024)
            fail("transaction-limit");
        inputs.push({ txid, vout, script: take(len), sequence: read32() });
    }
    const no = count();
    if (no < 1 || no > 128)
        fail("transaction-limit");
    const outputs = [];
    for (let i = 0; i < no; i++) {
        const satoshis = read64(), len = count();
        if (len > 1024)
            fail("transaction-limit");
        outputs.push({ satoshis, script: take(len) });
    }
    const locktime = read32();
    if (at !== raw.length)
        fail("trailing-transaction");
    return { version, inputs, outputs, locktime };
}
function outputBytes(o) {
    return concat(le64(o.satoshis), compact(o.script.length), o.script);
}
export function serializeTransaction(tx) {
    return concat(le32(tx.version), compact(tx.inputs.length), ...tx.inputs.map((i) => concat(fixed(i.txid, 32), le32(i.vout), compact(i.script.length), i.script, le32(i.sequence))), compact(tx.outputs.length), ...tx.outputs.map(outputBytes), le32(tx.locktime));
}
/** 仅计算规范交易摘要；不产生签名，也不代替完整前序输出核验。 */
export async function forkIdAllSighash(tx, inputIndex, prev) {
    if (!Number.isInteger(inputIndex) ||
        inputIndex < 0 ||
        inputIndex >= tx.inputs.length ||
        prev.script.length === 0 ||
        prev.script.length > 1024)
        fail("invalid-prevout");
    money(prev.satoshis);
    const hashPrevouts = await sha256d(concat(...tx.inputs.map((i) => concat(i.txid, le32(i.vout))))), hashSequence = await sha256d(concat(...tx.inputs.map((i) => le32(i.sequence)))), hashOutputs = await sha256d(concat(...tx.outputs.map(outputBytes)));
    const input = tx.inputs[inputIndex];
    return sha256d(concat(le32(tx.version), hashPrevouts, hashSequence, input.txid, le32(input.vout), compact(prev.script.length), prev.script, le64(prev.satoshis), le32(input.sequence), hashOutputs, le32(tx.locktime), le32(0x41)));
}
export async function p2pkhSighash(tx, inputIndex, prev) {
    if (!p2pkh(prev.script))
        fail("invalid-prevout");
    return forkIdAllSighash(tx, inputIndex, prev);
}
export async function inspectP2pkh(raw, evidence, publicKey, inputIndex) {
    const tx = parseTransaction(raw, 640);
    if (tx.inputs.length > 4 ||
        tx.outputs.length > 6 ||
        evidence.length !== tx.inputs.length ||
        !Number.isInteger(inputIndex) ||
        inputIndex < 0 ||
        inputIndex >= tx.inputs.length)
        fail("unsupported");
    const own = p2pkhScript(publicKey);
    let inputs = 0n;
    const prevouts = [];
    const seen = new Set();
    for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        if (input.script.length !== 0)
            fail("already-signed");
        const prior = parseTransaction(evidence[i].transaction);
        const txid = await sha256d(evidence[i].transaction);
        if (!equal(txid, input.txid) || input.vout >= prior.outputs.length)
            fail("invalid-prevout");
        const ref = Array.from(input.txid).join(",") + ":" + input.vout;
        if (seen.has(ref))
            fail("duplicate-input");
        seen.add(ref);
        const prev = prior.outputs[input.vout];
        if (!equal(prev.script, own))
            fail("wrong-key");
        inputs = addMoney(inputs, prev.satoshis);
        prevouts.push(prev);
    }
    let outputs = 0n, change = 0n;
    const external = [];
    for (const o of tx.outputs) {
        if (!p2pkh(o.script))
            fail("unsupported-script");
        outputs = addMoney(outputs, o.satoshis);
        if (equal(o.script, own))
            change = addMoney(change, o.satoshis);
        else
            external.push({ ...o, script: o.script.slice() });
    }
    if (outputs > inputs)
        fail("negative-fee");
    const digest = await p2pkhSighash(tx, inputIndex, prevouts[inputIndex]);
    return {
        publicKey: publicKey.slice(),
        externalOutputs: external,
        change,
        fee: inputs - outputs,
        // Every own P2PKH output is a return, regardless of its business role.
        // The remaining wallet value includes the miner fee.
        amount: inputs - change,
        digest,
        inputIndex,
    };
}
/** 设备内部 KeyProvider：只签已经重新解析的 P2PKH 或域隔离持有权，普通 SDK 无 signHash/getPrivateKey。 */
export class DeviceIdentityKey {
    key;
    closed = false;
    constructor(privateKey) {
        fixed(privateKey, 32);
        if (!secp256k1.utils.isValidPrivateKey(privateKey))
            fail("invalid-key");
        this.key = privateKey.slice();
    }
    publicKey() {
        if (this.closed)
            fail("locked");
        return secp256k1.getPublicKey(this.key, true);
    }
    async signP2pkh(raw, evidence, inputIndex, authorize, signal) {
        const review = await inspectP2pkh(raw, evidence, this.publicKey(), inputIndex);
        const frozen = review.digest.slice();
        if (!(await authorize(structuredClone(review))))
            fail("denied");
        if (this.closed)
            fail("locked");
        if (signal?.aborted)
            fail("revoked");
        const signature = concat(secp256k1
            .sign(frozen, this.key, { prehash: false, lowS: true })
            .toDERRawBytes(), Uint8Array.of(0x41));
        return { review, signature };
    }
    async signAllP2pkh(raw, evidence, signal, beforeSign) {
        const tx = raw.slice(), prev = evidence.map((e) => ({ transaction: e.transaction.slice() })), count = parseTransaction(tx, 640).inputs.length;
        const reviews = [];
        for (let i = 0; i < count; i++)
            reviews.push(await inspectP2pkh(tx, prev, this.publicKey(), i));
        await beforeSign();
        if (this.closed)
            fail("locked");
        if (signal.aborted)
            fail("revoked");
        return reviews.map((r) => concat(secp256k1
            .sign(r.digest, this.key, { prehash: false, lowS: true })
            .toDERRawBytes(), Uint8Array.of(0x41)));
    }
    /** 费用池签名仍从完整交易证据计算，绝不开放任意摘要签名接口。 */
    async signAllFeePool(raw, previous, family, stage, signal, beforeSign) {
        const { inspectFeePool } = await import("./feepool.js");
        const review = await inspectFeePool(raw.slice(), previous.map((p) => p.slice()), this.publicKey(), family, stage);
        await beforeSign();
        if (this.closed)
            fail("locked");
        if (signal.aborted)
            fail("revoked");
        return review.digests.map((digest) => concat(secp256k1
            .sign(digest, this.key, { prehash: false, lowS: true })
            .toDERRawBytes(), Uint8Array.of(0x41)));
    }
    async provePossession(transcript, sessionId, challenge) {
        const digest = await possessionDigest(transcript, this.publicKey(), sessionId, challenge);
        if (this.closed)
            fail("locked");
        return secp256k1.sign(digest, this.key, { prehash: false, lowS: true }).toDERRawBytes();
    }
    async signConnectEnvelope(kind, body, signal, authorize, network = "main") {
        const { inspectConnectEnvelope } = await import("./connect-envelope.js");
        const review = await inspectConnectEnvelope(kind, structuredClone(body), this.publicKey(), network);
        const digest = review.digest.slice();
        if (!(await authorize(structuredClone(review))))
            fail("denied");
        if (this.closed)
            fail("locked");
        if (signal.aborted)
            fail("revoked");
        return secp256k1.sign(digest, this.key, { prehash: false, lowS: true }).toDERRawBytes();
    }
    async reviewChannel(kind, raw) {
        const channel = await import('./channel.js'), pub = this.publicKey();
        if (kind === 'seal')
            return channel.inspectSignedChannel(raw, pub);
        if (kind === 'open') {
            const opened = await channel.openChannelEnvelope(raw, pub, peer => { this.publicKey(); return secp256k1.getSharedSecret(this.key, peer, true).slice(1); });
            try {
                this.publicKey();
                return opened.review;
            }
            finally {
                opened.message.fill(0);
            }
        }
        return channel.inspectChannel(kind, raw, pub);
    }
    async signChannel(kind, raw, signal, authorize) {
        const frozen = new Uint8Array(raw), review = await this.reviewChannel(kind, frozen), digest = review.digest.slice();
        if (!(await authorize(structuredClone(review))))
            fail('denied');
        this.publicKey();
        if (signal.aborted)
            fail('revoked');
        return secp256k1.sign(digest, this.key, { prehash: false, lowS: true }).toDERRawBytes();
    }
    async sealChannel(raw, signal, authorize) {
        const channel = await import('./channel.js'), frozen = new Uint8Array(raw), pub = this.publicKey();
        if (!(await authorize(await channel.inspectSignedChannel(frozen, pub))))
            fail('denied');
        this.publicKey();
        if (signal.aborted)
            fail('revoked');
        const result = await channel.sealChannelSigned(frozen, pub, peer => { this.publicKey(); return secp256k1.getSharedSecret(this.key, peer, true).slice(1); });
        if (this.closed || signal.aborted) {
            result.fill(0);
            fail('revoked');
        }
        return result;
    }
    async openChannel(raw, signal, authorize) {
        const channel = await import('./channel.js'), pub = this.publicKey();
        const result = await channel.openChannelEnvelope(new Uint8Array(raw), pub, peer => { this.publicKey(); return secp256k1.getSharedSecret(this.key, peer, true).slice(1); });
        try {
            if (!(await authorize(structuredClone(result.review))))
                fail('denied');
            this.publicKey();
            if (signal.aborted)
                fail('revoked');
            return result.message;
        }
        catch (error) {
            result.message.fill(0);
            throw error;
        }
    }
    async signNetworkIdentity(kind, body, signal, authorize) {
        const { inspectNetworkIdentity } = await import('./network-identity.js');
        const review = await inspectNetworkIdentity(kind, structuredClone(body), this.publicKey()), digest = review.digest.slice();
        if (!(await authorize(structuredClone(review))))
            fail('denied');
        this.publicKey();
        if (signal.aborted)
            fail('revoked');
        return secp256k1.sign(digest, this.key, { prehash: false, lowS: true }).toDERRawBytes();
    }
    async signBitfsWire(body, signal, authorize) {
        const frozen = decode(encode(body, 32768), 32768), { inspectBitfsWire } = await import('./bitfs-wire.js');
        const review = await inspectBitfsWire(frozen, this.publicKey()), digest = review.digest.slice();
        if (review.kind === 5)
            fail('payment-context-required');
        if (!(await authorize(structuredClone(review))))
            fail('denied');
        this.publicKey();
        if (signal.aborted)
            fail('revoked');
        return secp256k1.sign(digest, this.key, { prehash: false, lowS: true }).toDERRawBytes();
    }
    close() {
        this.closed = true;
        this.key.fill(0);
    }
}
export const secpIdentityVerifier = {
    verify: (digest, signature, publicKey) => {
        try {
            return secp256k1.verify(signature, fixed(digest, 32), fixed(publicKey, 33), { prehash: false, lowS: true });
        }
        catch {
            return false;
        }
    },
};
