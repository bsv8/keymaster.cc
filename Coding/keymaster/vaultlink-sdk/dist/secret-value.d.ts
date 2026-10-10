import type { Value } from "./cbor.js";
/** Internal ownership cleanup for rejected/discarded decoded secret payloads. */
export declare function wipeResultBytes(value: Value): void;
