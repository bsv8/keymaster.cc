import { equal, fail, fixed, u32 } from "./bytes.js";
import { MAX_MESSAGE } from "./fragments.js";
/** 单业务槽 + 一个最近结果 + 接受水位；结果淘汰绝不允许旧 ID 再执行。 */
export class RequestGate {
    watermark = 0;
    active;
    recent;
    closed = false;
    accept(r) {
        if (this.closed)
            fail("disconnected");
        u32(r.id);
        if (r.id === 0 ||
            !r.sessionId ||
            fixed(r.commitment, 32).every((x) => x === 0))
            fail("invalid-request");
        const known = this.active?.id === r.id
            ? this.active
            : this.recent?.id === r.id
                ? this.recent
                : undefined;
        if (known) {
            if (known.sessionId !== r.sessionId ||
                !equal(known.commitment, r.commitment))
                fail("request-conflict");
            return this.copy(known);
        }
        if (r.id <= this.watermark)
            fail("replay");
        if (this.active)
            fail("busy");
        this.watermark = r.id;
        this.active = {
            ...r,
            commitment: r.commitment.slice(),
            state: "awaiting-user",
            payload: null,
        };
        return this.copy(this.active);
    }
    start(id) {
        const r = this.current(id);
        if (r.state !== "awaiting-user")
            fail("invalid-state");
        r.state = "executing";
    }
    complete(id, payload, retainResult = true) {
        const r = this.current(id);
        if (r.state !== "executing" || payload.length > MAX_MESSAGE)
            fail("invalid-state");
        r.state = "completed";
        // The application message can be fragmented. A query wraps its payload in
        // another envelope, so reserve bounded space for that envelope. One-time
        // secrets retain only completion state and replay protection, never bytes.
        r.payload = retainResult && payload.length <= MAX_MESSAGE - 512 ? payload.slice() : null;
        return this.finish(r);
    }
    cancel(id, commitment) {
        const r = this.active?.id === id
            ? this.active
            : this.recent?.id === id
                ? this.recent
                : undefined;
        if (!r)
            fail("result-unknown");
        if (!equal(fixed(commitment, 32), r.commitment))
            fail("request-conflict");
        if (r.state === "awaiting-user") {
            r.state = "cancelled";
            return this.finish(r);
        }
        return this.copy(r);
    }
    deny(id) {
        const r = this.current(id);
        if (r.state !== "awaiting-user")
            fail("invalid-state");
        r.state = "denied";
        return this.finish(r);
    }
    unknown(id) {
        const r = this.current(id);
        r.state = "unknown";
        return this.finish(r);
    }
    query(id, sessionId, commitment) {
        const r = this.active?.id === id
            ? this.active
            : this.recent?.id === id
                ? this.recent
                : undefined;
        if (!r)
            return null;
        if (r.sessionId !== sessionId ||
            !equal(fixed(commitment, 32), r.commitment))
            fail("request-conflict");
        return this.copy(r);
    }
    invalidate() {
        this.closed = true;
        this.active = undefined;
        this.recent =
            undefined; /* 不把清空水位当作同连接新请求；对象永久关闭，重连另建实例。 */
    }
    current(id) {
        if (this.closed)
            fail("disconnected");
        if (!this.active || this.active.id !== id)
            fail("invalid-request");
        return this.active;
    }
    finish(r) {
        this.recent = r;
        this.active = undefined;
        return this.copy(r);
    }
    copy(r) {
        return {
            ...r,
            commitment: r.commitment.slice(),
            payload: r.payload?.slice() ?? null,
        };
    }
}
