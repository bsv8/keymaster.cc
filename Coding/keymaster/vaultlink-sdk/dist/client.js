import { wipeResultBytes } from "./secret-value.js";
import { fragments, FragmentAssembler } from "./fragments.js";
import { equal, fail, fixed, u32 } from "./bytes.js";
import { object } from "./cbor.js";
import { FrameReader, frame, Type } from "./frame.js";
import { commitment } from "./crypto.js";
/** 此类只接受已完成配对/持有权验证的会话；生命周期由宿主显式绑定，不伪造 connected。 */
export class ProtocolClient {
    transport;
    send;
    receive;
    binding;
    onEvent;
    assembler = new FragmentAssembler();
    nextId = 1;
    // 串行发送完整消息，避免两个大请求交错分片；控制请求最多等待一个有界消息。
    sending = Promise.resolve();
    pending = new Map();
    reader = new FrameReader();
    closed = false;
    lastEvent = 0;
    running = false;
    constructor(transport, send, receive, binding, onEvent = () => { }) {
        this.transport = transport;
        this.send = send;
        this.receive = receive;
        this.binding = binding;
        this.onEvent = onEvent;
        u32(binding.sessionEpoch);
        u32(binding.deviceRunId);
        u32(binding.connectionId);
        if (!binding.sessionId)
            fail("invalid-session");
    }
    async run() {
        if (this.running || this.closed)
            fail("invalid-state");
        this.running = true;
        const heartbeat = setInterval(() => {
            void commitment("system", 1, { op: "system.ping" })
                .then((c) => this.execute("system.ping", {}, c, 4000))
                .catch((e) => this.close(e));
        }, 1000);
        try {
            while (!this.closed) {
                const chunk = await this.transport.read();
                if (chunk === null)
                    fail("disconnected");
                for (const f of this.reader.feed(chunk)) {
                    const plain = await this.receive.open(f);
                    let v;
                    try {
                        v = await this.assembler.accept(plain, f.type);
                    }
                    finally {
                        plain.fill(0);
                    }
                    if (v === undefined)
                        continue;
                    let delivered = false;
                    try {
                        if (f.type === Type.EVENT) {
                            const e = object(v, ["kind", "eventSeq", "binding", "payload"]);
                            this.checkBinding(e.binding);
                            if (typeof e.eventSeq !== "number" || e.eventSeq <= this.lastEvent)
                                continue;
                            u32(e.eventSeq);
                            this.lastEvent = e.eventSeq;
                            this.onEvent(e.payload);
                            delivered = true;
                            continue;
                        }
                        if (f.type !== Type.RESPONSE)
                            fail("invalid-response");
                        const r = object(v, [
                            "requestId",
                            "binding",
                            "commitment",
                            "payload",
                        ]);
                        this.checkBinding(r.binding);
                        if (typeof r.requestId !== "number")
                            fail("invalid-response");
                        const p = this.pending.get(r.requestId);
                        if (!p)
                            continue;
                        if (!(r.commitment instanceof Uint8Array) ||
                            !equal(r.commitment, p.commitment))
                            fail("invalid-commitment");
                        clearTimeout(p.timer);
                        this.pending.delete(r.requestId);
                        delivered = true;
                        p.resolve(r.payload);
                    }
                    finally {
                        if (!delivered)
                            wipeResultBytes(v);
                    }
                }
            }
        }
        catch (e) {
            await this.close(e);
        }
        finally {
            clearInterval(heartbeat);
        }
    }
    /** 只读绑定用于重连核验/诊断，不泄露任何链路密钥。 */
    get sessionBinding() {
        return { ...this.binding };
    }
    execute(op, body, commitment, timeoutMs = 120000) {
        return this.submit(op, body, commitment, timeoutMs).result;
    }
    /** 返回实际分配的 ID，使 query/cancel 不需要猜测心跳占用的编号。 */
    submit(op, body, commitment, timeoutMs = 120000) {
        if (this.closed)
            fail("disconnected");
        if (!/^[a-z][a-z0-9.-]{0,47}$/.test(op) ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1)
            fail("invalid-request");
        if (this.pending.size >= 32)
            fail("busy");
        if (this.nextId > 0xffffffff)
            fail("request-id-exhausted");
        const requestId = this.nextId++;
        const c = fixed(commitment, 32).slice();
        if (c.every((x) => x === 0))
            fail("invalid-commitment");
        const payload = {
            op,
            opVersion: 1,
            body,
            requestId,
            binding: this.binding,
            commitment: c,
        };
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error("result-unknown"));
            }, timeoutMs);
            this.pending.set(requestId, {
                resolve,
                reject,
                timer,
                commitment: c,
                binding: { ...this.binding },
            });
            const sending = this.sending.then(async () => {
                if (this.closed)
                    fail("disconnected");
                const parts = await fragments(payload);
                try {
                    for (const part of parts)
                        await this.transport.write(frame(await this.send.seal(Type.REQUEST, part)));
                }
                finally {
                    for (const part of parts)
                        part.fill(0);
                }
            });
            this.sending = sending.catch(e => this.close(e));
        });
        return { requestId, result };
    }
    /** 取消/查询/心跳均为 REQUEST 控制操作，由调用方提交目标 ID 与承诺；不自动重试支付。 */
    async close(reason = new Error("disconnected")) {
        if (this.closed)
            return;
        this.closed = true;
        this.send.close();
        this.receive.close();
        this.reader.reset();
        this.assembler.close();
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(reason);
        }
        this.pending.clear();
        await this.transport.close();
    }
    checkBinding(v) {
        const b = object(v, [
            "sessionId",
            "sessionEpoch",
            "connectionId",
            "deviceRunId",
        ]);
        if (Object.entries(this.binding).some(([k, x]) => b[k] !== x))
            fail("stale-session");
    }
}
