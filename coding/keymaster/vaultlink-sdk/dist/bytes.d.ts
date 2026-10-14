/** 字节统一使用 Uint8Array，浏览器核心不依赖 Buffer 或 Node。 */
export declare function fail(code: string): never;
export declare class ProtocolError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare const utf8: (s: string) => Uint8Array;
export declare function concat(...parts: Uint8Array[]): Uint8Array;
export declare function equal(a: Uint8Array, b: Uint8Array): boolean;
export declare function hex(a: Uint8Array): string;
export declare function unhex(s: string): Uint8Array;
export declare function u32(n: number): number;
export declare function be32(n: number): Uint8Array;
export declare function fixed(b: Uint8Array, n: number): Uint8Array;
export declare const MAX_U64: bigint;
export declare function money(n: bigint): bigint;
export declare function addMoney(a: bigint, b: bigint): bigint;
