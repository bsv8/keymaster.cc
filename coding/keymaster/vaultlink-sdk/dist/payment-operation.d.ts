import { type Value } from "./cbor.js";
import { DeviceIdentityKey } from "./bsv.js";
import { PaymentPolicy, type PaymentInspection, type Quote } from "./payment.js";
import { type OperationHandler } from "./device.js";
/** 同一个实际交易只预占一次；所有输入共用一次授权。宿主负责原子绑定 policy 的 Key 与本 DeviceKey。 */
export declare class P2pkhPaymentOperation implements OperationHandler {
    private key;
    private policy;
    private context;
    private confirm;
    readonly profile: string;
    readonly version = 1;
    constructor(key: DeviceIdentityKey, policy: PaymentPolicy, context: {
        owner: string;
        kind: "app" | "plugin";
        sessionId: string | null;
    } | null, confirm: (request: PaymentInspection, quote: Quote, signal: AbortSignal) => Promise<{
        allow: boolean;
        raiseSessionLimit?: bigint;
    }>);
    verify(body: Value): Promise<Value>;
    private request;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
