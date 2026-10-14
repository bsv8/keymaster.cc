import { fail } from "./bytes.js";
import { object } from "./cbor.js";
import { commitment } from "./crypto.js";
import { inspectP2pkh } from "./bsv.js";
/** 同一个实际交易只预占一次；所有输入共用一次授权。宿主负责原子绑定 policy 的 Key 与本 DeviceKey。 */
export class P2pkhPaymentOperation {
    key;
    policy;
    context;
    confirm;
    profile;
    version = 1;
    constructor(key, policy, context, confirm) {
        this.key = key;
        this.policy = policy;
        this.context = context;
        this.confirm = confirm;
        this.profile = context === null ? "bsv-payment-context" : "bsv-payment";
    }
    async verify(body) {
        const b = object(body, [
            "rawTx",
            "prevTransactions",
            "channelId",
            "paymentId",
            ...(this.context === null ? ["sessionId"] : []),
        ]);
        if (!(b.rawTx instanceof Uint8Array) ||
            !Array.isArray(b.prevTransactions) ||
            b.prevTransactions.some((v) => !(v instanceof Uint8Array)) ||
            typeof b.channelId !== "string" ||
            typeof b.paymentId !== "string")
            fail("invalid-request");
        const frozen = structuredClone(b);
        const review = await inspectP2pkh(frozen.rawTx, frozen.prevTransactions.map((transaction) => ({
            transaction,
        })), this.key.publicKey(), 0);
        /* Profile 不接收主机自报 amount/change，实际输出重新核算。 */ return {
            rawTx: frozen.rawTx,
            prevTransactions: frozen.prevTransactions,
            channelId: frozen.channelId,
            paymentId: frozen.paymentId,
            ...(this.context === null ? { sessionId: frozen.sessionId } : {}),
            amount: review.amount,
        };
    }
    async request(core) {
        const b = object(core, [
            "rawTx",
            "prevTransactions",
            "channelId",
            "paymentId",
            "amount",
            ...(this.context === null ? ["sessionId"] : []),
        ]);
        if (typeof b.amount !== "bigint")
            fail("invalid-amount");
        let context = this.context;
        if (context === null) {
            const snapshot = await this.policy.snapshot();
            const channel = snapshot.channels.find(c => c.id === b.channelId);
            if (!channel)
                fail("invalid-channel");
            const sessionId = core.sessionId;
            if (sessionId !== null && typeof sessionId !== "string")
                fail("invalid-session");
            context = { owner: channel.owner, kind: channel.kind, sessionId };
        }
        return {
            requestId: b.paymentId,
            channelId: b.channelId,
            ...context,
            network: "main",
            paymentType: "p2pkh",
            amount: b.amount,
            commitment: await commitment(this.profile, 1, core),
        };
    }
    async authorize(core, signal) {
        const p = await this.request(core), q = await this.policy.quote(p);
        let approval;
        if (q.reasons.length) {
            const answer = await this.confirm(structuredClone(p), structuredClone(q), signal);
            if (!answer.allow || signal.aborted)
                return false;
            approval = {
                requestCommitment: p.commitment,
                configRevision: q.configRevision,
                sessionRevision: q.sessionRevision,
                ...(answer.raiseSessionLimit === undefined
                    ? {}
                    : { raiseSessionLimit: answer.raiseSessionLimit }),
            };
        }
        if (signal.aborted)
            return false;
        await this.policy.reserve(p, approval);
        if (signal.aborted) {
            await this.policy.releaseUnexecuted(p.requestId);
            return false;
        }
        return true;
    }
    async execute(core, signal) {
        const p = await this.request(core), b = core;
        let signatures;
        let signingStarted = false;
        try {
            await this.policy.assertExecutable(p.requestId);
            if (signal.aborted)
                fail("revoked");
            signingStarted = true;
            signatures = await this.key.signAllP2pkh(b.rawTx, b.prevTransactions.map((transaction) => ({
                transaction,
            })), signal, () => this.policy.assertExecutable(p.requestId));
        }
        catch (e) {
            if (signingStarted)
                await this.policy.markUnknown(p.requestId);
            else
                await this.policy.releaseUnexecuted(p.requestId);
            throw e;
        }
        /* 从此开始可能已有可花钱签名。落盘失败不释放额度，不交付签名。 */ await this.policy.markSigned(p.requestId);
        return { signatures, amount: p.amount };
    }
}
