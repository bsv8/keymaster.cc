import { secp256k1 } from "@noble/curves/secp256k1";
import { addMoney, concat, equal, fail, fixed, hex } from "./bytes.js";
import { sha256d } from "./crypto.js";
import { forkIdAllSighash, parseTransaction, p2pkhScript, } from "./bsv.js";
/** 顺序必须与现有两种真实协议一致：Connect server/client；BitFS buyer/seller/arbiter。 */
export function feePoolScript(keys) {
    if (keys.length !== 2 && keys.length !== 3)
        fail("unsupported-script");
    const seen = new Set();
    for (const key of keys) {
        fixed(key, 33);
        secp256k1.ProjectivePoint.fromHex(key);
        if (seen.has(hex(key)))
            fail("duplicate-key");
        seen.add(hex(key));
    }
    return concat(Uint8Array.of(0x52), ...keys.map((k) => concat(Uint8Array.of(33), k)), Uint8Array.of(0x50 + keys.length, 0xae));
}
function roles(script, family) {
    const count = family === "connect" ? 2 : 3;
    if (script.length !== 3 + 34 * count)
        fail("unsupported-script");
    const keys = Array.from({ length: count }, (_, i) => script.slice(2 + 34 * i, 35 + 34 * i));
    if (!equal(feePoolScript(keys), script))
        fail("unsupported-script");
    return keys;
}
function proof(script) {
    if (script.length < 4 || script[0] !== 0 || script[1] !== 0x6a)
        return false;
    const op = script[2];
    if (op > 0 && op < 76)
        return script.length === 3 + op;
    if (op === 76)
        return script[3] >= 76 && script.length === 4 + script[3];
    if (op === 77 && script.length >= 5) {
        const n = script[3] + 256 * script[4];
        return n > 255 && script.length === 5 + n;
    }
    return false;
}
/** 只从交易与完整前序原文解释资金；不接受自报 sourceSatoshis/paid/change/digest。 */
export async function inspectFeePool(raw, previous, publicKey, family, stage, role = "payer") {
    if ((family !== "connect" && family !== "bitfs") ||
        (stage !== "fund" && stage !== "state"))
        fail("unsupported");
    if ((role !== "payer" && role !== "cosigner") || (stage === "fund" && role !== "payer"))
        fail("unsupported-role");
    const tx = parseTransaction(raw, 640);
    if (tx.inputs.length > 4 || previous.length !== tx.inputs.length)
        fail("invalid-prevout");
    const own = p2pkhScript(publicKey), prevouts = [], seen = new Set();
    let inputSum = 0n, outputSum = 0n;
    for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        if (input.script.length)
            fail("already-signed");
        const ref = hex(input.txid) + ":" + input.vout;
        if (seen.has(ref))
            fail("duplicate-input");
        seen.add(ref);
        const prior = parseTransaction(previous[i]);
        if (!equal(await sha256d(previous[i]), input.txid) ||
            input.vout >= prior.outputs.length)
            fail("invalid-prevout");
        const out = prior.outputs[input.vout];
        inputSum = addMoney(inputSum, out.satoshis);
        prevouts.push(out);
    }
    for (const o of tx.outputs)
        outputSum = addMoney(outputSum, o.satoshis);
    if (outputSum > inputSum)
        fail("negative-fee");
    let paid = 0n, change = 0n, locked = 0n, pool = null;
    if (stage === "fund") {
        if ((tx.outputs.length !== 1 && tx.outputs.length !== 2) ||
            (tx.outputs.length === 2 && !equal(tx.outputs[1].script, own)) ||
            prevouts.some((o) => !equal(o.script, own)))
            fail("invalid-funding");
        const keys = roles(tx.outputs[0].script, family), buyer = keys[family === "connect" ? 1 : 0];
        if (!equal(buyer, publicKey))
            fail("wrong-key");
        locked = tx.outputs[0].satoshis;
        change = tx.outputs[1]?.satoshis ?? 0n;
        if (locked === 0n)
            fail("invalid-amount");
    }
    else {
        if (tx.inputs.length !== 1 || tx.inputs[0].vout !== 0)
            fail("invalid-pool-input");
        const source = prevouts[0], keys = roles(source.script, family);
        const payer = keys[family === "connect" ? 1 : 0];
        if (role === "payer" ? !equal(payer, publicKey) : equal(payer, publicKey) || !keys.some(k => equal(k, publicKey)))
            fail("wrong-key");
        const expected = keys.map(p2pkhScript);
        if (tx.outputs.length !== expected.length &&
            !(family === "bitfs" && tx.outputs.length === 4))
            fail("invalid-pool-output");
        for (let i = 0; i < expected.length; i++) {
            const out = tx.outputs[i];
            if (!equal(out.script, expected[i]))
                fail("invalid-pool-output");
            if (equal(out.script, own))
                change = addMoney(change, out.satoshis);
            else
                paid = addMoney(paid, out.satoshis);
        }
        if (tx.outputs.length === 4 &&
            (tx.outputs[3].satoshis !== 0n || !proof(tx.outputs[3].script)))
            fail("invalid-payment-proof");
        if (role === "payer")
            pool = {
                id: hex(tx.inputs[0].txid) + ":0",
                binding: await sha256d(source.script),
            };
    }
    return {
        family,
        stage,
        role,
        paid,
        change,
        locked,
        pool,
        fee: inputSum - outputSum,
        outputs: tx.outputs,
        digests: await Promise.all(prevouts.map((p, i) => forkIdAllSighash(tx, i, p))),
    };
}
