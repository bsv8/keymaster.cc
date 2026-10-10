import { fail, MAX_U64 } from "./bytes.js";
import { decode, encode, object } from "./cbor.js";
import { PaymentPolicy, policyArchiveId, policyArchiveRecord } from "./payment.js";
const uint = (v) => { if ((typeof v !== "number" && typeof v !== "bigint") || (typeof v === "number" && !Number.isSafeInteger(v)))
    fail("corrupt-state"); const n = BigInt(v); if (n < 0n || n > MAX_U64)
    fail("corrupt-state"); return n; };
const revision = (v) => { const n = uint(v); if (n > 0xffffffffn)
    fail("corrupt-state"); return Number(n); };
const text = (v) => { if (typeof v !== "string")
    fail("corrupt-state"); return v; };
const flag = (v) => { if (typeof v !== "boolean")
    fail("corrupt-state"); return v; };
const bytes = (v) => { if (!(v instanceof Uint8Array))
    fail("corrupt-state"); return new Uint8Array(v); };
const list = (v) => { if (!Array.isArray(v))
    fail("corrupt-state"); return v; };
const pool = (v) => { const x = object(v, ["id", "binding", "previousPaid", "paid"]); return { id: text(x.id), binding: bytes(x.binding), previousPaid: uint(x.previousPaid), paid: uint(x.paid) }; };
/** Exact C++ Policy v2 bank. Public state only: no wallet key, PIN or password.
 * Conversion preserves uint64 precision, closed sessions, consumed/unknown
 * payments, revision fences and fee-pool baselines. It grants no import right. */
export function encodePaymentPolicy(snapshot, key) {
    const s = PaymentPolicy.inspectSnapshot(snapshot, key);
    return encode({ ...s, pending: s.pending.map(p => ({ ...p, pool: p.pool ?? null })) }, 65536);
}
export function decodePaymentPolicy(raw, key) {
    const decoded = decode(raw, 65536);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array)
        fail("corrupt-state");
    const version = uint(decoded.version);
    const x = object(decoded, version === 3n ? ["version", "key", "channels", "sessions", "pending", "pools", "archive"] : ["version", "key", "channels", "sessions", "pending", "pools"]);
    if (version !== 2n && version !== 3n)
        fail("corrupt-state");
    const s = { version: Number(version), key: text(x.key),
        channels: list(x.channels).map(v => {
            const c = object(v, ["id", "owner", "kind", "network", "paymentType", "enabled", "singleLimit", "defaultSessionLimit", "revision"]);
            const kind = text(c.kind);
            if (kind !== "plugin" && kind !== "app")
                fail("corrupt-state");
            return { id: text(c.id), owner: text(c.owner), kind, network: text(c.network), paymentType: text(c.paymentType), enabled: flag(c.enabled), singleLimit: uint(c.singleLimit), defaultSessionLimit: uint(c.defaultSessionLimit), revision: revision(c.revision) };
        }),
        sessions: list(x.sessions).map(v => { const s = object(v, version === 3n ? ["id", "owner", "limit", "used", "revision", "active", "archivedUsed"] : ["id", "owner", "limit", "used", "revision", "active"]); return { id: text(s.id), owner: text(s.owner), limit: uint(s.limit), used: uint(s.used), revision: revision(s.revision), active: flag(s.active), ...(version === 3n ? { archivedUsed: uint(s.archivedUsed) } : {}) }; }),
        pending: list(x.pending).map(v => {
            const p = object(v, ["id", "channelId", "sessionId", "amount", "commitment", "configRevision", "sessionRevision", "state", "pool"]);
            const state = text(p.state);
            if (state !== "reserved" && state !== "signed" && state !== "unknown" && state !== "released")
                fail("corrupt-state");
            return { id: text(p.id), channelId: text(p.channelId), sessionId: p.sessionId === null ? null : text(p.sessionId), amount: uint(p.amount), commitment: bytes(p.commitment), configRevision: revision(p.configRevision), sessionRevision: revision(p.sessionRevision), state, ...(p.pool === null ? {} : { pool: pool(p.pool) }) };
        }),
        pools: list(x.pools).map(v => { const p = object(v, version === 3n ? ["id", "binding", "paid", "archivedPaid"] : ["id", "binding", "paid"]); return { id: text(p.id), binding: bytes(p.binding), paid: uint(p.paid), ...(version === 3n ? { archivedPaid: uint(p.archivedPaid) } : {}) }; }) };
    if (version === 3n) {
        const a = object(x.archive, ["payments", "sessions"]);
        const entries = (v) => list(v).map(e => { const x = object(e, ["idHash", "recordHash"]); return { idHash: bytes(x.idHash), recordHash: bytes(x.recordHash) }; });
        s.archive = { payments: entries(a.payments), sessions: list(a.sessions).map(e => { const x = object(e, ["idHash", "recordHash", "record"]), r = object(x.record, ["id", "owner", "limit", "used", "revision", "active", "archivedUsed"]); return { idHash: bytes(x.idHash), recordHash: bytes(x.recordHash), record: { id: text(r.id), owner: text(r.owner), limit: uint(r.limit), used: uint(r.used), revision: revision(r.revision), active: flag(r.active), archivedUsed: uint(r.archivedUsed) } }; }) };
    }
    return PaymentPolicy.inspectSnapshot(s, key);
}
/** Device migration must reject unsupported channels before transferring a key. */
export function assertHardwarePaymentPolicy(snapshot, key) {
    const s = PaymentPolicy.inspectSnapshot(snapshot, key), supported = new Set(["p2pkh", "bsv.standard", "feepool.connect", "feepool.bitfs", "feepool.connect.cosigner", "feepool.bitfs.cosigner"]);
    if (s.channels.some(c => c.network !== "main" || !supported.has(c.paymentType)))
        fail("unsupported-policy");
    decodePaymentPolicy(encodePaymentPolicy(s, key), key);
}
/** Reconnecting a migrated backend may observe later device activity, but must
 * never accept an empty/reset/older ledger for the same imported private key.
 * Limits can legitimately change under newer revisions; spent amounts, closed
 * sessions, payment identities and pool baselines cannot go backwards. */
