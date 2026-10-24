import { automaticSigningOperation, inspectSigningChannel, sameSigningRegistration } from "./signing-channel.js";
import { sha256 as digest256 } from "@noble/hashes/sha256";
import { encode } from "./cbor.js";
import { addMoney, equal, fail, fixed, hex, money, MAX_U64 } from "./bytes.js";
export function policyArchiveId(id) { return digest256(new TextEncoder().encode(id)); }
export function policyArchiveRecord(value) { return digest256(encode(value, 65536)); }
const archiveContains = (entries, value) => entries.some(e => equal(e.idHash, policyArchiveId(value)));
const id = (s) => {
    if (typeof s !== "string" || !/^[a-zA-Z0-9._:/-]{1,96}$/.test(s))
        fail("invalid-id");
    return s;
};
function revision(n) {
    if (!Number.isSafeInteger(n) || n < 1 || n >= 0xffffffff)
        fail("invalid-revision");
}
function config(c) {
    id(c.id);
    id(c.owner);
    id(c.network);
    id(c.paymentType);
    if (c.kind !== "app" && c.kind !== "plugin")
        fail("invalid-owner");
    if (typeof c.enabled !== "boolean")
        fail("invalid-config");
    money(c.singleLimit);
    money(c.defaultSessionLimit);
    revision(c.revision);
    return { ...c };
}
/** 单实例执行权威。所有 read/check/reserve/commit 串行；存储失败后永久失效，防止不确定落盘后重用额度。 */
export class PaymentPolicy {
    store;
    state;
    alive = true;
    tail = Promise.resolve();
    constructor(store, key) {
        this.store = store;
        this.state = {
            version: 2,
            key,
            channels: [],
            sessions: [],
            pending: [],
            pools: [],
        };
    }
    static async open(store, key) {
        if (!/^0[23][0-9a-f]{64}$/.test(key))
            fail("invalid-key");
        const p = new PaymentPolicy(store, key);
        const old = await store.load();
        if (old) {
            // 仅迁移内部 v1 账本；保留原额度/未知结果，不能迁移主机提交的任意快照。
            if (old.version === 1 &&
                !Object.hasOwn(old, "pools")) {
                old.version = 2;
                old.pools = [];
            }
            PaymentPolicy.validate(old, key);
            p.state = structuredClone(old);
            // Migrate only known operation channels, never payment limits, identities,
            // pending liabilities or the generic digest-signing capability.
            for (const channel of p.state.signing ?? []) {
                if (automaticSigningOperation(channel.operation) && channel.mode === "manual") {
                    revision(channel.revision + 1);
                    channel.mode = "automatic";
                    channel.revision++;
                }
            }
            // 断电位置不可判断：旧预占转成未知并保留占用。App 预算按连接 ID 持久，
            // 进程或 USB 重启不等于 App 主动断开；已关闭标记也原样保留。
            for (const request of p.state.pending)
                if (request.state === "reserved")
                    request.state = "unknown";
            await p.persist();
        }
        return p;
    }
    run(f) {
        const p = this.tail.then(() => {
            if (!this.alive)
                fail("policy-unavailable");
            return f();
        });
        this.tail = p.catch(() => { });
        return p;
    }
    async persist() {
        try {
            encode({ ...this.state, pending: this.state.pending.map(p => ({ ...p, pool: p.pool ?? null })) }, 65536);
            await this.store.save(structuredClone(this.state));
        }
        catch (e) {
            this.alive = false;
            throw e;
        }
    }
    /** Compact only terminal records. Exact hash tombstones retain replay
     * exclusion and source-bank continuation; unknown outcomes never disappear.
     * Active session and pool totals remain unchanged, with accounted archived
     * subtotals used by startup validation. Capacity remains fail closed. */
    compact(payments, sessions) {
        const before = structuredClone(this.state), s = this.state;
        const archive = s.archive ?? { payments: [], sessions: [] };
        let changed = false;
        if (payments) {
            for (const p of [...s.pending]) {
                if ((p.state !== 'signed' && p.state !== 'released') || archive.payments.length >= 512)
                    continue;
                archive.payments.push({ idHash: policyArchiveId(p.id), recordHash: policyArchiveRecord({ ...p, pool: p.pool ?? null }) });
                if (p.state === 'signed') {
                    if (p.sessionId) {
                        const session = this.session(p.sessionId);
                        session.archivedUsed = addMoney(session.archivedUsed ?? 0n, p.amount);
                    }
                    if (p.pool) {
                        const pool = s.pools.find(x => x.id === p.pool.id);
                        pool.archivedPaid = addMoney(pool.archivedPaid ?? 0n, p.amount);
                    }
                }
                s.pending = s.pending.filter(x => x.id !== p.id);
                changed = true;
            }
        }
        if (sessions) {
            for (const session of [...s.sessions]) {
                if (session.active || s.pending.some(p => p.sessionId === session.id) || archive.sessions.length >= 512)
                    continue;
                const record = { ...session, archivedUsed: session.used };
                archive.sessions.push({ idHash: policyArchiveId(session.id), recordHash: policyArchiveRecord(record), record });
                s.sessions = s.sessions.filter(x => x.id !== session.id);
                changed = true;
            }
        }
        if (changed) {
            s.version = s.version === 4 ? 4 : 3;
            s.archive = archive;
            for (const session of s.sessions)
                session.archivedUsed ??= 0n;
            for (const pool of s.pools)
                pool.archivedPaid ??= 0n;
            try {
                PaymentPolicy.validate(s, s.key);
                encode({ ...s, pending: s.pending.map(p => ({ ...p, pool: p.pool ?? null })) }, 65536);
            }
            catch (e) {
                this.state = before;
                throw e;
            }
        }
        return changed;
    }
    async configure(c, confirmed) {
        const copy = config(c);
        return this.run(async () => {
            const old = this.state.channels.find((x) => x.id === copy.id);
            if (old &&
                (old.owner !== copy.owner ||
                    old.kind !== copy.kind ||
                    old.network !== copy.network ||
                    old.paymentType !== copy.paymentType))
                fail("channel-conflict");
            if ((old && copy.revision !== old.revision + 1) ||
                (!old && copy.revision !== 1))
                fail("stale-config");
            if ((!old ||
                (!old.enabled && copy.enabled) ||
                copy.singleLimit > old.singleLimit ||
                copy.defaultSessionLimit > old.defaultSessionLimit) &&
                confirmed !== true)
                fail("confirmation-required");
            if (!old && this.state.channels.length >= 32)
                fail("capacity");
            // App 的默认会话总额属于 owner，所有渠道共享；修改单个设置行也须原子同步。
            const peers = copy.kind === "app"
                ? this.state.channels.filter((c) => c.kind === "app" &&
                    c.owner === copy.owner &&
                    c.id !== copy.id &&
                    c.defaultSessionLimit !== copy.defaultSessionLimit)
                : [];
            for (const peer of peers) {
                revision(peer.revision + 1);
                if (copy.defaultSessionLimit > peer.defaultSessionLimit && !confirmed)
                    fail("confirmation-required");
            }
            for (const peer of peers) {
                peer.defaultSessionLimit = copy.defaultSessionLimit;
                peer.revision++;
            }
            this.state.channels = this.state.channels.filter((x) => x.id !== copy.id);
            this.state.channels.push(copy);
            await this.persist();
        });
    }
    async startSession(sessionId, owner, confirmed) {
        id(sessionId);
        id(owner);
        return this.run(async () => {
            if (confirmed !== true)
                fail("confirmation-required");
            if (archiveContains(this.state.archive?.sessions ?? [], sessionId) || this.state.sessions.some((s) => s.id === sessionId))
                fail("session-reuse");
            if (this.state.sessions.length >= 16) {
                if (this.compact(true, true))
                    await this.persist();
            }
            if (this.state.sessions.length >= 16)
                fail("capacity");
            const channels = this.state.channels.filter((x) => x.owner === owner && x.kind === "app");
            if (!channels.length)
                fail("unknown-owner");
            // New sessions carry identity/revocation only. Historical limits stay
            // decodable on old sessions but cannot grant or restrict spending.
            const limit = 0n;
            this.state.sessions.push({
                id: sessionId,
                owner,
                limit,
                used: 0n,
                revision: 1,
                active: true,
                ...(this.state.version >= 3 ? { archivedUsed: 0n } : {}),
            });
            await this.persist();
        });
    }
    async closeSession(sessionId) {
        return this.run(async () => {
            const s = this.session(sessionId);
            s.active = false;
            await this.persist();
        });
    }
    async quote(p) {
        const copy = this.inspectCopy(p);
        return this.run(async () => this.evaluate(copy));
    }
    async inspectPool(poolId, binding, paid) {
        id(poolId);
        const hash = fixed(binding, 32).slice();
        money(paid);
        return this.run(async () => {
            const previous = this.state.pools.find((p) => p.id === poolId);
            if (previous && !equal(previous.binding, hash))
                fail("pool-conflict");
            const previousPaid = previous?.paid ?? 0n;
            return {
                amount: poolPaymentDelta(previousPaid, paid),
                pool: { id: poolId, binding: hash, previousPaid, paid },
            };
        });
    }
    async reserve(p, approval) {
        const copy = this.inspectCopy(p);
        const a = approval
            ? { ...approval, requestCommitment: approval.requestCommitment.slice() }
            : undefined;
        return this.run(async () => {
            if (archiveContains(this.state.archive?.payments ?? [], copy.requestId) || this.state.pending.some((x) => x.id === copy.requestId))
                fail("request-reuse");
            if (this.state.pending.length >= 128) {
                if (this.compact(true, true))
                    await this.persist();
            }
            if (this.state.pending.length >= 256)
                fail("capacity");
            const q = this.evaluate(copy);
            if (copy.pool &&
                !this.state.pools.some((p) => p.id === copy.pool.id) &&
                this.state.pools.length >= 256)
                fail("capacity");
            if (q.reasons.length) {
                if (!a ||
                    !equal(fixed(a.requestCommitment, 32), copy.commitment) ||
                    a.configRevision !== q.configRevision ||
                    a.sessionRevision !== q.sessionRevision)
                    fail("confirmation-required");
            }
            else if (a &&
                (a.configRevision !== q.configRevision ||
                    a.sessionRevision !== q.sessionRevision ||
                    !equal(a.requestCommitment, copy.commitment)))
                fail("stale-approval");
            if (a?.raiseSessionLimit !== undefined) {
                // Retained wire field for decoding old histories, not an authority.
                fail("session-limits-removed");
            }
            if (copy.kind === "app") {
                const s = this.session(copy.sessionId);
                s.used = addMoney(s.used, copy.amount); /* used 包含预占。提高/确认不清零。 */
            }
            this.state.pending.push({
                id: copy.requestId,
                sessionId: copy.sessionId,
                channelId: copy.channelId,
                amount: copy.amount,
                commitment: copy.commitment.slice(),
                configRevision: q.configRevision,
                sessionRevision: copy.kind === "app" ? this.session(copy.sessionId).revision : 0,
                state: "reserved",
                ...(copy.pool ? { pool: structuredClone(copy.pool) } : {}),
            });
            if (copy.pool) {
                const pool = this.state.pools.find((p) => p.id === copy.pool.id);
                if (pool)
                    pool.paid = copy.pool.paid;
                else
                    this.state.pools.push({
                        id: copy.pool.id,
                        binding: copy.pool.binding.slice(),
                        paid: copy.pool.paid,
                        ...(this.state.version >= 3 ? { archivedPaid: 0n } : {}),
                    });
            }
            await this.persist();
            return q;
        });
    }
    /** 在不可逆签名之前调用；配置/会话过期则拒绝，不能靠提前 quote 放行。 */
    async assertExecutable(requestId) {
        return this.run(async () => {
            const p = this.pending(requestId);
            if (p.state !== "reserved")
                fail("invalid-state");
            const c = this.state.channels.find((c) => c.id === p.channelId);
            if (!c || c.revision !== p.configRevision)
                fail("revoked");
            if (p.sessionId) {
                const s = this.session(p.sessionId);
                if (!s.active || s.revision !== p.sessionRevision)
                    fail("revoked");
            }
        });
    }
    async markSigned(requestId) {
        return this.setState(requestId, "signed");
    }
    async markUnknown(requestId) {
        return this.setState(requestId, "unknown");
    }
    async setState(requestId, state) {
        return this.run(async () => {
            const p = this.pending(requestId);
            if (p.state === "signed" && state === "unknown")
                return;
            if (p.state !== "reserved" && p.state !== state)
                fail("invalid-state");
            p.state = state;
            await this.persist();
        });
    }
    /**
     * 只允许受信执行权威在持有绑定该 request 的未签终止证明时，释放
     * 重启后已变为 unknown 的预占。普通 App/插件不可到达此方法。
     * 已签/部分签名的 request 必须拒绝。
     */
    async releaseUnknownProven(requestId) {
        return this.run(async () => {
            const p = this.pending(requestId);
            if (p.state === "released")
                return;
            if (p.state !== "unknown" && p.state !== "reserved")
                fail("result-unknown");
            if (p.pool) {
                const pool = this.state.pools.find((x) => x.id === p.pool.id);
                if (!pool || pool.paid !== p.pool.paid)
                    fail("corrupt-state");
                pool.paid = p.pool.previousPaid;
            }
            if (p.sessionId) {
                const s = this.session(p.sessionId);
                if (s.used < p.amount)
                    fail("corrupt-state");
                s.used -= p.amount;
            }
            /* 保留墓碑防 requestId 再执行。 */ p.state = "released";
            await this.persist();
        });
    }
    /** 只允许执行权威在确定未执行时释放；App/普通插件不得调用此内部方法。 */
    async releaseUnexecuted(requestId) {
        return this.run(async () => {
            const p = this.pending(requestId);
            if (p.state !== "reserved")
                fail("result-unknown");
            if (p.pool) {
                const pool = this.state.pools.find((x) => x.id === p.pool.id);
                if (!pool || pool.paid !== p.pool.paid)
                    fail("corrupt-state");
                pool.paid = p.pool.previousPaid;
            }
            if (p.sessionId) {
                const s = this.session(p.sessionId);
                if (s.used < p.amount)
                    fail("corrupt-state");
                s.used -= p.amount;
            }
            /* 保留墓碑防 requestId 再执行。 */ p.state = "released";
            await this.persist();
        });
    }
    /** 与支付账本原子存储；已知操作自动注册，重复注册不能替换身份。 */
    async registerSigning(channels, network, confirmed) {
        const copies = channels.map(inspectSigningChannel);
        if (!copies.length || copies.length > 32 || new Set(copies.map(c => c.id)).size !== copies.length)
            fail("invalid-signing-channel");
        return this.run(async () => {
            if (network !== "main" && network !== "test")
                fail("network-identity-required");
            if (this.state.network && this.state.network !== network || this.state.channels.some(c => c.network !== network))
                fail("network-identity-mismatch");
            const next = structuredClone(this.state.signing ?? []);
            for (const c of copies) {
                const old = next.find(x => x.id === c.id);
                if (old) {
                    if (!sameSigningRegistration(old, c))
                        fail("channel-conflict");
                    continue;
                }
                const automatic = automaticSigningOperation(c.operation);
                if ((!confirmed && !automatic) || c.revision !== 1)
                    fail("confirmation-required");
                if (next.length >= 32)
                    fail("capacity");
                next.push(automatic ? { ...c, mode: "automatic" } : c);
            }
            const changed = next.length !== (this.state.signing?.length ?? 0);
            if (changed) {
                this.state.version = 4;
                this.state.network = network;
                this.state.signing = next;
                this.state.archive ??= { payments: [], sessions: [] };
                for (const s of this.state.sessions)
                    s.archivedUsed ??= 0n;
                for (const p of this.state.pools)
                    p.archivedPaid ??= 0n;
                await this.persist();
            }
            return copies.map(c => structuredClone(next.find(x => x.id === c.id)));
        });
    }
    /** 调用者只能是钱包设置入口；主机协议不能转发这个能力给硬件。 */
    async configureSigning(id, mode, expectedRevision) {
        return this.run(async () => {
            const c = this.state.signing?.find(x => x.id === id);
            if (!c)
                fail("channel-required");
            if (c.revision !== expectedRevision)
                fail("stale-config");
            if (automaticSigningOperation(c.operation) && mode !== "automatic")
                fail("operation-policy-automatic");
            const next = inspectSigningChannel({ ...c, mode, revision: c.revision + 1 });
            Object.assign(c, next);
            await this.persist();
        });
    }
    async signingChannel(channelId, operation, network) {
        return this.run(async () => {
            if (this.state.network !== network)
                fail("network-identity-mismatch");
            const c = this.state.signing?.find(x => x.id === channelId);
            if (!c || c.operation !== operation)
                fail("channel-required");
            return structuredClone(c);
        });
    }
    async snapshot() {
        return this.run(async () => structuredClone(this.state));
    }
    lock() {
        this.alive = false;
    }
    session(s) {
        const x = this.state.sessions.find((x) => x.id === s);
        if (!x)
            fail("invalid-session");
        return x;
    }
    pending(s) {
        const x = this.state.pending.find((x) => x.id === s);
        if (!x)
            fail("invalid-request");
        return x;
    }
    inspectCopy(p) {
        id(p.requestId);
        id(p.channelId);
        id(p.owner);
        id(p.network);
        id(p.paymentType);
        money(p.amount);
        if (p.operation !== undefined && (p.operation !== "internal-pool-state" || p.kind !== "plugin" || !/^feepool\.(connect|bitfs)(\.cosigner)?$/.test(p.paymentType)))
            fail("invalid-operation");
        if (p.kind !== "app" && p.kind !== "plugin")
            fail("invalid-owner");
        if (p.sessionId !== null)
            id(p.sessionId);
        if (fixed(p.commitment, 32).every((x) => x === 0))
            fail("invalid-commitment");
        if (p.pool) {
            id(p.pool.id);
            fixed(p.pool.binding, 32);
            money(p.pool.previousPaid);
            money(p.pool.paid);
        }
        return {
            ...p,
            commitment: p.commitment.slice(),
            ...(p.pool
                ? { pool: { ...p.pool, binding: p.pool.binding.slice() } }
                : {}),
        };
    }
    evaluate(p) {
        if (p.pool) {
            const pool = this.state.pools.find((x) => x.id === p.pool.id);
            if (pool && !equal(pool.binding, p.pool.binding))
                fail("pool-conflict");
            if ((pool?.paid ?? 0n) !== p.pool.previousPaid)
                fail("stale-pool");
            if (poolPaymentDelta(p.pool.previousPaid, p.pool.paid) !== p.amount)
                fail("invalid-pool-delta");
            // 同池正在执行时不接受下一笔，避免未执行释放导致后续增量少计。
            if (this.state.pending.some((x) => x.state === "reserved" && x.pool?.id === p.pool.id))
                fail("busy");
        }
        const c = this.state.channels.find((x) => x.id === p.channelId);
        if (!c ||
            c.owner !== p.owner ||
            c.kind !== p.kind ||
            c.network !== p.network ||
            c.paymentType !== p.paymentType)
            fail("invalid-channel");
        const reasons = [];
        if (!p.operation) {
            if (!c.enabled)
                reasons.push("disabled");
            if (p.amount > c.singleLimit)
                reasons.push("single-limit");
        }
        let s;
        if (p.kind === "app") {
            if (!p.sessionId)
                fail("invalid-session");
            s = this.session(p.sessionId);
            if (!s.active || s.owner !== p.owner)
                fail("invalid-session");
            if (s.used > MAX_U64 - p.amount)
                fail("amount-overflow");
            // Session usage is historical responsibility only, never an allowance.
            // Identity, active/revision and overflow checks remain enforced.
        }
        else if (p.sessionId !== null)
            fail("invalid-session");
        return {
            reasons,
            amount: p.amount,
            used: s?.used ?? 0n,
            singleLimit: c.singleLimit,
            sessionLimit: null,
            configRevision: c.revision,
            sessionRevision: s?.revision ?? 0,
        };
    }
    /** Migration codecs use the same ledger invariants as normal startup; no
     * importing an empty replacement to recover from malformed state. */
    static inspectSnapshot(snapshot, key) {
        if (!/^0[23][0-9a-f]{64}$/.test(key))
            fail("invalid-key");
        const frozen = structuredClone(snapshot);
        PaymentPolicy.validate(frozen, key);
        return frozen;
    }
    static validate(s, key) {
        if (!s ||
            (s.version !== 2 && s.version !== 3 && s.version !== 4) ||
            s.key !== key ||
            !Array.isArray(s.channels) ||
            !Array.isArray(s.sessions) ||
            !Array.isArray(s.pending) ||
            !Array.isArray(s.pools) ||
            s.pools.length > 256 ||
            s.channels.length > 32 ||
            s.sessions.length > 16 ||
            s.pending.length > 256)
            fail("corrupt-state");
        if (s.version === 4) {
            if ((s.network !== "main" && s.network !== "test") || !Array.isArray(s.signing) || s.signing.length > 32 || s.channels.some(c => c.network !== s.network))
                fail("corrupt-state");
            const ids = new Set();
            for (const c of s.signing) {
                inspectSigningChannel(c);
                if (ids.has(c.id))
                    fail("corrupt-state");
                ids.add(c.id);
            }
        }
        else if (s.signing !== undefined || s.network !== undefined)
            fail("corrupt-state");
        if (s.version >= 3) {
            if (!s.archive || !Array.isArray(s.archive.payments) || !Array.isArray(s.archive.sessions) || s.archive.payments.length > 512 || s.archive.sessions.length > 512)
                fail('corrupt-state');
            for (const entries of [s.archive.payments]) {
                const ids = new Set();
                for (const e of entries) {
                    if (Object.keys(e).sort().join() !== 'idHash,recordHash')
                        fail('corrupt-state');
                    fixed(e.idHash, 32);
                    fixed(e.recordHash, 32);
                    if (ids.has(hex(e.idHash)))
                        fail('corrupt-state');
                    ids.add(hex(e.idHash));
                }
            }
            const archivedSessions = new Set();
            for (const e of s.archive.sessions) {
                if (Object.keys(e).sort().join() !== 'idHash,record,recordHash')
                    fail('corrupt-state');
                fixed(e.idHash, 32);
                fixed(e.recordHash, 32);
                const r = e.record;
                if (!r || Object.keys(r).sort().join() !== 'active,archivedUsed,id,limit,owner,revision,used')
                    fail('corrupt-state');
                id(r.id);
                id(r.owner);
                money(r.limit);
                money(r.used);
                revision(r.revision);
                if (r.active !== false || r.archivedUsed !== r.used || !equal(e.idHash, policyArchiveId(r.id)) || !equal(e.recordHash, policyArchiveRecord(r)) || archivedSessions.has(r.id))
                    fail('corrupt-state');
                archivedSessions.add(r.id);
            }
            for (const session of s.sessions) {
                if (session.archivedUsed === undefined)
                    fail('corrupt-state');
                money(session.archivedUsed);
                if (archiveContains(s.archive.sessions, session.id))
                    fail('corrupt-state');
            }
            for (const pool of s.pools) {
                if (pool.archivedPaid === undefined)
                    fail('corrupt-state');
                money(pool.archivedPaid);
            }
            for (const p of s.pending)
                if (archiveContains(s.archive.payments, p.id))
                    fail('corrupt-state');
        }
        else if (s.archive || s.sessions.some(x => x.archivedUsed !== undefined) || s.pools.some(x => x.archivedPaid !== undefined))
            fail('corrupt-state');
        const unique = (values) => {
            if (new Set(values).size !== values.length)
                fail("corrupt-state");
        };
        for (const c of s.channels)
            config(c);
        unique(s.channels.map((c) => c.id));
        for (const x of s.sessions) {
            id(x.id);
            id(x.owner);
            money(x.limit);
            money(x.used);
            revision(x.revision);
            if (typeof x.active !== "boolean")
                fail("corrupt-state");
        }
        unique(s.sessions.map((x) => x.id));
        for (const x of s.pending) {
            id(x.id);
            id(x.channelId);
            money(x.amount);
            fixed(x.commitment, 32);
            revision(x.configRevision);
            const channel = s.channels.find((c) => c.id === x.channelId);
            const session = s.sessions.find((t) => t.id === x.sessionId);
            if (!["reserved", "signed", "unknown", "released"].includes(x.state) ||
                !channel ||
                x.commitment.every((b) => b === 0) ||
                x.configRevision > channel.revision ||
                (channel.kind === "app"
                    ? !session ||
                        session.owner !== channel.owner ||
                        !Number.isSafeInteger(x.sessionRevision) ||
                        x.sessionRevision < 1 ||
                        x.sessionRevision > session.revision
                    : x.sessionId !== null || x.sessionRevision !== 0))
                fail("corrupt-state");
        }
        unique(s.pending.map((x) => x.id));
        unique(s.pools.map((x) => x.id));
        for (const pool of s.pools) {
            id(pool.id);
            fixed(pool.binding, 32);
            money(pool.paid);
            let total = pool.archivedPaid ?? 0n;
            for (const p of s.pending.filter((x) => x.pool?.id === pool.id)) {
                const x = p.pool;
                money(x.previousPaid);
                money(x.paid);
                if (!equal(pool.binding, fixed(x.binding, 32)) ||
                    poolPaymentDelta(x.previousPaid, x.paid) !== p.amount)
                    fail("corrupt-state");
                if (p.state !== "released")
                    total = addMoney(total, p.amount);
            }
            if (total !== pool.paid)
                fail("corrupt-state");
        }
        for (const p of s.pending)
            if (p.pool && !s.pools.some((x) => x.id === p.pool.id))
                fail("corrupt-state");
        for (const session of s.sessions) {
            let accounted = session.archivedUsed ?? 0n;
            for (const payment of s.pending)
                if (payment.sessionId === session.id && payment.state !== "released")
                    accounted = addMoney(accounted, payment.amount);
            if (accounted !== session.used)
                fail("corrupt-state");
        }
    }
}
/** Output-only net business value. NOT wallet spend or an approval amount:
 * it cannot account for fees without verified inputs. Inspectors compute spend
 * as owned inputs minus all own P2PKH outputs instead. */
export function externalOutputAmount(outputs) {
    let total = 0n;
    for (const o of outputs) {
        money(o.amount);
        if (typeof o.owned !== "boolean")
            fail("invalid-output");
        if (!o.owned)
            total = addMoney(total, o.amount);
    }
    return total;
}
/** 费用池累计更新仅按核验后的对外付款增量；同池连续状态验证由 Profile 负责。 */
export function poolPaymentDelta(previous, next) {
    money(previous);
    money(next);
    if (next < previous)
        fail("payment-rollback");
    return next - previous;
}
// 可用于日志关联的非秘密标识；不导出真实私钥或正文。
export const paymentCommitmentId = (b) => hex(fixed(b, 32));
