import { equal, fail, utf8 } from './bytes.js';
function scalarText(s) {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                fail('invalid-utf8');
        }
        else if (c >= 0xdc00 && c <= 0xdfff)
            fail('invalid-utf8');
    }
}
/** RFC 8785 on the device's bounded subset; native ECMAScript number serialization. */
export function canonicalJson(value) {
    const seen = new Set();
    let nodes = 0, materialized = 0;
    function write(v, depth) {
        if (++nodes > 256 || depth > 12)
            fail('json-limit');
        let out;
        if (v === null)
            out = 'null';
        else if (typeof v === 'boolean')
            out = v ? 'true' : 'false';
        else if (typeof v === 'number') {
            if (!Number.isFinite(v))
                fail('invalid-json');
            out = JSON.stringify(v);
        }
        else if (typeof v === 'string') {
            scalarText(v);
            out = JSON.stringify(v);
        }
        else {
            if (typeof v !== 'object' || seen.has(v))
                fail('invalid-json');
            seen.add(v);
            if (Array.isArray(v)) {
                const entries = [];
                for (let i = 0; i < v.length; i++) {
                    if (!(i in v))
                        fail('invalid-json');
                    entries.push(write(v[i], depth + 1));
                }
                out = '[' + entries.join(',') + ']';
            }
            else {
                if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
                    fail('invalid-json');
                out = '{' + Object.keys(v).sort().map(k => { if (++nodes > 256)
                    fail('json-limit'); scalarText(k); return JSON.stringify(k) + ':' + write(v[k], depth + 1); }).join(',') + '}';
            }
            seen.delete(v);
        }
        materialized += utf8(out).length;
        if (materialized > 32768)
            fail('json-limit');
        return out;
    }
    const raw = utf8(write(value, 0));
    if (raw.length > 16384)
        fail('json-limit');
    return raw;
}
export function parseCanonicalJson(raw) {
    if (raw.length > 16384)
        fail('json-limit');
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    }
    catch {
        fail('invalid-json');
    }
    if (!equal(raw, canonicalJson(value)))
        fail('non-canonical-json');
    return value;
}
