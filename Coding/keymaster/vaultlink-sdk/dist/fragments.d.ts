import { type Value } from "./cbor.js";
export declare const MAX_MESSAGE = 32768, FRAGMENT_BYTES = 640;
/** 不增加帧类型。每个分片仍独立认证和连续编号；业务对象只在整体验证后交给解析器。 */
export declare function fragments(value: Value): Promise<Uint8Array[]>;
export declare class FragmentAssembler {
    private pending;
    accept(plain: Uint8Array, type?: number): Promise<Value | undefined>;
    close(): void;
}
