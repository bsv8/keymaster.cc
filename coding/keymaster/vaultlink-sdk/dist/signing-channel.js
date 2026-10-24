import { fail } from "./bytes.js";
export const signingOperations = Object.freeze([
    "identity.noise-proof", "identity.peer-record", "connect.identity-sign", "connect.intent-sign",
    "bitfs.wire-sign", "channel.public-message", "channel.hash-request", "channel.private-message",
    "software.digest-sign",
]);
/** This allowlist is not a digest-signing permission: typed callers still validate
 * the full operation document before entering the signing policy. */
export function automaticSigningOperation(operation) {
    return signingOperations.includes(operation) && operation !== "software.digest-sign";
}
export function inspectSigningChannel(value) {
    if (!value || Object.keys(value).sort().join() !== "id,kind,mode,operation,owner,revision" ||
        !/^[a-zA-Z0-9._:/-]{1,96}$/.test(value.id) || !/^[a-zA-Z0-9._:/-]{1,96}$/.test(value.owner) ||
        (value.kind !== "app" && value.kind !== "plugin") || !signingOperations.includes(value.operation) ||
        (value.mode !== "automatic" && value.mode !== "manual") ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision >= 0xffffffff)
        fail("invalid-signing-channel");
    return { ...value };
}
export function sameSigningRegistration(a, b) {
    return a.id === b.id && a.owner === b.owner && a.kind === b.kind && a.operation === b.operation;
}
