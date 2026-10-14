import { secp256k1 } from '@noble/curves/secp256k1';
import { decode, encode, object } from './cbor.js';
import { equal, fail, hex, MAX_U64 } from './bytes.js';
import { sha256, sha256d } from './crypto.js';
import { inspectFeePool, feePoolScript } from './feepool.js';
import { parseTransaction, p2pkhScript, forkIdAllSighash } from './bsv.js';
import { verifyChannelSignature } from './channel.js';
const array = (v, n) => { if (!Array.isArray(v) || (n !== undefined && v.length !== n))
    fail('invalid-document'); return v; };
const bytes = (v, n, nonzero = false) => { if (!(v instanceof Uint8Array) || (n !== undefined && v.length !== n) || (nonzero && v.every(b => b === 0)))
    fail('invalid-document'); return v; };
const uint = (v) => { if ((typeof v !== 'number' && typeof v !== 'bigint') || (typeof v === 'number' && !Number.isSafeInteger(v)))
    fail('invalid-document'); const n = BigInt(v); if (n < 0n || n > MAX_U64)
    fail('invalid-document'); return n; };
const child = (v, n) => array(decode(bytes(v), 16384, 256), n);
const pub = (v) => { const b = bytes(v, 33); if (b[0] !== 2 && b[0] !== 3)
    fail('invalid-key'); try {
    secp256k1.ProjectivePoint.fromHex(b);
}
catch {
    fail('invalid-key');
} return b; };
function authorization(raw) {
    const v = child(raw, 6);
    bytes(v[0], 32, true);
    bytes(v[1], 32, true);
    const sequence = uint(v[2]);
    if (sequence < 1n || sequence > 4294967294n)
        fail('invalid-sequence');
    uint(v[3]);
    const hashes = child(v[4]);
    if (!hashes.length || hashes.length > 64)
        fail('invalid-document');
    const seen = new Set();
    for (const h of hashes) {
        const id = hex(bytes(h, 32));
        if (seen.has(id))
            fail('duplicate-hash');
        seen.add(id);
    }
    const deadline = uint(v[5]);
    if (deadline === 0n || deadline > 0x7fffffffffffffffn)
        fail('invalid-time');
    return v;
}
export async function bitfsWireDigest(kind, document) { return sha256(encode(['bitfs/wire-signature', 1, kind, document], 32768)); }
export async function inspectBitfsWire(body, own) {
    const fields = object(body, ['kind', 'document']), kind = Number(uint(fields.kind));
    if (![1, 5, 6, 8, 9, 10, 11].includes(kind))
        fail('unsupported-kind');
    const document = bytes(fields.document), v = array(decode(document, 16384, 256));
    const facts = [];
    const add = (name, value) => facts.push({ name, value: value instanceof Uint8Array ? hex(value) : String(value) });
    if (kind === 1) {
        array(v, 8);
        bytes(v[0], 32);
        pub(v[1]);
        uint(v[2]);
        uint(v[3]);
        const size = uint(v[4]), expiry = uint(v[5]);
        if (size > 8192n * 262144n || !expiry || expiry > 0x7fffffffffffffffn)
            fail('invalid-document');
        if (size === 0n && !equal(bytes(v[0]), await sha256(new Uint8Array())))
            fail('invalid-document');
        const arbiters = child(v[6]), seen = new Set();
        for (const a of arbiters) {
            const id = hex(pub(a));
            if (seen.has(id))
                fail('duplicate-key');
            seen.add(id);
        }
        const name = v[7];
        if (typeof name !== 'string' || !name || name.trim() !== name || name === '.' || name === '..' || /[\/\\\p{Cc}]/u.test(name))
            fail('invalid-filename');
        add('seedHash', v[0]);
        add('peer', v[1]);
        add('seedPrice', v[2]);
        add('blockPrice', v[3]);
        add('expiresAt', v[5]);
    }
    else if (kind === 5) {
        const a = authorization(document);
        add('quoteId', a[0]);
        add('refundTxId', a[1]);
        add('paymentSequence', a[2]);
        add('cumulativePaid', a[3]);
        add('expiresAt', a[5]);
    }
    else if (kind === 6) {
        array(v, 1);
        bytes(v[0], 32, true);
        add('authorizationId', v[0]);
    }
    else if (kind === 8) {
        array(v, 5);
        const pool = uint(v[0]);
        if (!pool)
            fail('invalid-document');
        const script = bytes(v[1], 105);
        if (script[0] !== 0x52 || script[1] !== 33 || script[35] !== 33 || script[69] !== 33 || script[103] !== 0x53 || script[104] !== 0xae)
            fail('unsupported-script');
        const keys = [pub(script.slice(2, 35)), pub(script.slice(36, 69)), pub(script.slice(70, 103))];
        if (new Set(keys.map(hex)).size !== 3)
            fail('duplicate-key');
        if (!equal(keys[1], own))
            fail('wrong-key');
        const refund = parseTransaction(bytes(v[2])), a = authorization(v[3]);
        if (refund.inputs.length !== 1 || refund.outputs.length !== 3)
            fail('invalid-refund');
        const input = refund.inputs[0];
        if (input.txid.every(b => b === 0) || input.vout !== 0 || input.sequence === 0xffffffff || input.script.length || uint(a[2]) <= BigInt(input.sequence))
            fail('invalid-refund');
        let total = 0n;
        for (let i = 0; i < 3; i++) {
            const out = refund.outputs[i];
            if (!equal(out.script, p2pkhScript(keys[i])) || (i > 0 && out.satoshis !== 0n))
                fail('invalid-refund');
            total += out.satoshis;
        }
        if (total > pool || uint(a[3]) > total)
            fail('invalid-amount');
        verifyChannelSignature(bytes(v[4]), await bitfsWireDigest(5, bytes(v[3])), keys[0]);
        add('lockedAmount', v[0]);
        add('peer', keys[0]);
        add('quoteId', a[0]);
        add('paymentSequence', a[2]);
        add('cumulativePaid', a[3]);
    }
    else if (kind === 9) {
        array(v, 3);
        bytes(v[0], 32);
        if (!uint(v[1]))
            fail('invalid-amount');
        const signature = bytes(v[2]);
        if (!signature.length || signature.length > 256)
            fail('invalid-signature');
        add('claimId', v[0]);
        add('arbiterAmount', v[1]);
    }
    else if (kind === 10) {
        array(v, 2);
        bytes(v[0], 32, true);
        bytes(v[1], 32, true);
        add('claimId', v[0]);
    }
    else {
        array(v, 3);
        bytes(v[0], 32, true);
        const branch = uint(v[1]);
        if (branch === 0n) {
            if (uint(v[2]) > 2n)
                fail('invalid-document');
        }
        else if (branch === 1n)
            bytes(v[2], 32);
        else
            fail('invalid-document');
        add('requestId', v[0]);
        add('result', v[1]);
    }
    return { kind, digest: await bitfsWireDigest(kind, document), facts };
}
/** A Kind 5 signature can authorize arbitration settlement. Account its actual
 * pool delta here, before signing, using complete funding evidence. Kind 7
 * subsequently signs the same paid baseline and incurs no second charge. */
