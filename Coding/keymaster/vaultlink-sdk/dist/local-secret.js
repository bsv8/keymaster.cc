import { fail, unhex } from "./bytes.js";
import { object } from "./cbor.js";
export function validateLocalScope(scope) {
    if (typeof scope !== "string" || !scope || new TextEncoder().encode(scope).length > 95 || /[\u0000-\u001f\u007f]/u.test(scope) || /[\ud800-\udfff]/u.test(scope))
        fail("invalid-scope");
    return scope;
}
export function validateLocalSecret(value) {
    const s = object(value, ["version", "keySource", "saltHex", "nonceHex", "ciphertextHex"]);
    if (s.version !== 3 || s.keySource !== "active-key-hkdf-v1" || typeof s.saltHex !== "string" || typeof s.nonceHex !== "string" || typeof s.ciphertextHex !== "string" || s.saltHex.length !== 32 || s.nonceHex.length !== 24 || s.ciphertextHex.length < 34 || s.ciphertextHex.length > 1056)
        fail("invalid-secret");
    unhex(s.saltHex);
    unhex(s.nonceHex);
    unhex(s.ciphertextHex);
    return { ...s };
}
