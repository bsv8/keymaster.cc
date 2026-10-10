import { addMoney, equal, fail, hex } from "./bytes.js";
import { sha256d } from "./crypto.js";
import { forkIdAllSighash, parseTransaction, p2pkhScript } from "./bsv.js";
/** 只识别能证明当前 Key 独占的单签输入；数据 push/drop 不改变花费条件。
 * 不执行任意脚本、不从主机的 address/lockingScript 声明推断输入归属。
 */
export function standardUnlockKind(script, pub) {
    if (equal(script, p2pkhScript(pub)))
        return "p2pkh";
    let at = 0;
    while (at < script.length) {
        let n = script[at++];
        if (n === 76) {
            if (at >= script.length)
                return null;
            n = script[at++];
            if (n < 76)
                return null;
        }
        else if (n === 77) {
            if (at + 2 > script.length)
                return null;
            n = script[at] + 256 * script[at + 1];
            at += 2;
            if (n < 256)
                return null;
        }
        else if (n < 1 || n > 75)
            return null;
        if (at + n >= script.length)
            return null;
        const data = script.subarray(at, at + n);
        at += n;
        const op = script[at++];
        if (op === 0xac)
            return at === script.length && equal(data, pub) ? "p2pk" : null;
        if (op !== 0x75)
            return null;
    }
    return null;
}
/** 标准交易的输出脚本是承诺的一部分。未知输出按外部支出计额并显示原文，
 * 绝不把调用方声称的找零当成已验证归属。费用池必须用专用 Profile 计新增额。
 */
export async function inspectStandard(raw, previous, publicKey) {
    const tx = parseTransaction(raw, 8192);
    if (previous.length !== tx.inputs.length || tx.inputs.length > 10 || tx.outputs.length > 32)
        fail("unsupported");
    const seen = new Set(), digests = [], unlockKinds = [];
    let inputs = 0n, outputs = 0n, change = 0n, amount = 0n;
    for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i], ref = hex(input.txid) + ":" + input.vout;
        if (input.script.length)
            fail("already-signed");
        if (seen.has(ref))
            fail("duplicate-input");
        seen.add(ref);
        const prior = parseTransaction(previous[i]);
        if (!equal(await sha256d(previous[i]), input.txid) || input.vout >= prior.outputs.length)
            fail("invalid-prevout");
        const out = prior.outputs[input.vout], kind = standardUnlockKind(out.script, publicKey);
        if (!kind)
            fail("unsupported-input");
        unlockKinds.push(kind);
        inputs = addMoney(inputs, out.satoshis);
        digests.push(await forkIdAllSighash(tx, i, out));
    }
    for (const out of tx.outputs) {
        outputs = addMoney(outputs, out.satoshis);
        if (standardUnlockKind(out.script, publicKey))
            change = addMoney(change, out.satoshis);
        else
            amount = addMoney(amount, out.satoshis);
    }
    if (outputs > inputs)
        fail("negative-fee");
    return { amount, change, fee: inputs - outputs, digests, unlockKinds, outputs: tx.outputs };
}
