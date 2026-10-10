export type RequestState = "awaiting-user" | "executing" | "completed" | "denied" | "cancelled" | "unknown";
export interface RequestIdentity {
    id: number;
    sessionId: string;
    commitment: Uint8Array;
}
export interface RequestResult extends RequestIdentity {
    state: RequestState;
    payload: Uint8Array | null;
}
/** 单业务槽 + 一个最近结果 + 接受水位；结果淘汰绝不允许旧 ID 再执行。 */
export declare class RequestGate {
    private watermark;
    private active;
    private recent;
    private closed;
    accept(r: RequestIdentity): RequestResult;
    start(id: number): void;
    complete(id: number, payload: Uint8Array, retainResult?: boolean): RequestResult;
    cancel(id: number, commitment: Uint8Array): RequestResult;
    deny(id: number): RequestResult;
    unknown(id: number): RequestResult;
    query(id: number, sessionId: string, commitment: Uint8Array): RequestResult | null;
    invalidate(): void;
    private current;
    private finish;
    private copy;
}
