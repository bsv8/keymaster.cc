import { equal, fail } from "./bytes.js";
import { encode, decode, object } from "./cbor.js";
import { sha256 } from "./crypto.js";
export const MAX_MESSAGE = 32768, FRAGMENT_BYTES = 640;
/** 不增加帧类型。每个分片仍独立认证和连续编号；业务对象只在整体验证后交给解析器。 */
export async function fragments(value) {
    const raw = encode(value, MAX_MESSAGE);
    if (raw.length <= 896)
        return [raw];
    const out = [];
    try {
        const hash = await sha256(raw);
        for (let offset = 0; offset < raw.length; offset += FRAGMENT_BYTES) {
            const data = raw.slice(offset, offset + FRAGMENT_BYTES);
            try {
                out.push(encode({ fragment: { total: raw.length, offset, hash, data } }));
            }
            finally {
                data.fill(0);
            }
        }
        return out;
    }
    catch (error) {
        for (const part of out)
            part.fill(0);
        throw error;
    }
    finally {
        raw.fill(0);
    }
}
export class FragmentAssembler {
    pending;
    async accept(plain, type = 0) {
        const value = decode(plain);
        if (!value || typeof value !== "object" || value instanceof Uint8Array || Array.isArray(value) || !("fragment" in value))
            return value;
        const wrapper = object(value, ["fragment"]), f = object(wrapper.fragment, ["total", "offset", "hash", "data"]);
        if (typeof f.total !== "number" || f.total <= 896 || f.total > MAX_MESSAGE || typeof f.offset !== "number" || !(f.hash instanceof Uint8Array) || f.hash.length !== 32 || !(f.data instanceof Uint8Array) || !f.data.length || f.data.length > FRAGMENT_BYTES)
            fail("invalid-fragment");
        if (!this.pending) {
            if (f.offset !== 0)
                fail("fragment-order");
            this.pending = { raw: new Uint8Array(f.total), hash: f.hash.slice(), offset: 0, started: Date.now(), type };
        }
        const p = this.pending;
        if (type !== p.type || Date.now() - p.started > 8000 || f.total !== p.raw.length || f.offset !== p.offset || !equal(f.hash, p.hash) || p.offset + f.data.length > p.raw.length || (p.offset + f.data.length < p.raw.length && f.data.length !== FRAGMENT_BYTES))
            fail("fragment-order");
        p.raw.set(f.data, p.offset);
        p.offset += f.data.length;
        if (p.offset !== p.raw.length)
            return;
        this.pending = undefined;
        try {
            if (!equal(await sha256(p.raw), p.hash))
                fail("fragment-hash");
            return decode(p.raw, MAX_MESSAGE);
        }
        finally {
            p.raw.fill(0);
        }
    }
    close() { this.pending?.raw.fill(0); this.pending = undefined; }
}
