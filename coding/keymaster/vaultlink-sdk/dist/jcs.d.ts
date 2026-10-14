export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** RFC 8785 on the device's bounded subset; native ECMAScript number serialization. */
export declare function canonicalJson(value: JsonValue): Uint8Array;
export declare function parseCanonicalJson(raw: Uint8Array): JsonValue;
