import { type Frame } from "./frame.js";
import { type Generations, type IdentityVerifier, type PairedKeys } from "./handshake.js";
import { type Transport } from "./transport.js";
import { type Binding, ProtocolClient } from "./client.js";
export interface DeviceKey {
    publicKey(): Uint8Array;
    provePossession(transcript: Uint8Array, sessionId: number, challenge: Uint8Array): Promise<Uint8Array>;
}
/** 真实字节管道，保留合并读取的多帧；握手/业务共用，避免在阶段切换时丢掉尾帧。 */
export declare class PacketLink {
    readonly transport: Transport;
    private reader;
    private queue;
    private reading;
    constructor(transport: Transport);
    read(timeoutMs?: number): Promise<Frame>;
    private readNext;
    send(f: Frame): Promise<void>;
    /** Client 专用读取视图：把已缓冲尾帧重新编码，之后沿用同一字节管道。 */
    clientTransport(): Transport;
}
export interface ReadySession {
    link: PacketLink;
    keys: PairedKeys;
    binding: Binding;
}
export declare function connectHost(transport: Transport, generations: Generations, expectedPublicKey: Uint8Array, verifier: IdentityVerifier, confirmPairing: (code: string) => Promise<boolean>, capabilities?: number[]): Promise<ProtocolClient>;
/** 首次绑定专用：两端明确配对并证明持有权后才交付公钥。
 * 此入口不用于已有钱包重连，不能把 wrong-key 转成首次绑定。
 */
export declare function enrollHost(transport: Transport, generations: Generations, verifier: IdentityVerifier, confirmPairing: (code: string) => Promise<boolean>, capabilities?: number[]): Promise<{
    client: ProtocolClient;
    publicKey: Uint8Array;
}>;
export declare function acceptDevice(transport: Transport, key: DeviceKey, deviceRunId: number, connectionId: number, confirmPairing: (code: string) => Promise<boolean>, capabilities?: number[]): Promise<ReadySession>;
