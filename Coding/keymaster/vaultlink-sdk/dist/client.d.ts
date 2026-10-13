import { type Value } from "./cbor.js";
import { type RecordCipher } from "./crypto.js";
import { type Transport } from "./transport.js";
export interface Binding {
    sessionId: string;
    sessionEpoch: number;
    connectionId: number;
    deviceRunId: number;
}
/** 此类只接受已完成配对/持有权验证的会话；生命周期由宿主显式绑定，不伪造 connected。 */
export declare class ProtocolClient {
    private transport;
    private send;
    private receive;
    private binding;
    private onEvent;
    private assembler;
    private nextId;
    private sending;
    private pending;
    private reader;
    private closed;
    private lastEvent;
    private running;
    constructor(transport: Transport, send: RecordCipher, receive: RecordCipher, binding: Binding, onEvent?: (v: Value) => void);
    run(): Promise<void>;
    /** 只读绑定用于重连核验/诊断，不泄露任何链路密钥。 */
    get sessionBinding(): Binding;
    execute(op: string, body: Value, commitment: Uint8Array, timeoutMs?: number): Promise<Value>;
    /** 返回实际分配的 ID，使 query/cancel 不需要猜测心跳占用的编号。 */
    submit(op: string, body: Value, commitment: Uint8Array, timeoutMs?: number): {
        requestId: number;
        result: Promise<Value>;
    };
    /** 取消/查询/心跳均为 REQUEST 控制操作，由调用方提交目标 ID 与承诺；不自动重试支付。 */
    close(reason?: unknown): Promise<void>;
    private checkBinding;
}
