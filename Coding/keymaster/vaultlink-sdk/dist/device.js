import { fragments, FragmentAssembler, MAX_MESSAGE } from "./fragments.js";
import { equal, fail, ProtocolError } from "./bytes.js";
import { decode, encode, object } from "./cbor.js";
import { commitment } from "./crypto.js";
import { Type } from "./frame.js";
import { RequestGate } from "./requests.js";
import { wipeResultBytes } from "./secret-value.js";
/** SDK 只登记真实操作。设备持续读取控制消息，业务执行不阻塞取消/状态查询；单业务槽由 Gate 强制。 */
export class DeviceServer {
    session;
    onLock;
    assembler = new FragmentAssembler();
    gate = new RequestGate();
    sending = Promise.resolve();
    stopped = false;
    active;
    operations = new Map();
    abort;
    constructor(session, onLock) {
        this.session = session;
        this.onLock = onLock;
    }
    register(op, handler) {
        if (this.operations.has(op) || op.startsWith("system."))
            fail("invalid-operation");
        this.operations.set(op, handler);
    }
    async run() {
        try {
            while (!this.stopped) {
                const f = await this.session.link.read(8000);
                if (f.type !== Type.REQUEST)
                    fail("invalid-message");
                const plain = await this.session.keys.receive.open(f);
                let message;
                try {
                    message = await this.assembler.accept(plain, f.type);
                }
                finally {
                    plain.fill(0);
                }
                if (message === undefined)
                    continue;
                const r = object(message, [
                    "op",
                    "opVersion",
                    "body",
                    "requestId",
                    "binding",
                    "commitment",
                ]);
                this.checkBinding(r.binding);
                if (typeof r.op !== "string" ||
                    r.opVersion !== 1 ||
                    typeof r.requestId !== "number" ||
                    !(r.commitment instanceof Uint8Array))
                    fail("invalid-request");
                if (r.op.startsWith("system.")) {
                    await this.control(r);
                    continue;
                }
                if (this.active) {
                    await this.respond(r, { error: "busy" });
                    continue;
                }
                this.active = this.business(r)
                    .catch(() => this.close())
                    .finally(() => {
                    this.active = undefined;
                });
            }
        }
        catch {
            await this.close();
        }
    }
    async business(r) {
        try {
            const handler = this.operations.get(r.op);
            if (!handler)
                fail("unsupported");
            const core = await handler.verify(r.body);
            if (this.stopped)
                fail("revoked");
            const computed = await commitment(handler.profile, handler.version, core);
            if (!equal(computed, r.commitment))
                fail("invalid-commitment");
            const accepted = this.gate.accept({
                id: r.requestId,
                sessionId: this.session.binding.sessionId,
                commitment: computed,
            });
            if (accepted.state !== "awaiting-user") {
                await this.respond(r, accepted.payload
                    ? decode(accepted.payload)
                    : { state: accepted.state });
                return;
            }
            this.abort = new AbortController();
            if (!(await handler.authorize(core, this.abort.signal))) {
                if (this.stopped)
                    return;
                if (this.abort.signal.aborted) {
                    await this.respond(r, { error: "cancelled" });
                    return;
                }
                this.gate.deny(r.requestId);
                await this.respond(r, { error: "denied" });
                return;
            }
            if (this.stopped || this.abort.signal.aborted)
                return;
            this.gate.start(r.requestId);
            const result = await handler.execute(core, this.abort.signal);
            if (this.stopped) {
                if (handler.retainResult === false)
                    wipeResultBytes(result);
                return;
            }
            let encoded;
            try {
                encoded = encode(result, MAX_MESSAGE);
                this.gate.complete(r.requestId, encoded, handler.retainResult !== false);
                await this.respond(r, result);
            }
            finally {
                encoded?.fill(0);
                if (handler.retainResult === false)
                    wipeResultBytes(result);
            }
        }
        catch (e) {
            if (!this.stopped) {
                try {
                    this.gate.unknown(r.requestId);
                }
                catch {
                    /* 未接收请求没有执行槽，错误不制造完成结果。 */
                }
                await this.respond(r, {
                    error: e instanceof ProtocolError ? e.code : "result-unknown",
                });
            }
        }
    }
    async control(r) {
        if (r.op === "system.ping") {
            await this.respond(r, { alive: true });
            return;
        }
        if (r.op === "system.lock" || r.op === "system.close") {
            await this.close();
            return;
        }
        if (r.op !== "system.query" && r.op !== "system.cancel") {
            await this.respond(r, { error: "unsupported" });
            return;
        }
        try {
            const b = object(r.body, ["requestId", "commitment"]);
            if (typeof b.requestId !== "number" ||
                !(b.commitment instanceof Uint8Array))
                fail("invalid-request");
            const result = r.op === "system.query"
                ? this.gate.query(b.requestId, this.session.binding.sessionId, b.commitment)
                : this.gate.cancel(b.requestId, b.commitment);
            if (r.op === "system.cancel" && result?.state === "cancelled")
                this.abort?.abort();
            this.assembler.close();
            await this.respond(r, result
                ? { state: result.state, payload: result.payload }
                : { state: "unknown", payload: null });
        }
        catch (e) {
            await this.respond(r, {
                error: e instanceof ProtocolError ? e.code : "result-unknown",
            });
        }
    }
    checkBinding(value) {
        const b = object(value, [
            "sessionId",
            "sessionEpoch",
            "connectionId",
            "deviceRunId",
        ]);
        if (Object.entries(this.session.binding).some(([k, v]) => b[k] !== v))
            fail("stale-session");
    }
    async respond(r, payload) {
        const value = { requestId: r.requestId, binding: this.session.binding, commitment: r.commitment, payload };
        const sending = this.sending.then(async () => {
            if (this.stopped)
                fail("disconnected");
            const parts = await fragments(value);
            try {
                for (const plain of parts)
                    await this.session.link.send(await this.session.keys.send.seal(Type.RESPONSE, plain));
            }
            finally {
                for (const plain of parts)
                    plain.fill(0);
            }
        });
        this.sending = sending.catch(() => { });
        await sending;
    }
    async close() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.abort?.abort();
        this.assembler.close();
        this.gate.invalidate();
        this.session.keys.send.close();
        this.session.keys.receive.close();
        try {
            await this.onLock();
        }
        finally {
            await this.session.link.transport.close();
        }
    }
}
