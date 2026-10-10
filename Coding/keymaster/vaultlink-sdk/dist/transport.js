import { fail } from "./bytes.js";
/** 串口许可由 Window 的用户手势取得，再把 port 交给适配器；核心不访问 navigator 或 Coordinator。 */
export class WebSerialTransport {
    port;
    reader;
    writer;
    stopped = false;
    constructor(port) {
        this.port = port;
        if (!port.readable || !port.writable)
            fail("port-unavailable");
        this.reader = port.readable.getReader();
        this.writer = port.writable.getWriter();
    }
    static async open(port, baudRate = 115200) {
        await port.open({ baudRate });
        return new WebSerialTransport(port);
    }
    async read() {
        if (this.stopped)
            return null;
        const r = await this.reader.read();
        return r.done ? null : r.value;
    }
    async write(bytes) {
        if (this.stopped)
            fail("disconnected");
        await this.writer.write(bytes.slice());
    }
    async close() {
        if (this.stopped)
            return;
        this.stopped = true;
        // 拔插时不能等待未完成写入正常排空。读取消/写中止都执行，再释放句柄。
        await Promise.allSettled([this.reader.cancel(), this.writer.abort()]);
        this.reader.releaseLock();
        this.writer.releaseLock();
        await this.port.close();
    }
}
