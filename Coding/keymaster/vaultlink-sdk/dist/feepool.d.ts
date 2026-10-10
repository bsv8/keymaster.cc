import { type TxOutput } from "./bsv.js";
export type FeePoolFamily = "connect" | "bitfs";
export type FeePoolStage = "fund" | "state";
export interface FeePoolReview {
    family: FeePoolFamily;
    stage: FeePoolStage;
    role: "payer" | "cosigner";
    fee: bigint;
    change: bigint;
    paid: bigint;
    locked: bigint;
    pool: {
        id: string;
        binding: Uint8Array;
    } | null;
    outputs: TxOutput[];
    digests: Uint8Array[];
}
/** 顺序必须与现有两种真实协议一致：Connect server/client；BitFS buyer/seller/arbiter。 */
export declare function feePoolScript(keys: readonly Uint8Array[]): Uint8Array;
/** 只从交易与完整前序原文解释资金；不接受自报 sourceSatoshis/paid/change/digest。 */
export declare function inspectFeePool(raw: Uint8Array, previous: readonly Uint8Array[], publicKey: Uint8Array, family: FeePoolFamily, stage: FeePoolStage, role?: "payer" | "cosigner"): Promise<FeePoolReview>;
