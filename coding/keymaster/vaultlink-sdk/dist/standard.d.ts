/** 只识别能证明当前 Key 独占的单签输入；数据 push/drop 不改变花费条件。
 * 不执行任意脚本、不从主机的 address/lockingScript 声明推断输入归属。
 */
export declare function standardUnlockKind(script: Uint8Array, pub: Uint8Array): "p2pkh" | "p2pk" | null;
/** 标准交易的输出脚本是承诺的一部分。未知输出按外部支出计额并显示原文，
 * 绝不把调用方声称的找零当成已验证归属。费用池必须用专用 Profile 计新增额。
 */
export declare function inspectStandard(raw: Uint8Array, previous: readonly Uint8Array[], publicKey: Uint8Array): Promise<{
    amount: bigint;
    change: bigint;
    fee: bigint;
    digests: Uint8Array<ArrayBufferLike>[];
    unlockKinds: ("p2pkh" | "p2pk")[];
    outputs: import("./bsv.js").TxOutput[];
}>;
