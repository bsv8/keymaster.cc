export interface Transport {
    read(): Promise<Uint8Array | null>;
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
export interface SerialPortLike {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: {
        baudRate: number;
    }): Promise<void>;
    close(): Promise<void>;
}
/** 串口许可由 Window 的用户手势取得，再把 port 交给适配器；核心不访问 navigator 或 Coordinator。 */
export declare class WebSerialTransport implements Transport {
    private port;
    private reader;
    private writer;
    private stopped;
    private constructor();
    static open(port: SerialPortLike, baudRate?: number): Promise<WebSerialTransport>;
    read(): Promise<Uint8Array | null>;
    write(bytes: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
