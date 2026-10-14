import { concat, equal, fail, MAX_U64, utf8 } from "./bytes.js";
const MAX_BYTES = 896, MAX_DEPTH = 6;
function compare(a, b) {
    if (a.length !== b.length)
        return a.length - b.length;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return 0;
}
function text(s) {
    const b = utf8(s);
    if (new TextDecoder("utf-8", { fatal: true }).decode(b) !== s)
        fail("invalid-utf8");
    return b;
}
function head(major, n) {
    if (n < 0n || n > MAX_U64)
        fail("integer-overflow");
    if (n < 24n)
        return Uint8Array.of((major << 5) | Number(n));
    const width = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 0xffffffffn ? 4 : 8;
    const b = new Uint8Array(1 + width);
    b[0] = (major << 5) | { 1: 24, 2: 25, 4: 26, 8: 27 }[width];
    for (let i = width; i > 0; i--) {
        b[i] = Number(n & 255n);
        n >>= 8n;
    }
    return b;
}
/** 自动按 UTF-8 字节长度和字节序排列 map；拒绝超深、非法文本及无界输出。 */
export function encode(value, maxBytes = MAX_BYTES) {
    let size = 0;
    const parts = [];
    const put = (b) => {
        size += b.length;
        if (size > maxBytes)
            fail("message-too-large");
        parts.push(b);
    };
    function visit(v, depth) {
        if (v === null) {
            put(Uint8Array.of(0xf6));
            return;
        }
        if (typeof v === "boolean") {
            put(Uint8Array.of(v ? 0xf5 : 0xf4));
            return;
        }
        if (typeof v === "number" || typeof v === "bigint") {
            if (typeof v === "number" && !Number.isSafeInteger(v))
                fail("invalid-integer");
            const n = BigInt(v);
            put(head(n < 0n ? 1 : 0, n < 0n ? -1n - n : n));
            return;
        }
        if (typeof v === "string") {
            const b = text(v);
            put(head(3, BigInt(b.length)));
            put(b);
            return;
        }
        if (v instanceof Uint8Array) {
            put(head(2, BigInt(v.length)));
            put(v);
            return;
        }
        if (depth >= MAX_DEPTH)
            fail("depth-exceeded");
        if (Array.isArray(v)) {
            put(head(4, BigInt(v.length)));
            for (const x of v)
                visit(x, depth + 1);
            return;
        }
        if (typeof v !== "object" ||
            (Object.getPrototypeOf(v) !== Object.prototype &&
                Object.getPrototypeOf(v) !== null))
            fail("invalid-value");
        const entries = Object.entries(v)
            .map(([k, x]) => ({ b: text(k), x }))
            .sort((a, b) => compare(a.b, b.b));
        if (entries.length > 24)
            fail("map-too-large");
        put(head(5, BigInt(entries.length)));
        for (const { b, x } of entries) {
            if (b.length < 1 || b.length > 31)
                fail("invalid-key");
            put(head(3, BigInt(b.length)));
            put(b);
            visit(x, depth + 1);
        }
    }
    visit(value, 0);
    return concat(...parts);
}
export function decode(bytes, maxBytes = MAX_BYTES, maxNodes = Infinity) {
    if (bytes.length > maxBytes)
        fail("message-too-large");
    let at = 0, nodes = 0;
    const take = (n) => {
        if (n < 0 || at + n > bytes.length)
            fail("truncated");
        const b = bytes.slice(at, at + n);
        at += n;
        return b;
    };
    function read(depth) {
        if (++nodes > maxNodes)
            fail("node-limit");
        const h = take(1)[0], major = h >> 5, ai = h & 31;
        if (major === 7) {
            if (ai === 20)
                return false;
            if (ai === 21)
                return true;
            if (ai === 22)
                return null;
            fail("invalid-simple");
        }
        if (major > 5 || ai > 27)
            fail("invalid-type");
        let n = BigInt(ai);
        if (ai >= 24) {
            const width = 1 << (ai - 24);
            const b = take(width);
            n = 0n;
            for (const x of b)
                n = (n << 8n) | BigInt(x);
            const min = [24n, 256n, 65536n, 4294967296n][ai - 24];
            if (n < min)
                fail("non-shortest");
        }
        if (major === 0 || major === 1) {
            const x = major === 0 ? n : -1n - n;
            return x <= BigInt(Number.MAX_SAFE_INTEGER) &&
                x >= BigInt(Number.MIN_SAFE_INTEGER)
                ? Number(x)
                : x;
        }
        if (n > BigInt(bytes.length - at))
            fail("invalid-length");
        const count = Number(n);
        if (major === 2)
            return take(count);
        if (major === 3) {
            try {
                return new TextDecoder("utf-8", { fatal: true }).decode(take(count));
            }
            catch {
                fail("invalid-utf8");
            }
        }
        if (depth >= MAX_DEPTH)
            fail("depth-exceeded");
        if (major === 4) {
            const a = [];
            for (let i = 0; i < count; i++)
                a.push(read(depth + 1));
            return a;
        }
        if (count > 24 || count * 2 > bytes.length - at)
            fail("map-too-large");
        const o = Object.create(null);
        let previous;
        for (let i = 0; i < count; i++) {
            const key = read(depth + 1);
            if (typeof key !== "string")
                fail("invalid-key");
            const b = text(key);
            if (b.length < 1 ||
                b.length > 31 ||
                (previous && compare(previous, b) >= 0))
                fail("key-order");
            previous = b;
            o[key] = read(depth + 1);
        }
        return o;
    }
    const v = read(0);
    if (at !== bytes.length)
        fail("trailing-bytes");
    return v;
}
export function object(v, keys) {
    if (!v ||
        typeof v !== "object" ||
        v instanceof Uint8Array ||
        Array.isArray(v))
        fail("invalid-object");
    if (Object.keys(v).length !== keys.length ||
        keys.some((k) => !Object.hasOwn(v, k)))
        fail("invalid-fields");
    return v;
}
export function canonical(bytes) {
    return equal(bytes, encode(decode(bytes)));
}