export async function inspectBitfsAuthorization(raw, previous, own, auth) {
    const a = object(auth, ['document', 'refundTemplate']), document = bytes(a.document), refund = bytes(a.refundTemplate);
    const wire = await inspectBitfsWire({ kind: 5, document }, own), v = authorization(document);
    const review = await inspectFeePool(raw, previous, own, 'bitfs', 'state', 'payer'), baseline = await inspectFeePool(refund, previous, own, 'bitfs', 'state', 'payer');
    // 普通累计付款保留开池退款锁；不得通过 Kind 5 授权提前清零锁定值。
    const target = parseTransaction(raw), template = parseTransaction(refund);
    if (review.paid !== uint(v[3]) || target.inputs[0].sequence !== Number(uint(v[2])) || target.outputs.length !== 3 || target.outputs[2].satoshis !== 0n || target.locktime !== template.locktime || baseline.paid !== 0n || template.inputs[0].sequence >= target.inputs[0].sequence || !equal(await sha256d(refund), bytes(v[1])))
        fail('invalid-authorization');
    return { ...review, digests: [wire.digest] };
}
export class BitfsWireOperation {
    key;
    confirm;
    profile = 'bitfs-wire-document';
    version = 1;
    constructor(key, confirm) {
        this.key = key;
        this.confirm = confirm;
    }
    async verify(body) { const core = decode(encode(body, 32768), 32768); const review = await inspectBitfsWire(core, this.key.publicKey()); if (review.kind === 5)
        fail('payment-context-required'); return core; }
    async authorize(core, signal) { return this.confirm(await inspectBitfsWire(core, this.key.publicKey()), signal); }
    async execute(core, signal) { return { publicKey: this.key.publicKey(), signature: await this.key.signBitfsWire(core, signal, async () => true) }; }
}
/** Kind 2 precedes funding delivery. Derive the source amount from the exact
 * canonical v4 refund and fee rule, then authenticate the buyer's signature.
 * This never manufactures a previous transaction or trusts a source amount. */
export async function inspectBitfsOpening(raw, request, own) {
    const v = array(decode(request, 16384, 256), 8);
    if (uint(v[0]) !== 1n || uint(v[1]) !== 2n || !equal(bytes(v[2]), raw))
        fail('invalid-opening');
    const keys = [pub(v[3]), pub(v[4]), pub(v[5])], script = feePoolScript(keys), rate = uint(v[6]);
    if (!equal(keys[1], own) || rate > BigInt(Number.MAX_SAFE_INTEGER))
        fail('wrong-key');
    const tx = parseTransaction(raw), input = tx.inputs[0];
    if (tx.version !== 1 || tx.inputs.length !== 1 || !input || input.vout !== 0 || input.script.length || input.sequence !== 2 || tx.outputs.length !== 3)
        fail('invalid-opening');
    for (let i = 0; i < 3; i++)
        if (!equal(tx.outputs[i].script, p2pkhScript(keys[i])) || (i > 0 && tx.outputs[i].satoshis !== 0n))
            fail('invalid-opening');
    const product = BigInt(raw.length + 149) * rate;
    if (product > BigInt(Number.MAX_SAFE_INTEGER) - 999n)
        fail('invalid-amount');
    const fee = (product + 999n) / 1000n, locked = tx.outputs[0].satoshis + fee;
    if (locked <= 0n || locked > BigInt(Number.MAX_SAFE_INTEGER))
        fail('invalid-amount');
    const digest = await forkIdAllSighash(tx, 0, { satoshis: locked, script }), signature = bytes(v[7]);
    if (signature.at(-1) !== 0x41)
        fail('invalid-signature');
    verifyChannelSignature(signature.subarray(0, -1), digest, keys[0]);
    return { family: 'bitfs', stage: 'state', role: 'cosigner', paid: 0n, fee, change: 0n, locked, pool: null, outputs: tx.outputs, digests: [digest] };
}
