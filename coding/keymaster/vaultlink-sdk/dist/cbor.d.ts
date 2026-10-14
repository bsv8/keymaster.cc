export type Value = null | boolean | number | bigint | string | Uint8Array | Value[] | {
    [key: string]: Value;
};
/** 自动按 UTF-8 字节长度和字节序排列 map；拒绝超深、非法文本及无界输出。 */
export declare function encode(value: Value, maxBytes?: number): Uint8Array;
export declare function decode(bytes: Uint8Array, maxBytes?: number, maxNodes?: number): Value;
export declare function object(v: Value, keys: string[]): {
    [key: string]: Value;
};
export declare function canonical(bytes: Uint8Array): boolean;
