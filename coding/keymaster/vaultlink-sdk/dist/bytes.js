/** 字节统一使用 Uint8Array，浏览器核心不依赖 Buffer 或 Node。 */
export function fail(code) {
    throw new ProtocolError(code);
}
export class ProtocolError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "ProtocolError";
    }
}
export const utf8 = (s) => new TextEncoder().encode(s);
export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
export function equal(a, b) {
    if (a.length !== b.length)
        return false;
    let d = 0;
    for (let i = 0; i < a.length; i++)
        d |= a[i] ^ b[i];
    return d === 0;
}
export function hex(a) {
    return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function unhex(s) {
    if (!/^(?:[0-9a-f]{2})*$/.test(s))
        fail("invalid-hex");
    return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export function u32(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
        fail("invalid-u32");
    return n;
}
export function be32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, u32(n));
    return b;
}
export function fixed(b, n) {
    if (!(b instanceof Uint8Array) || b.length !== n)
        fail("invalid-length");
    return b;
}
export const MAX_U64 = (1n << 64n) - 1n;
export function money(n) {
    if (typeof n !== "bigint" || n < 0n || n > MAX_U64)
        fail("invalid-amount");
    return n;
}
export function addMoney(a, b) {
    const n = money(a) + money(b);
    return money(n);
}
