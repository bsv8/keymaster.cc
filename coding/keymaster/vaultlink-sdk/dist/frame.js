import { fail, u32 } from "./bytes.js";
export const VERSION = 2, MAX_FRAME_PAYLOAD = 1024;
export const Type = {
    HELLO: 1,
    HELLO_ACK: 2,
    PAIR_CONFIRM: 3,
    PAIR_OK: 4,
    POSSESSION_PROVE: 5,
    POSSESSION_OK: 6,
    REQUEST: 16,
    RESPONSE: 17,
    EVENT: 18,
};
const validType = (t) => Object.values(Type).some((x) => x === t);
export function crc32(b) {
    let c = 0xffffffff;
    for (const x of b) {
        c ^= x;
        for (let i = 0; i < 8; i++)
            c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
}
export function frame(f) {
    if (!validType(f.type) || f.payload.length > MAX_FRAME_PAYLOAD)
        fail("invalid-frame");
    const b = new Uint8Array(15 + f.payload.length), d = new DataView(b.buffer);
    b.set([0xa5, 0x5a, VERSION, f.type, 0]);
    d.setUint32(5, u32(f.seq), true);
    d.setUint16(9, f.payload.length, true);
    b.set(f.payload, 11);
    d.setUint32(b.length - 4, crc32(b.subarray(2, b.length - 4)), true);
    return b;
}
/** 定长候选缓冲；从不按主机声明的长度分配。认证帧丢失后由 RecordCipher 的 seq 连续性关链。 */
export class FrameReader {
    b = new Uint8Array(1039);
    used = 0;
    dropped = 0;
    feed(chunk) {
        const out = [];
        for (const x of chunk) {
            if (this.used === this.b.length)
                this.shift(1);
            this.b[this.used++] = x;
            while (this.used >= 2) {
                if (this.b[0] !== 0xa5 || this.b[1] !== 0x5a) {
                    this.shift(1);
                    continue;
                }
                if (this.used < 11)
                    break;
                const d = new DataView(this.b.buffer), len = d.getUint16(9, true);
                if (this.b[2] !== VERSION ||
                    this.b[4] !== 0 ||
                    !validType(this.b[3]) ||
                    len > MAX_FRAME_PAYLOAD) {
                    this.dropped++;
                    this.shift(1);
                    continue;
                }
                if (this.used < 15 + len)
                    break;
                if (d.getUint32(11 + len, true) !== crc32(this.b.subarray(2, 11 + len))) {
                    this.dropped++;
                    this.shift(1);
                    continue;
                }
                out.push({
                    type: this.b[3],
                    seq: d.getUint32(5, true),
                    payload: this.b.slice(11, 11 + len),
                });
                this.shift(15 + len);
            }
        }
        return out;
    }
    reset() {
        this.b.fill(0);
        this.used = 0;
    }
    shift(n) {
        this.b.copyWithin(0, n, this.used);
        this.used -= n;
    }
}
