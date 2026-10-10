export declare const VERSION = 2, MAX_FRAME_PAYLOAD = 1024;
export declare const Type: {
    readonly HELLO: 1;
    readonly HELLO_ACK: 2;
    readonly PAIR_CONFIRM: 3;
    readonly PAIR_OK: 4;
    readonly POSSESSION_PROVE: 5;
    readonly POSSESSION_OK: 6;
    readonly REQUEST: 16;
    readonly RESPONSE: 17;
    readonly EVENT: 18;
};
export interface Frame {
    type: number;
    seq: number;
    payload: Uint8Array;
}
export declare function crc32(b: Uint8Array): number;
export declare function frame(f: Frame): Uint8Array;
/** 定长候选缓冲；从不按主机声明的长度分配。认证帧丢失后由 RecordCipher 的 seq 连续性关链。 */
export declare class FrameReader {
    private b;
    private used;
    dropped: number;
    feed(chunk: Uint8Array): Frame[];
    reset(): void;
    private shift;
}
