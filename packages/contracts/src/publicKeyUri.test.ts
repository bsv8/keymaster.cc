import { expect, it } from "vitest";
import { parsePublicKeyUri } from "./publicKeyUri.js";
const key = "02" + "ab".repeat(32);
it("keeps existing QR payloads and supports explicit contact URIs", () => {
 for (const input of [key.toUpperCase(), JSON.stringify({ publicKeyHex: key }), `keymaster:contact?publicKeyHex=${key}`, `keymaster://contact?publicKeyHex=${key}`]) expect(parsePublicKeyUri(input)).toBe(key);
});
it("rejects malformed or unrelated URI data and duplicate identity parameters", () => {
 for (const input of ["02bad", `https://contact?publicKeyHex=${key}`, `keymaster:contact?publicKeyHex=${key}&publicKeyHex=${key}`, `keymaster:contact?publicKeyHex=${key}&unknown=1`, `keymaster:contact?publicKeyHex=${key}#extra`, `keymaster:transfer?publicKeyHex=${key}`]) expect(parsePublicKeyUri(input)).toBeUndefined();
});