export function assertPaymentPolicyContinuation(source, current, key) {
    const before = PaymentPolicy.inspectSnapshot(source, key), after = PaymentPolicy.inspectSnapshot(current, key);
    for (const c of before.channels) {
        const next = after.channels.find(x => x.id === c.id);
        if (!next || next.owner !== c.owner || next.kind !== c.kind || next.network !== c.network || next.paymentType !== c.paymentType
            || next.revision < c.revision || (next.revision === c.revision && (next.singleLimit !== c.singleLimit || next.defaultSessionLimit !== c.defaultSessionLimit || next.enabled !== c.enabled)))
            fail("policy-rollback");
    }
    const archived = (entries, id, record) => entries?.some(e => sameBytes(e.idHash, policyArchiveId(id)) && sameBytes(e.recordHash, policyArchiveRecord(record))) === true;
    for (const kind of ["payments", "sessions"])
        for (const entry of before.archive?.[kind] ?? []) {
            if (!after.archive?.[kind].some(e => sameBytes(e.idHash, entry.idHash) && sameBytes(e.recordHash, entry.recordHash)))
                fail("policy-rollback");
        }
    for (const s of before.sessions) {
        const next = after.sessions.find(x => x.id === s.id) ?? after.archive?.sessions.find(e => sameBytes(e.idHash, policyArchiveId(s.id)))?.record;
        if (!next || (next.archivedUsed ?? 0n) < (s.archivedUsed ?? 0n) || next.owner !== s.owner || next.used < s.used || next.revision < s.revision || (!s.active && next.active)
            || (next.revision === s.revision && next.limit !== s.limit))
            fail("policy-rollback");
    }
    for (const p of before.pending) {
        const next = after.pending.find(x => x.id === p.id);
        if (!next && (p.state === "signed" || p.state === "released") && archived(after.archive?.payments, p.id, { ...p, pool: p.pool ?? null }))
            continue;
        if (p.state === "reserved" || !next || next.channelId !== p.channelId || next.sessionId !== p.sessionId || next.amount !== p.amount
            || next.configRevision !== p.configRevision || next.sessionRevision !== p.sessionRevision || !sameBytes(next.commitment, p.commitment)
            || (p.state === "released" ? next.state !== "released" : next.state !== "signed" && next.state !== "unknown")
            || Boolean(next.pool) !== Boolean(p.pool) || (p.pool && (!next.pool || next.pool.id !== p.pool.id
            || !sameBytes(next.pool.binding, p.pool.binding) || next.pool.previousPaid !== p.pool.previousPaid || next.pool.paid !== p.pool.paid)))
            fail("policy-rollback");
    }
    for (const pool of before.pools) {
        const next = after.pools.find(x => x.id === pool.id);
        if (!next || !sameBytes(next.binding, pool.binding) || next.paid < pool.paid || (next.archivedPaid ?? 0n) < (pool.archivedPaid ?? 0n))
            fail("policy-rollback");
    }
}
function sameBytes(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
