import { type Value } from "./cbor.js";
import { type ReadySession } from "./session.js";
export interface OperationHandler {
    /** False for one-time private material: queries/replays retain status only. */
    retainResult?: boolean;
    profile: string;
    version: number;
    /** verify 返回 Profile 完整规范核心，禁止主机挑选字段。 */ verify(body: Value): Promise<Value>;
    authorize(core: Value, signal: AbortSignal): Promise<boolean>;
    execute(core: Value, signal: AbortSignal): Promise<Value>;
}
/** SDK 只登记真实操作。设备持续读取控制消息，业务执行不阻塞取消/状态查询；单业务槽由 Gate 强制。 */
export declare class DeviceServer {
    private session;
    private onLock;
    private assembler;
    private gate;
    private sending;
    private stopped;
    private active;
    private operations;
    private abort;
    constructor(session: ReadySession, onLock: () => void | Promise<void>);
    register(op: string, handler: OperationHandler): void;
    run(): Promise<void>;
    private business;
    private control;
    private checkBinding;
    private respond;
    close(): Promise<void>;
}
